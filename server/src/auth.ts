// Sign-in with Google, and OAuth for MCP clients (Better Auth with its MCP plugin).
//
//   /api/auth/*                              Better Auth: Google sign-in, sessions, the OAuth endpoints
//   /.well-known/oauth-protected-resource    RFC 9728, names the authorization server
//   /.well-known/oauth-authorization-server  RFC 8414
//
// An MCP client finds these from the 401 answer of POST /mcp, sends the person to the sign-in page
// and gets an access token for the resource PUBLIC_URL/mcp. The token names the Better Auth user.
// Which Cosmos account that user linked is in links.json (store.ts), not here.
//
// The database is DATA_DIR/auth.db (SQLite): users, sessions, OAuth clients, grants and signing keys.
// Never log a token, a cookie or an OAuth code.

import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { toNodeHandler } from "better-auth/node";
import { jwt } from "better-auth/plugins/jwt";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp, requireMcpAuth } from "@better-auth/mcp";

type Log = (fields: Record<string, unknown>) => void;

/** An access token is checked without the database, so a revoked grant works until its token ends. Keep this short. */
export const ACCESS_TOKEN_SECONDS = 10 * 60;

export interface AuthConfig {
  /** The public origin, such as https://cosmos-mcp.example.com. */
  publicUrl: string;
  secret: string;
  googleClientId: string;
  googleClientSecret: string;
  dataDir: string;
  /** Tests only: sign-in with email and password. The caller allows it only on a loopback host. */
  testLogin: boolean;
  /** Called after a user was deleted, with the Better Auth user id. */
  onUserDeleted: (userId: string) => Promise<void>;
}

export interface SignedInUser {
  id: string;
  email: string;
  name: string;
}

/** One MCP client that the user let in. */
export interface Grant {
  clientId: string;
  name: string;
  since: string;
}

export type BearerCheck = { userId: string } | { status: number; headers: Record<string, string>; body: string };

export interface Auth {
  /** True for a path that Better Auth serves. */
  owns(path: string): boolean;
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** The user of the session cookie. */
  user(req: IncomingMessage): Promise<SignedInUser | undefined>;
  /** Checks the bearer token of an MCP request: signature, issuer, audience and expiry. */
  bearer(req: IncomingMessage): Promise<BearerCheck>;
  /** True while the user exists. An access token outlives its user by up to its lifetime. */
  exists(userId: string): Promise<boolean>;
  grants(userId: string): Promise<Grant[]>;
  /** Ends the grant of one client: its consent and its tokens. */
  revoke(userId: string, clientId: string): Promise<void>;
  resource: string;
}

function webHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || name.startsWith(":")) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

export async function createAuth(config: AuthConfig, log: Log): Promise<Auth> {
  const resource = `${config.publicUrl}/mcp`;
  const database = new DatabaseSync(join(config.dataDir, "auth.db"));
  database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

  const auth = betterAuth({
    appName: "Cosmos Copy",
    baseURL: config.publicUrl,
    secret: config.secret,
    database,
    socialProviders: { google: { clientId: config.googleClientId, clientSecret: config.googleClientSecret } },
    emailAndPassword: { enabled: config.testLogin },
    user: {
      deleteUser: {
        enabled: true,
        afterDelete: async (user) => {
          await config.onUserDeleted(user.id);
        },
      },
    },
    plugins: [
      jwt({ disableSettingJwtHeader: true }),
      // Clients name themselves with a Client ID Metadata Document (Claude Code and Codex do). Open
      // dynamic registration stays off: it would let anyone on the internet add client records.
      // Tests register a client that way, because a metadata document needs an HTTPS host.
      mcp({
        loginPage: "/login",
        consentPage: "/consent",
        resource,
        accessTokenExpiresIn: ACCESS_TOKEN_SECONDS,
        ...(config.testLogin ? { allowDynamicClientRegistration: true, allowUnauthenticatedClientRegistration: true, clientRegistrationDefaultApplicationType: "infer" as const } : {}),
      }),
      cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
    ],
  });

  const migrations = await getMigrations(auth.options);
  await migrations.runMigrations();
  if (migrations.toBeCreated.length || migrations.toBeAdded.length) {
    log({ event: "auth_migrated", created: migrations.toBeCreated.length, changed: migrations.toBeAdded.length });
  }

  const node = toNodeHandler(auth);
  const guard = requireMcpAuth(auth, (_request, claims) => Response.json({ sub: claims.sub ?? "" }), { resource });
  const context = await auth.$context;

  return {
    resource,
    owns: (path) => path === "/api/auth" || path.startsWith("/api/auth/") || path.startsWith("/.well-known/oauth-") || path.startsWith("/.well-known/openid-configuration"),
    handle: (req, res) => node(req, res),
    async user(req) {
      const session = await auth.api.getSession({ headers: webHeaders(req) }).catch(() => null);
      if (!session?.user) return undefined;
      return { id: session.user.id, email: session.user.email, name: session.user.name };
    },
    async bearer(req) {
      const headers = new Headers();
      for (const name of ["authorization", "dpop"]) {
        const value = req.headers[name];
        if (typeof value === "string") headers.set(name, value);
      }
      const response = await guard(new Request(resource, { method: "POST", headers }));
      if (response.status === 200) {
        const { sub } = (await response.json()) as { sub: string };
        if (sub) return { userId: sub };
      }
      const out: Record<string, string> = { "content-type": "application/json" };
      const challenge = response.headers.get("www-authenticate");
      if (challenge) out["www-authenticate"] = challenge;
      return { status: response.status === 200 ? 401 : response.status, headers: out, body: response.status === 200 ? "{}" : await response.text() };
    },
    async exists(userId) {
      return Boolean(await context.internalAdapter.findUserById(userId));
    },
    async grants(userId) {
      const consents = (await context.adapter.findMany({ model: "oauthConsent", where: [{ field: "userId", value: userId }] })) as {
        clientId: string;
        createdAt?: Date | string;
      }[];
      const out: Grant[] = [];
      for (const consent of consents) {
        if (out.some((grant) => grant.clientId === consent.clientId)) continue;
        const client = (await context.adapter.findOne({ model: "oauthClient", where: [{ field: "clientId", value: consent.clientId }] })) as { name?: string | null } | null;
        out.push({ clientId: consent.clientId, name: client?.name || consent.clientId, since: consent.createdAt ? new Date(consent.createdAt).toISOString() : "" });
      }
      return out;
    },
    async revoke(userId, clientId) {
      const where = [
        { field: "userId", value: userId },
        { field: "clientId", value: clientId },
      ];
      for (const model of ["oauthRefreshToken", "oauthAccessToken", "oauthConsent"]) await context.adapter.deleteMany({ model, where });
    },
  };
}
