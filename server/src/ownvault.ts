// The own vault: references that the user copied on sites other than Cosmos. The server keeps the
// file, a still image and what the page said about it. An agent writes the description later.
//
// Layout, per owner (the Cosmos user id of the account, as in picks.ts):
//   DATA_DIR/vault/<owner>/items.json      the list, newest first
//   DATA_DIR/vault/<owner>/media/<id>.<ext> the file as it was copied
//   DATA_DIR/vault/<owner>/thumb/<id>.jpg   a still image, long edge at most 1568 px

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import type { Reference } from "./cosmos.js";
import { writeFileAtomic } from "./store.js";

export const OWN_ID_PATTERN = /^t\d{15}$/;
export const OWNER_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const FILE_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** The link to a still image of the own vault, on any origin of this server. */
export const OWN_THUMB_URL = /^https?:\/\/[^/]+\/vault\/t\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{43}\.jpg(?:\?[^#]*)?$/;

export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
export const MAX_ITEMS = 5_000;
export const MAX_OWNER_BYTES = 5 * 1024 * 1024 * 1024;
const THUMB_LONG_EDGE = 1568;
/** A second, small still image for grids. */
export const SMALL_LONG_EDGE = 640;
const FFMPEG_TIMEOUT_MS = 20_000;
const MAX_TEXT = 300;
const MAX_URL = 2_000;
const MAX_DESCRIPTION = 600;
const MAX_TAGS = 20;
const MAX_TAG = 40;

type Log = (fields: Record<string, unknown>) => void;

/** The file types the vault keeps. The type comes from the bytes, never from the sender. */
const IMAGE_TYPES: Record<string, { ext: string; mime: string }> = {
  jpeg: { ext: "jpg", mime: "image/jpeg" },
  png: { ext: "png", mime: "image/png" },
  webp: { ext: "webp", mime: "image/webp" },
  gif: { ext: "gif", mime: "image/gif" },
  avif: { ext: "avif", mime: "image/avif" },
};
const VIDEO_TYPES: Record<string, { ext: string; mime: string }> = {
  mp4: { ext: "mp4", mime: "video/mp4" },
  webm: { ext: "webm", mime: "video/webm" },
  mov: { ext: "mov", mime: "video/quicktime" },
};

export interface OwnItem {
  id: string;
  kind: "image" | "video";
  ext: string;
  mime: string;
  bytes: number;
  sha256: string;
  width?: number;
  height?: number;
  /** The page the user was on. */
  pageUrl?: string;
  pageTitle?: string;
  /** The host name of the page, such as "dribbble.com". */
  site?: string;
  alt?: string;
  /** The address of the media file on that site. */
  sourceUrl?: string;
  savedAt: string;
  /** The secret in the links to the file and its still image. */
  fileKey: string;
  /** Written by an agent that looked at the image. */
  description?: string;
  tags?: string[];
}

interface ItemsFile {
  version: 1;
  items: OwnItem[];
}

export interface UploadMeta {
  id: string;
  kind: "image" | "video";
  pageUrl?: string;
  pageTitle?: string;
  alt?: string;
  sourceUrl?: string;
}

export class VaultError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function cleanText(value: unknown, max = MAX_TEXT): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : undefined;
}

function cleanUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_URL) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Reads the upload description that the extension sent. Throws on a wrong shape. */
export function parseUploadMeta(raw: unknown): UploadMeta {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (typeof value.id !== "string" || !OWN_ID_PATTERN.test(value.id)) throw new VaultError(400, "id must be t and 15 digits.");
  if (value.kind !== "image" && value.kind !== "video") throw new VaultError(400, "kind must be image or video.");
  return {
    id: value.id,
    kind: value.kind,
    pageUrl: cleanUrl(value.pageUrl),
    pageTitle: cleanText(value.pageTitle),
    alt: cleanText(value.alt),
    sourceUrl: cleanUrl(value.sourceUrl),
  };
}

function run(command: string, args: string[], timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 }, (error) => (error ? reject(error) : resolve()));
  });
}

/** The container type of a video, from its first bytes. */
function videoType(head: Buffer): { ext: string; mime: string } | undefined {
  if (head.length >= 12 && head.toString("latin1", 4, 8) === "ftyp") {
    return head.toString("latin1", 8, 10) === "qt" ? VIDEO_TYPES.mov : VIDEO_TYPES.mp4;
  }
  if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3) return VIDEO_TYPES.webm;
  return undefined;
}

async function readHead(file: string, bytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of createReadStream(file, { start: 0, end: bytes - 1 })) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

async function makeThumb(input: string | Buffer, target: string, longEdge = THUMB_LONG_EDGE): Promise<void> {
  const data = await sharp(input, { limitInputPixels: 120_000_000, animated: false })
    .rotate()
    .resize({ width: longEdge, height: longEdge, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 85 })
    .toBuffer();
  await writeFileAtomic(target, data);

}

export class OwnVault {
  private readonly root: string;
  private readonly files = new Map<string, ItemsFile>();
  private readonly queues = new Map<string, Promise<unknown>>();
  /** False when ffmpeg is missing: videos are then refused. */
  ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";

  constructor(
    dataDir: string,
    private readonly log: Log,
  ) {
    this.root = join(dataDir, "vault");
  }

  private dir(owner: string): string {
    if (!OWNER_PATTERN.test(owner)) throw new VaultError(400, "Unknown owner.");
    return join(this.root, owner);
  }

  mediaPath(owner: string, item: OwnItem): string {
    return join(this.dir(owner), "media", `${item.id}.${item.ext}`);
  }

  thumbPath(owner: string, item: OwnItem): string {
    return join(this.dir(owner), "thumb", `${item.id}.jpg`);
  }

  smallThumbPath(owner: string, item: OwnItem): string {
    return join(this.dir(owner), "thumb", `${item.id}.s.jpg`);
  }

  /** A directory for uploads in progress, on the same volume as the vault so a rename is atomic. */
  async tempDir(): Promise<string> {
    const dir = join(this.root, ".tmp");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /** Removes uploads that a crash left behind. */
  async cleanTemp(): Promise<void> {
    await rm(join(this.root, ".tmp"), { recursive: true, force: true }).catch(() => undefined);
  }

  /** Runs the steps of one owner one after the other. */
  private queue<T>(owner: string, step: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(owner) ?? Promise.resolve();
    const next = previous.then(step, step);
    const tail = next.catch(() => undefined);
    this.queues.set(owner, tail);
    void tail.then(() => {
      if (this.queues.get(owner) === tail) this.queues.delete(owner);
    });
    return next;
  }

  private async load(owner: string): Promise<ItemsFile> {
    const cached = this.files.get(owner);
    if (cached) return cached;
    let file: ItemsFile = { version: 1, items: [] };
    try {
      const parsed = JSON.parse(await readFile(join(this.dir(owner), "items.json"), "utf8")) as ItemsFile;
      if (parsed?.version === 1 && Array.isArray(parsed.items)) file = parsed;
    } catch (error) {
      // A missing file is an empty vault. Any other failure must not turn into "empty" and then a write.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.files.set(owner, file);
    return file;
  }

  private async write(owner: string, file: ItemsFile): Promise<void> {
    await mkdir(this.dir(owner), { recursive: true, mode: 0o700 });
    await writeFileAtomic(join(this.dir(owner), "items.json"), JSON.stringify(file));
  }

  /** The items of an owner, newest first. The array is a copy. */
  async list(owner: string): Promise<OwnItem[]> {
    return [...(await this.load(owner)).items];
  }

  async get(owner: string, id: string): Promise<OwnItem | undefined> {
    return (await this.load(owner)).items.find((item) => item.id === id);
  }

  async byKey(owner: string, fileKey: string): Promise<OwnItem | undefined> {
    if (!OWNER_PATTERN.test(owner) || !FILE_KEY_PATTERN.test(fileKey)) return undefined;
    return (await this.load(owner)).items.find((item) => item.fileKey === fileKey);
  }

  /**
   * Takes a finished upload (a temporary file) into the vault. The temporary file is always gone
   * after the call. The same bytes a second time return the item that exists.
   */
  async add(owner: string, meta: UploadMeta, temporary: string): Promise<{ item: OwnItem; existed: boolean }> {
    try {
      const { size } = await stat(temporary);
      const limit = meta.kind === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
      if (size === 0) throw new VaultError(400, "The file is empty.");
      if (size > limit) throw new VaultError(413, `The file is larger than ${limit / 1024 / 1024} MB.`);

      // The slow work runs before the queue, so one large video does not hold the other saves.
      const sha256 = await hashFile(temporary);
      let type: { ext: string; mime: string } | undefined;
      let width: number | undefined;
      let height: number | undefined;
      const thumbTemporary = `${temporary}.thumb`;
      const smallTemporary = `${temporary}.small`;
      try {
        if (meta.kind === "image") {
          const info = await sharp(temporary, { limitInputPixels: 120_000_000 }).metadata().catch(() => undefined);
          type = info?.format ? IMAGE_TYPES[info.format === "heif" && info.compression === "av1" ? "avif" : info.format] : undefined;
          if (!type || !info?.width || !info.height) throw new VaultError(415, "The file is not an image that the vault keeps (JPEG, PNG, WebP, GIF, AVIF).");
          const turned = (info.orientation ?? 1) >= 5;
          width = turned ? info.height : info.width;
          height = turned ? info.width : info.height;
          await makeThumb(temporary, thumbTemporary);
          await makeThumb(thumbTemporary, smallTemporary, SMALL_LONG_EDGE);
        } else {
          type = videoType(await readHead(temporary, 16));
          if (!type) throw new VaultError(415, "The file is not a video that the vault keeps (MP4, WebM, MOV).");
          const frame = `${temporary}.frame.jpg`;
          try {
            // The first frame at or after 0.5 s, else the first frame of a shorter clip.
            await run(this.ffmpeg, ["-v", "error", "-nostdin", "-y", "-ss", "0.5", "-i", temporary, "-frames:v", "1", "-q:v", "3", frame], FFMPEG_TIMEOUT_MS).catch(() =>
              run(this.ffmpeg, ["-v", "error", "-nostdin", "-y", "-i", temporary, "-frames:v", "1", "-q:v", "3", frame], FFMPEG_TIMEOUT_MS),
            );
            const info = await sharp(frame).metadata();
            width = info.width;
            height = info.height;
            await makeThumb(frame, thumbTemporary);
            await makeThumb(thumbTemporary, smallTemporary, SMALL_LONG_EDGE);
          } catch (error) {
            if (error instanceof VaultError) throw error;
            this.log({ level: "error", event: "vault_poster_failed", error: (error as Error).message.slice(0, 200) });
            throw new VaultError(415, "The server could not read a frame of the video.");
          } finally {
            await unlink(frame).catch(() => undefined);
          }
        }

        return await this.queue(owner, async () => {
          const file = await this.load(owner);
          const same = file.items.find((item) => item.sha256 === sha256);
          if (same) return { item: same, existed: true };
          if (file.items.some((item) => item.id === meta.id)) throw new VaultError(409, "A reference with this id exists.");
          if (file.items.length >= MAX_ITEMS) throw new VaultError(507, `The vault is full (${MAX_ITEMS} references). Delete some on the vault page.`);
          if (file.items.reduce((sum, item) => sum + item.bytes, 0) + size > MAX_OWNER_BYTES) {
            throw new VaultError(507, "The vault is full (5 GB). Delete some references on the vault page.");
          }
          let site: string | undefined;
          try {
            site = meta.pageUrl ? new URL(meta.pageUrl).hostname.replace(/^www\./, "") : undefined;
          } catch {
            site = undefined;
          }
          const item: OwnItem = {
            id: meta.id,
            kind: meta.kind,
            ext: type!.ext,
            mime: type!.mime,
            bytes: size,
            sha256,
            width,
            height,
            pageUrl: meta.pageUrl,
            pageTitle: meta.pageTitle,
            site,
            alt: meta.alt,
            sourceUrl: meta.sourceUrl,
            savedAt: new Date().toISOString(),
            fileKey: randomBytes(32).toString("base64url"),
          };
          await mkdir(join(this.dir(owner), "media"), { recursive: true, mode: 0o700 });
          await mkdir(join(this.dir(owner), "thumb"), { recursive: true, mode: 0o700 });
          await rename(thumbTemporary, this.thumbPath(owner, item));
          await rename(smallTemporary, this.smallThumbPath(owner, item));
          await rename(temporary, this.mediaPath(owner, item));
          // The list is written last: files without an entry are harmless, an entry without files is not.
          const next: ItemsFile = { version: 1, items: [item, ...file.items] };
          try {
            await this.write(owner, next);
          } catch (error) {
            await unlink(this.thumbPath(owner, item)).catch(() => undefined);
            await unlink(this.smallThumbPath(owner, item)).catch(() => undefined);
            await unlink(this.mediaPath(owner, item)).catch(() => undefined);
            throw error;
          }
          this.files.set(owner, next);
          return { item, existed: false };
        });
      } finally {
        await unlink(thumbTemporary).catch(() => undefined);
        await unlink(smallTemporary).catch(() => undefined);
      }
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  /** Stores the description that an agent wrote. False when the item does not exist. */
  describe(owner: string, id: string, description: string, tags: string[]): Promise<boolean> {
    return this.queue(owner, async () => {
      const file = await this.load(owner);
      const index = file.items.findIndex((item) => item.id === id);
      const text = cleanText(description, MAX_DESCRIPTION);
      if (index < 0 || !text) return false;
      const cleanTags = [...new Set(tags.map((tag) => cleanText(tag, MAX_TAG)?.toLowerCase()).filter((tag): tag is string => Boolean(tag)))].slice(0, MAX_TAGS);
      const items = [...file.items];
      items[index] = { ...items[index]!, description: text, tags: cleanTags };
      const next: ItemsFile = { version: 1, items };
      await this.write(owner, next);
      this.files.set(owner, next);
      return true;
    });
  }

  /** Deletes one item and its files. False when it does not exist. */
  remove(owner: string, id: string): Promise<boolean> {
    return this.queue(owner, async () => {
      const file = await this.load(owner);
      const item = file.items.find((entry) => entry.id === id);
      if (!item) return false;
      const next: ItemsFile = { version: 1, items: file.items.filter((entry) => entry.id !== id) };
      await this.write(owner, next);
      this.files.set(owner, next);
      await unlink(this.mediaPath(owner, item)).catch(() => undefined);
      await unlink(this.thumbPath(owner, item)).catch(() => undefined);
      await unlink(this.smallThumbPath(owner, item)).catch(() => undefined);
      return true;
    });
  }

  /** Deletes all of an owner's vault. */
  deleteOwner(owner: string): Promise<void> {
    if (!OWNER_PATTERN.test(owner)) return Promise.resolve();
    return this.queue(owner, async () => {
      this.files.delete(owner);
      await rm(this.dir(owner), { recursive: true, force: true }).catch((error: unknown) =>
        this.log({ level: "error", event: "vault_delete_failed", error: (error as Error).message }),
      );
    });
  }

  /** The bytes of the still image of an item, for the image loader. */
  async thumbOfUrl(url: string): Promise<Buffer | undefined> {
    const match = /\/vault\/t\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{43})\.jpg(?:[?#]|$)/.exec(url);
    if (!match) return undefined;
    const item = await this.byKey(match[1]!, match[2]!);
    return item ? readFile(this.thumbPath(match[1]!, item)) : undefined;
  }
}

/** The link to the still image of an item. */
export function thumbUrl(baseUrl: string, owner: string, item: OwnItem): string {
  return `${baseUrl}/vault/t/${owner}/${item.fileKey}.jpg`;
}

/** The link to the file of an item. */
export function fileUrl(baseUrl: string, owner: string, item: OwnItem): string {
  return `${baseUrl}/vault/f/${owner}/${item.fileKey}`;
}

/** An own item in the shape that the tools use for every reference. */
export function toReference(baseUrl: string, owner: string, item: OwnItem): Reference {
  return {
    id: item.id,
    kind: item.kind,
    title: item.pageTitle,
    description: item.description ?? item.alt,
    sourceUrl: item.pageUrl,
    pageUrl: item.pageUrl ?? fileUrl(baseUrl, owner, item),
    mediaUrl: fileUrl(baseUrl, owner, item),
    thumbnailUrl: thumbUrl(baseUrl, owner, item),
    width: item.width,
    height: item.height,
    savedAt: item.savedAt,
    createdAt: item.savedAt,
  };
}

/** The words of a query that an item must hold, and how well it matches. 0 means no match. */
export function matchScore(item: OwnItem, query: string): number {
  const tokens = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 1);
  if (tokens.length === 0) return 0;
  const strong = [item.description, ...(item.tags ?? [])].filter(Boolean).join(" ").toLowerCase();
  const weak = [item.pageTitle, item.alt, item.site].filter(Boolean).join(" ").toLowerCase();
  let score = 0;
  let hits = 0;
  for (const token of tokens) {
    const inStrong = strong.includes(token);
    const inWeak = weak.includes(token);
    if (inStrong || inWeak) hits += 1;
    score += (inStrong ? 2 : 0) + (inWeak ? 1 : 0);
  }
  // More than half of the words must match, so one common word does not bring in everything.
  return hits * 2 > tokens.length ? score : 0;
}
