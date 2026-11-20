// HTTP routes of the own vault.
//
//   POST /vault/upload               the extension's helper sends one copied file (device key)
//   GET  /vault/f/<owner>/<fileKey>  the file. The key in the link is the secret.
//   GET  /vault/t/<owner>/<fileKey>.jpg  its still image

import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, SMALL_LONG_EDGE, OwnVault, parseUploadMeta, VaultError, type OwnItem, type UploadMeta } from "./ownvault.js";
import { RateLimiter } from "./ratelimit.js";
import type { Account, LinkStore } from "./store.js";

type Log = (fields: Record<string, unknown>) => void;

const MAX_META_CHARS = 16 * 1024;
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;

/** Headers for stored files: they come from other sites, so a browser must never run them as a page of this origin. */
const FILE_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; sandbox",
  "cross-origin-resource-policy": "same-origin",
  "cache-control": "private, max-age=31536000, immutable",
};

function json(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers }).end(JSON.stringify(value));
}

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

/** Passes at most `limit` bytes, then fails. */
function cap(limit: number): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      total += chunk.byteLength;
      done(total > limit ? new VaultError(413, `The file is larger than ${limit / 1024 / 1024} MB.`) : null, chunk);
    },
  });
}

export class VaultRoutes {
  /** Uploads per account. */
  private readonly uploads = new RateLimiter(Number(process.env.UPLOAD_RATE_LIMIT ?? 300), 60 * 60_000);

  constructor(
    private readonly vault: OwnVault,
    private readonly store: LinkStore,
    private readonly keyFailures: RateLimiter,
    private readonly log: Log,
  ) {}

  /** True when the path belongs to these routes and the response was sent. */
  async handle(req: IncomingMessage, res: ServerResponse, path: string, ip: string): Promise<boolean> {
    if (path === "/vault/upload") {
      if (req.method !== "POST") json(res, 405, { error: "Method not allowed. Use POST." }, { allow: "POST" });
      else await this.upload(req, res, ip);
      return true;
    }
    const match = /^\/vault\/(f|t)\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{43})(\.jpg)?$/.exec(path);
    if (!match) return false;
    const [, type, owner, fileKey, suffix] = match;
    if ((type === "t") !== (suffix === ".jpg")) return false;
    if (req.method !== "GET" && req.method !== "HEAD") {
      json(res, 405, { error: "Method not allowed." }, { allow: "GET, HEAD" });
      return true;
    }
    const item = await this.vault.byKey(owner!, fileKey!).catch(() => undefined);
    if (!item) {
      json(res, 404, { error: "Not found." });
      return true;
    }
    if (type === "t") {
      // A grid asks for a small width and gets the small still image.
      const width = Number(new URL(req.url ?? "/", "http://localhost").searchParams.get("w") ?? 0);
      const small = width > 0 && width <= SMALL_LONG_EDGE;
      await this.send(req, res, small ? this.vault.smallThumbPath(owner!, item) : this.vault.thumbPath(owner!, item), "image/jpeg", true);
    }
    else await this.send(req, res, this.vault.mediaPath(owner!, item), item.mime, true, `tasteref-${item.id}.${item.ext}`);
    return true;
  }

  private account(req: IncomingMessage, ip: string): Account | undefined | "blocked" {
    if (this.keyFailures.blocked(ip)) return "blocked";
    const username = header(req, "x-username");
    const key = header(req, "x-device-key");
    const account = USERNAME_PATTERN.test(username) && key && key.length <= 256 ? this.store.authenticate(username, key, this.log) : undefined;
    if (!account) this.keyFailures.hit(ip);
    return account;
  }

  private async upload(req: IncomingMessage, res: ServerResponse, ip: string): Promise<void> {
    const account = this.account(req, ip);
    if (account === "blocked") return json(res, 429, { error: "Too many requests with a wrong key. Try again later." }, { "retry-after": "900" });
    if (!account) return json(res, 401, { error: "Missing or wrong device key." });
    if (!this.uploads.hit(account.userId)) return json(res, 429, { error: "Too many saves. Try again later." }, { "retry-after": "900" });

    let meta: UploadMeta;
    try {
      const raw = header(req, "x-meta");
      if (!raw || raw.length > MAX_META_CHARS) throw new VaultError(400, "x-meta is missing or too long.");
      meta = parseUploadMeta(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    } catch (error) {
      return json(res, 400, { error: error instanceof VaultError ? error.message : "x-meta must be base64url JSON." });
    }
    const limit = meta.kind === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
    const declared = Number(header(req, "content-length") || 0);
    if (declared > limit) return json(res, 413, { error: `The file is larger than ${limit / 1024 / 1024} MB.` }, { connection: "close" });

    const temporary = join(await this.vault.tempDir(), randomBytes(12).toString("hex"));
    try {
      await pipeline(req, cap(limit), createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      if (res.headersSent || res.destroyed) return;
      if (error instanceof VaultError) return json(res, error.status, { error: error.message }, { connection: "close" });
      return json(res, 400, { error: "The upload did not finish." }, { connection: "close" });
    }
    try {
      const username = header(req, "x-username");
      const key = header(req, "x-device-key");
      const { item, existed } = await this.vault.add(account.userId, meta, temporary, () => this.store.authenticate(username, key, this.log)?.userId === account.userId);
      this.log({ event: "vault_saved", kind: item.kind, bytes: item.bytes, existed });
      json(res, 200, { ok: true, id: item.id, existed });
    } catch (error) {
      if (error instanceof VaultError) return json(res, error.status, { error: error.message });
      this.log({ level: "error", event: "vault_save_failed", error: (error as Error).message.slice(0, 200) });
      json(res, 500, { error: "The server could not store the file." });
    }
  }

  /** Sends a file, with one byte range when the client asks for it (a video player does). */
  private async send(req: IncomingMessage, res: ServerResponse, file: string, mime: string, inline: boolean, name?: string): Promise<void> {
    let size: number;
    try {
      size = (await stat(file)).size;
    } catch {
      return json(res, 404, { error: "Not found." });
    }
    const headers: Record<string, string> = {
      ...FILE_HEADERS,
      "content-type": mime,
      "accept-ranges": "bytes",
      "content-disposition": `${inline ? "inline" : "attachment"}${name ? `; filename="${name}"` : ""}`,
    };
    let start = 0;
    let end = size - 1;
    let status = 200;
    const range = /^bytes=(\d*)-(\d*)$/.exec(header(req, "range"));
    if (range && (range[1] || range[2])) {
      if (range[1]) {
        start = Number(range[1]);
        if (range[2]) end = Math.min(Number(range[2]), size - 1);
      } else {
        start = Math.max(size - Number(range[2]), 0);
      }
      if (!(start <= end) || start >= size) {
        res.writeHead(416, { ...FILE_HEADERS, "content-range": `bytes */${size}` }).end();
        return;
      }
      status = 206;
      headers["content-range"] = `bytes ${start}-${end}/${size}`;
    }
    headers["content-length"] = String(end - start + 1);
    res.writeHead(status, headers);
    if (req.method === "HEAD" || size === 0) return void res.end();
    await pipeline(createReadStream(file, { start, end }), res).catch(() => undefined);
  }
}

export type { OwnItem };
