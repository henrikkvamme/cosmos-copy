// A fake Cosmos GraphQL API for the smoke test.
//
// - A request with "Authorization: Bearer <token>" gets mock data. Tokens are fake JWTs made by
//   makeToken(). The mock answers only the operations of src/vault.ts and src/cosmos.ts, found by
//   their operation names (CosmosMcp...).
// - A request without Authorization goes to the real https://api.cosmos.so/graphql, so the
//   anonymous paths are tested against the real API.
//
// Every request is recorded in `requests` ({op, auth, tokenN, variables}).

import { createServer } from "node:http";

const REAL_GRAPHQL_URL = "https://api.cosmos.so/graphql";
const MINUTE = 60_000;

export function makeToken(username, expInSeconds, n, signature = "fakesig") {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub: username, exp: Math.floor(Date.now() / 1000) + expInSeconds, n })}.${signature}`;
}

function parseToken(token) {
  const [, payload, signature] = token.split(".");
  if (signature !== "fakesig" || !payload) return undefined;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

function element(id, caption, kind = "image") {
  const media =
    kind === "video"
      ? { __typename: "Video", url: `https://cdn.cosmos.so/fake-${id}.mp4`, width: 640, height: 360, thumbnail: { url: `https://cdn.cosmos.so/fake-${id}.jpg` }, duration: 4 }
      : { __typename: "StaticImage", url: `https://cdn.cosmos.so/fake-${id}.jpg`, width: 800, height: 600 };
  return {
    __typename: "MediaElementTile",
    id,
    createdAt: "2026-01-01T00:00:00Z",
    shareUrl: `https://www.cosmos.so/e/${id}`,
    generatedCaption: { text: caption },
    source: null,
    media,
  };
}

/** Builds the mock state. Element ids 900001..900014; e5 is in two collections. */
export function createState(now = Date.now()) {
  const captions = {
    900001: "dark dashboard with charts",
    900002: "motion study of a bouncing loader",
    900003: "editorial type poster",
    900004: "motion blur onboarding animation",
    900005: "pastel mobile settings screen",
    900006: "motion graphics for a product launch",
    900007: "brutalist landing page",
    900008: "spring motion card stack",
    900009: "serif headline layout",
    900010: "motion path icons",
    900011: "glass morphism login form",
    900012: "motion timeline scrubber",
    900013: "grid of product cards",
    900014: "skeleton loader shimmer",
  };
  const elements = new Map();
  for (const [id, caption] of Object.entries(captions)) {
    elements.set(Number(id), element(Number(id), caption, caption.startsWith("motion") ? "video" : "image"));
  }
  const at = (minutesAgo) => new Date(now - minutesAgo * MINUTE).toISOString().replace("Z", "123Z");
  const connections = (pairs) => pairs.map(([id, minutesAgo]) => ({ elementId: id, createdAt: at(minutesAgo) }));
  const users = {
    henrikkvamme: { id: 1711980257, username: "henrikkvamme" },
    otheruser: { id: 42, username: "otheruser" },
  };
  const clusters = [
    {
      id: 1137778943, ownerId: 1711980257, name: "Agent references", slug: "agent-references", isPrivate: false, parentId: null,
      connections: connections([[900001, 1], [900003, 3], [900005, 5], [900007, 7], [900009, 9], [900011, 11], [900013, 13]]),
    },
    {
      id: 2001, ownerId: 1711980257, name: "Motion studies", slug: "motion-studies", isPrivate: true, parentId: null,
      connections: connections([[900002, 2], [900004, 4], [900006, 6], [900008, 8], [900010, 10], [900012, 12], [900005, 20]]),
    },
    { id: 2002, ownerId: 1711980257, name: "Test saves", slug: "test-saves", isPrivate: true, parentId: null, connections: [] },
    { id: 2003, ownerId: 1711980257, name: "Loaders", slug: "loaders", isPrivate: true, parentId: 2001, connections: connections([[900014, 15]]) },
    { id: 3001, ownerId: 42, name: "Other stuff", slug: "other-stuff", isPrivate: true, parentId: null, connections: connections([[900007, 1]]) },
  ];
  return { users, clusters, elements, revoked: new Set() };
}

const authError = (status = 401) => ({
  status,
  body: { errors: [{ message: "You are unauthenticated. Sign in first.", extensions: { code: "AUTHENTICATION" } }], data: null },
});
const forbidden = () => ({ status: 403, body: { errors: [{ message: "Not allowed.", extensions: { code: "AUTHORIZATION" } }], data: null } });
const ok = (data) => ({ status: 200, body: { data } });

function page(items, variables, maxPageSize) {
  const offset = variables.pageCursor ? Number(variables.pageCursor) : 0;
  const size = Math.min(variables.pageSize ?? 20, maxPageSize);
  const slice = items.slice(offset, offset + size);
  const next = offset + size < items.length ? String(offset + size) : null;
  return { slice, next };
}

function clusterView(state, cluster) {
  const owner = Object.values(state.users).find((user) => user.id === cluster.ownerId);
  return {
    id: cluster.id,
    name: cluster.name,
    slug: cluster.slug,
    description: null,
    isPrivate: cluster.isPrivate,
    numberOfElements: cluster.connections.length,
    owner: { username: owner?.username },
  };
}

function answer(state, op, variables, user) {
  switch (op) {
    case "CosmosMcpMe":
      return ok({ me: { id: user.id, username: user.username } });
    case "CosmosMcpUserClusters": {
      if (Number(variables.userId) !== user.id) return forbidden();
      const top = state.clusters.filter((c) => c.ownerId === user.id && !c.parentId);
      // Two per page, so the server must follow the cursor.
      const { slice, next } = page(top, variables, 2);
      const items = slice.map((c) => ({
        ...clusterView(state, c),
        subClusters: { items: state.clusters.filter((s) => s.parentId === c.id).map((s) => clusterView(state, s)) },
      }));
      return ok({ userClusters: { items, meta: { nextPageCursor: next, count: top.length } } });
    }
    case "CosmosMcpClusterConnections": {
      const cluster = state.clusters.find((c) => c.id === Number(variables.clusterId));
      if (!cluster || cluster.ownerId !== user.id) return forbidden();
      const sorted = [...cluster.connections].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      // Five per page, so a collection of seven needs two upstream pages.
      const { slice, next } = page(sorted, variables, 5);
      const items = slice.map((c) => ({ createdAt: c.createdAt, element: state.elements.get(c.elementId) }));
      return ok({ clusterConnections: { items, meta: { nextPageCursor: next } } });
    }
    case "CosmosMcpSearchElements": {
      if (variables.userId == null || Number(variables.userId) !== user.id) return forbidden();
      const term = String(variables.searchTerm ?? "").toLowerCase().trim();
      if (!term) return ok({ searchElements: { results: [], meta: { nextPageCursor: null, count: 0 } } });
      const ids = new Set(state.clusters.filter((c) => c.ownerId === user.id).flatMap((c) => c.connections.map((x) => x.elementId)));
      const words = term.split(/\s+/);
      let found = [...ids].map((id) => state.elements.get(id)).filter((e) => words.some((w) => e.generatedCaption.text.includes(w)));
      if (variables.contentType === "VIDEO") found = found.filter((e) => e.media.__typename === "Video");
      if (variables.contentType === "IMAGE") found = found.filter((e) => e.media.__typename === "StaticImage");
      found.sort((a, b) => a.id - b.id);
      const { slice, next } = page(found, variables, 3);
      return ok({ searchElements: { results: slice.map((e) => ({ element: e })), meta: { nextPageCursor: next, count: found.length } } });
    }
    case "CosmosMcpElement": {
      const found = state.elements.get(Number(variables.elementId));
      return found
        ? ok({ elementView: { element: found } })
        : { status: 200, body: { errors: [{ message: "Element not found", extensions: { code: "NOT_FOUND" } }], data: null } };
    }
    case "CosmosMcpSaveReference": {
      if (Number(variables.userId) !== user.id) return forbidden();
      if (variables.clusterIdsToDisconnect?.length) return forbidden();
      for (const clusterId of variables.clusterIdsToConnect) {
        const cluster = state.clusters.find((c) => c.id === Number(clusterId));
        if (!cluster || cluster.ownerId !== user.id) return forbidden();
        for (const elementId of variables.elementIds) {
          if (!state.elements.has(elementId)) state.elements.set(elementId, element(elementId, "saved by the smoke test"));
          if (!cluster.connections.some((c) => c.elementId === elementId)) {
            cluster.connections.push({ elementId, createdAt: new Date().toISOString() });
          }
        }
      }
      return ok({ element: { editElementsConnectionsToClusters: { success: true } } });
    }
    default:
      return { status: 400, body: { errors: [{ message: `The fake Cosmos does not know ${op}.` }] } };
  }
}

/** Starts the fake. Returns {url, state, requests, close}. */
export async function startFakeCosmos() {
  const state = createState();
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      res.writeHead(400).end("not json");
      return;
    }
    const op = /(?:query|mutation)\s+(\w+)/.exec(payload.query ?? "")?.[1] ?? "anonymous-operation";
    const authorization = req.headers.authorization;
    const record = { op, auth: Boolean(authorization), variables: payload.variables, userAgent: req.headers["user-agent"] };
    requests.push(record);

    if (!authorization) {
      // Anonymous: the real Cosmos answers.
      try {
        const upstream = await fetch(REAL_GRAPHQL_URL, {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": req.headers["user-agent"] ?? "cosmos-mcp/0.1" },
          body: raw,
        });
        res.writeHead(upstream.status, { "content-type": "application/json" }).end(await upstream.text());
      } catch (error) {
        res.writeHead(502).end(String(error));
      }
      return;
    }

    const token = authorization.replace(/^Bearer\s+/i, "");
    const claims = parseToken(token);
    record.tokenN = claims?.n;
    const user = claims && state.users[claims.sub];
    let result;
    if (!user || !(claims.exp * 1000 > Date.now()) || state.revoked.has(token)) result = authError();
    else result = answer(state, op, payload.variables ?? {}, user);
    res.writeHead(result.status, { "content-type": "application/json" }).end(JSON.stringify(result.body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/graphql`,
    state,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
