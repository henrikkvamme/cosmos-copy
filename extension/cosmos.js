// Cosmos access, with Henrik's cosmos.so session cookies.
// Cosmos uses persisted GraphQL queries. The hashes come from the Cosmos web
// bundle (assets/graphql-*.js, names from assets/api-*.js). If Cosmos changes
// them, the calls fail with a clear error and copying to the clipboard still works.
const QUERIES = {
  me: "sha256:bec68711b46272bf22c04623a42abcdd29ad9a114b1c079b05f8c670be1f543b",
  isLiked: "sha256:21ab2856fde6eeb57fff1c6ba179109499cb485f4ce3f4d2e3427bc62c11fb91",
  like: "sha256:abc5472ae8340c2c0718a44aedc9fcb7d21ef55400682019b5c938c608181129",
  clusterBySlug: "sha256:4efc84bf9ebb4956d698e4421cbd8947aa8b0951fec75251c8bf4786696dbcb2",
  createCluster: "sha256:7cc419bfdc9204f75bdf48af0571a7d9cdb56397cc60a27910d7fbc0d968b5a7",
  editConnections: "sha256:50f4d890cc8758987cb2d0b6d4adefda81e5c17d5b7208b93c74f937005777a3",
  searchClusters: "sha256:5bf09e7334f5cbb379c0733feaa82b8ed5c1e118842ea675545aa9b4360d28f6",
};

async function graphql(documentId, variables = {}) {
  const res = await fetch("https://www.cosmos.so/api/graphql", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ documentId, variables }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.errors?.length) {
    throw new Error(`Cosmos API: ${body.errors?.[0]?.message ?? `HTTP ${res.status}`}`);
  }
  return body.data;
}

let mePromise;
function me() {
  mePromise ??= graphql(QUERIES.me).then((data) => {
    if (!data?.me?.id) throw new Error("Sign in to Cosmos first");
    return { id: data.me.id, username: data.me.username };
  });
  mePromise.catch(() => (mePromise = undefined));
  return mePromise;
}

export const slugify = (name) =>
  name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const pendingLikes = new Map();

export const cosmos = {
  me,

  async isLiked(elementId) {
    const data = await graphql(QUERIES.isLiked, { elementId: Number(elementId), userId: (await me()).id });
    return Boolean(data?.elementView?.element?.isLikedBy);
  },

  // The like mutation toggles, so check the state first. A second press while a like is
  // in progress shares that like, so two presses cannot toggle twice.
  like(elementId) {
    const key = String(elementId);
    if (!pendingLikes.has(key)) {
      const run = (async () => {
        if (await cosmos.isLiked(key)) return;
        const input = { elementId: Number(key), userId: (await me()).id, userInteractionSource: "ELEMENT_VIEW" };
        await graphql(QUERIES.like, { input });
      })().finally(() => pendingLikes.delete(key));
      pendingLikes.set(key, run);
    }
    return pendingLikes.get(key);
  },

  // Finds Henrik's collection by name, or creates it as a public collection.
  async collection(name) {
    const { id: userId, username } = await me();
    const slug = slugify(name);
    const found = await graphql(QUERIES.clusterBySlug, {
      slug,
      ownerUsername: username,
      userId,
      fetchSubCluster: false,
      isLoggedIn: true,
    }).catch(() => null);
    if (found?.cluster?.id) return { id: found.cluster.id, name, slug: found.cluster.slug ?? slug, username };
    const created = await graphql(QUERIES.createCluster, { name, userId, isPrivate: false, isLoggedIn: true });
    const cluster = created?.cluster?.create;
    if (!cluster?.id) throw new Error("Could not create the Cosmos collection");
    return { id: cluster.id, name, slug: cluster.slug ?? slug, username };
  },

  // Henrik's collections, for the "Save to" menu. An empty search term lists them all.
  async collections() {
    const { id: userId, username } = await me();
    const data = await graphql(QUERIES.searchClusters, { userId, searchTerm: "" });
    return (data?.searchClusters?.items ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      username: c.owner?.username ?? username,
      isPrivate: Boolean(c.isPrivate),
    }));
  },

  async save(elementId, clusterId) {
    const data = await graphql(QUERIES.editConnections, {
      clusterIdsToConnect: [clusterId],
      clusterIdsToDisconnect: [],
      elementIds: [Number(elementId)],
      userId: (await me()).id,
    });
    if (!data?.element?.editElementsConnectionsToClusters?.success) throw new Error("Cosmos did not save the element");
  },

  // Reads the element's media URL from its page's JSON-LD. The DOM only has a
  // blob: URL for videos, and the open page's JSON-LD can be stale after
  // in-app navigation, so the page is fetched again.
  async media(elementId) {
    const res = await fetch(`https://www.cosmos.so/e/${elementId}`, { credentials: "include" });
    if (!res.ok) throw new Error(`Cosmos page returned HTTP ${res.status}`);
    const html = await res.text();
    for (const [, json] of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
      let data;
      try {
        data = JSON.parse(json);
      } catch {
        continue;
      }
      if (data?.contentUrl && (data["@type"] === "VideoObject" || data["@type"] === "ImageObject")) {
        const kind = data["@type"] === "VideoObject" ? "video" : "image";
        const thumb = kind === "video" ? data.thumbnailUrl : data.contentUrl;
        return { kind, url: data.contentUrl, thumb };
      }
    }
    const og = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1];
    if (og) return { kind: "image", url: og, thumb: og };
    throw new Error("No image or video found on this Cosmos element");
  },
};
