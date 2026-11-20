// The picker page, the variants canvas and the screenshot upload.
//
//   GET  /p/<id>              picker page            GET  /v/<id>          canvas page
//   GET  /p/<id>/state        the session            GET  /v/<id>/state    the board
//   PUT  /p/<id>/state        {picked, hidden}       GET  /v/<id>/img/<n>  screenshot n
//   POST /p/<id>/more         "More like these"      PUT  /u/<upload id>/<n>  upload screenshot n
//   POST /p/<id>/done         Done
//   GET  /assets/<file>       page scripts, styles and icons
//
// The ids are bearer secrets. An unknown id gives 404, and many from one IP give 429. Never log an id.

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import sharp, { type Metadata, type OutputInfo } from "sharp";
import { getSimilarElements } from "./cosmos.js";
import { historyEntry, prefetchPickImages } from "./design.js";
import { hashId, MAX_MORE_ROUNDS, MORE_PER_ROUND, type Board, type PickStore, type Session, type Tile } from "./picks.js";
import { RateLimiter } from "./ratelimit.js";

const MAX_STATE_BYTES = 64 * 1024;
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const MAX_IMAGE_WIDTH = 2880;
const MAX_IMAGE_HEIGHT = 12000;
/** Decoded size limit of an upload. A decode holds about 4 bytes per pixel. */
const MAX_INPUT_PIXELS = 50_000_000;
/** Uploads decode one at a time. More than this many waiting gives 503. */
const MAX_UPLOADS_WAITING = 4;

const PAGES_DIR = fileURLToPath(new URL("../pages/", import.meta.url));
const ASSETS: Record<string, string> = {
  "picker.js": "text/javascript; charset=utf-8",
  "canvas.js": "text/javascript; charset=utf-8",
  "pages.css": "text/css; charset=utf-8",
  "favicon.svg": "image/svg+xml",
  "favicon-32.png": "image/png",
  "apple-touch-icon.png": "image/png",
};
const PAGE_FILES = { picker: "picker.html", canvas: "canvas.html" } as const;

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https://cdn.cosmos.so; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow",
  "cross-origin-opener-policy": "same-origin",
};

type Log = (fields: Record<string, unknown>) => void;

/** Reads the page files once. They are small and change only with a deploy. */
function loadFiles(): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const name of [...Object.keys(ASSETS), ...Object.values(PAGE_FILES)]) files.set(name, readFileSync(PAGES_DIR + name));
  return files;
}

class BodyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > maxBytes) throw new BodyError(413, "too large");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).byteLength;
    if (total > maxBytes) throw new BodyError(413, "too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** A write from a page: JSON only, so a form on another site cannot send it. */
async function readPageJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw new BodyError(415, "The body must be application/json.");
  const body = await readBody(req, MAX_STATE_BYTES);
  try {
    const value = body.length ? JSON.parse(body.toString("utf8")) : {};
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch {
    throw new BodyError(400, "The body is not a JSON object.");
  }
}

function idList(value: unknown, allowed: Set<string>): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    const id = String(item);
    if (allowed.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

export class Pages {
  private readonly files = loadFiles();
  /** Requests with an unknown id, per IP. */
  private uploadsWaiting = 0;
  private uploadQueue: Promise<unknown> = Promise.resolve();

  /** Runs image decodes one after another, so several uploads cannot fill the memory together. */
  private oneAtATime<T>(work: () => Promise<T>): Promise<T> {
    this.uploadsWaiting++;
    const run = this.uploadQueue.then(work, work).finally(() => this.uploadsWaiting--);
    this.uploadQueue = run.catch(() => undefined);
    return run;
  }

  private readonly guesses = new RateLimiter(Number(process.env.PAGE_GUESS_LIMIT ?? 30), 15 * 60_000);
  /** "More like these" in progress per session, so a double click does not add the same tiles twice. */
  private readonly moreInflight = new Map<string, Promise<Tile[]>>();

  constructor(
    private readonly picks: PickStore,
    private readonly log: Log,
  ) {}

  /** The path as it may be logged: ids replaced by ":id". */
  static logPath(path: string): string {
    return path.replace(/^\/(p|v|u)\/[^/]+/, "/$1/:id");
  }

  /** Handles a page route. Returns false when the path is not one. */
  async handle(req: IncomingMessage, res: ServerResponse, path: string, ip: string): Promise<boolean> {
    const asset = /^\/assets\/([a-z0-9-]+\.(?:js|css|svg|png))$/.exec(path);
    if (asset) {
      const name = asset[1]!;
      const type = ASSETS[name];
      if (!type || (req.method !== "GET" && req.method !== "HEAD")) return this.notFound(res), true;
      res.writeHead(200, { "content-type": type, "cache-control": "no-cache", ...SECURITY_HEADERS }).end(this.files.get(name));
      return true;
    }
    const match = /^\/(p|v|u)\/([^/]+)(?:\/([a-z]+))?(?:\/(\d{1,2}))?$/.exec(path);
    if (!match) return false;
    const [, kind, id = "", action, index] = match;
    if (this.guesses.blocked(ip)) {
      this.send(res, 429, { error: "Too many requests with a wrong link. Try again later." }, { "retry-after": "900" });
      return true;
    }
    try {
      if (kind === "p") await this.picker(req, res, id, action, index, ip);
      else if (kind === "v") await this.canvas(req, res, id, action, index, ip);
      else await this.upload(req, res, id, action, index, ip);
    } catch (error) {
      if (error instanceof BodyError) this.send(res, error.status, { error: error.message });
      else throw error;
    }
    return true;
  }

  private send(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
    res
      .writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...SECURITY_HEADERS, ...headers })
      .end(JSON.stringify(value));
  }

  private notFound(res: ServerResponse, ip?: string): void {
    if (ip) this.guesses.hit(ip);
    this.send(res, 404, { error: "This link has expired or is wrong." });
  }

  private methodNotAllowed(res: ServerResponse, allow: string): void {
    this.send(res, 405, { error: "Method not allowed." }, { allow });
  }

  private page(res: ServerResponse, name: keyof typeof PAGE_FILES): void {
    res
      .writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS })
      .end(this.files.get(PAGE_FILES[name]));
  }

  // ---- Picker ----

  private sessionState(session: Session): unknown {
    return {
      task: session.task,
      status: session.status,
      tiles: session.tiles.map(({ id, thumb, w, h, kind, round }) => ({ id, thumb, w, h, kind, round })),
      picked: session.picked,
      hidden: session.hidden,
      rounds: session.rounds,
      maxRounds: MAX_MORE_ROUNDS,
    };
  }

  private async picker(req: IncomingMessage, res: ServerResponse, id: string, action: string | undefined, index: string | undefined, ip: string): Promise<void> {
    const session = this.picks.session(id);
    if (!session || index !== undefined) return this.notFound(res, ip);

    if (!action) {
      if (req.method !== "GET" && req.method !== "HEAD") return this.methodNotAllowed(res, "GET");
      return this.page(res, "picker");
    }
    if (action === "state") {
      if (req.method === "GET") {
        if (!session.seenAt || Date.now() - Date.parse(session.seenAt) > 60_000) {
          session.seenAt = new Date().toISOString();
          this.picks.save().catch((error: unknown) => this.log({ level: "error", event: "picks_write_failed", error: (error as Error).message }));
        }
        return this.send(res, 200, this.sessionState(session));
      }
      if (req.method !== "PUT") return this.methodNotAllowed(res, "GET, PUT");
      const body = await readPageJson(req);
      if (session.status === "done") return this.send(res, 409, this.sessionState(session));
      this.applyState(session, body);
      await this.picks.save();
      return this.send(res, 200, this.sessionState(session));
    }
    if (action === "more") {
      if (req.method !== "POST") return this.methodNotAllowed(res, "POST");
      const body = await readPageJson(req);
      if (session.status === "done") return this.send(res, 409, this.sessionState(session));
      this.applyState(session, body);
      if (session.picked.length === 0) return this.send(res, 400, { error: "Pick one first." });
      if (session.rounds >= MAX_MORE_ROUNDS) return this.send(res, 409, this.sessionState(session));
      const hash = hashId(id);
      let inflight = this.moreInflight.get(hash);
      if (!inflight) {
        inflight = this.findMore(session).finally(() => this.moreInflight.delete(hash));
        this.moreInflight.set(hash, inflight);
      }
      const added = await inflight;
      await this.picks.save();
      return this.send(res, 200, { ...(this.sessionState(session) as object), added: added.map((tile) => tile.id) });
    }
    if (action === "done") {
      if (req.method !== "POST") return this.methodNotAllowed(res, "POST");
      const body = await readPageJson(req);
      if (session.status !== "done") {
        this.applyState(session, body);
        session.status = "done";
        session.doneAt = new Date().toISOString();
        this.picks.touch(session);
        prefetchPickImages(session);
        await this.picks.save();
        try {
          await this.picks.addHistory(session.owner, historyEntry(session));
        } catch (error) {
          this.log({ level: "error", event: "history_write_failed", error: (error as Error).message });
        }
        this.log({ event: "picks_done", picked: session.picked.length, candidates: session.tiles.length });
        this.picks.wake(id);
      }
      return this.send(res, 200, this.sessionState(session));
    }
    return this.notFound(res);
  }

  /** Takes picked and hidden from a page write. Ids that are not tiles of the session are ignored. */
  private applyState(session: Session, body: Record<string, unknown>): void {
    const allowed = new Set(session.tiles.map((tile) => tile.id));
    const picked = idList(body.picked, allowed);
    const hidden = idList(body.hidden, allowed);
    if (picked) session.picked = picked;
    if (hidden) session.hidden = hidden.filter((tileId) => !session.picked.includes(tileId));
    if (picked || hidden) this.picks.touch(session);
  }

  /** Up to MORE_PER_ROUND new tiles that look like the picks, round robin over the picks. */
  private async findMore(session: Session): Promise<Tile[]> {
    const lists = await Promise.all(session.picked.map((pickId) => getSimilarElements(pickId).catch(() => [])));
    const known = new Set(session.tiles.map((tile) => tile.id));
    const round = session.rounds + 1;
    const added: Tile[] = [];
    const positions = lists.map(() => 0);
    while (added.length < MORE_PER_ROUND) {
      let progressed = false;
      for (let index = 0; index < lists.length && added.length < MORE_PER_ROUND; index++) {
        const list = lists[index]!;
        while (positions[index]! < list.length) {
          const item = list[positions[index]!++]!;
          if (known.has(item.id)) continue;
          known.add(item.id);
          added.push({ id: item.id, thumb: item.thumb, w: item.width, h: item.height, kind: item.kind, round });
          progressed = true;
          break;
        }
      }
      if (!progressed) break;
    }
    session.rounds = round;
    session.tiles.push(...added);
    this.picks.touch(session);
    return added;
  }

  // ---- Canvas ----

  private boardState(board: Board): unknown {
    return {
      task: board.task,
      createdAt: board.createdAt,
      variants: board.variants.map((variant) => ({
        name: variant.name,
        takes: variant.takes.map(({ id, thumb, w, h, what }) => ({ id, thumb, w, h, what })),
        image: variant.image ?? null,
      })),
    };
  }

  private async canvas(req: IncomingMessage, res: ServerResponse, id: string, action: string | undefined, index: string | undefined, ip: string): Promise<void> {
    const board = this.picks.board(id);
    if (!board) return this.notFound(res, ip);
    if (req.method !== "GET" && req.method !== "HEAD") return this.methodNotAllowed(res, "GET");
    if (!action && index === undefined) return this.page(res, "canvas");
    if (action === "state" && index === undefined) return this.send(res, 200, this.boardState(board));
    if (action === "img" && index !== undefined) {
      const n = Number(index) - 1;
      if (!board.variants[n]?.image) return this.notFound(res);
      let data: Buffer;
      try {
        data = await readFile(this.picks.imageFile(hashId(id), n));
      } catch {
        return this.notFound(res);
      }
      res.writeHead(200, { "content-type": "image/webp", "cache-control": "private, max-age=86400", ...SECURITY_HEADERS }).end(data);
      return;
    }
    return this.notFound(res);
  }

  // ---- Upload ----

  private async upload(req: IncomingMessage, res: ServerResponse, uploadId: string, action: string | undefined, index: string | undefined, ip: string): Promise<void> {
    // The path is /u/<upload id>/<n>: the regex puts n in `index` and leaves `action` empty.
    const found = this.picks.boardForUpload(uploadId);
    if (!found || action !== undefined || index === undefined) return this.notFound(res, ip);
    if (req.method !== "PUT" && req.method !== "POST") return this.methodNotAllowed(res, "PUT");
    const n = Number(index) - 1;
    const variant = found.board.variants[n];
    if (!variant) return this.send(res, 404, { error: `This board has ${found.board.variants.length} variants.` });
    const type = (req.headers["content-type"] ?? "").toLowerCase();
    if (type && !/^(image\/(png|jpeg|webp)|application\/octet-stream|application\/x-www-form-urlencoded)\b/.test(type)) {
      return this.send(res, 415, { error: "Send the image as the raw body (curl -T file.png <url>): PNG, JPEG or WebP." });
    }
    if (this.uploadsWaiting >= MAX_UPLOADS_WAITING) return this.send(res, 503, { error: "Too many uploads at once. Try again in a few seconds." });
    const body = await readBody(req, MAX_UPLOAD_BYTES);
    let metadata: Metadata;
    try {
      // metadata() reads the header only, so this check comes before any decode.
      metadata = await sharp(body).metadata();
      if (!["png", "jpeg", "webp"].includes(metadata.format ?? "")) throw new Error("format");
    } catch {
      return this.send(res, 400, { error: "The body is not a PNG, JPEG or WebP image." });
    }
    if ((metadata.width ?? 0) * (metadata.height ?? 0) > MAX_INPUT_PIXELS) {
      return this.send(res, 413, { error: `The image is larger than ${MAX_INPUT_PIXELS / 1_000_000} megapixels. Take a smaller screenshot.` });
    }
    let output: { data: Buffer; info: OutputInfo };
    try {
      output = await this.oneAtATime(() =>
        sharp(body, { limitInputPixels: MAX_INPUT_PIXELS, animated: false })
          .rotate()
          .resize({ width: MAX_IMAGE_WIDTH, height: MAX_IMAGE_HEIGHT, fit: "inside", withoutEnlargement: true })
          .webp({ quality: 90 })
          .toBuffer({ resolveWithObject: true }),
      );
    } catch {
      return this.send(res, 400, { error: "The body is not a PNG, JPEG or WebP image." });
    }
    await this.picks.writeImage(found.hash, n, output.data);
    variant.image = { w: output.info.width, h: output.info.height, version: Date.now() };
    await this.picks.save();
    this.log({ event: "variant_uploaded", variant: n + 1, width: output.info.width, height: output.info.height });
    res
      .writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS })
      .end(`Uploaded variant ${n + 1} (${output.info.width} x ${output.info.height} px).\n`);
  }
}
