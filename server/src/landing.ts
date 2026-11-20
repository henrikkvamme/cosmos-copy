// The landing page: GET / for a browser, and its files under /assets/landing/.
// It is the one public page: search engines may list it, so it sends no x-robots-tag.

import { readdirSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL("../pages/landing/", import.meta.url));
const TYPES: Record<string, string> = {
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  webp: "image/webp",
  jpg: "image/jpeg",
  png: "image/png",
  mp4: "video/mp4",
};
const HEADERS: Record<string, string> = {
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
  "cross-origin-opener-policy": "same-origin",
};

export class Landing {
  private readonly html = readFileSync(DIR + "index.html");
  /** The files of the page by name. They are read once and change only with a deploy. */
  private readonly files = new Map<string, { type: string; body: Buffer }>();

  constructor() {
    for (const name of readdirSync(DIR)) {
      const type = TYPES[name.split(".").pop() ?? ""];
      if (type) this.files.set(name, { type, body: readFileSync(DIR + name) });
    }
  }

  /** True when the client asks for a page. A script or curl gets the plain usage text. */
  static wantsHtml(req: IncomingMessage): boolean {
    // A client that names text/html with q=0 refuses a page.
    return (req.headers.accept ?? "").split(",").some((range) => {
      const [type, ...params] = range.split(";").map((part) => part.trim().toLowerCase());
      const q = params.find((param) => param.startsWith("q="));
      return type === "text/html" && (!q || Number(q.slice(2)) > 0);
    });
  }

  page(res: ServerResponse): void {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", vary: "accept", ...HEADERS }).end(this.html);
  }

  /** Handles a file of the page. Returns false when the path is not one. */
  handle(req: IncomingMessage, res: ServerResponse, path: string): boolean {
    const match = /^\/assets\/landing\/([a-z0-9-]+\.[a-z0-9]+)$/.exec(path);
    if (!match) return false;
    const file = this.files.get(match[1]!);
    if (!file || (req.method !== "GET" && req.method !== "HEAD")) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" }).end("Not found.\n");
      return true;
    }
    // Pictures and videos keep their name for good, so a browser may hold them for a day. The script and the style are checked each time.
    const media = file.type.startsWith("image/") || file.type.startsWith("video/");
    const headers = { "content-type": file.type, "cache-control": media ? "public, max-age=86400" : "no-cache", "accept-ranges": "bytes", ...HEADERS };
    const size = file.body.byteLength;
    // Safari plays a video only from a server that answers a byte range request.
    // A range applies to GET only (RFC 9110, 14.2).
    const range = req.method === "GET" ? /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "") : null;
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) {
        res.writeHead(416, { ...headers, "content-range": `bytes */${size}` }).end();
        return true;
      }
      const part = file.body.subarray(start, end + 1);
      res.writeHead(206, { ...headers, "content-length": part.byteLength, "content-range": `bytes ${start}-${end}/${size}` }).end(part);
      return true;
    }
    res.writeHead(200, { ...headers, "content-length": size }).end(req.method === "HEAD" ? undefined : file.body);
    return true;
  }
}
