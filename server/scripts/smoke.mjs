// Smoke test for the server. Run it after `npm run build`:  node scripts/smoke.mjs
//
// It starts a fake Cosmos (scripts/fake-cosmos.mjs) and the built server (dist/index.js) with
// COSMOS_GRAPHQL_URL pointing at the fake. Authenticated calls get mock data. Anonymous calls go
// through the fake to the real Cosmos API, so the public paths are tested against the real API.
// It also calls the real Cosmos API directly for the anonymous lookups.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeToken, startFakeCosmos } from "./fake-cosmos.mjs";

const SERVER_DIR = fileURLToPath(new URL("..", import.meta.url));
const HENRIK_ID = "1711980257";
const REAL_ELEMENT = "1754412159";

let failures = 0;
let passes = 0;
function check(name, condition, detail) {
  if (condition) {
    passes += 1;
    console.log(`ok   ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail !== undefined ? `\n     ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 800)}` : ""}`);
  }
}

const newKey = () => randomBytes(32).toString("base64url");
const secrets = [];
function secret(value) {
  secrets.push(value);
  return value;
}

// ---------------------------------------------------------------------------------------------
// Processes

const fake = await startFakeCosmos();
const dataDir = await mkdtemp(join(tmpdir(), "cosmos-mcp-smoke-"));
const port = 3900 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}`;
let child;
let output = "";

async function startServer() {
  child = spawn(process.execPath, ["dist/index.js"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      COSMOS_GRAPHQL_URL: fake.url,
      TRUST_PROXY: "0",
      KEY_FAILURE_LIMIT: "20",
      LINK_RATE_LIMIT: "60",
      PICK_WAIT_MS: "3000",
      ORPHAN_IMAGE_MS: "0",
      PAGE_GUESS_LIMIT: "30",
    },
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

// ---------------------------------------------------------------------------------------------
// Helpers

async function mcp(path) {
  const client = new Client({ name: "smoke", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + path)));
  return client;
}

function textOf(result) {
  return (result.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
}

async function call(client, name, args = {}) {
  return client.callTool({ name, arguments: args });
}

async function rawInitialize(path) {
  const response = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } },
    }),
  });
  await response.text();
  return response.status;
}

async function link(token, deviceKey, deviceName) {
  const response = await fetch(`${base}/link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, deviceKey, deviceName }),
  });
  return { status: response.status, body: await response.json() };
}

async function unlink(deviceKey) {
  const response = await fetch(`${base}/unlink`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceKey }),
  });
  return { status: response.status, body: await response.json() };
}

const vaultPath = (username, key) => `/mcp/${username}?key=${encodeURIComponent(key)}`;
const idsOf = (result) => (result.structuredContent?.references ?? []).map((r) => String(r.id));
const lastToken = () => [...fake.requests].reverse().find((r) => r.auth)?.tokenN;

async function readStore() {
  return JSON.parse(await readFile(join(dataDir, "links.json"), "utf8"));
}

/** The server writes some changes in the background: read the file until `ready` holds (2 s at most). */
async function readStoreWhen(ready) {
  let data;
  for (let attempt = 0; attempt < 40; attempt++) {
    data = await readStore();
    if (ready(data)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return data;
}

// ---------------------------------------------------------------------------------------------
// Tests

try {
  // Direct anonymous calls to the real Cosmos API.
  {
    const ask = (query, variables) =>
      fetch("https://api.cosmos.so/graphql", {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "cosmos-mcp/0.1" },
        body: JSON.stringify({ query, variables }),
      }).then((r) => r.json());
    const user = await ask(`query { user(username: "henrikkvamme") { id username } }`);
    check("real API: user(username) gives the user id", String(user.data?.user?.id) === HENRIK_ID, user);
    const search = await ask(
      `query($u: UserId) { searchElements(searchTerm: "motion", filters: { userId: $u }, meta: { pageSize: 5 }) { results { element { id } } meta { count } } }`,
      { u: Number(HENRIK_ID) },
    );
    check("real API: searchElements with filters.userId returns Henrik's elements", (search.data?.searchElements?.results?.length ?? 0) > 0, search);
    const save = await ask(
      `mutation CosmosMcpSaveReference($userId: UserId!, $elementIds: [ElementId!]!, $clusterIdsToConnect: [ClusterId!]!, $clusterIdsToDisconnect: [ClusterId!]!) { element { editElementsConnectionsToClusters(input: { userId: $userId, elementIds: $elementIds, clusterIdsToConnect: $clusterIdsToConnect, clusterIdsToDisconnect: $clusterIdsToDisconnect }) { success } } }`,
      { userId: Number(HENRIK_ID), elementIds: [1], clusterIdsToConnect: [1], clusterIdsToDisconnect: [] },
    );
    check(
      "real API: the save mutation text is valid (anonymous call fails only on login)",
      save.errors?.length === 1 && save.errors[0].extensions?.code === "AUTHENTICATION",
      save,
    );
    const clusters = await ask(
      `query { userClusters(userId: ${HENRIK_ID}, meta: { pageSize: 5 }) { items { id name slug description isPrivate numberOfElements owner { username } subClusters { items { id name slug description isPrivate numberOfElements owner { username } } } } meta { nextPageCursor count } } }`,
    );
    check(
      "real API: the userClusters query text is valid (anonymous call fails only on login)",
      clusters.errors?.length === 1 && clusters.errors[0].extensions?.code === "AUTHENTICATION",
      clusters,
    );
  }

  await startServer();
  check("GET /health", (await (await fetch(`${base}/health`)).text()) === "ok");

  // Anonymous route, as before. Real Cosmos through the fake.
  {
    const client = await mcp("/mcp/henrikkvamme/agent-references");
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    check("anonymous route: tools unchanged", JSON.stringify(tools) === JSON.stringify(["get_reference", "list_references", "search_references"]), tools);
    const listed = await call(client, "list_references", { limit: 5 });
    check("anonymous route: list_references returns 5", idsOf(listed).length === 5, textOf(listed));
    const searched = await call(client, "search_references", {});
    check("anonymous route: search_references with no query returns references", idsOf(searched).length > 0, textOf(searched));
    const got = await call(client, "get_reference", { id: REAL_ELEMENT });
    check("anonymous route: get_reference returns text and image", got.content.some((c) => c.type === "image") && !got.isError, textOf(got));
    await client.close();
    check("anonymous route: no request to Cosmos carried a token", fake.requests.every((r) => !r.auth), fake.requests.filter((r) => r.auth));
  }

  // Link checks.
  const keyA = secret(newKey());
  const keyB = secret(newKey());
  const keyOther = secret(newKey());
  const t1 = secret(makeToken("henrikkvamme", 2 * 86400, 1));
  const t2 = secret(makeToken("henrikkvamme", 3 * 86400, 2));
  const t3 = secret(makeToken("henrikkvamme", 4 * 86400, 3));
  const tOther = secret(makeToken("otheruser", 2 * 86400, 9));
  const badToken = secret(makeToken("henrikkvamme", 86400, 0, "wrongsig"));
  {
    const bad = await link(badToken, keyA, "Bad");
    check("link with a token Cosmos refuses gives 401", bad.status === 401, bad);
    const notJwt = await link(secret("this-is-not-a-jwt-token-at-all"), keyA, "Bad");
    check("link with a token that is not a JWT gives 400", notJwt.status === 400, notJwt);
    const expired = await link(secret(makeToken("henrikkvamme", -10, 0)), keyA, "Bad");
    check("link with an expired token gives 400", expired.status === 400, expired);
    const shortKey = await link(t1, "short", "Bad");
    check("link with a short device key gives 400", shortKey.status === 400, shortKey);
    check("refused links store nothing", (await readStore().catch(() => null)) === null);

    const first = await link(t1, keyA, "Brave on leela");
    check("device A links", first.status === 200 && first.body.deviceAdded && first.body.tokenUpdated && first.body.userId === HENRIK_ID, first);
    const mode = (await stat(join(dataDir, "links.json"))).mode & 0o777;
    check("links.json has mode 600", mode === 0o600, mode.toString(8));
    const stored = await readStore();
    const account = stored.accounts.henrikkvamme;
    check(
      "links.json stores a key hash, not the key",
      account.devices.length === 1 && /^[0-9a-f]{64}$/.test(account.devices[0].keyHash) && !JSON.stringify(stored).includes(keyA),
      account,
    );
  }

  // Vault auth.
  {
    check("vault with no key gives 401", (await rawInitialize("/mcp/henrikkvamme")) === 401);
    check("vault with a wrong key gives 401", (await rawInitialize(vaultPath("henrikkvamme", newKey()))) === 401);
    check("vault with device A key gives 200", (await rawInitialize(vaultPath("henrikkvamme", keyA))) === 200);
    check("vault GET gives 405", (await fetch(`${base}${vaultPath("henrikkvamme", keyA)}`)).status === 405);
  }

  // Two devices relay in turn.
  {
    const second = await link(t2, keyB, "Chrome on fry");
    check("device B links and its newer token replaces the stored one", second.status === 200 && second.body.deviceAdded && second.body.tokenUpdated, second);
    const relayOld = await link(t1, keyA, "Brave on leela");
    check("device A relays an older token: not stored", relayOld.status === 200 && !relayOld.body.deviceAdded && relayOld.body.tokenUpdated === false, relayOld);
    for (const [name, key] of [["A", keyA], ["B", keyB]]) {
      const client = await mcp(vaultPath("henrikkvamme", key));
      const result = await call(client, "list_collections");
      check(`device ${name} works after both relays, with the newer token`, !result.isError && lastToken() === 2, { text: textOf(result), token: lastToken() });
      await client.close();
    }
    const relayNew = await link(t3, keyA, "Brave on leela");
    check("device A relays a newer token: stored", relayNew.status === 200 && relayNew.body.tokenUpdated === true, relayNew);
    for (const [name, key] of [["A", keyA], ["B", keyB]]) {
      const client = await mcp(vaultPath("henrikkvamme", key));
      const result = await call(client, "list_collections");
      check(`device ${name} works with the newest token`, !result.isError && lastToken() === 3, { token: lastToken() });
      await client.close();
    }
    const stored = await readStore();
    check("links.json has two devices for henrikkvamme", stored.accounts.henrikkvamme.devices.length === 2, stored.accounts.henrikkvamme.devices.length);
  }

  // Another username.
  {
    const other = await link(tOther, keyOther, "Other browser");
    check("another user links", other.status === 200 && other.body.username === "otheruser", other);
    check("henrikkvamme vault with the other user's key gives 401", (await rawInitialize(vaultPath("henrikkvamme", keyOther))) === 401);
    check("otheruser vault with Henrik's key gives 401", (await rawInitialize(vaultPath("otheruser", keyA))) === 401);
    const client = await mcp(vaultPath("otheruser", keyOther));
    const result = await call(client, "list_collections");
    const names = (result.structuredContent?.collections ?? []).map((c) => c.name);
    check("otheruser vault sees only its own collections", JSON.stringify(names) === JSON.stringify(["Other stuff"]), names);
    await client.close();
  }

  // Vault tools.
  const vault = await mcp(vaultPath("henrikkvamme", keyA));
  {
    const tools = (await vault.listTools()).tools.map((t) => t.name).sort();
    check(
      "vault: tools",
      JSON.stringify(tools) ===
        JSON.stringify([
          "clear_pick_history",
          "contact_sheet",
          "get_reference",
          "list_collections",
          "list_references",
          "note_references",
          "note_result",
          "save_reference",
          "search_cosmos",
          "search_references",
          "show_variants",
          "start_picks",
          "wait_for_picks",
        ]),
      tools,
    );

    const before = fake.requests.length;
    const collections = await call(vault, "list_collections");
    const list = collections.structuredContent?.collections ?? [];
    const pages = fake.requests.slice(before).filter((r) => r.op === "CosmosMcpUserClusters").length;
    check("list_collections: all 4 collections, across 2 upstream pages", list.length === 4 && pages === 2, { names: list.map((c) => c.name), pages });
    const loaders = list.find((c) => c.slug === "loaders");
    check("list_collections: a subcollection has its parent in the URL", loaders?.url === "https://www.cosmos.so/henrikkvamme/motion-studies/loaders", loaders);
    check(
      "list_collections: private ones are marked",
      list.find((c) => c.slug === "motion-studies")?.isPrivate === true &&
        list.find((c) => c.slug === "agent-references")?.isPrivate === false &&
        textOf(collections).includes("Motion studies (private)"),
      textOf(collections),
    );

    // list_references: merged by save time, duplicate once, past the first upstream page.
    const expected = Array.from({ length: 14 }, (_, i) => String(900001 + i));
    const startAll = fake.requests.length;
    const all = await call(vault, "list_references", { limit: 50 });
    check("list_references: all collections merged by save time", JSON.stringify(idsOf(all)) === JSON.stringify(expected), idsOf(all));
    const agentPages = fake.requests.slice(startAll).filter((r) => r.op === "CosmosMcpClusterConnections" && String(r.variables.clusterId) === "1137778943").length;
    check("list_references: read past the first upstream page", agentPages >= 2, agentPages);
    const e5 = all.structuredContent.references.find((r) => r.id === "900005");
    check(
      "list_references: the duplicate shows once, with both collections",
      idsOf(all).filter((id) => id === "900005").length === 1 && e5?.collections.map((c) => c.slug).sort().join(",") === "agent-references,motion-studies",
      e5?.collections,
    );
    const paged = [];
    let cursor;
    let rounds = 0;
    do {
      const result = await call(vault, "list_references", { limit: 6, ...(cursor ? { cursor } : {}) });
      paged.push(...idsOf(result));
      cursor = result.structuredContent?.nextCursor ?? undefined;
      rounds += 1;
    } while (cursor && rounds < 10);
    check("list_references: pages of 6 give the same 14, no repeats", JSON.stringify(paged) === JSON.stringify(expected) && rounds === 3, { paged, rounds });
    const motion = await call(vault, "list_references", { collection: "Motion studies" });
    check(
      "list_references: one collection by name",
      JSON.stringify(idsOf(motion)) === JSON.stringify(["900002", "900004", "900006", "900008", "900010", "900012", "900005"]),
      idsOf(motion),
    );
    const unknown = await call(vault, "list_references", { collection: "nope" });
    check("list_references: an unknown collection gives an error", unknown.isError === true && textOf(unknown).includes("No collection matches"), textOf(unknown));

    // search_references.
    const startSearch = fake.requests.length;
    const motionSearch = await call(vault, "search_references", { query: "motion", limit: 50 });
    const searchCalls = fake.requests.slice(startSearch).filter((r) => r.op === "CosmosMcpSearchElements");
    check(
      "search_references: searchElements with filters.userId and the token",
      idsOf(motionSearch).length === 6 && searchCalls.every((r) => r.auth && String(r.variables.userId) === HENRIK_ID),
      { ids: idsOf(motionSearch), calls: searchCalls.length },
    );
    const firstPage = await call(vault, "search_references", { query: "motion", limit: 2 });
    const secondPage = await call(vault, "search_references", { query: "motion", limit: 2, cursor: firstPage.structuredContent.nextCursor });
    const thirdPage = await call(vault, "search_references", { query: "motion", limit: 2, cursor: secondPage.structuredContent.nextCursor });
    const pagedSearch = [...idsOf(firstPage), ...idsOf(secondPage), ...idsOf(thirdPage)];
    check("search_references: cursor pages without gaps or repeats", JSON.stringify(pagedSearch) === JSON.stringify(idsOf(motionSearch)), pagedSearch);
    const inAgent = await call(vault, "search_references", { query: "page poster cards", collection: "agent-references" });
    check("search_references: a collection keeps only its elements", JSON.stringify(idsOf(inAgent)) === JSON.stringify(["900003", "900007", "900013"]), idsOf(inAgent));
    const videos = await call(vault, "search_references", { query: "loader", kind: "video" });
    check("search_references: kind video", JSON.stringify(idsOf(videos)) === JSON.stringify(["900002"]), idsOf(videos));
    const empty = await call(vault, "search_references", { limit: 5 });
    check("search_references: an empty query lists the newest saves", JSON.stringify(idsOf(empty)) === JSON.stringify(expected.slice(0, 5)), idsOf(empty));

    // get_reference: public element, anonymous read of the real Cosmos.
    const startGet = fake.requests.length;
    const got = await call(vault, "get_reference", { id: `https://www.cosmos.so/e/${REAL_ELEMENT}` });
    check(
      "vault get_reference: image and metadata of a public element, read anonymously",
      !got.isError && got.content.some((c) => c.type === "image") && fake.requests.slice(startGet).every((r) => !r.auth),
      textOf(got),
    );

    // search_cosmos: real Cosmos, anonymous.
    const startCosmos = fake.requests.length;
    const cosmos = await call(vault, "search_cosmos", { query: "brutalist poster", limit: 5 });
    const cosmosCalls = fake.requests.slice(startCosmos);
    check(
      "search_cosmos: real results, anonymous, no userId filter",
      idsOf(cosmos).length === 5 && cosmosCalls.length > 0 && cosmosCalls.every((r) => !r.auth && r.variables.userId == null),
      textOf(cosmos).slice(0, 400),
    );
    const cosmosNext = await call(vault, "search_cosmos", { query: "brutalist poster", limit: 5, cursor: cosmos.structuredContent.nextCursor });
    check(
      "search_cosmos: the next page has other elements",
      idsOf(cosmosNext).length > 0 && idsOf(cosmosNext).every((id) => !idsOf(cosmos).includes(id)),
      [idsOf(cosmos), idsOf(cosmosNext)],
    );
    const cosmosVideo = await call(vault, "search_cosmos", { query: "liquid motion", kind: "video", limit: 3 });
    check("search_cosmos: kind video", idsOf(cosmosVideo).length > 0 && cosmosVideo.structuredContent.references.every((r) => r.kind === "video"), textOf(cosmosVideo).slice(0, 300));

    // save_reference.
    const saved = await call(vault, "save_reference", { id: "900003", collection: "Test saves" });
    check("save_reference: saves to a collection and returns its link", !saved.isError && textOf(saved).includes("https://www.cosmos.so/henrikkvamme/test-saves"), textOf(saved));
    const afterSave = await call(vault, "list_references", { collection: "test-saves" });
    check("save_reference: the element is in the test collection", JSON.stringify(idsOf(afterSave)) === JSON.stringify(["900003"]), idsOf(afterSave));
    const clusterCount = fake.state.clusters.length;
    const missing = await call(vault, "save_reference", { id: "900003", collection: "Brand new collection" });
    check(
      "save_reference: an unknown collection gives an error and makes no collection",
      missing.isError === true && fake.state.clusters.length === clusterCount && !fake.requests.slice(-3).some((r) => r.op === "CosmosMcpSaveReference" && r.variables.clusterIdsToConnect.length === 0),
      textOf(missing),
    );
  }

  // The design flow: contact sheets, a pick session, the canvas and the history.
  {
    const images = (result) => (result.content ?? []).filter((c) => c.type === "image");
    const page = (path, init = {}) => fetch(base + path, init);
    const json = (body) => ({ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const post = (body) => ({ ...json(body), method: "POST" });

    const instructions = vault.getInstructions() ?? "";
    check("design: the server instructions name the flow", instructions.includes("start_picks") && instructions.includes("wait_for_picks") && instructions.includes("Never ask Henrik"), instructions);

    const noHistory = await call(vault, "contact_sheet", { source: "history" });
    check("contact_sheet history: empty at first", !noHistory.isError && textOf(noHistory).includes("No pick history yet") && images(noHistory).length === 0, textOf(noHistory));

    const cosmosSheet = await call(vault, "contact_sheet", { source: "cosmos", query: "dark web dashboard", count: 6 });
    check(
      "contact_sheet cosmos: one JPEG sheet and 6 numbered lines",
      !cosmosSheet.isError && images(cosmosSheet).length === 1 && images(cosmosSheet)[0].mimeType === "image/jpeg" && /^6\. \[\d+\]/m.test(textOf(cosmosSheet)),
      textOf(cosmosSheet).slice(0, 600),
    );
    const sheetJpeg = Buffer.from(images(cosmosSheet)[0]?.data ?? "", "base64");
    check("contact_sheet cosmos: the image is a real JPEG", sheetJpeg[0] === 0xff && sheetJpeg[1] === 0xd8 && sheetJpeg.length > 5000, sheetJpeg.length);
    const nextSheet = await call(vault, "contact_sheet", { source: "cosmos", query: "dark web dashboard", count: 3, cursor: cosmosSheet.structuredContent?.nextCursor });
    check("contact_sheet cosmos: the next page goes on numbering at 7", !nextSheet.isError && /^7\. \[\d+\]/m.test(textOf(nextSheet)), textOf(nextSheet).slice(0, 400));
    const otherQuery = await call(vault, "contact_sheet", { source: "cosmos", query: "red poster", cursor: cosmosSheet.structuredContent?.nextCursor });
    check("contact_sheet cosmos: a cursor with another query gives an error", otherQuery.isError === true, textOf(otherQuery));
    const longQuery = ("暗色仪表板界面设计 dark trading dashboard ").repeat(12).slice(0, 300);
    const longSheet = await call(vault, "contact_sheet", { source: "cosmos", query: longQuery, count: 3 });
    const longCursor = longSheet.structuredContent?.nextCursor;
    if (longCursor) {
      const longNext = await call(vault, "contact_sheet", { source: "cosmos", query: longQuery, count: 3, cursor: longCursor });
      check("contact_sheet cosmos: a 300-character query gives a cursor that works", !longNext.isError && longCursor.length < 1000, `${longCursor.length} ${textOf(longNext).slice(0, 200)}`);
    } else {
      check("contact_sheet cosmos: a 300-character query gives a result", !longSheet.isError, textOf(longSheet).slice(0, 300));
    }
    const noQuery = await call(vault, "contact_sheet", { source: "cosmos" });
    check("contact_sheet cosmos: no query gives an error", noQuery.isError === true, textOf(noQuery));
    const vaultSheet = await call(vault, "contact_sheet", { source: "vault", count: 5 });
    check(
      "contact_sheet vault: newest saves as a sheet (fake images do not load and are named)",
      !vaultSheet.isError && images(vaultSheet).length === 1 && textOf(vaultSheet).includes("did not load") && /^5\. \[9000\d\d\]/m.test(textOf(vaultSheet)),
      textOf(vaultSheet).slice(0, 600),
    );
    const bigSheet = await call(vault, "contact_sheet", { source: "cosmos", query: "mobile onboarding", count: 40 });
    check("contact_sheet: 40 references give 2 sheets", !bigSheet.isError && images(bigSheet).length === 2, images(bigSheet).length);

    // A pick session.
    const candidates = ["2133684761", "320548184", "603155855", "not-an-id"];
    const started = await call(vault, "start_picks", { task: "Web dashboard for energy trading", candidates });
    const sessionId = started.structuredContent?.session;
    const link = started.structuredContent?.link ?? "";
    secret(sessionId);
    check(
      "start_picks: returns the picker link and skips a bad id",
      !started.isError && link.endsWith(`/p/${sessionId}`) && started.structuredContent.candidates === 3 && started.structuredContent.skipped.includes("not-an-id") && textOf(started).includes("Do not ask Henrik"),
      textOf(started),
    );
    const guessed = newKey().slice(0, 43);
    check("picker: a guessed session id gives 404", (await page(`/p/${guessed}`)).status === 404 && (await page(`/p/${guessed}/state`)).status === 404);
    const html = await page(`/p/${sessionId}`);
    check(
      "picker: the page has a strict CSP and no referrer",
      html.status === 200 && html.headers.get("referrer-policy") === "no-referrer" && (html.headers.get("content-security-policy") ?? "").includes("script-src 'self'") && (await html.text()).includes("/assets/picker.js"),
    );
    check("picker: the script is served", (await page("/assets/picker.js")).status === 200 && (await page("/assets/canvas.js")).status === 200 && (await page("/assets/pages.css")).status === 200);
    const before = await (await page(`/p/${sessionId}/state`)).json();
    check("picker: the state has 3 tiles and no picks", before.tiles.length === 3 && before.picked.length === 0 && before.status === "open", before);
    check("picker: a write without JSON content type gives 415", (await page(`/p/${sessionId}/state`, { method: "PUT", body: "{}" })).status === 415);

    const notYet = await call(vault, "wait_for_picks", { session: sessionId });
    check("wait_for_picks: not done yet after the wait, with the count so far", !notYet.isError && textOf(notYet).startsWith("Not done yet") && textOf(notYet).includes("has the picker open"), textOf(notYet));

    const waiting = call(vault, "wait_for_picks", { session: link });
    const [first, second, third] = before.tiles.map((t) => t.id);
    const saved = await (await page(`/p/${sessionId}/state`, json({ picked: [first, "999"], hidden: [third] }))).json();
    check("picker: a click saves the picks and drops unknown ids", JSON.stringify(saved.picked) === JSON.stringify([first]) && JSON.stringify(saved.hidden) === JSON.stringify([third]), saved);
    const more = await page(`/p/${sessionId}/more`, post({ picked: [first], hidden: [third] }));
    const moreBody = await more.json();
    check("picker: More like these adds up to 12 new tiles", more.status === 200 && moreBody.added.length > 0 && moreBody.added.length <= 12 && moreBody.tiles.length === 3 + moreBody.added.length && moreBody.rounds === 1, { status: more.status, added: moreBody.added?.length });
    const extra = moreBody.added?.[0];
    const doneAt = Date.now();
    const done = await (await page(`/p/${sessionId}/done`, post({ picked: [first, extra], hidden: [third] }))).json();
    check("picker: Done stores the picks", done.status === "done" && JSON.stringify(done.picked) === JSON.stringify([first, extra]), done);
    const picks = await waiting;
    check(
      "wait_for_picks: a waiting call returns the picks as images when Done is clicked",
      !picks.isError && images(picks).length === 2 && textOf(picks).includes(`Pick 1: [${first}]`) && textOf(picks).includes(`Pick 2: [${extra}]`) && Date.now() - doneAt < 3000,
      textOf(picks).slice(0, 400),
    );
    check(
      "wait_for_picks: the result carries the plan, build and show steps",
      textOf(picks).includes("Propose at most 3 variants") && textOf(picks).includes("three rounds") && textOf(picks).includes("show_variants"),
      textOf(picks).slice(-900),
    );
    const again = await call(vault, "wait_for_picks", { session: sessionId });
    check("wait_for_picks: a later call returns the same picks at once", !again.isError && JSON.stringify(again.structuredContent?.picks?.map((p) => p.id)) === JSON.stringify([first, extra]));
    check("picker: a write after Done gives 409", (await page(`/p/${sessionId}/state`, json({ picked: [] }))).status === 409);
    const unknown = await call(vault, "wait_for_picks", { session: guessed });
    check("wait_for_picks: an unknown session gives an error", unknown.isError === true, textOf(unknown));
    {
      const otherClient = await mcp(vaultPath("otheruser", keyOther));
      const foreign = await call(otherClient, "wait_for_picks", { session: sessionId });
      check("wait_for_picks: another user cannot read the session", foreign.isError === true, textOf(foreign));
      await otherClient.close();
    }

    // The history.
    const history = await call(vault, "contact_sheet", { source: "history" });
    check(
      "contact_sheet history: one task, picked and passed",
      !history.isError && images(history).length === 1 && textOf(history).includes('Task "Web dashboard for energy trading"') && textOf(history).includes("picked 1-2"),
      textOf(history).slice(0, 500),
    );
    const historyFile = JSON.parse(await readFile(join(dataDir, "history", "henrikkvamme.json"), "utf8"));
    const entry = historyFile.entries[0];
    check(
      "history: picked ids, passed ids without the hidden tile, time",
      JSON.stringify(entry.picked.map((i) => i.id)) === JSON.stringify([first, extra]) && entry.passed.some((i) => i.id === second) && !entry.passed.some((i) => i.id === third) && Boolean(entry.at),
      entry,
    );
    check("history: the file has mode 600", ((await stat(join(dataDir, "history", "henrikkvamme.json"))).mode & 0o777) === 0o600);

    // A no-pick Done.
    const empty = await call(vault, "start_picks", { task: "Landing page", candidates: [REAL_ELEMENT] });
    secret(empty.structuredContent?.session);
    await page(`/p/${empty.structuredContent?.session}/done`, post({ picked: [] }));
    const none = await call(vault, "wait_for_picks", { session: empty.structuredContent?.session });
    check("wait_for_picks: Done without picks says nothing fits", !none.isError && textOf(none).includes("without picks") && textOf(none).includes("start_picks"), textOf(none));

    // The canvas.
    const shown = await call(vault, "show_variants", {
      task: "Web dashboard for energy trading",
      variants: [
        { name: "Close match of pick 1", takes: [{ id: first }] },
        { name: "Layout of pick 1, colours of pick 2", takes: [{ id: first, what: "layout" }, { id: extra, what: "colours" }] },
      ],
    });
    const canvasLink = shown.structuredContent?.link ?? "";
    const uploads = shown.structuredContent?.uploads ?? [];
    const boardId = canvasLink.split("/v/")[1];
    secret(boardId);
    for (const upload of uploads) secret(upload.url.split("/u/")[1]?.split("/")[0]);
    check("show_variants: a canvas link and 2 upload commands", !shown.isError && /\/v\/[A-Za-z0-9_-]{43}$/.test(canvasLink) && uploads.length === 2 && textOf(shown).includes("curl -sS --fail -T"), textOf(shown));
    const uploadPath = new URL(uploads[0]?.url ?? base).pathname;
    const sharp = (await import("sharp")).default;
    const png = await sharp({ create: { width: 1440, height: 900, channels: 3, background: "#203040" } }).png().toBuffer();
    const put = await page(uploadPath, { method: "PUT", body: png });
    check("upload: a PNG is stored", put.status === 200 && (await put.text()).includes("1440 x 900"), put.status);
    check("upload: garbage gives 400", (await page(uploadPath, { method: "PUT", body: Buffer.from("not an image") })).status === 400);
    const huge = await sharp({ create: { width: 8000, height: 8000, channels: 3, background: "#fff" } }).png().toBuffer();
    check("upload: an image over 50 megapixels gives 413 before decoding", (await page(uploadPath, { method: "PUT", body: huge })).status === 413, huge.length);
    check("upload: a guessed upload id gives 404", (await page(`/u/${newKey().slice(0, 43)}/1`, { method: "PUT", body: png })).status === 404);
    check("upload: the view id cannot upload", (await page(`/u/${boardId}/1`, { method: "PUT", body: png })).status === 404);
    check("upload: variant 3 of 2 gives 404", (await page(uploadPath.replace(/\/1$/, "/3"), { method: "PUT", body: png })).status === 404);
    const board = await (await page(`/v/${boardId}/state`)).json();
    check(
      "canvas: the state has the variants, their picks and the first screenshot",
      board.variants.length === 2 && board.variants[0].image?.w === 1440 && board.variants[1].image === null && board.variants[1].takes.map((t) => t.what).join() === "layout,colours",
      board,
    );
    const img = await page(`/v/${boardId}/img/1`);
    check("canvas: the screenshot is served as WebP", img.status === 200 && img.headers.get("content-type") === "image/webp");
    check("canvas: a missing screenshot gives 404", (await page(`/v/${boardId}/img/2`)).status === 404);
    check("canvas: the page is served", (await page(`/v/${boardId}`)).status === 200);
    check("canvas: a guessed board id gives 404", (await page(`/v/${newKey().slice(0, 43)}/state`)).status === 404);
    const picksFile = await readFile(join(dataDir, "picks.json"), "utf8");
    check("picks.json holds no session or board id, only hashes", !picksFile.includes(sessionId) && !picksFile.includes(boardId));

    // The style record.
    const historyPath = join(dataDir, "history", "henrikkvamme.json");
    const resultDir = join(dataDir, "history-images", "henrikkvamme");
    const resultFiles = () => readdir(resultDir).catch(() => []);
    const noShot = await call(vault, "note_result", { canvas: canvasLink, variant: 2, project: "zug-web", deviations: "None." });
    check("note_result: a variant without a screenshot is refused", noShot.isError === true && textOf(noShot).includes("no screenshot"), textOf(noShot));
    const noWhat = await call(vault, "note_result", { canvas: canvasLink, variant: 1, project: "zug-web", deviations: "None." });
    check("note_result: a reference without a note is refused", noWhat.isError === true && textOf(noWhat).includes(first) && textOf(noWhat).includes("took"), textOf(noWhat));
    const wrongRef = await call(vault, "note_result", { canvas: canvasLink, variant: 1, project: "zug-web", deviations: "None.", took: [{ id: extra, what: "colours" }] });
    check("note_result: a note for a reference the variant does not take is refused", wrongRef.isError === true && textOf(wrongRef).includes("does not take"), textOf(wrongRef));
    const badCanvas = await call(vault, "note_result", { canvas: `${base}/v/${newKey().slice(0, 43)}`, variant: 1, project: "zug-web", deviations: "None." });
    check("note_result: an unknown canvas is refused", badCanvas.isError === true && textOf(badCanvas).includes("No canvas"), textOf(badCanvas));
    check("note_result: nothing was records so far", (await resultFiles()).length === 0);
    const entriesBefore = JSON.parse(await readFile(historyPath, "utf8")).entries.length;
    const recorded = await call(vault, "note_result", { canvas: canvasLink, variant: 1, project: "zug-web", deviations: "Less dense than the reference.", took: [{ id: first, what: "layout and colours" }] });
    check("note_result: records the accepted variant", !recorded.isError && recorded.structuredContent?.replaced === false && recorded.structuredContent?.project === "zug-web", textOf(recorded));
    let records = JSON.parse(await readFile(historyPath, "utf8")).entries;
    const withResult = () => records.filter((e) => e.result);
    check(
      "note_result: the record is on the entry of the task, with its own copy of the reference",
      records.length === entriesBefore && withResult().length === 1 && withResult()[0].project === "zug-web" && withResult()[0].result.took[0].what === "layout and colours" &&
        withResult()[0].result.took[0].thumb.startsWith("https://") && (await resultFiles()).join() === withResult()[0].result.file && !JSON.stringify(records).includes(boardId),
      records,
    );
    const recordedAgain = await call(vault, "note_result", { canvas: canvasLink, variant: 1, project: "zug-web", deviations: "Less dense, and the sidebar is gone.", took: [{ id: first, what: "layout" }] });
    records = JSON.parse(await readFile(historyPath, "utf8")).entries;
    check(
      "note_result: the same canvas replaces its record, and the old image is deleted",
      !recordedAgain.isError && recordedAgain.structuredContent?.replaced === true && withResult().length === 1 && withResult()[0].result.took[0].what === "layout" && (await resultFiles()).join() === withResult()[0].result.file,
      textOf(recordedAgain),
    );
    // Another project with the same task name, and a screenshot of a long page.
    const shownTwo = await call(vault, "show_variants", { task: "web dashboard for energy trading", variants: [{ name: "Dark", takes: [{ id: extra, what: "colours" }] }] });
    const uploadTwo = new URL(shownTwo.structuredContent?.uploads?.[0]?.url ?? base);
    secret(uploadTwo.pathname.split("/")[2]);
    secret((shownTwo.structuredContent?.link ?? "").split("/v/")[1]);
    const long = await sharp({ create: { width: 2000, height: 8000, channels: 3, background: "#808080", noise: { type: "gaussian", mean: 128, sigma: 60 } } }).jpeg({ quality: 50 }).toBuffer();
    const putLong = await page(uploadTwo.pathname, { method: "PUT", body: long });
    const otherProject = await call(vault, "note_result", { canvas: shownTwo.structuredContent?.link, variant: 1, project: "Other App", deviations: "Darker." });
    records = JSON.parse(await readFile(historyPath, "utf8")).entries;
    check(
      "note_result: another canvas with the same task name gets its own entry",
      putLong.status === 200 && !otherProject.isError && otherProject.structuredContent?.replaced === false && withResult().length === 2 && records.length === entriesBefore + 1 &&
        withResult().map((e) => e.project).sort().join() === "Other App,zug-web" && (await resultFiles()).length === 2,
      textOf(otherProject),
    );
    const longRecord = records.find((e) => e.project === "Other App")?.result;
    const longFile = longRecord ? await readFile(join(resultDir, longRecord.file)) : Buffer.alloc(0);
    check("note_result: a long screenshot is cut and stays small", longRecord?.image.w === 1280 && longRecord?.image.h === 2000 && longFile.length * 1.34 < 1_200_000, { image: longRecord?.image, bytes: longFile.length });
    const rejectedLater = await call(vault, "note_references", { task: "web dashboard for energy trading", rejected: [extra] });
    records = JSON.parse(await readFile(historyPath, "utf8")).entries;
    check("note_result: a later rejection does not change the record", !rejectedLater.isError && records.find((e) => e.project === "Other App")?.result.took[0].id === extra);
    const style = await call(vault, "contact_sheet", { source: "history", project: "ZUG-web" });
    check(
      "contact_sheet history: a project gives its record with the final screenshot",
      !style.isError && style.structuredContent?.tasks?.length === 1 && style.structuredContent.tasks[0].result?.deviations.includes("sidebar") && images(style).length === 2 &&
        textOf(style).includes(`took from [${first}]: layout`) && textOf(style).includes("deviations: Less dense") && !textOf(style).includes("Other App"),
      textOf(style),
    );
    const allStyles = await call(vault, "contact_sheet", { source: "history" });
    check("contact_sheet history: the full history names the projects", textOf(allStyles).includes("Projects with a style record") && allStyles.structuredContent?.projects?.length === 2, textOf(allStyles));
    const noProject = await call(vault, "contact_sheet", { source: "history", project: "nope" });
    check("contact_sheet history: an unknown project names the known ones", !noProject.isError && textOf(noProject).includes('No task has the project "nope"') && textOf(noProject).includes("zug-web"), textOf(noProject));
    check("design: the server instructions name note_result", instructions.includes("note_result") && instructions.includes("style of an earlier project"), instructions);

    // Clearing the history.
    const cleared = await call(vault, "clear_pick_history", { task: "web dashboard for energy trading" });
    check("clear_pick_history: deletes the entries of one task", !cleared.isError && cleared.structuredContent?.removed === 2, textOf(cleared));
    check("clear_pick_history: the result images of the task are deleted", (await resultFiles()).length === 0, await resultFiles());
    const clearedAll = await call(vault, "clear_pick_history", {});
    check("clear_pick_history: deletes the rest", !clearedAll.isError && clearedAll.structuredContent?.removed === 1, textOf(clearedAll));
    const afterClear = await call(vault, "contact_sheet", { source: "history" });
    check("contact_sheet history: empty after clearing", textOf(afterClear).includes("No pick history yet"), textOf(afterClear));

    // Pasted references with an id strip, and a rejection.
    check("design: the server instructions name the id strip", instructions.includes("note_references") && instructions.includes("check digits"), instructions);
    const label = (id) => `${id}-${String(98n - ((BigInt(id) * 100n) % 97n)).padStart(2, "0")}`;
    check("id strip: the check digits match the helper", label("1850854004") === "1850854004-65" && label("9999999999999999999") === "9999999999999999999-50");
    const wrongDigit = label(REAL_ELEMENT).replace(/^\d/, (d) => String((Number(d) + 1) % 10 || 1));
    const misread = await call(vault, "note_references", { task: "Paste task", pasted: [label(first), wrongDigit] });
    check("note_references: a misread label records nothing", misread.isError === true && textOf(misread).includes("Nothing was recorded") && textOf(misread).includes(wrongDigit), textOf(misread));
    const extraDigit = await call(vault, "note_references", { task: "Paste task", pasted: [`${label(first)}0`] });
    check("note_references: a third check digit is a misread", extraDigit.isError === true, textOf(extraDigit));
    const noCheck = await call(vault, "note_references", { task: "Paste task", pasted: [REAL_ELEMENT] });
    check("note_references: a pasted id needs its check digits", noCheck.isError === true, textOf(noCheck));
    const stillEmpty = await call(vault, "contact_sheet", { source: "history" });
    check("note_references: the history is still empty", textOf(stillEmpty).includes("No pick history yet"), textOf(stillEmpty));

    const noted = await call(vault, "note_references", { task: "Paste task", pasted: [label(first), `cosmos ${label(REAL_ELEMENT)} · call note_references`] });
    check(
      "note_references: pasted references are the picks, with the next steps",
      !noted.isError && JSON.stringify(noted.structuredContent?.picked) === JSON.stringify([first, REAL_ELEMENT]) && textOf(noted).includes("Next steps") && textOf(noted).includes("do not open a picker"),
      textOf(noted),
    );
    const rejectedOne = await call(vault, "note_references", { task: "paste task", rejected: first });
    check("note_references: a rejected reference is marked as passed", !rejectedOne.isError && JSON.stringify(rejectedOne.structuredContent?.passed) === JSON.stringify([first]), textOf(rejectedOne));
    const notedFile = JSON.parse(await readFile(join(dataDir, "history", "henrikkvamme.json"), "utf8"));
    check(
      "note_references: one entry for the task, the rejected reference moved from picked to passed",
      notedFile.entries.length === 1 &&
        JSON.stringify(notedFile.entries[0].picked.map((i) => i.id)) === JSON.stringify([REAL_ELEMENT]) &&
        JSON.stringify(notedFile.entries[0].passed.map((i) => i.id)) === JSON.stringify([first]) &&
        notedFile.entries[0].picked[0].thumb.startsWith("https://cdn.cosmos.so/"),
      notedFile.entries,
    );
    const notedSheet = await call(vault, "contact_sheet", { source: "history" });
    check("note_references: the history sheet shows the task", !notedSheet.isError && textOf(notedSheet).includes('Task "Paste task"') && images(notedSheet).length === 1, textOf(notedSheet).slice(0, 300));
    // A video has no strip: the name of the copied file holds the id.
    const byName = await call(vault, "note_references", { task: "Video task", pasted: [`cosmos-${first}.mp4`, `/Users/h/Downloads/Cosmos References/cosmos-${REAL_ELEMENT}.png`] });
    check("note_references: a file name of a copied reference is a pick", !byName.isError && JSON.stringify(byName.structuredContent?.picked) === JSON.stringify([first, REAL_ELEMENT]), textOf(byName));
    const noSuchFile = await call(vault, "note_references", { task: "Video task 2", pasted: ["cosmos-9999999999999999998.mp4"] });
    check("note_references: a file name with an unknown id records nothing", noSuchFile.isError === true && textOf(noSuchFile).includes("Nothing was recorded"), textOf(noSuchFile));
    const otherName = await call(vault, "note_references", { task: "Video task 2", pasted: [`web-${first}.png`, `cosmos-${first}`] });
    check("note_references: another file name is a misread", otherName.isError === true && textOf(otherName).includes("Nothing was recorded"), textOf(otherName));
    const notAnId = await call(vault, "note_references", { task: "Other task", rejected: ["not an id"] });
    check("note_references: a value that is not an id records nothing", notAnId.isError === true, textOf(notAnId));
    await call(vault, "clear_pick_history", {});
  }

  // A token Cosmos no longer accepts.
  {
    fake.state.revoked.add(t3);
    const refused = await call(vault, "list_collections");
    check("refused token: tool error with the renew hint", refused.isError === true && textOf(refused).includes("Visit cosmos.so in Brave to renew the link."), textOf(refused));
    const stored = await readStoreWhen((data) => !data.accounts.henrikkvamme?.token);
    check("refused token: deleted from links.json, devices kept", !stored.accounts.henrikkvamme.token && stored.accounts.henrikkvamme.devices.length === 2, stored.accounts.henrikkvamme);
    const again = await call(vault, "search_references", { query: "motion" });
    check("missing token: tool error with the renew hint", again.isError === true && textOf(again).includes("Visit cosmos.so in Brave to renew the link."), textOf(again));
    const cosmos = await call(vault, "search_cosmos", { query: "red poster", limit: 2 });
    check("missing token: search_cosmos still works", !cosmos.isError && idsOf(cosmos).length === 2, textOf(cosmos).slice(0, 200));
    const relinked = await link(secret(makeToken("henrikkvamme", 5 * 86400, 4)), keyB, "Chrome on fry");
    check("a new relay after a refused token links again", relinked.status === 200 && relinked.body.tokenUpdated, relinked);
    const works = await call(vault, "list_collections");
    check("the vault works again after the relay", !works.isError && lastToken() === 4, textOf(works).slice(0, 200));
  }
  await vault.close();

  // Expired token on read, after a restart with a stored file.
  {
    await stopServer();
    const stored = await readStore();
    stored.accounts.henrikkvamme.token.exp = Math.floor(Date.now() / 1000) - 5;
    await writeFile(join(dataDir, "links.json"), JSON.stringify(stored), { mode: 0o600 });
    await startServer();
    const client = await mcp(vaultPath("henrikkvamme", keyA));
    const result = await call(client, "list_references");
    check("expired token: tool error with the renew hint", result.isError === true && textOf(result).includes("Visit cosmos.so in Brave to renew the link."), textOf(result));
    await client.close();
    const after = await readStoreWhen((data) => !data.accounts.henrikkvamme?.token);
    check("expired token: deleted on read, devices kept", !after.accounts.henrikkvamme.token && after.accounts.henrikkvamme.devices.length === 2, after.accounts.henrikkvamme);
  }

  // Unlink.
  {
    const removeB = await unlink(keyB);
    check("unlink device B", removeB.status === 200 && removeB.body.removed === true, removeB);
    check("device B key gives 401 after unlink", (await rawInitialize(vaultPath("henrikkvamme", keyB))) === 401);
    check("device A key still works", (await rawInitialize(vaultPath("henrikkvamme", keyA))) === 200);
    const removeA = await unlink(keyA);
    check("unlink the last device", removeA.status === 200 && removeA.body.removed === true, removeA);
    const stored = await readStore();
    check("no devices left: the account and its token are deleted", !stored.accounts.henrikkvamme && Boolean(stored.accounts.otheruser), Object.keys(stored.accounts));
    const again = await unlink(keyA);
    check("unlink an unknown key: removed false", again.status === 200 && again.body.removed === false, again);
    const files = await readdir(dataDir);
    check("no temporary files left in DATA_DIR", files.every((f) => !f.endsWith(".tmp")), files);
  }

  // Rate limit of wrong keys.
  {
    let status = 0;
    for (let i = 0; i < 25 && status !== 429; i++) status = await rawInitialize(vaultPath("henrikkvamme", newKey()));
    check("many wrong keys from one IP give 429", status === 429, status);
  }

  // Rate limit of guessed page ids (after all other page checks: it blocks this IP).
  {
    let status = 0;
    for (let i = 0; i < 40 && status !== 429; i++) status = (await fetch(`${base}/p/${newKey().slice(0, 43)}/state`)).status;
    check("many guessed page ids from one IP give 429", status === 429, status);
  }

  // Two history writes at the same time, after the history is loaded (the old code lost one).
  {
    const { PickStore } = await import(join(SERVER_DIR, "dist/picks.js"));
    const dir = await mkdtemp(join(tmpdir(), "cosmos-mcp-history-"));
    const store = new PickStore(dir);
    const entry = (task) => ({ task, at: new Date().toISOString(), picked: [{ id: "1", thumb: "https://cdn.cosmos.so/x" }], passed: [] });
    await store.history("racer");
    await Promise.all([store.addHistory("racer", entry("task A")), store.addHistory("racer", entry("task B"))]);
    const onDisk = JSON.parse(await readFile(join(dir, "history", "racer.json"), "utf8"));
    check("history: two Done at the same time keep both tasks", onDisk.entries.length === 2, onDisk.entries.map((e) => e.task));
    // A paste at the limit of picks per task: the new one is stored, the oldest goes.
    const item = (n) => ({ id: String(n), thumb: "https://cdn.cosmos.so/x" });
    for (let n = 0; n < 100; n += 20) await store.noteReferences("racer", "full task", Array.from({ length: 20 }, (_, k) => item(1000 + n + k)), []);
    await store.noteReferences("racer", "Full Task", [item(2000)], [item(1001)]);
    const full = (await store.history("racer")).find((e) => e.task === "full task");
    check(
      "note: at 100 picks a new paste is stored, and a rejected pick moves to passed",
      full?.picked.length === 100 && full.picked.at(-1).id === "2000" && !full.picked.some((p) => p.id === "1001") && full.passed[0]?.id === "1001",
      full && { picked: full.picked.length, last: full.picked.at(-1), passed: full.passed },
    );
    await store.noteReferences("racer", "full task", [item(2001), item(2002)], []);
    const over = (await store.history("racer")).find((e) => e.task === "full task");
    check("note: over the limit the oldest picks go", over?.picked.length === 100 && over.picked[0].id === "1003" && over.picked.at(-1).id === "2002", over && { first: over.picked[0], n: over.picked.length });
    await rm(dir, { recursive: true, force: true });
  }

  // Logs.
  {
    await stopServer();
    const leaked = secrets.filter((value) => output.includes(value));
    check("server logs hold no token and no device key", leaked.length === 0, `${leaked.length} secrets found in the log`);
    check("server logs hold no query string of a vault request", !output.includes("?key="));
    check("server logs show page paths with :id", output.includes('"path":"/p/:id/state"') && output.includes('"path":"/u/:id/1"'));
    check("anonymous route never sent a token (whole run)", fake.requests.filter((r) => r.op === "CosmosMcpCollection").every((r) => !r.auth));
    check("every Cosmos request sent the cosmos-mcp user agent", fake.requests.every((r) => String(r.userAgent).startsWith("cosmos-mcp/0.1")));
  }
} catch (error) {
  failures += 1;
  console.log(`FAIL unexpected error: ${error instanceof Error ? error.stack : error}`);
} finally {
  await stopServer();
  await fake.close();
  await rm(dataDir, { recursive: true, force: true });
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) {
  console.log("\nServer log:\n" + output);
  process.exitCode = 1;
}
