// Smoke test for the own vault (references from other sites). Run it after `npm run build`:
//   node scripts/smoke-vault.mjs
// It starts a fake Cosmos and the built server, like smoke.mjs. The video checks need ffmpeg.

import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import sharp from "sharp";
import { makeToken, startFakeCosmos } from "./fake-cosmos.mjs";

const SERVER_DIR = fileURLToPath(new URL("..", import.meta.url));
const OWNER = "1711980257";
const run = promisify(execFile);

let failures = 0;
let passes = 0;
function check(name, condition, detail) {
  if (condition) {
    passes += 1;
    console.log(`ok   ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail !== undefined ? `\n     ${typeof detail === "string" ? detail.slice(0, 800) : JSON.stringify(detail).slice(0, 800)}` : ""}`);
  }
}

const fake = await startFakeCosmos();
const dataDir = await mkdtemp(join(tmpdir(), "tasteref-vault-"));
const port = 4400 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}`;
let child;
let output = "";

async function startServer(env = {}) {
  child = spawn(process.execPath, ["dist/index.js"], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, COSMOS_GRAPHQL_URL: fake.url, TRUST_PROXY: "0", KEY_FAILURE_LIMIT: "50", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not start:\n${output}`);
}

async function stopServer() {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await exited;
}

async function mcp(path) {
  const client = new Client({ name: "smoke", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + path)));
  return client;
}
const textOf = (result) => (result.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
const imagesOf = (result) => (result.content ?? []).filter((c) => c.type === "image");
const call = (client, name, args = {}) => client.callTool({ name, arguments: args });
const idsOf = (result) => (result.structuredContent?.references ?? []).map((r) => String(r.id));
const newId = () => `t${String(BigInt(`0x${randomBytes(8).toString("hex")}`) % 10n ** 15n).padStart(15, "0")}`;
const checkDigits = (id) => String(98n - ((BigInt(id.slice(1)) * 100n) % 97n)).padStart(2, "0");
const meta = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

async function upload(key, value, body, { username = "henrikkvamme", headers = {} } = {}) {
  const response = await fetch(`${base}/vault/upload`, {
    method: "POST",
    headers: { "x-device-key": key, "x-username": username, "x-meta": typeof value === "string" ? value : meta(value), "content-type": "application/octet-stream", ...headers },
    body,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

const picture = (r, g, b, width = 900, height = 600) => sharp({ create: { width, height, channels: 3, background: { r, g, b } } });

try {
  await startServer();
  const key = randomBytes(32).toString("base64url");
  const token = makeToken("henrikkvamme", 2 * 86400, 1);
  const linked = await fetch(`${base}/link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, deviceKey: key, deviceName: "Smoke" }) });
  check("link works", linked.status === 200);
  const vaultPath = `/mcp/henrikkvamme?key=${encodeURIComponent(key)}`;

  const red = await picture(200, 30, 30).png().toBuffer();
  const blue = await picture(20, 40, 200, 2400, 1200).jpeg().toBuffer();
  const idRed = newId();
  const idBlue = newId();
  const idRedAgain = newId();

  // ---- Upload: who may, and what ----
  {
    const noKey = await upload("", { id: idRed, kind: "image" }, red);
    check("upload without key gives 401", noKey.status === 401, noKey);
    const wrongKey = await upload(randomBytes(32).toString("base64url"), { id: idRed, kind: "image" }, red);
    check("upload with a wrong key gives 401", wrongKey.status === 401, wrongKey);
    const wrongUser = await upload(key, { id: idRed, kind: "image" }, red, { username: "otheruser" });
    check("upload with another username gives 401", wrongUser.status === 401, wrongUser);
    const badId = await upload(key, { id: "../../etc/passwd", kind: "image" }, red);
    check("upload with a bad id gives 400", badId.status === 400, badId);
    const numericId = await upload(key, { id: "1754412159", kind: "image" }, red);
    check("upload with a Cosmos id gives 400", numericId.status === 400, numericId);
    const badMeta = await upload(key, "not-json", red);
    check("upload with bad meta gives 400", badMeta.status === 400, badMeta);
    const notImage = await upload(key, { id: newId(), kind: "image" }, Buffer.from("<html><script>alert(1)</script></html>"));
    check("upload of HTML as an image gives 415", notImage.status === 415, notImage);
    const svg = await upload(key, { id: newId(), kind: "image" }, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>'));
    check("upload of SVG gives 415", svg.status === 415, svg);
    const notVideo = await upload(key, { id: newId(), kind: "video" }, red);
    check("upload of an image as a video gives 415", notVideo.status === 415, notVideo);
    const empty = await upload(key, { id: newId(), kind: "image" }, Buffer.alloc(0));
    check("upload of an empty file gives 400", empty.status === 400, empty);
    const get = await fetch(`${base}/vault/upload`);
    check("GET on the upload route gives 405", get.status === 405);

    const first = await upload(key, { id: idRed, kind: "image", pageUrl: "https://dribbble.com/shots/1-red-landing", pageTitle: "Red landing page", alt: "hero section", sourceUrl: "javascript:alert(1)" }, red);
    check("upload of a PNG works", first.status === 200 && first.body.id === idRed && first.body.existed === false, first);
    const again = await upload(key, { id: idRedAgain, kind: "image", pageUrl: "https://example.com/" }, red);
    check("the same bytes again return the first item", again.status === 200 && again.body.id === idRed && again.body.existed === true, again);
    const aliasClash = await upload(key, { id: idRedAgain, kind: "image" }, blue);
    check("the id of a repeated copy is used too", aliasClash.status === 409, aliasClash);
    const clash = await upload(key, { id: idRed, kind: "image" }, blue);
    check("another file with a used id gives 409", clash.status === 409, clash);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await upload(key, { id: idBlue, kind: "image", pageUrl: "https://www.awwwards.com/sites/blue", pageTitle: "Blue dashboard" }, blue);
    check("upload of a JPEG works", second.status === 200 && second.body.id === idBlue, second);
    // The server answers 413 and closes the connection. A client that still sends sees a broken connection.
    const tooLarge = await upload(key, { id: newId(), kind: "image" }, Buffer.alloc(26 * 1024 * 1024, 1)).catch(() => ({ status: 413 }));
    check("an image over 25 MB is refused", tooLarge.status === 413, tooLarge);
  }

  // ---- Files on disk ----
  const items = JSON.parse(await readFile(join(dataDir, "vault", OWNER, "items.json"), "utf8")).items;
  const redItem = items.find((item) => item.id === idRed);
  const blueItem = items.find((item) => item.id === idBlue);
  {
    check("the list holds 2 items, newest first", items.length === 2 && items[0].id === idBlue, items.map((i) => i.id));
    check("the item keeps the page facts", redItem.site === "dribbble.com" && redItem.pageTitle === "Red landing page" && redItem.alt === "hero section" && redItem.mime === "image/png" && redItem.width === 900);
    check("a javascript: source URL is dropped", redItem.sourceUrl === undefined, redItem.sourceUrl);
    const media = await readdir(join(dataDir, "vault", OWNER, "media"));
    const thumbs = await readdir(join(dataDir, "vault", OWNER, "thumb"));
    check("2 media files and 4 still images", media.length === 2 && thumbs.length === 4, { media, thumbs });
    const temp = await readdir(join(dataDir, "vault", ".tmp")).catch(() => []);
    check("no temporary upload files stay", temp.length === 0, temp);
  }

  // ---- Links to the files ----
  {
    const thumb = await fetch(`${base}/vault/t/${OWNER}/${blueItem.fileKey}.jpg`);
    const bytes = Buffer.from(await thumb.arrayBuffer());
    const info = await sharp(bytes).metadata();
    check("the still image link works, long edge 1568", thumb.status === 200 && thumb.headers.get("content-type") === "image/jpeg" && info.width === 1568, info);
    check("file responses forbid sniffing and scripts", thumb.headers.get("x-content-type-options") === "nosniff" && /sandbox/.test(thumb.headers.get("content-security-policy") ?? ""));
    const small = await fetch(`${base}/vault/t/${OWNER}/${blueItem.fileKey}.jpg?format=webp&w=560`);
    const smallInfo = await sharp(Buffer.from(await small.arrayBuffer())).metadata();
    check("a small width gives the small still image", small.status === 200 && smallInfo.width === 640, smallInfo);
    const file = await fetch(`${base}/vault/f/${OWNER}/${redItem.fileKey}`);
    check("the file link returns the same bytes", file.status === 200 && Buffer.from(await file.arrayBuffer()).equals(red) && file.headers.get("content-type") === "image/png");
    const range = await fetch(`${base}/vault/f/${OWNER}/${redItem.fileKey}`, { headers: { range: "bytes=0-9" } });
    check("a byte range works", range.status === 206 && (await range.arrayBuffer()).byteLength === 10 && range.headers.get("content-range") === `bytes 0-9/${red.length}`);
    const badRange = await fetch(`${base}/vault/f/${OWNER}/${redItem.fileKey}`, { headers: { range: `bytes=${red.length + 5}-` } });
    check("a range past the end gives 416", badRange.status === 416);
    const wrongKey = await fetch(`${base}/vault/f/${OWNER}/${randomBytes(32).toString("base64url")}`);
    check("a wrong file key gives 404", wrongKey.status === 404);
    const wrongOwner = await fetch(`${base}/vault/f/999/${redItem.fileKey}`);
    check("the key with another owner gives 404", wrongOwner.status === 404);
    const traversal = await fetch(`${base}/vault/f/..%2F..%2Flinks.json/${redItem.fileKey}`);
    check("a path in the owner part gives 404", traversal.status === 404);
    const post = await fetch(`${base}/vault/f/${OWNER}/${redItem.fileKey}`, { method: "POST" });
    check("POST on a file link gives 405", post.status === 405);
  }

  // ---- Tools ----
  const client = await mcp(vaultPath);
  {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    check("the vault has the describe_references tool", tools.includes("describe_references"), tools);
    const listed = await call(client, "list_references", { limit: 50 });
    const ids = idsOf(listed);
    check("list_references holds both own items and the Cosmos saves", ids.includes(idRed) && ids.includes(idBlue) && ids.some((id) => /^\d+$/.test(id)), ids);
    check("own items are the newest, in save order", ids[0] === idBlue && ids[1] === idRed, ids.slice(0, 3));
    check("the list asks for descriptions", /2 references from other sites need a description/.test(textOf(listed)), textOf(listed).slice(-300));
    const paged = await call(client, "list_references", { limit: 1 });
    const next = await call(client, "list_references", { limit: 2, cursor: paged.structuredContent.nextCursor });
    check("paging over the merged list has no gap and no repeat", idsOf(paged)[0] === idBlue && idsOf(next)[0] === idRed && /^\d+$/.test(idsOf(next)[1]), [idsOf(paged), idsOf(next)]);

    const got = await call(client, "get_reference", { id: idBlue });
    check("get_reference shows an own item with its image", !got.isError && imagesOf(got).length === 1 && /awwwards\.com/.test(textOf(got)) && /has no description/.test(textOf(got)), textOf(got));
    const byPrefix = await call(client, "get_reference", { id: `tasteref-${idRed}` });
    check("get_reference accepts the tasteref- form", !byPrefix.isError && byPrefix.structuredContent.id === idRed, textOf(byPrefix));
    const byAlias = await call(client, "get_reference", { id: idRedAgain });
    check("the id of a repeated copy resolves to the first item", !byAlias.isError && byAlias.structuredContent.id === idRed, textOf(byAlias));
    const aliasLabel = await call(client, "note_references", { task: "smoke alias", pasted: [`tasteref ${idRedAgain}-${checkDigits(idRedAgain)} · call note_references`] });
    check("note_references accepts the label of a repeated copy", !aliasLabel.isError, textOf(aliasLabel));
    const unknown = await call(client, "get_reference", { id: newId() });
    check("get_reference of an unknown own id is an error", unknown.isError === true, textOf(unknown));

    const before = await call(client, "search_references", { query: "crimson hero" });
    check("search does not find an item that has no matching words", !idsOf(before).includes(idRed), idsOf(before));
    const byTitle = await call(client, "search_references", { query: "blue dashboard" });
    check("search finds an own item by its page title", idsOf(byTitle)[0] === idBlue, idsOf(byTitle));

    const start = await call(client, "describe_references", {});
    check("describe_references shows the 2 open items as images", imagesOf(start).length === 2 && start.structuredContent.left === 2 && start.structuredContent.shown.includes(idRed), textOf(start));
    const stored = await call(client, "describe_references", {
      descriptions: [
        { id: idRed, description: "A crimson hero section with a large serif headline and one button.", tags: ["Crimson", "hero", "serif", "landing page"] },
        { id: newId(), description: "This one does not exist in the vault." },
        { id: "1754412159", description: "A Cosmos id is not an own reference." },
      ],
    });
    check("describe_references stores one and names the unknown ones", stored.structuredContent.stored.length === 1 && stored.structuredContent.unknown.length === 2 && stored.structuredContent.left === 1, textOf(stored));
    const after = await call(client, "search_references", { query: "crimson hero" });
    check("search finds the item by its new description, first", idsOf(after)[0] === idRed, idsOf(after));
    const byTag = await call(client, "search_references", { query: "serif" });
    check("search finds the item by a tag", idsOf(byTag).includes(idRed), idsOf(byTag));
    const videosOnly = await call(client, "search_references", { query: "crimson hero", kind: "video" });
    check("the kind filter holds for own items", !idsOf(videosOnly).includes(idRed), idsOf(videosOnly));
    const described = await call(client, "get_reference", { id: idRed });
    check("get_reference shows the description", /crimson hero section/.test(textOf(described)) && !/has no description/.test(textOf(described)), textOf(described));

    const sheet = await call(client, "contact_sheet", { source: "vault", count: 12 });
    const sheetIds = (sheet.structuredContent?.references ?? []).map((r) => String(r.id));
    check("the contact sheet of the vault holds own items", !sheet.isError && sheetIds.includes(idRed) && sheetIds.includes(idBlue) && imagesOf(sheet).length >= 1, textOf(sheet).slice(0, 400));
    check("the contact sheet draws the still images of own items", !/The image of (1|2)[, ]/.test(textOf(sheet)), textOf(sheet).match(/.*did not load.*/)?.[0]);
    const sheetQuery = await call(client, "contact_sheet", { source: "vault", query: "crimson hero" });
    check("a contact sheet with a query finds own items", !sheetQuery.isError && (sheetQuery.structuredContent?.references ?? []).some((r) => String(r.id) === idRed), textOf(sheetQuery).slice(0, 400));

    const label = `tasteref ${idRed}-${checkDigits(idRed)} · call note_references`;
    const noted = await call(client, "note_references", { task: "smoke landing page", pasted: [label] });
    check("note_references accepts the label of an own item", !noted.isError, textOf(noted));
    const badLabel = await call(client, "note_references", { task: "smoke landing page", pasted: [`tasteref ${idRed}-${checkDigits(idRed) === "11" ? "12" : "11"}`] });
    check("note_references refuses wrong check digits", badLabel.isError === true || /check digits|read wrongly|not recorded/i.test(textOf(badLabel)), textOf(badLabel));

    const picks = await call(client, "start_picks", { task: "smoke picks", candidates: [idRed, idBlue] });
    const link = /https?:\/\/\S+\/p\/[A-Za-z0-9_-]{43}/.exec(textOf(picks))?.[0];
    check("start_picks takes own items as candidates", !picks.isError && Boolean(link), textOf(picks).slice(0, 300));
    if (link) {
      const state = await fetch(`${link.replace(/\/p\//, "/p/api/")}`).catch(() => undefined);
      const page = await fetch(link);
      check("the picker page opens", page.status === 200, state?.status);
    }
  }

  // ---- Video ----
  {
    const video = join(dataDir, "clip.mp4");
    let made = true;
    try {
      await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=640x360:rate=24", "-pix_fmt", "yuv420p", video]);
    } catch {
      made = false;
      console.log("skip video checks: ffmpeg is not installed");
    }
    if (made) {
      const bytes = await readFile(video);
      const idVideo = newId();
      const saved = await upload(key, { id: idVideo, kind: "video", pageUrl: "https://x.com/someone/status/1", pageTitle: "Motion test" }, bytes);
      check("upload of an MP4 works", saved.status === 200 && saved.body.id === idVideo, saved);
      const item = JSON.parse(await readFile(join(dataDir, "vault", OWNER, "items.json"), "utf8")).items.find((i) => i.id === idVideo);
      check("the video has a size and the type from its bytes", item?.mime === "video/mp4" && item.width === 640 && item.height === 360, item);
      const poster = await fetch(`${base}/vault/t/${OWNER}/${item.fileKey}.jpg`);
      check("the video has a still image", poster.status === 200 && (await sharp(Buffer.from(await poster.arrayBuffer())).metadata()).width === 640);
      const part = await fetch(`${base}/vault/f/${OWNER}/${item.fileKey}`, { headers: { range: "bytes=100-" } });
      check("the video answers an open byte range", part.status === 206 && part.headers.get("content-type") === "video/mp4" && (await part.arrayBuffer()).byteLength === bytes.length - 100);
      const got = await call(client, "get_reference", { id: idVideo });
      check("get_reference shows the video with its frame", !got.isError && imagesOf(got).length === 1 && /This reference is a video/.test(textOf(got)), textOf(got));
      const onlyVideos = await call(client, "search_references", { kind: "video" });
      check("the kind filter with no query holds own videos", idsOf(onlyVideos).includes(idVideo), idsOf(onlyVideos));
      const broken = await upload(key, { id: newId(), kind: "video" }, Buffer.concat([bytes.subarray(0, 12), Buffer.alloc(2000, 7)]));
      check("a broken video gives 415", broken.status === 415, broken);
      await rm(video, { force: true });
    }
  }
  await client.close();

  // ---- A restart keeps the vault ----
  {
    await stopServer();
    await startServer();
    const again = await mcp(vaultPath);
    const listed = await call(again, "list_references", { limit: 50 });
    check("the vault is there after a restart", idsOf(listed).includes(idRed) && idsOf(listed).includes(idBlue), idsOf(listed));
    const described = await call(again, "search_references", { query: "crimson hero" });
    check("the description is there after a restart", idsOf(described)[0] === idRed, idsOf(described));
    await again.close();
  }

  // ---- No Cosmos token: the own items still answer ----
  {
    fake.state.revoked.add(token);
    const offline = await mcp(vaultPath);
    await call(offline, "list_collections", {}); // Cosmos refuses the token, and the server drops it.
    const listed = await call(offline, "list_references", { limit: 50 });
    check("with no Cosmos token, list_references gives the own items and a notice", !listed.isError && idsOf(listed).includes(idRed) && idsOf(listed).every((id) => /^t\d{15}$/.test(id)) && /Cosmos references are not in this result/.test(textOf(listed)), textOf(listed).slice(-400));
    const found = await call(offline, "search_references", { query: "crimson hero" });
    check("with no Cosmos token, search gives the own items", !found.isError && idsOf(found)[0] === idRed, textOf(found));
    const got = await call(offline, "get_reference", { id: idRed });
    check("with no Cosmos token, get_reference of an own item works", !got.isError && imagesOf(got).length === 1, textOf(got));
    const noted = await call(offline, "note_references", { task: "smoke offline", pasted: [`tasteref ${idBlue}-${checkDigits(idBlue)}`] });
    check("with no Cosmos token, note_references takes a new own label", !noted.isError && !/not recorded|could not/i.test(textOf(noted)), textOf(noted));
    const offlineSheet = await call(offline, "contact_sheet", { source: "vault" });
    check("with no Cosmos token, the contact sheet gives the own items and the renew hint", !offlineSheet.isError && (offlineSheet.structuredContent?.references ?? []).some((r) => String(r.id) === idRed) && /renew/i.test(textOf(offlineSheet)), textOf(offlineSheet).slice(0, 400));
    const inCollection = await call(offline, "list_references", { collection: "Agent references" });
    check("with no Cosmos token, a collection gives the renew hint", inCollection.isError === true && /renew/i.test(textOf(inCollection)), textOf(inCollection));
    await offline.close();
  }

  // ---- The last unlink deletes the vault ----
  {
    const response = await fetch(`${base}/unlink`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceKey: key }) });
    check("unlink works", response.status === 200);
    let gone = false;
    for (let attempt = 0; attempt < 40 && !gone; attempt++) {
      gone = !(await readdir(join(dataDir, "vault", OWNER)).catch(() => undefined));
      if (!gone) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    check("the vault of the account is deleted with its last browser", gone);
    const file = await fetch(`${base}/vault/f/${OWNER}/${redItem.fileKey}`);
    check("the file link is dead after the delete", file.status === 404);
  }

  check("the server log holds no device key", !output.includes(key));
  check("the server log holds no file key", !output.includes(redItem.fileKey) && !output.includes(blueItem.fileKey) && /\/vault\/f\/:key/.test(output));
} catch (error) {
  failures += 1;
  console.log(`FAIL the test stopped: ${error?.stack ?? error}`);
  console.log(output.slice(-2000));
} finally {
  await stopServer();
  await fake.close?.();
  await rm(dataDir, { recursive: true, force: true });
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
