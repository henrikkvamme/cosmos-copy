// The pages of a signed-in person and their JSON endpoints.
//
//   GET  /login, /consent          steps of the OAuth flow (Better Auth sends the browser here)
//   GET  /account                  the account: email, the linked Cosmos account, the MCP clients
//   GET  /connect                  confirm the link of a Cosmos account (the ticket is in the URL fragment)
//   GET  /privacy                  what the server stores
//   POST /connect/start            {deviceKey} from the extension: returns a connect ticket
//   POST /connect/state            {deviceKey} from the extension: is a signed-in user linked?
//   GET  /account/api/me           the state for the pages
//   POST /account/api/connect      {ticket, confirm?}: show or confirm the link
//   POST /account/api/unlink       remove the link to the Cosmos account
//   POST /account/api/revoke       {clientId}: end the grant of one MCP client
//
// The cookie endpoints take JSON only and check the Origin header, so another site cannot call them.
// Never log a ticket or a device key.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ACCESS_TOKEN_SECONDS, type Auth, type SignedInUser } from "./auth.js";
import type { RateLimiter } from "./ratelimit.js";
import type { LinkStore } from "./store.js";

type Log = (fields: Record<string, unknown>) => void;

const PAGES_DIR = fileURLToPath(new URL("../pages/", import.meta.url));
const PAGE_PATHS = new Set(["/login", "/consent", "/account", "/connect", "/privacy"]);
const ASSETS: Record<string, string> = { "/assets/account.js": "text/javascript; charset=utf-8" };
const MAX_BODY_BYTES = 4 * 1024;
const DEVICE_KEY_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow",
  "cross-origin-opener-policy": "same-origin",
  "cache-control": "no-store",
};

export class AccountPages {
  private readonly html = readFileSync(PAGES_DIR + "account.html");
  private readonly script = readFileSync(PAGES_DIR + "account.js");

  constructor(
    private readonly auth: Auth,
    private readonly store: LinkStore,
    private readonly publicUrl: string,
    private readonly limiter: RateLimiter,
    private readonly log: Log,
  ) {}

  private json(res: ServerResponse, status: number, value: unknown): void {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" }).end(JSON.stringify(value));
  }

  private async body(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
    if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return undefined;
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      total += (chunk as Buffer).byteLength;
      if (total > MAX_BODY_BYTES) return undefined;
      chunks.push(chunk as Buffer);
    }
    try {
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }

  /** A write with the session cookie: from this origin only. */
  private async signedIn(req: IncomingMessage, res: ServerResponse): Promise<SignedInUser | undefined> {
    if (req.method === "POST" && req.headers.origin !== this.publicUrl) {
      this.json(res, 403, { error: "Wrong origin." });
      return undefined;
    }
    const user = await this.auth.user(req);
    if (!user) this.json(res, 401, { error: "Not signed in." });
    return user;
  }

  /** Handles the request when the path is one of this class. Returns false for other paths. */
  async handle(req: IncomingMessage, res: ServerResponse, path: string, ip: string): Promise<boolean> {
    if (PAGE_PATHS.has(path)) {
      if (req.method !== "GET" && req.method !== "HEAD") return this.json(res, 405, { error: "Method not allowed." }), true;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS }).end(this.html);
      return true;
    }
    if (ASSETS[path]) {
      res.writeHead(200, { "content-type": ASSETS[path], "cache-control": "no-cache", "x-content-type-options": "nosniff" }).end(this.script);
      return true;
    }

    if (path === "/connect/start") {
      if (req.method !== "POST") return this.json(res, 405, { error: "Method not allowed. Use POST." }), true;
      if (!this.limiter.hit(ip)) return this.json(res, 429, { error: "Too many requests. Try again later." }), true;
      const deviceKey = (await this.body(req))?.deviceKey;
      const started = typeof deviceKey === "string" && DEVICE_KEY_PATTERN.test(deviceKey) ? this.store.startConnect(deviceKey) : undefined;
      if (!started) return this.json(res, 404, { error: "This browser is not linked to a Cosmos account. Open cosmos.so and sign in first." }), true;
      this.log({ event: "connect_started" });
      // The ticket goes in the fragment: a fragment is not sent to a server and is not in a log.
      this.json(res, 200, { ok: true, username: started.username, url: `${this.publicUrl}/connect#${started.ticket}` });
      return true;
    }

    if (path === "/connect/state") {
      if (req.method !== "POST") return this.json(res, 405, { error: "Method not allowed. Use POST." }), true;
      if (!this.limiter.hit(ip)) return this.json(res, 429, { error: "Too many requests. Try again later." }), true;
      const deviceKey = (await this.body(req))?.deviceKey;
      const connected = typeof deviceKey === "string" && DEVICE_KEY_PATTERN.test(deviceKey) ? this.store.connected(deviceKey) : undefined;
      if (connected === undefined) return this.json(res, 404, { error: "This browser is not linked to a Cosmos account." }), true;
      this.json(res, 200, { ok: true, connected });
      return true;
    }

    if (!path.startsWith("/account/api/")) return false;
    const name = path.slice("/account/api/".length);

    if (name === "me") {
      if (req.method !== "GET") return this.json(res, 405, { error: "Method not allowed." }), true;
      const user = await this.auth.user(req);
      if (!user) return this.json(res, 200, { user: null }), true;
      const account = this.store.accountOfUser(user.id);
      this.json(res, 200, {
        user: { email: user.email, name: user.name },
        cosmos: account ? { username: account.username, token: Boolean(account.token), devices: account.devices.length } : null,
        clients: await this.auth.grants(user.id),
        mcpUrl: this.auth.resource,
        tokenMinutes: ACCESS_TOKEN_SECONDS / 60,
      });
      return true;
    }

    if (req.method !== "POST") return this.json(res, 405, { error: "Method not allowed. Use POST." }), true;
    const user = await this.signedIn(req, res);
    if (!user) return true;
    const body = await this.body(req);
    if (!body) return this.json(res, 400, { error: "The body must be a JSON object." }), true;

    if (name === "connect") {
      const ticket = body.ticket;
      if (typeof ticket !== "string" || !TICKET_PATTERN.test(ticket)) return this.json(res, 400, { error: "No ticket." }), true;
      if (!this.limiter.hit(ip)) return this.json(res, 429, { error: "Too many requests. Try again later." }), true;
      if (body.confirm !== true) {
        const account = this.store.peekConnect(ticket);
        if (!account) return this.json(res, 410, { error: "expired" }), true;
        return this.json(res, 200, { username: account.username, email: user.email, current: this.store.accountOfUser(user.id)?.username ?? null }), true;
      }
      let account;
      try {
        account = await this.store.confirmConnect(ticket, user.id);
      } catch (error) {
        this.log({ level: "error", event: "store_write_failed", error: error instanceof Error ? error.message : String(error) });
        return this.json(res, 503, { error: "The server could not store the link. Start again from the extension." }), true;
      }
      if (!account) return this.json(res, 410, { error: "expired" }), true;
      this.log({ event: "connected", users: account.users.length });
      return this.json(res, 200, { ok: true, username: account.username }), true;
    }

    if (name === "unlink") {
      const changed = this.store.unbindUser(user.id);
      try {
        await this.store.save();
      } catch (error) {
        this.log({ level: "error", event: "store_write_failed", error: error instanceof Error ? error.message : String(error) });
        return this.json(res, 503, { error: "The server could not store the change." }), true;
      }
      this.log({ event: "user_unlinked", changed });
      return this.json(res, 200, { ok: true }), true;
    }

    if (name === "revoke") {
      const clientId = body.clientId;
      if (typeof clientId !== "string" || clientId.length > 2048) return this.json(res, 400, { error: "No client." }), true;
      await this.auth.revoke(user.id, clientId);
      this.log({ event: "grant_revoked" });
      return this.json(res, 200, { ok: true }), true;
    }

    return this.json(res, 404, { error: "Not found." }), true;
  }
}
