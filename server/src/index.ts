// HTTP entry point. Stateless MCP over Streamable HTTP: each POST gets a new server and transport.
//
//   POST /mcp/:username/:slug   MCP endpoint for the public Cosmos collection cosmos.so/<username>/<slug>
//   GET  /health                "ok"
//   GET  /                      usage

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getCollection, SLUG_PATTERN, USERNAME_PATTERN, type Collection } from "./cosmos.js";
import { buildInstructions, buildServer } from "./mcp.js";

const PORT = Number(process.env.PORT ?? 3000);
const MAX_BODY_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const INSTRUCTIONS_WAIT_MS = 2_500;

const USAGE = `cosmos-mcp: a read-only MCP server for public Cosmos (cosmos.so) collections.

MCP endpoint (Streamable HTTP, stateless, no login):
  POST /mcp/<username>/<slug>     for the collection https://www.cosmos.so/<username>/<slug>

Tools: search_references, list_references, get_reference.

Add it to Claude Code:
  claude mcp add --transport http cosmos https://<this-host>/mcp/<username>/<slug>

Health: GET /health
`;

function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), ...fields }));
}

function sendText(res: ServerResponse, status: number, text: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...headers }).end(text);
}

function sendRpcError(res: ServerResponse, status: number, code: number, message: string, headers: Record<string, string> = {}): void {
  res
    .writeHead(status, { "content-type": "application/json", ...headers })
    .end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).byteLength;
    if (total > MAX_BODY_BYTES) throw new Error("too large");
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

async function handleMcp(req: IncomingMessage, res: ServerResponse, username: string, slug: string): Promise<string[]> {
  let body: unknown;
  try {
    body = await readJson(req);
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === "too large";
    sendRpcError(res, tooLarge ? 413 : 400, -32700, tooLarge ? "Request body is too large." : "Parse error: the body is not JSON.");
    return [];
  }
  const methods = rpcMethods(body);

  // The instructions name the collection. Do not let a slow Cosmos delay the initialize reply.
  let collection: Collection | undefined;
  if (methods.includes("initialize")) {
    collection = await Promise.race([
      getCollection(username, slug).catch(() => undefined),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), INSTRUCTIONS_WAIT_MS).unref()),
    ]);
  }

  const server = buildServer(username, slug, buildInstructions(username, slug, collection));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
  return methods;
}

const httpServer = createServer((req, res) => {
  const started = Date.now();
  let path: string;
  try {
    path = new URL(req.url ?? "/", "http://localhost").pathname.replace(/\/+$/, "") || "/";
  } catch {
    return sendText(res, 400, "Bad request URL.\n");
  }
  let methods: string[] = [];

  res.on("finish", () => {
    if (path === "/health") return;
    log({ method: req.method, path, status: res.statusCode, ms: Date.now() - started, ...(methods.length ? { rpc: methods } : {}) });
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
    log({ level: "error", path, error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
    if (!res.headersSent) sendRpcError(res, 500, -32603, "Internal server error.");
    else res.end();
  });
});

httpServer.requestTimeout = REQUEST_TIMEOUT_MS;
httpServer.headersTimeout = 15_000;
httpServer.setTimeout(REQUEST_TIMEOUT_MS + 5_000);

httpServer.listen(PORT, "0.0.0.0", () => log({ event: "listening", port: PORT }));

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    log({ event: "shutdown", signal });
    httpServer.close(() => process.exit(0));
    httpServer.closeAllConnections();
    setTimeout(() => process.exit(0), 3_000).unref();
  });
}
