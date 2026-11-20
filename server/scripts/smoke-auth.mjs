// Smoke test for sign-in. Run it after `npm run build`:  node scripts/smoke-auth.mjs
//
// It starts a fake Cosmos and the built server with AUTH_TEST_LOGIN=1 (sign-in with email and
// password, on loopback only) on a data directory in the old format (links.json version 1, pick
// data under the username). It checks the move to version 2, the OAuth flow of an MCP client, the
// link of a Cosmos account to a signed-in user, and what is deleted when.

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeToken, startFakeCosmos } from "./fake-cosmos.mjs";

const SERVER_DIR = fileURLToPath(new URL("..", import.meta.url));
const COSMOS_ID = "1711980257";
const REDIRECT = "http://127.0.0.1:9911/callback";

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

const secrets = [];
function secret(value) {
  secrets.push(value);
  return value;
}
const sha = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const exists = (path) => stat(path).then(() => true, () => false);

const fake = await startFakeCosmos();
const dataDir = await mkdtemp(join(tmpdir(), "cosmos-mcp-auth-"));
const port = 4400 + Math.floor(Math.random() * 500);
const base = `http://localhost:${port}`;
let child;
let output = "";

async function startServer() {
  child = spawn(process.execPath, ["dist/index.js"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      DATA_DIR: dataDir,
      PUBLIC_URL: base,
      AUTH_TEST_LOGIN: "1",
      BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
      COSMOS_GRAPHQL_URL: fake.url,
      TRUST_PROXY: "0",
      CONNECT_RATE_LIMIT: "200",
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

/** A browser of one person: it keeps the cookies. */
function browser() {
  let cookie = "";
  const keep = (lines) => {
    for (const line of lines) {
      const [pair] = line.split(";");
      const name = pair.split("=")[0];
      cookie = cookie.split("; ").filter((part) => part && !part.startsWith(`${name}=`)).concat(pair).join("; ");
    }
  };
  return {
    async post(path, body, headers = {}) {
      const res = await fetch(base + path, { method: "POST", redirect: "manual", headers: { "content-type": "application/json", origin: base, cookie, ...headers }, body: JSON.stringify(body) });
      keep(res.headers.getSetCookie());
      const text = await res.text();
      let json = {};
      try {
        json = JSON.parse(text);
      } catch {}
      return { status: res.status, json };
    },
    /** A page navigation. fetch cannot set Sec-Fetch-Mode, and the authorize endpoint redirects only for a navigation. */
    get(path) {
      return new Promise((resolve, reject) => {
        httpRequest(new URL(path, base), { headers: { cookie, accept: "text/html", "sec-fetch-mode": "navigate" } }, (res) => {
          keep(res.headers["set-cookie"] ?? []);
          let text = "";
          res.on("data", (chunk) => (text += chunk));
          res.on("end", () => {
            let json = {};
            try {
              json = JSON.parse(text);
            } catch {}
            resolve({ status: res.statusCode, location: res.headers.location ?? null, json, text });
          });
        })
          .on("error", reject)
          .end();
      });
    },
  };
}

async function rpc(token, body, path = "/mcp") {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = {};
  try {
    json = JSON.parse(text.startsWith("event:") || text.startsWith("data:") ? text.split("\n").find((line) => line.startsWith("data:")).slice(5) : text);
  } catch {}
  return { status: res.status, json, challenge: res.headers.get("www-authenticate") };
}
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } };
const callTool = (name, args = {}) => ({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });

/** Signs a new person up and takes an MCP client through the OAuth flow. */
async function signInClient(email) {
  const page = browser();
  const reg = await page.post("/api/auth/oauth2/register", { client_name: "Smoke client", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
  const clientId = reg.json.client_id;
  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    state: "s1",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    scope: "openid profile email offline_access",
    resource: `${base}/mcp`,
  });
  const authorize = await page.get(`/api/auth/oauth2/authorize?${query}`);
  const loginUrl = new URL(authorize.location ?? "/", base);
  const signUp = await page.post("/api/auth/sign-up/email", { email, password: secret(randomBytes(12).toString("base64url")), name: "Ada Test", oauth_query: loginUrl.search.slice(1) });
  const consentUrl = new URL(signUp.json.url ?? "/", base);
  const consent = await page.post("/api/auth/oauth2/consent", { accept: true, oauth_query: consentUrl.search.slice(1) });
  const callback = new URL(consent.json.url ?? "http://none");
  const code = secret(callback.searchParams.get("code") ?? "no-code");
  const tokenRes = await fetch(`${base}/api/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: `${base}/mcp` }),
  });
  const tokens = await tokenRes.json();
  if (tokens.access_token) secret(tokens.access_token);
  if (tokens.refresh_token) secret(tokens.refresh_token);
  return { page, clientId, loginPath: loginUrl.pathname, consentPath: consentUrl.pathname, callback, tokens, tokenStatus: tokenRes.status };
}

const readStore = async () => JSON.parse(await readFile(join(dataDir, "links.json"), "utf8"));
const historyFile = (owner) => join(dataDir, "history", `${owner}.json`);
const imageDir = (owner) => join(dataDir, "history-images", owner);

try {
  // The data of the server before sign-in existed: one account under its username.
  const keyA = secret(randomBytes(32).toString("base64url"));
  const cosmosToken = secret(makeToken("henrikkvamme", 2 * 86400, 1));
  const tokenExp = JSON.parse(Buffer.from(cosmosToken.split(".")[1], "base64url").toString("utf8")).exp;
  const oldHistory = JSON.stringify({ version: 1, entries: [{ task: "old task", at: "2026-11-01T10:00:00.000Z", picked: [{ id: "900001", thumb: "https://cdn.cosmos.so/x" }], passed: [] }] });
  await writeFile(
    join(dataDir, "links.json"),
    JSON.stringify({
      version: 1,
      accounts: { henrikkvamme: { username: "henrikkvamme", userId: COSMOS_ID, token: { token: cosmosToken, exp: tokenExp }, devices: [{ keyHash: sha(keyA), name: "Old browser", linkedAt: "2026-11-01T10:00:00.000Z", lastSeen: "2026-11-01T10:00:00.000Z" }] } },
    }),
    { mode: 0o600 },
  );
  await mkdir(join(dataDir, "history"), { recursive: true });
  await writeFile(historyFile("henrikkvamme"), oldHistory, { mode: 0o600 });
  await mkdir(imageDir("henrikkvamme"), { recursive: true });
  await writeFile(join(imageDir("henrikkvamme"), "old.jpg"), "image");

  await startServer();

  // Version 1 to version 2.
  {
    const stored = await readStore();
    const account = stored.accounts[COSMOS_ID];
    check("migration: links.json is version 2 and keyed by the Cosmos user id", stored.version === 2 && account?.username === "henrikkvamme" && !stored.accounts.henrikkvamme, Object.keys(stored.accounts));
    check("migration: the device and the token are kept, no user is linked", account?.devices.length === 1 && account.token?.exp === tokenExp && Array.isArray(account.users) && account.users.length === 0, account && { devices: account.devices.length, users: account.users });
    check("migration: links.json keeps mode 600", ((await stat(join(dataDir, "links.json"))).mode & 0o777) === 0o600);
    check("migration: the history file moved to the user id", (await exists(historyFile(COSMOS_ID))) && !(await exists(historyFile("henrikkvamme"))) && (await readFile(historyFile(COSMOS_ID), "utf8")) === oldHistory);
    check("migration: the history images moved to the user id", (await exists(join(imageDir(COSMOS_ID), "old.jpg"))) && !(await exists(imageDir("henrikkvamme"))));
    const keyPath = `/mcp/henrikkvamme?key=${encodeURIComponent(keyA)}`;
    check("migration: the old key URL still works", (await rpc(undefined, INIT, keyPath)).status === 200);
    const history = await rpc(undefined, callTool("contact_sheet", { source: "history" }), keyPath);
    check("migration: the key URL reads the moved history", JSON.stringify(history.json).includes("old task"), history.json);
  }

  // What an MCP client finds before sign-in.
  {
    const none = await rpc(undefined, INIT);
    check("/mcp with no token gives 401 and names the resource metadata", none.status === 401 && String(none.challenge).includes(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`), { status: none.status, challenge: none.challenge });
    const bad = await rpc("not-a-token", INIT);
    check("/mcp with a bad token gives 401", bad.status === 401, bad.status);
    const resource = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    check("resource metadata names the resource and the issuer", resource.resource === `${base}/mcp` && resource.authorization_servers?.[0] === `${base}/api/auth`, resource);
    const server = await (await fetch(`${base}/.well-known/oauth-authorization-server/api/auth`)).json();
    check(
      "server metadata: PKCE S256 and client id metadata documents",
      server.issuer === `${base}/api/auth` && server.code_challenge_methods_supported?.includes("S256") && server.client_id_metadata_document_supported === true,
      { issuer: server.issuer, pkce: server.code_challenge_methods_supported, cimd: server.client_id_metadata_document_supported },
    );
    check("/mcp GET gives 405", (await fetch(`${base}/mcp`)).status === 405);
  }

  // The pages.
  for (const path of ["/login", "/consent", "/account", "/connect", "/privacy"]) {
    const res = await fetch(base + path);
    const csp = res.headers.get("content-security-policy") ?? "";
    check(`page ${path}: 200 with a strict content security policy`, res.status === 200 && csp.includes("default-src 'none'") && csp.includes("frame-ancestors 'none'") && res.headers.get("cache-control") === "no-store", { status: res.status, csp });
  }

  // The OAuth flow of an MCP client, for a person with no linked Cosmos account.
  const ada = await signInClient(`ada-${Date.now()}@example.com`);
  {
    check("oauth: authorize sends the browser to /login, then to /consent", ada.loginPath === "/login" && ada.consentPath === "/consent", { login: ada.loginPath, consent: ada.consentPath });
    check("oauth: consent returns a code to the redirect URI with the issuer", ada.callback.origin + ada.callback.pathname === REDIRECT && ada.callback.searchParams.get("state") === "s1" && ada.callback.searchParams.get("iss") === `${base}/api/auth`, ada.callback.origin + ada.callback.pathname);
    check("oauth: the token endpoint gives an access token of 10 minutes and a refresh token", ada.tokenStatus === 200 && ada.tokens.expires_in === 600 && Boolean(ada.tokens.refresh_token), { status: ada.tokenStatus, expires: ada.tokens.expires_in });
    const init = await rpc(ada.tokens.access_token, INIT);
    check("not linked: initialize works and the instructions say what to do", init.status === 200 && String(init.json.result?.instructions).includes("Connect account"), init.json);
    const list = await rpc(ada.tokens.access_token, { jsonrpc: "2.0", id: 3, method: "tools/list" });
    check("not linked: the tool list is the full list", (list.json.result?.tools ?? []).some((tool) => tool.name === "note_references"), list.json);
    const call = await rpc(ada.tokens.access_token, callTool("list_collections"));
    check("not linked: a tool call returns the link guidance as an error", call.json.result?.isError === true && JSON.stringify(call.json).includes("Connect account"), call.json);
    const reused = await fetch(`${base}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: ada.callback.searchParams.get("code"), redirect_uri: REDIRECT, client_id: ada.clientId, code_verifier: "x".repeat(43), resource: `${base}/mcp` }),
    });
    check("oauth: a code cannot be used twice", reused.status >= 400, reused.status);
  }

  // Link the Cosmos account of the browser (device key A) to Ada.
  let ticket;
  {
    const state = async (key) => fetch(`${base}/connect/state`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceKey: key }) });
    check("connect state: an unknown device gives 404", (await state(randomBytes(32).toString("base64url"))).status === 404);
    check("connect state: not connected yet", (await (await state(keyA)).json()).connected === false);
    const start = async (key) => {
      const res = await fetch(`${base}/connect/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceKey: key }) });
      return { status: res.status, json: await res.json() };
    };
    check("connect start: an unknown device gives 404", (await start(randomBytes(32).toString("base64url"))).status === 404);
    const started = await start(keyA);
    ticket = secret(String(started.json.url).split("#")[1] ?? "");
    check("connect start: returns the connect URL with the ticket in the fragment", started.status === 200 && String(started.json.url).startsWith(`${base}/connect#`) && /^[A-Za-z0-9_-]{43}$/.test(ticket) && started.json.username === "henrikkvamme", started.status);

    const anonymous = await browser().post("/account/api/connect", { ticket });
    check("connect: no session gives 401", anonymous.status === 401, anonymous);
    const foreign = await ada.page.post("/account/api/connect", { ticket, confirm: true }, { origin: "https://evil.example" });
    check("connect: another origin gives 403", foreign.status === 403, foreign);
    const form = await fetch(`${base}/account/api/connect`, { method: "POST", headers: { "content-type": "text/plain", origin: base }, body: JSON.stringify({ ticket, confirm: true }) });
    check("connect: a body that is not JSON is refused", form.status === 400 || form.status === 401, form.status);
    const peek = await ada.page.post("/account/api/connect", { ticket });
    check("connect: the page sees the Cosmos username before it confirms", peek.status === 200 && peek.json.username === "henrikkvamme" && peek.json.current === null, peek);
    check("connect: a look does not link", (await readStore()).accounts[COSMOS_ID].users.length === 0);
    const confirmed = await ada.page.post("/account/api/connect", { ticket, confirm: true });
    check("connect: confirm links the account", confirmed.status === 200 && confirmed.json.username === "henrikkvamme", confirmed);
    const again = await ada.page.post("/account/api/connect", { ticket, confirm: true });
    check("connect: a ticket works once", again.status === 410, again);
    const stored = await readStore();
    check("connect: links.json has the user on the account", stored.accounts[COSMOS_ID].users.length === 1 && !JSON.stringify(stored).includes(ticket), stored.accounts[COSMOS_ID].users.length);
    check("connect state: connected", (await (await state(keyA)).json()).connected === true);

    const me = await ada.page.get("/account/api/me");
    check("account: shows the Cosmos account and the allowed client", me.json.cosmos?.username === "henrikkvamme" && me.json.clients?.length === 1 && me.json.clients[0].clientId === ada.clientId && me.json.mcpUrl === `${base}/mcp`, me.json);
    const collections = await rpc(ada.tokens.access_token, callTool("list_collections"));
    check("linked: the same access token now reads the vault", collections.json.result?.isError !== true && JSON.stringify(collections.json).includes("Agent references"), collections.json);
    const history = await rpc(ada.tokens.access_token, callTool("contact_sheet", { source: "history" }));
    check("linked: the sign-in reads the same history as the key URL", JSON.stringify(history.json).includes("old task"), history.json);
  }

  // A second person cannot take the account without a ticket, and sees nothing of it.
  const eve = await signInClient(`eve-${Date.now()}@example.com`);
  {
    const call = await rpc(eve.tokens.access_token, callTool("list_collections"));
    check("another person: not linked, no vault", call.json.result?.isError === true, call.json);
    const used = await eve.page.post("/account/api/connect", { ticket, confirm: true });
    check("another person: the used ticket gives nothing", used.status === 410, used);
    const revoke = await eve.page.post("/account/api/revoke", { clientId: ada.clientId });
    const me = await ada.page.get("/account/api/me");
    check("another person: cannot remove the client of someone else", revoke.status === 200 && me.json.clients?.length === 1, me.json.clients);
  }

  // A ticket ends when its device is removed. The account stays while a user is linked.
  {
    const res = await fetch(`${base}/connect/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceKey: keyA }) });
    const pending = secret(String((await res.json()).url).split("#")[1]);
    const unlinked = await fetch(`${base}/unlink`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceKey: keyA }) });
    check("device unlink: accepted", unlinked.status === 200, unlinked.status);
    const peek = await eve.page.post("/account/api/connect", { ticket: pending });
    check("device unlink: its open ticket is dead", peek.status === 410, peek);
    const stored = await readStore();
    check("device unlink: the account stays, because a user is linked", stored.accounts[COSMOS_ID]?.devices.length === 0 && stored.accounts[COSMOS_ID].users.length === 1, stored.accounts[COSMOS_ID]);
    check("device unlink: the history stays", await exists(historyFile(COSMOS_ID)));
    check("device unlink: the key URL is dead", (await rpc(undefined, INIT, `/mcp/henrikkvamme?key=${encodeURIComponent(keyA)}`)).status === 401);
  }

  // Remove a client.
  {
    const revoke = await ada.page.post("/account/api/revoke", { clientId: ada.clientId });
    const me = await ada.page.get("/account/api/me");
    check("revoke: the client is gone from the account", revoke.status === 200 && me.json.clients?.length === 0, me.json.clients);
    const refresh = await fetch(`${base}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: ada.tokens.refresh_token, client_id: ada.clientId, resource: `${base}/mcp` }),
    });
    check("revoke: the refresh token is dead", refresh.status >= 400, refresh.status);
  }

  // Delete the account of the last user: with no device left, all data of the Cosmos account goes.
  {
    const wrongOrigin = await ada.page.post("/account/api/unlink", {}, { origin: "https://evil.example" });
    check("unlink: another origin gives 403", wrongOrigin.status === 403, wrongOrigin);
    const deleted = await ada.page.post("/api/auth/delete-user", {});
    check("delete account: accepted", deleted.status === 200, deleted);
    let stored = await readStore();
    for (let attempt = 0; attempt < 30 && stored.accounts[COSMOS_ID]; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      stored = await readStore();
    }
    check("delete account: the Cosmos account with no device and no user is deleted, token included", !stored.accounts[COSMOS_ID] && !JSON.stringify(stored).includes(cosmosToken), Object.keys(stored.accounts));
    for (let attempt = 0; attempt < 30 && ((await exists(historyFile(COSMOS_ID))) || (await exists(imageDir(COSMOS_ID)))); attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
    check("delete account: the history and its images are deleted", !(await exists(historyFile(COSMOS_ID))) && !(await exists(imageDir(COSMOS_ID))));
    const me = await ada.page.get("/account/api/me");
    check("delete account: the session is over", me.json.user === null, me.json);
    const call = await rpc(ada.tokens.access_token, callTool("list_collections"));
    check("delete account: a token that is still valid gives 401", call.status === 401, { status: call.status, json: call.json });
  }

  // Logs.
  {
    await stopServer();
    const leaked = secrets.filter((value) => value && output.includes(value));
    check("server logs hold no token, code, ticket, password or device key", leaked.length === 0, `${leaked.length} secrets found in the log`);
    check("server logs hold no query string of the OAuth endpoints", !output.includes("code_challenge=") && !output.includes("?key="));
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
