// Loads the still image of a reference, from the Cosmos CDN or from the own vault, and makes it
// small enough for an MCP image content block.

import sharp from "sharp";
import { cosmosFetch, type Reference } from "./cosmos.js";

const MAX_LONG_EDGE = 1568;
const MAX_BASE64_CHARS = 4_000_000;
const MAX_DOWNLOAD_BYTES = 30 * 1024 * 1024;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const CACHE_TTL_MS = 24 * 60 * 60_000;

export interface Visual {
  /** Base64 JPEG. */
  data: string;
  mimeType: "image/jpeg";
  width: number;
  height: number;
  sourceUrl: string;
}

const cache = new Map<string, { visual: Visual; at: number }>();
let cacheBytes = 0;

function cacheGet(url: string): Visual | undefined {
  const entry = cache.get(url);
  if (!entry) return undefined;
  cache.delete(url);
  cacheBytes -= entry.visual.data.length;
  if (Date.now() - entry.at > CACHE_TTL_MS) return undefined;
  cache.set(url, entry);
  cacheBytes += entry.visual.data.length;
  return entry.visual;
}

function cachePut(url: string, visual: Visual): void {
  cache.set(url, { visual, at: Date.now() });
  cacheBytes += visual.data.length;
  for (const [key, entry] of cache) {
    if (cacheBytes <= MAX_CACHE_BYTES) break;
    cache.delete(key);
    cacheBytes -= entry.visual.data.length;
  }
}

/** Reads the still image of a reference that this server stores (the own vault), from its link. */
let localSource: ((url: string) => Promise<Buffer | undefined>) | undefined;

export function setLocalSource(source: (url: string) => Promise<Buffer | undefined>): void {
  localSource = source;
}

/** The still image of a link of the own vault, or undefined for another link. */
export async function readLocal(url: string): Promise<Buffer | undefined> {
  return localSource?.(url);
}

async function download(url: string): Promise<Buffer> {
  const response = await cosmosFetch(url, { headers: { accept: "image/*" } });
  if (!response.ok) throw new Error(`CDN returned HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_DOWNLOAD_BYTES) throw new Error(`image is too large (${declared} bytes)`);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > MAX_DOWNLOAD_BYTES) throw new Error("image is too large");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function encode(input: Buffer, longEdge: number, quality: number) {
  return sharp(input, { limitInputPixels: 120_000_000, animated: false })
    .rotate()
    .resize({ width: longEdge, height: longEdge, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality })
    .toBuffer({ resolveWithObject: true });
}

/**
 * Returns the image of an image reference, or the thumbnail of a video reference, with a long edge
 * of at most `maxLongEdge` pixels.
 */
export async function loadVisual(reference: Pick<Reference, "thumbnailUrl" | "width">, maxLongEdge = MAX_LONG_EDGE): Promise<Visual> {
  const source = reference.thumbnailUrl;
  if (!source) throw new Error("the reference has no image");
  const longEdgeCap = Math.min(maxLongEdge, MAX_LONG_EDGE);
  const cacheKey = longEdgeCap === MAX_LONG_EDGE ? source : `${source}#${longEdgeCap}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // Ask the CDN for a WebP copy, which is a smaller download. The CDN enlarges an image when "w"
  // is larger than its width, so never ask for more than the known width.
  let input: Buffer;
  const local = await localSource?.(source);
  if (local) {
    input = local;
  } else {
    const resized = new URL(source);
    resized.searchParams.set("format", "webp");
    if (reference.width) resized.searchParams.set("w", String(Math.min(reference.width, longEdgeCap)));
    try {
      input = await download(resized.toString());
    } catch {
      input = await download(source);
    }
  }

  const attempts = ([
    [longEdgeCap, 85],
    [longEdgeCap, 70],
    [1024, 70],
    [768, 60],
  ] as [number, number][]).filter(([edge], index) => index < 2 || edge < longEdgeCap);
  for (const [longEdge, quality] of attempts) {
    const { data, info } = await encode(input, longEdge, quality);
    const base64 = data.toString("base64");
    if (base64.length > MAX_BASE64_CHARS) continue;
    const visual: Visual = {
      data: base64,
      mimeType: "image/jpeg",
      width: info.width,
      height: info.height,
      sourceUrl: source,
    };
    cachePut(cacheKey, visual);
    return visual;
  }
  throw new Error("the image stays too large after downscaling");
}
