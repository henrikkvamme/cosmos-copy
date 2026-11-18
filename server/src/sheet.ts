// Contact sheets: numbered thumbnails in one JPEG, so an agent can look at 30 references at once.
//
// The numbers are drawn as strokes in SVG, not as text: the server image has no fonts, and
// librsvg would draw text without a font as nothing or as boxes.

import sharp, { type OverlayOptions } from "sharp";
import { cosmosFetch } from "./cosmos.js";

export const SHEET_COLUMNS = 6;
export const SHEET_ROWS = 5;
export const PER_SHEET = SHEET_COLUMNS * SHEET_ROWS;
const CELL_W = 256;
const CELL_H = 192;
const GAP = 8;
const BACKGROUND = "#0d0d0e";
const CELL_BACKGROUND = { r: 28, g: 28, b: 31, alpha: 1 };
const ACCENT = "#4c8dff";
const FETCH_CONCURRENCY = 8;
const MAX_THUMB_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;

export interface SheetCell {
  number: number;
  /** A still image on cdn.cosmos.so. */
  thumb?: string;
  /** The known width of the original, so the CDN is never asked to enlarge. */
  width?: number;
  /** History sheets: picked cells get a blue frame and a check, passed cells are dimmed. */
  state?: "picked" | "passed";
}

export interface Sheet {
  /** Base64 JPEG. */
  data: string;
  mimeType: "image/jpeg";
  width: number;
  height: number;
  /** The numbers whose thumbnail did not load. */
  missing: number[];
}

// ---- Thumbnails ----

const cache = new Map<string, Buffer>();
let cacheBytes = 0;

function cacheGet(key: string): Buffer | undefined {
  const value = cache.get(key);
  if (!value) return undefined;
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function cachePut(key: string, value: Buffer): void {
  cache.set(key, value);
  cacheBytes += value.length;
  for (const [oldKey, oldValue] of cache) {
    if (cacheBytes <= MAX_CACHE_BYTES) break;
    cache.delete(oldKey);
    cacheBytes -= oldValue.length;
  }
}

/** A thumbnail URL on the Cosmos CDN: WebP, at most `w` pixels wide. */
export function cdnThumb(url: string, w: number, knownWidth?: number): string {
  const resized = new URL(url);
  resized.search = "";
  resized.searchParams.set("format", "webp");
  resized.searchParams.set("w", String(knownWidth ? Math.min(knownWidth, w) : w));
  return resized.toString();
}

/** One cell image (contain, on the cell colour), or undefined when it does not load. */
async function cellImage(cell: SheetCell): Promise<Buffer | undefined> {
  if (!cell.thumb) return undefined;
  const url = cdnThumb(cell.thumb, CELL_W * 2, cell.width);
  const cached = cacheGet(url);
  if (cached) return cached;
  try {
    const response = await cosmosFetch(url, { headers: { accept: "image/*" } });
    if (!response.ok) return undefined;
    const input = Buffer.from(await response.arrayBuffer());
    if (input.length > MAX_THUMB_BYTES) return undefined;
    const output = await sharp(input, { limitInputPixels: 60_000_000, animated: false })
      .rotate()
      .resize({ width: CELL_W, height: CELL_H, fit: "contain", background: CELL_BACKGROUND })
      .flatten({ background: CELL_BACKGROUND })
      .png()
      .toBuffer();
    cachePut(url, output);
    return output;
  } catch {
    return undefined;
  }
}

export async function mapLimit<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await run(items[index]!);
      }
    }),
  );
  return results;
}

// ---- Digits ----

// Seven segments in a 10 x 16 box: a top, b top right, c bottom right, d bottom, e bottom left,
// f top left, g middle.
const SEGMENTS: Record<string, [number, number, number, number]> = {
  a: [1, 1, 9, 1],
  b: [9, 1, 9, 8],
  c: [9, 8, 9, 15],
  d: [1, 15, 9, 15],
  e: [1, 8, 1, 15],
  f: [1, 1, 1, 8],
  g: [1, 8, 9, 8],
};
const DIGITS = ["abcdef", "bc", "abged", "abgcd", "fgbc", "afgcd", "afgedc", "abc", "abcdefg", "abcdfg"];
const DIGIT_SCALE = 1.25;
const DIGIT_W = 10 * DIGIT_SCALE;
const DIGIT_H = 16 * DIGIT_SCALE;
const DIGIT_GAP = 5;

function numberPath(value: number, x: number, y: number): string {
  let path = "";
  [...String(value)].forEach((char, index) => {
    const ox = x + index * (DIGIT_W + DIGIT_GAP);
    for (const segment of DIGITS[Number(char)] ?? "") {
      const [x1, y1, x2, y2] = SEGMENTS[segment]!;
      path += `M${ox + x1 * DIGIT_SCALE} ${y + y1 * DIGIT_SCALE}L${ox + x2 * DIGIT_SCALE} ${y + y2 * DIGIT_SCALE}`;
    }
  });
  return path;
}

function badge(value: number, x: number, y: number, fill: string): string {
  const digits = String(value).length;
  const w = 12 + digits * DIGIT_W + (digits - 1) * DIGIT_GAP;
  const h = DIGIT_H + 12;
  return (
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${fill}"/>` +
    `<path d="${numberPath(value, x + 6, y + 6)}" stroke="#fff" stroke-width="2.6" stroke-linecap="round" fill="none"/>`
  );
}

// ---- Sheet ----

/** Renders up to PER_SHEET cells into one JPEG. */
export async function renderSheet(cells: SheetCell[]): Promise<Sheet> {
  const shown = cells.slice(0, PER_SHEET);
  const columns = Math.min(SHEET_COLUMNS, Math.max(1, shown.length));
  const rows = Math.max(1, Math.ceil(shown.length / SHEET_COLUMNS));
  const width = GAP + columns * (CELL_W + GAP);
  const height = GAP + rows * (CELL_H + GAP);
  const images = await mapLimit(shown, FETCH_CONCURRENCY, cellImage);

  const composites: OverlayOptions[] = [];
  let overlay = "";
  const missing: number[] = [];
  shown.forEach((cell, index) => {
    const left = GAP + (index % SHEET_COLUMNS) * (CELL_W + GAP);
    const top = GAP + Math.floor(index / SHEET_COLUMNS) * (CELL_H + GAP);
    const image = images[index];
    if (image) {
      composites.push({ input: image, left, top });
    } else {
      missing.push(cell.number);
      overlay += `<rect x="${left}" y="${top}" width="${CELL_W}" height="${CELL_H}" fill="#1c1c1f"/>`;
      const cx = left + CELL_W / 2;
      const cy = top + CELL_H / 2;
      overlay += `<path d="M${cx - 14} ${cy - 14}L${cx + 14} ${cy + 14}M${cx + 14} ${cy - 14}L${cx - 14} ${cy + 14}" stroke="#55555c" stroke-width="3" stroke-linecap="round"/>`;
    }
    if (cell.state === "passed") {
      overlay += `<rect x="${left}" y="${top}" width="${CELL_W}" height="${CELL_H}" fill="#000" fill-opacity="0.55"/>`;
    }
    if (cell.state === "picked") {
      overlay += `<rect x="${left + 2}" y="${top + 2}" width="${CELL_W - 4}" height="${CELL_H - 4}" rx="4" fill="none" stroke="${ACCENT}" stroke-width="4"/>`;
      const cx = left + CELL_W - 22;
      const cy = top + 22;
      overlay += `<circle cx="${cx}" cy="${cy}" r="13" fill="${ACCENT}"/>`;
      overlay += `<path d="M${cx - 6} ${cy}L${cx - 1.5} ${cy + 5}L${cx + 6.5} ${cy - 5}" stroke="#fff" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
    }
    overlay += badge(cell.number, left + 6, top + 6, cell.state === "picked" ? ACCENT : "rgba(0,0,0,0.78)");
  });
  composites.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${overlay}</svg>`), left: 0, top: 0 });

  const data = await sharp({ create: { width, height, channels: 3, background: BACKGROUND } })
    .composite(composites)
    .jpeg({ quality: 82 })
    .toBuffer();
  return { data: data.toString("base64"), mimeType: "image/jpeg", width, height, missing };
}
