// Writes every logo file from tasteref-mark.svg. Run from the repo root after a change to the mark:
//   node docs/brand/export.mjs   (needs npm ci in server/ for sharp)
import { copyFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const root = new URL("../../", import.meta.url);
const sharp = createRequire(new URL("server/package.json", root))("sharp");
const svg = readFileSync(new URL("docs/brand/tasteref-mark.svg", root));

const png = (size, file, source = svg) =>
  sharp(source, { density: (72 * size) / 16 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toFile(new URL(file, root).pathname);

for (const size of [16, 32, 48, 128]) await png(size, `extension/icon${size}.png`);
await png(32, "server/pages/favicon-32.png");
// iOS rounds the corners itself and fills transparent corners with black, so this one is square.
await png(180, "server/pages/apple-touch-icon.png", Buffer.from(svg.toString().replace(' rx="3.6"', "")));
await png(120, "docs/brand/google-consent-120.png");
copyFileSync(new URL("docs/brand/tasteref-mark.svg", root), new URL("server/pages/favicon.svg", root));
console.log("logo files written");
