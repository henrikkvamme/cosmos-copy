// HTTP entry point. Stateless MCP over Streamable HTTP: each POST gets a new server and transport.
//
//   POST /mcp/:username/:slug   MCP endpoint for the public Cosmos collection cosmos.so/<username>/<slug>.
//                               Anonymous. It never uses a linked token.
//   POST /mcp/:username?key=…   The vault: all collections of a linked account. Needs a device key.
//   POST /mcp                   The vault of the signed-in user (OAuth, see auth.ts). No secret in the URL.
//   /api/auth/*, /.well-known/* Sign-in with Google and OAuth for MCP clients (auth.ts).
//   /login, /account, …         The pages of a signed-in person (account.ts).
//   POST /link                  {token, deviceKey, deviceName}: link a device and relay the Cosmos token.
//   POST /unlink                {deviceKey}: remove a device.
//   /p/<id>, /v/<id>, /u/<id>   Picker page, variants canvas and screenshot upload (see pages.ts).
//   GET  /health                "ok"
//   GET  /                      usage
//
// Never log a token, a device key, a page id or the body of /link and /unlink.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AccountPages } from "./account.js";
import { createAuth, type Auth } from "./auth.js";
import { CosmosError, getCollection, JWT_PATTERN, SLUG_PATTERN, USERNAME_PATTERN, type Collection } from "./cosmos.js";
import { buildInstructions, buildServer } from "./mcp.js";
import { Pages } from "./pages.js";
import { PickStore } from "./picks.js";
import { clientIp, RateLimiter } from "./ratelimit.js";
import { isExpired, jwtExpiry, LinkStore, TooManyDevicesError } from "./store.js";
import { buildVaultServer, fetchMe } from "./vault.js";

const PORT = Number(process.env.PORT ?? 3000);
const MAX_BODY_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const INSTRUCTIONS_WAIT_MS = 2_500;
const MAX_LINK_BODY_BYTES = 16 * 1024;
const DATA_DIR = process.env.DATA_DIR || "/data";
/** Optional: a comma-separated list of the Cosmos usernames that may link. Empty allows all. */
const ALLOWED_USERS = new Set(
  (process.env.LINK_ALLOWED_USERS ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean),
);
const DEVICE_KEY_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

const store = new LinkStore(DATA_DIR);
const picks = new PickStore(DATA_DIR);
/** The public origin for the links in tool results. Without it, the request's host is used. */
const PUBLIC_URL = (process.env.PUBLIC_URL ?? "").replace(/\/+$/, "");
/** /link and /unlink calls per IP. */
const linkLimiter = new RateLimiter(Number(process.env.LINK_RATE_LIMIT ?? 30), 15 * 60_000);
/** Vault requests with a missing or wrong key, per IP. Over the limit, the IP gets 429. */
const keyFailureLimiter = new RateLimiter(Number(process.env.KEY_FAILURE_LIMIT ?? 20), 15 * 60_000);

/** MCP requests of one signed-in user. */
const userLimiter = new RateLimiter(Number(process.env.USER_RATE_LIMIT ?? 600), 15 * 60_000);
/** /connect/start and the connect endpoint, per IP. */
const connectLimiter = new RateLimiter(Number(process.env.CONNECT_RATE_LIMIT ?? 30), 15 * 60_000);

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
/**
 * Tests only: sign-in with email and password. It needs a loopback PUBLIC_URL and a process that is
 * not in production mode, and the server then listens on the loopback interface only.
 */
const TEST_LOGIN = process.env.AUTH_TEST_LOGIN === "1";
if (TEST_LOGIN && (process.env.NODE_ENV === "production" || !PUBLIC_URL || !LOOPBACK_HOSTS.has(new URL(PUBLIC_URL).hostname))) {
  throw new Error("AUTH_TEST_LOGIN needs a loopback PUBLIC_URL and a process that is not in production mode.");
}

const NOT_LINKED =
  "The user is signed in, but no Cosmos account is linked to this sign-in yet, so the tools cannot work. " +
  "Tell the user: install the TasteRef browser extension, sign in on cosmos.so, open the extension and click " +
  '"Connect account". Then call the tool again. No restart is needed.';

let auth: Auth | undefined;
let accountPages: AccountPages | undefined;

const USAGE = `cosmos-mcp: a read-only MCP server for public Cosmos (cosmos.so) collections.

MCP endpoint (Streamable HTTP, stateless, no login):
  POST /mcp/<username>/<slug>     for the collection https://www.cosmos.so/<username>/<slug>
  Tools: search_references, list_references, get_reference.

Vault of a linked account (needs the device key from the browser extension):
  POST /mcp/<username>?key=<deviceKey>
  Tools: list_collections, list_references, search_references, get_reference, search_cosmos, save_reference,
  contact_sheet, start_picks, wait_for_picks, show_variants, note_references, note_result, clear_pick_history.

Vault of a signed-in user (sign in with Google, then link Cosmos from the extension):
  POST /mcp
  Account page: GET /account

Add it to Claude Code:
  claude mcp add --transport http cosmos https://<this-host>/mcp/<username>/<slug>

Health: GET /health
`;

function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), ...fields }));
}

const pages = new Pages(picks, log);

/** The origin of this server as the client sees it, for links in tool results. */
function baseUrl(req: IncomingMessage): string {
  if (PUBLIC_URL) return PUBLIC_URL;
  const forwarded = process.env.TRUST_PROXY !== "0" ? String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim() : "";
  const proto = forwarded === "https" || forwarded === "http" ? forwarded : "http";
  const host = /^[A-Za-z0-9.-]+(:\d+)?$/.test(req.headers.host ?? "") ? req.headers.host : `localhost:${PORT}`;
  return `${proto}://${host}`;
}

function sendText(res: ServerResponse, status: number, text: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...headers }).end(text);
}

function sendRpcError(res: ServerResponse, status: number, code: number, message: string, headers: Record<string, string> = {}): void {
  res
    .writeHead(status, { "content-type": "application/json", ...headers })
    .end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

function sendJson(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers }).end(JSON.stringify(value));
}

async function readJson(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).byteLength;
    if (total > maxBytes) throw new Error("too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function rpcMethods(body: unknown): string[] {
  const messages = Array.isArray(body) ? body : [body];
  return messages.map((message) => {
    const { method, params } = (message ?? {}) as { method?: unknown; params?: { name?: unknown } };
    if (typeof method !== "string") return "response";
    return method === "tools/call" && typeof params?.name === "string" ? `tools/call:${params.name}` : method;
  });
}

async function readRpcBody(req: IncomingMessage, res: ServerResponse): Promise<{ body: unknown } | undefined> {
  try {
    return { body: await readJson(req) };
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === "too large";
    sendRpcError(res, tooLarge ? 413 : 400, -32700, tooLarge ? "Request body is too large." : "Parse error: the body is not JSON.");
    return undefined;
  }
}

async function serve(req: IncomingMessage, res: ServerResponse, server: McpServer, body: unknown): Promise<void> {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

async function handleMcp(req: IncomingMessage, res: ServerResponse, username: string, slug: string): Promise<string[]> {
  const read = await readRpcBody(req, res);
  if (!read) return [];
  const { body } = read;
  const methods = rpcMethods(body);

  // The instructions name the collection. Do not let a slow Cosmos delay the initialize reply.
  let collection: Collection | undefined;
  if (methods.includes("initialize")) {
    collection = await Promise.race([
      getCollection(username, slug).catch(() => undefined),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), INSTRUCTIONS_WAIT_MS).unref()),
    ]);
  }

  await serve(req, res, buildServer(username, slug, buildInstructions(username, slug, collection)), body);
  return methods;
}

/** The vault. Every request needs a device key of this username, because its reads use the account token. */
async function handleVault(req: IncomingMessage, res: ServerResponse, username: string, key: string | null, ip: string): Promise<string[]> {
  if (keyFailureLimiter.blocked(ip)) {
    sendRpcError(res, 429, -32000, "Too many requests with a wrong key. Try again later.", { "retry-after": "900" });
    return [];
  }
  const account = key && key.length <= 256 ? store.authenticate(username, key, log) : undefined;
  if (!account) {
    keyFailureLimiter.hit(ip);
    sendRpcError(
      res,
      401,
      -32001,
      "Missing or wrong key. Use the MCP URL from the TasteRef extension: /mcp/<username>?key=<device key>.",
    );
    return [];
  }
  const read = await readRpcBody(req, res);
  if (!read) return [];
  const server = buildVaultServer({
    username: account.username,
    userId: account.userId,
    token: () => store.token(account.userId, log)?.token,
    dropToken: (token) => store.dropToken(account.userId, token, log),
    picks,
    baseUrl: baseUrl(req),
    log,
  });
  await serve(req, res, server, read.body);
  return rpcMethods(read.body);
}

/** The vault of the signed-in user. The bearer token names the user, and the store names the Cosmos account. */
async function handleSignedIn(req: IncomingMessage, res: ServerResponse): Promise<string[]> {
  if (!auth) {
    sendRpcError(res, 503, -32000, "Sign-in is not set up on this server. Use the MCP URL with the device key from the TasteRef extension.");
    return [];
  }
  const checked = await auth.bearer(req);
  if (!("userId" in checked)) {
    res.writeHead(checked.status, checked.headers).end(checked.body);
    return [];
  }
  // The token is checked without the database, so it can outlive its user. A deleted user gets nothing.
  if (!(await auth.exists(checked.userId))) {
    sendRpcError(res, 401, -32000, "This account was deleted. Sign in again.", { "www-authenticate": `Bearer error="invalid_token", resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp"` });
    return [];
  }
  if (!userLimiter.hit(checked.userId)) {
    sendRpcError(res, 429, -32000, "Too many requests. Try again later.", { "retry-after": "900" });
    return [];
  }
  const read = await readRpcBody(req, res);
  if (!read) return [];
  const methods = rpcMethods(read.body);
  const account = store.accountOfUser(checked.userId);
  if (!account) {
    // The same tools as a linked user gets, so the client's tool list stays right after the link.
    // A tool call gets the reason and the fix.
    const calls = (Array.isArray(read.body) ? read.body : [read.body]).filter(
      (message): message is { id: string | number; method: string } =>
        Boolean(message) && typeof message === "object" && (message as { method?: unknown }).method === "tools/call" && (message as { id?: unknown }).id !== undefined,
    );
    if (calls.length) {
      const results = calls.map((call) => ({ jsonrpc: "2.0", id: call.id, result: { content: [{ type: "text", text: NOT_LINKED }], isError: true } }));
      sendJson(res, 200, Array.isArray(read.body) ? results : results[0]);
      return methods;
    }
    const server = buildVaultServer(
      { username: "the user", userId: "", token: () => undefined, dropToken: () => undefined, picks, baseUrl: baseUrl(req), log },
      `This server gives access to the Cosmos (cosmos.so) vault of the signed-in user. ${NOT_LINKED}`,
    );
    await serve(req, res, server, read.body);
    return methods;
  }
  const server = buildVaultServer({
    username: account.username,
    userId: account.userId,
    token: () => store.token(account.userId, log)?.token,
    dropToken: (token) => store.dropToken(account.userId, token, log),
    picks,
    baseUrl: baseUrl(req),
    log,
  });
  await serve(req, res, server, read.body);
  return methods;
}

function readField(body: unknown, name: string): unknown {
  return body && typeof body === "object" ? (body as Record<string, unknown>)[name] : undefined;
}

async function handleLink(req: IncomingMessage, res: ServerResponse, ip: string): Promise<void> {
  if (!linkLimiter.hit(ip)) return sendJson(res, 429, { error: "Too many link requests. Try again later." }, { "retry-after": "900" });
  if (!store.writable) return sendJson(res, 503, { error: "The server cannot store links now." });
  let body: unknown;
  try {
    body = await readJson(req, MAX_LINK_BODY_BYTES);
  } catch {
    return sendJson(res, 400, { error: "The body must be JSON, at most 16 KB." });
  }
  const token = readField(body, "token");
  const deviceKey = readField(body, "deviceKey");
  const rawName = readField(body, "deviceName");
  if (typeof token !== "string" || token.length < 20 || token.length > 8192) {
    return sendJson(res, 400, { error: "token must be the Cosmos access token (a string)." });
  }
  if (typeof deviceKey !== "string" || !DEVICE_KEY_PATTERN.test(deviceKey)) {
    return sendJson(res, 400, { error: "deviceKey must be 32 to 128 characters of A-Z, a-z, 0-9, - and _." });
  }
  const deviceName = typeof rawName === "string" ? rawName.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 100) : "";
  if (!JWT_PATTERN.test(token)) return sendJson(res, 400, { error: "token is not a Cosmos access token (a JWT)." });
  const exp = jwtExpiry(token);
  if (exp === undefined) return sendJson(res, 400, { error: "token is not a Cosmos access token (a JWT with exp)." });
  if (isExpired({ token, exp })) return sendJson(res, 400, { error: "token has expired. Visit cosmos.so to renew it." });

  let me: { id: string; username: string };
  try {
    me = await fetchMe(token);
  } catch (error) {
    if (error instanceof CosmosError && error.code === "auth") {
      log({ event: "link_refused", reason: "cosmos_refused_token" });
      return sendJson(res, 401, { error: "Cosmos does not accept the token." });
    }
    log({ level: "error", event: "link_failed", code: error instanceof CosmosError ? error.code : "unknown" });
    return sendJson(res, 502, { error: "Could not check the token with Cosmos. Try again later." });
  }
  if (ALLOWED_USERS.size > 0 && !ALLOWED_USERS.has(me.username.toLowerCase())) {
    log({ event: "link_refused", reason: "user_not_allowed" });
    return sendJson(res, 403, { error: "This server does not link that Cosmos account." });
  }

  let result;
  try {
    result = store.link({ username: me.username, userId: me.id, token: { token, exp }, deviceKey, deviceName: deviceName || "Unnamed device" });
  } catch (error) {
    if (error instanceof TooManyDevicesError) return sendJson(res, 409, { error: error.message });
    throw error;
  }
  try {
    await store.save();
  } catch (error) {
    log({ level: "error", event: "store_write_failed", error: error instanceof Error ? error.message : String(error) });
    return sendJson(res, 503, { error: "The server could not store the link." });
  }
  const stored = result.account.token;
  log({
    event: "linked",
    username: result.account.username,
    devices: result.account.devices.length,
    deviceAdded: result.deviceAdded,
    tokenUpdated: result.tokenUpdated,
  });
  sendJson(res, 200, {
    ok: true,
    username: result.account.username,
    userId: result.account.userId,
    deviceName: deviceName || "Unnamed device",
    deviceAdded: result.deviceAdded,
    tokenUpdated: result.tokenUpdated,
    tokenExpiresAt: stored ? new Date(stored.exp * 1000).toISOString() : null,
    mcpPath: `/mcp/${result.account.username}`,
  });
}

async function handleUnlink(req: IncomingMessage, res: ServerResponse, ip: string): Promise<void> {
  if (!linkLimiter.hit(ip)) return sendJson(res, 429, { error: "Too many requests. Try again later." }, { "retry-after": "900" });
  let body: unknown;
  try {
    body = await readJson(req, MAX_LINK_BODY_BYTES);
  } catch {
    return sendJson(res, 400, { error: "The body must be JSON, at most 16 KB." });
  }
  const deviceKey = readField(body, "deviceKey");
  if (typeof deviceKey !== "string" || !DEVICE_KEY_PATTERN.test(deviceKey)) {
    return sendJson(res, 400, { error: "deviceKey must be 32 to 128 characters of A-Z, a-z, 0-9, - and _." });
  }
  const removed = store.unlink(deviceKey);
  // Save also when the key is already gone from memory: an earlier unlink may have failed to write,
  // and a restart would bring the key back.
  try {
    await store.save();
  } catch (error) {
    log({ level: "error", event: "store_write_failed", error: error instanceof Error ? error.message : String(error) });
    return sendJson(res, 503, { error: "The server could not store the change." });
  }
  log({ event: "unlinked", removed });
  sendJson(res, 200, { ok: true, removed });
}

const httpServer = createServer((req, res) => {
  const started = Date.now();
  // Log only the path: the query string of a vault request holds the device key.
  let path: string;
  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://localhost");
    path = url.pathname.replace(/\/+$/, "") || "/";
  } catch {
    return sendText(res, 400, "Bad request URL.\n");
  }
  let methods: string[] = [];

  res.on("finish", () => {
    if (path === "/health") return;
    log({ method: req.method, path: Pages.logPath(path), status: res.statusCode, ms: Date.now() - started, ...(methods.length ? { rpc: methods } : {}) });
  });

  void (async () => {
    if (path === "/health") {
      if (req.method !== "GET" && req.method !== "HEAD") return sendText(res, 405, "Method not allowed.\n", { allow: "GET" });
      return sendText(res, 200, "ok");
    }
    if (path === "/") {
      if (req.method !== "GET" && req.method !== "HEAD") return sendText(res, 405, "Method not allowed.\n", { allow: "GET" });
      return sendText(res, 200, USAGE);
    }
    if (path === "/link" || path === "/unlink") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed. Use POST." }, { allow: "POST" });
      const ip = clientIp(req);
      return path === "/link" ? handleLink(req, res, ip) : handleUnlink(req, res, ip);
    }
    if (auth?.owns(path)) return auth.handle(req, res);
    if (accountPages && (await accountPages.handle(req, res, path, clientIp(req)))) return;
    if (await pages.handle(req, res, path, clientIp(req))) return;
    if (path === "/mcp") {
      if (req.method !== "POST") return sendRpcError(res, 405, -32000, "Method not allowed. Use POST.", { allow: "POST" });
      methods = await handleSignedIn(req, res);
      return;
    }
    const vaultMatch = /^\/mcp\/([^/]+)$/.exec(path);
    if (vaultMatch) {
      if (req.method !== "POST") return sendRpcError(res, 405, -32000, "Method not allowed. Use POST.", { allow: "POST" });
      const [, username = ""] = vaultMatch;
      if (!USERNAME_PATTERN.test(username)) {
        return sendRpcError(res, 400, -32602, "Not a valid Cosmos username. Use /mcp/<username>?key=<device key>.");
      }
      methods = await handleVault(req, res, username, url.searchParams.get("key"), clientIp(req));
      return;
    }
    const match = /^\/mcp\/([^/]+)\/([^/]+)$/.exec(path);
    if (!match) return sendText(res, 404, "Not found. See GET / for usage.\n");
    if (req.method !== "POST") {
      // Stateless mode: no SSE stream to open and no session to delete.
      return sendRpcError(res, 405, -32000, "Method not allowed. Use POST.", { allow: "POST" });
    }
    const [, username = "", slug = ""] = match;
    if (!USERNAME_PATTERN.test(username) || !SLUG_PATTERN.test(slug)) {
      return sendRpcError(
        res,
        400,
        -32602,
        "Not a valid Cosmos collection. Use /mcp/<username>/<slug> with the names from https://www.cosmos.so/<username>/<slug>.",
      );
    }
    methods = await handleMcp(req, res, username, slug);
  })().catch((error: unknown) => {
    log({ level: "error", path: Pages.logPath(path), error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
    if (!res.headersSent) sendRpcError(res, 500, -32603, "Internal server error.");
    else res.end();
  });
});

httpServer.requestTimeout = REQUEST_TIMEOUT_MS;
httpServer.headersTimeout = 15_000;
httpServer.setTimeout(REQUEST_TIMEOUT_MS + 5_000);

// An account with no device and no user is deleted. Its picker links, canvases and history go with it.
store.onAccountDeleted = (userId) => void picks.deleteOwner(userId, log);
await store.load(log);
// The usernames of a version 1 file stay in links.json until their pick data has moved.
if (await picks.load(log, store.legacyOwners)) {
  await store.finishMigration().catch((error: unknown) => log({ level: "error", event: "store_write_failed", error: (error as Error).message }));
}

const authEnv = { secret: process.env.BETTER_AUTH_SECRET ?? "", id: process.env.GOOGLE_CLIENT_ID ?? "", key: process.env.GOOGLE_CLIENT_SECRET ?? "" };
if (PUBLIC_URL && authEnv.secret && ((authEnv.id && authEnv.key) || TEST_LOGIN)) {
  auth = await createAuth(
    {
      publicUrl: PUBLIC_URL,
      secret: authEnv.secret,
      googleClientId: authEnv.id,
      googleClientSecret: authEnv.key,
      dataDir: DATA_DIR,
      testLogin: TEST_LOGIN,
      onUserDeleted: async (userId) => {
        if (store.unbindUser(userId)) await store.save();
        log({ event: "user_deleted" });
      },
    },
    log,
  );
  // A user that was deleted while the link file could not be written is still in the file.
  let stale = 0;
  for (const userId of store.linkedUsers()) if (!(await auth.exists(userId)) && store.unbindUser(userId)) stale++;
  if (stale) {
    await store.save().catch((error: unknown) => log({ level: "error", event: "store_write_failed", error: (error as Error).message }));
    log({ event: "stale_users_removed", users: stale });
  }
  accountPages = new AccountPages(auth, store, PUBLIC_URL, connectLimiter, log);
  log({ event: "auth_ready", testLogin: TEST_LOGIN });
} else {
  log({ event: "auth_off", reason: "PUBLIC_URL, BETTER_AUTH_SECRET, GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set" });
}
setInterval(() => void picks.prune(log), 60 * 60_000).unref();
httpServer.listen(PORT, TEST_LOGIN ? "127.0.0.1" : "0.0.0.0", () => log({ event: "listening", port: PORT, dataDir: DATA_DIR, linkStore: store.writable ? "writable" : "unwritable" }));

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    log({ event: "shutdown", signal });
    httpServer.close(() => process.exit(0));
    httpServer.closeAllConnections();
    setTimeout(() => process.exit(0), 3_000).unref();
  });
}
