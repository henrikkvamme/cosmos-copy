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
        JSON.stringify(["get_reference", "list_collections", "list_references", "save_reference", "search_cosmos", "search_references"]),
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

  // Logs.
  {
    await stopServer();
    const leaked = secrets.filter((value) => output.includes(value));
    check("server logs hold no token and no device key", leaked.length === 0, `${leaked.length} secrets found in the log`);
    check("server logs hold no query string of a vault request", !output.includes("?key="));
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
