// Anonymous, read-only access to public Cosmos (cosmos.so) collections.
//
// Primary source: the public GraphQL API at https://api.cosmos.so/graphql. It accepts plain query
// text without a login, so this file sends its own small queries and does not depend on the
// persisted-query hashes of the Cosmos web bundle.
// Fallback for one element: the JSON-LD block of the public page https://www.cosmos.so/e/<id>.

const GRAPHQL_URL = process.env.COSMOS_GRAPHQL_URL || "https://api.cosmos.so/graphql";
const ALLOWED_HOSTS = new Set(["api.cosmos.so", "www.cosmos.so", "cdn.cosmos.so"]);
/** Tests point COSMOS_GRAPHQL_URL at a local fake Cosmos. That one origin is also allowed. */
const GRAPHQL_OVERRIDE_ORIGIN = process.env.COSMOS_GRAPHQL_URL ? new URL(process.env.COSMOS_GRAPHQL_URL).origin : undefined;
const USER_AGENT = "cosmos-mcp/0.1 (read-only MCP server for public collections)";
const UPSTREAM_TIMEOUT_MS = 10_000;

const COLLECTION_TTL_MS = 60_000;
const COLLECTION_STALE_MS = 60 * 60_000;
const ELEMENT_TTL_MS = 60 * 60_000;
const MAX_CACHED_COLLECTIONS = 200;
const MAX_CACHED_ELEMENTS = 2_000;
const PAGE_SIZE = 100;
const MAX_ELEMENTS = 5_000;

export const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;
export const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

export type ReferenceKind = "image" | "video" | "text";

export interface Reference {
  id: string;
  kind: ReferenceKind;
  /** True for a short looping clip (a GIF on Cosmos). Its kind is "video". */
  animated?: boolean;
  title?: string;
  description?: string;
  author?: string;
  authorUsername?: string;
  authorUrl?: string;
  /** The page the element came from, such as an Instagram post. */
  sourceUrl?: string;
  /** The element page on cosmos.so. */
  pageUrl: string;
  /** Image URL for an image, MP4 URL for a video. */
  mediaUrl?: string;
  /** A still image: the image itself, or the thumbnail of a video. */
  thumbnailUrl?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  /** When the element was saved to the collection. */
  savedAt?: string;
  /** When the element was first added to Cosmos. */
  createdAt?: string;
  text?: string;
}

export interface Collection {
  username: string;
  slug: string;
  name: string;
  description?: string;
  ownerName?: string;
  url: string;
  fetchedAt: number;
  /** Newest saved first. */
  references: Reference[];
  /** True when the collection has more elements than MAX_ELEMENTS. */
  truncated: boolean;
}

/** "auth": Cosmos refused the bearer token that was sent (expired or revoked). */
export type CosmosErrorCode = "not_found" | "upstream" | "auth";

/** A JWT: three base64url parts. Anything else is refused before it reaches a header. */
export const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export class CosmosError extends Error {
  constructor(
    readonly code: CosmosErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CosmosError";
  }
}

/** The only network exit of this server. It refuses every host that is not a Cosmos host. */
export async function cosmosFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const parsed = new URL(url);
  const allowed =
    (parsed.protocol === "https:" && ALLOWED_HOSTS.has(parsed.hostname)) || parsed.origin === GRAPHQL_OVERRIDE_ORIGIN;
  if (!allowed) {
    throw new CosmosError("upstream", `Refused to fetch ${parsed.protocol}//${parsed.hostname}: not a Cosmos host.`);
  }
  try {
    return await fetch(parsed, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      headers: { "user-agent": USER_AGENT, ...init.headers },
    });
  } catch (error) {
    // Only fixed reasons: a raw fetch error can quote request headers, including the bearer token.
    const reason = error instanceof Error && error.name === "TimeoutError" ? "timeout" : error instanceof TypeError ? "network or request error" : "request error";
    throw new CosmosError("upstream", `Request to ${parsed.hostname} failed: ${reason}`);
  }
}

// ---------------------------------------------------------------------------------------------
// GraphQL

export const ELEMENT_FIELDS = `
fragment Media on Media {
  __typename
  url
  width
  height
  ... on AnimatedImage { video { url thumbnailUrl } }
  ... on Video { thumbnail { url } duration }
}
fragment Element on ElementTile {
  __typename
  id
  createdAt
  shareUrl
  generatedCaption { text }
  source { url author { username fullName profileUrl } }
  ... on MediaElementTile { media { ...Media } }
  ... on WebsiteElementTile { media { ...Media } websiteTitle: title websiteDescription: description }
  ... on ProductElementTile { media { ...Media } productTitle: name productDescription: description }
  ... on TextElementTile { text }
}`;

const COLLECTION_QUERY = `
query CosmosMcpCollection($input: ClusterGetInput!, $pageCursor: String, $pageSize: Int) {
  cluster(input: $input) { id name slug description owner { username fullName } }
  clusterConnections(clusterInput: $input, meta: { pageSize: $pageSize, pageCursor: $pageCursor }) {
    items { createdAt element { ...Element } }
    meta { nextPageCursor count }
  }
}${ELEMENT_FIELDS}`;

const ELEMENT_QUERY = `
query CosmosMcpElement($elementId: ElementId!) {
  elementView(elementId: $elementId) { element { ...Element } }
}${ELEMENT_FIELDS}`;

interface GraphQLError {
  message?: string;
  extensions?: { code?: string; violations?: { message?: string }[] | null };
}

/**
 * Sends one GraphQL operation. With a token, Cosmos answers as that user (header
 * "Authorization: Bearer <token>"). Never put the token in an error message or a log line.
 */
export async function graphql<T>(query: string, variables: Record<string, unknown>, token?: string): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (token) {
    if (!JWT_PATTERN.test(token)) throw new CosmosError("auth", "The stored Cosmos token is malformed.");
    headers.authorization = `Bearer ${token}`;
  }
  const response = await cosmosFetch(GRAPHQL_URL, { method: "POST", headers, body: JSON.stringify({ query, variables }) });
  let payload: { data?: T | null; errors?: GraphQLError[] };
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    throw new CosmosError("upstream", `Cosmos API returned HTTP ${response.status} with a body that is not JSON.`);
  }
  const first = payload.errors?.[0];
  if (first) {
    const violations = (first.extensions?.violations ?? []).map((v) => v.message).filter(Boolean).join(" ");
    const message = [first.message, violations].filter(Boolean).join(" ");
    // Cosmos answers AUTHENTICATION for a private item, and also for an element id that does not exist.
    const code = first.extensions?.code ?? "";
    // With a token, AUTHENTICATION means that Cosmos does not accept the token.
    if (token && code === "AUTHENTICATION") throw new CosmosError("auth", message);
    if (["NOT_FOUND", "AUTHENTICATION", "AUTHORIZATION", "FORBIDDEN"].includes(code)) {
      throw new CosmosError("not_found", message);
    }
    // A schema change at Cosmos shows up here, for example "Cannot query field 'x' on type 'Y'".
    throw new CosmosError("upstream", `Cosmos API error (HTTP ${response.status}): ${message || "unknown error"}`);
  }
  if (!response.ok || payload.data == null) {
    throw new CosmosError("upstream", `Cosmos API returned HTTP ${response.status} with no data.`);
  }
  return payload.data;
}

interface RawMedia {
  __typename?: string;
  url?: string | null;
  width?: number | null;
  height?: number | null;
  video?: { url?: string | null; thumbnailUrl?: string | null } | null;
  thumbnail?: { url?: string | null } | null;
  duration?: number | null;
}

export interface RawElement {
  __typename?: string;
  id: number | string;
  createdAt?: string | null;
  shareUrl?: string | null;
  generatedCaption?: { text?: string | null } | null;
  source?: {
    url?: string | null;
    author?: { username?: string | null; fullName?: string | null; profileUrl?: string | null } | null;
  } | null;
  media?: RawMedia | null;
  websiteTitle?: string | null;
  websiteDescription?: string | null;
  productTitle?: string | null;
  productDescription?: string | null;
  text?: string | null;
}

/** Cosmos captions mark names with <n>...</n>. Remove such tags and tidy the white space. */
export function cleanText(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const text = value.replace(/<\/?[a-z][a-z0-9]*>/gi, "").replace(/\s+/g, " ").trim();
  return text || undefined;
}

export function toReference(raw: RawElement, savedAt?: string | null): Reference {
  const id = String(raw.id);
  const media = raw.media ?? undefined;
  const reference: Reference = {
    id,
    kind: "text",
    pageUrl: `https://www.cosmos.so/e/${id}`,
    title: cleanText(raw.websiteTitle ?? raw.productTitle),
    description: cleanText(raw.generatedCaption?.text) ?? cleanText(raw.websiteDescription ?? raw.productDescription),
    author: cleanText(raw.source?.author?.fullName),
    authorUsername: raw.source?.author?.username ?? undefined,
    authorUrl: raw.source?.author?.profileUrl ?? undefined,
    sourceUrl: raw.source?.url ?? undefined,
    savedAt: savedAt ?? undefined,
    createdAt: raw.createdAt ?? undefined,
    text: cleanText(raw.text),
  };
  if (media?.url) {
    reference.width = media.width ?? undefined;
    reference.height = media.height ?? undefined;
    if (media.__typename === "Video") {
      reference.kind = "video";
      reference.mediaUrl = media.url;
      reference.thumbnailUrl = media.thumbnail?.url ?? undefined;
      reference.durationSeconds = media.duration ?? undefined;
    } else if (media.__typename === "AnimatedImage" && media.video?.url) {
      reference.kind = "video";
      reference.animated = true;
      reference.mediaUrl = media.video.url;
      reference.thumbnailUrl = media.video.thumbnailUrl ?? media.url;
    } else {
      reference.kind = "image";
      reference.mediaUrl = media.url;
      reference.thumbnailUrl = media.url;
    }
  }
  if (reference.kind === "text" && !reference.description) reference.description = reference.text;
  return reference;
}

// ---------------------------------------------------------------------------------------------
// Collections

interface CollectionPage {
  cluster: {
    name?: string | null;
    slug?: string | null;
    description?: string | null;
    owner?: { username?: string | null; fullName?: string | null } | null;
  } | null;
  clusterConnections: {
    items: { createdAt?: string | null; element: RawElement | null }[];
    meta: { nextPageCursor?: string | null; count?: number | null };
  };
}

async function fetchCollection(username: string, slug: string): Promise<Collection> {
  const input = { ownerUsername: username, slug };
  const references: Reference[] = [];
  const seen = new Set<string>();
  let cluster: CollectionPage["cluster"] = null;
  let cursor: string | null = null;
  let truncated = false;
  do {
    const page: CollectionPage = await graphql<CollectionPage>(COLLECTION_QUERY, {
      input,
      pageCursor: cursor,
      pageSize: PAGE_SIZE,
    });
    if (!page.cluster) throw new CosmosError("not_found", `Collection not found: ${username}/${slug}`);
    cluster ??= page.cluster;
    for (const item of page.clusterConnections.items) {
      if (!item.element) continue;
      const reference = toReference(item.element, item.createdAt);
      if (seen.has(reference.id)) continue;
      seen.add(reference.id);
      references.push(reference);
    }
    const next = page.clusterConnections.meta.nextPageCursor ?? null;
    // Stop on a cursor that does not move, so a Cosmos fault cannot make an endless loop.
    cursor = next && next !== cursor && page.clusterConnections.items.length > 0 ? next : null;
    if (cursor && references.length >= MAX_ELEMENTS) {
      truncated = true;
      cursor = null;
    }
  } while (cursor);

  // Cosmos returns the newest saved element first. Sort again in case that changes.
  references.sort((a, b) => (b.savedAt ?? "").localeCompare(a.savedAt ?? ""));
  return {
    username,
    slug,
    name: cluster?.name ?? slug,
    description: cleanText(cluster?.description),
    ownerName: cluster?.owner?.fullName ?? undefined,
    url: `https://www.cosmos.so/${username}/${slug}`,
    fetchedAt: Date.now(),
    references,
    truncated,
  };
}

interface CacheEntry<T> {
  value?: T;
  at: number;
  error?: CosmosError;
  inflight?: Promise<T>;
}

const collections = new Map<string, CacheEntry<Collection>>();
const elements = new Map<string, CacheEntry<Reference>>();

function remember<T>(cache: Map<string, CacheEntry<T>>, key: string, entry: CacheEntry<T>, max: number): void {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > max) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Reads a public collection. Results stay in memory for about 60 seconds. */
export async function getCollection(username: string, slug: string): Promise<Collection> {
  if (!USERNAME_PATTERN.test(username) || !SLUG_PATTERN.test(slug)) {
    throw new CosmosError("not_found", `Not a valid Cosmos collection name: ${username}/${slug}`);
  }
  const key = `${username.toLowerCase()}/${slug.toLowerCase()}`;
  const entry = collections.get(key);
  const age = entry ? Date.now() - entry.at : Infinity;
  if (entry && age < COLLECTION_TTL_MS) {
    if (entry.value && !entry.error) return entry.value;
    if (entry.error) throw entry.error;
  }
  if (entry?.inflight) return entry.inflight;

  const stale = entry?.value;
  const inflight = fetchCollection(username, slug).then(
    (value) => {
      remember(collections, key, { value, at: Date.now() }, MAX_CACHED_COLLECTIONS);
      return value;
    },
    (error: unknown) => {
      const cosmosError = error instanceof CosmosError ? error : new CosmosError("upstream", String(error));
      if (cosmosError.code === "not_found") {
        // Remember a missing collection too, so repeated calls do not load Cosmos.
        remember(collections, key, { at: Date.now(), error: cosmosError }, MAX_CACHED_COLLECTIONS);
        throw cosmosError;
      }
      // Cosmos is unreachable: serve the last good copy for up to an hour.
      if (stale && Date.now() - stale.fetchedAt < COLLECTION_STALE_MS) {
        remember(collections, key, { value: stale, at: Date.now() - COLLECTION_TTL_MS / 2 }, MAX_CACHED_COLLECTIONS);
        return stale;
      }
      collections.delete(key);
      throw cosmosError;
    },
  );
  remember(collections, key, { ...entry, at: entry?.at ?? 0, inflight }, MAX_CACHED_COLLECTIONS);
  return inflight;
}

// ---------------------------------------------------------------------------------------------
// Single elements

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Fallback: read the JSON-LD block of the public element page. */
async function fetchElementFromPage(id: string): Promise<Reference> {
  const response = await cosmosFetch(`https://www.cosmos.so/e/${id}`, { headers: { accept: "text/html" } });
  if (response.status === 404) throw new CosmosError("not_found", `Element not found: ${id}`);
  if (!response.ok) throw new CosmosError("upstream", `Cosmos element page returned HTTP ${response.status}.`);
  const html = await response.text();
  for (const match of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(decodeEntities(match[1] ?? "")) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = data["@type"];
    if (type !== "ImageObject" && type !== "VideoObject") continue;
    const text = (key: string) => (typeof data[key] === "string" ? (data[key] as string) : undefined);
    const number = (key: string) => (typeof data[key] === "number" ? (data[key] as number) : undefined);
    const creator = (data.creator ?? data.author) as { name?: string; url?: string } | undefined;
    return {
      id,
      kind: type === "VideoObject" ? "video" : "image",
      pageUrl: `https://www.cosmos.so/e/${id}`,
      description: cleanText(text("description")),
      author: cleanText(creator?.name),
      authorUrl: creator?.url,
      sourceUrl: text("sameAs"),
      mediaUrl: text("contentUrl"),
      thumbnailUrl: text("thumbnailUrl") ?? (type === "ImageObject" ? text("contentUrl") : undefined),
      width: number("width"),
      height: number("height"),
      createdAt: text("uploadDate") ?? text("datePublished"),
    };
  }
  throw new CosmosError("upstream", `The Cosmos page of element ${id} has no ImageObject or VideoObject JSON-LD.`);
}

async function fetchElement(id: string): Promise<Reference> {
  try {
    const data = await graphql<{ elementView: { element: RawElement | null } | null }>(ELEMENT_QUERY, {
      elementId: Number(id),
    });
    if (!data.elementView?.element) throw new CosmosError("not_found", `Element not found: ${id}`);
    return toReference(data.elementView.element);
  } catch (error) {
    if (error instanceof CosmosError && error.code === "not_found") throw error;
    const apiMessage = error instanceof Error ? error.message : String(error);
    try {
      return await fetchElementFromPage(id);
    } catch (pageError) {
      if (pageError instanceof CosmosError && pageError.code === "not_found") throw pageError;
      const pageMessage = pageError instanceof Error ? pageError.message : String(pageError);
      throw new CosmosError("upstream", `${apiMessage} The page fallback also failed: ${pageMessage}`);
    }
  }
}

/** Reads one public element by id. Results stay in memory for an hour. */
export async function getElement(id: string): Promise<Reference> {
  const entry = elements.get(id);
  if (entry?.value && Date.now() - entry.at < ELEMENT_TTL_MS) return entry.value;
  if (entry?.inflight) return entry.inflight;
  const inflight = fetchElement(id).then(
    (value) => {
      remember(elements, id, { value, at: Date.now() }, MAX_CACHED_ELEMENTS);
      return value;
    },
    (error: unknown) => {
      elements.delete(id);
      throw error;
    },
  );
  remember(elements, id, { at: 0, inflight }, MAX_CACHED_ELEMENTS);
  return inflight;
}

/** Reads one element as the token's user, so a private element works too. Never cached. */
export async function getElementWithToken(id: string, token: string): Promise<Reference> {
  const data = await graphql<{ elementView: { element: RawElement | null } | null }>(
    ELEMENT_QUERY,
    { elementId: Number(id) },
    token,
  );
  if (!data.elementView?.element) throw new CosmosError("not_found", `Element not found: ${id}`);
  return toReference(data.elementView.element);
}

// ---------------------------------------------------------------------------------------------
// Search

const SEARCH_QUERY = `
query CosmosMcpSearchElements($searchTerm: String!, $userId: UserId, $contentType: ElementContentTypeFilter, $pageSize: Int, $pageCursor: String) {
  searchElements(searchTerm: $searchTerm, filters: { userId: $userId, contentType: $contentType }, meta: { pageSize: $pageSize, pageCursor: $pageCursor }) {
    results { element { ...Element } }
    meta { nextPageCursor count }
  }
}${ELEMENT_FIELDS}`;

export interface SearchPage {
  references: Reference[];
  nextCursor?: string;
  /** The number of matches Cosmos reports, when it reports one. */
  count?: number;
}

/**
 * Ranks elements by meaning. With userId it searches the elements that user saved, else all of
 * Cosmos. An empty search term returns no items at Cosmos, so callers must not send one.
 */
export async function searchElements(options: {
  searchTerm: string;
  userId?: string;
  kind?: "image" | "video";
  pageSize: number;
  cursor?: string;
  token?: string;
}): Promise<SearchPage> {
  const data = await graphql<{
    searchElements: {
      results: { element: RawElement | null }[];
      meta: { nextPageCursor?: string | null; count?: number | null };
    } | null;
  }>(
    SEARCH_QUERY,
    {
      searchTerm: options.searchTerm,
      userId: options.userId ? Number(options.userId) : null,
      contentType: options.kind === "image" ? "IMAGE" : options.kind === "video" ? "VIDEO" : null,
      pageSize: options.pageSize,
      pageCursor: options.cursor ?? null,
    },
    options.token,
  );
  const result = data.searchElements;
  const references: Reference[] = [];
  const seen = new Set<string>();
  for (const item of result?.results ?? []) {
    if (!item.element) continue;
    const reference = toReference(item.element);
    if (seen.has(reference.id) || (options.kind && reference.kind !== options.kind)) continue;
    seen.add(reference.id);
    references.push(reference);
  }
  const next = result?.meta.nextPageCursor ?? undefined;
  return {
    references,
    nextCursor: next && next !== options.cursor && (result?.results.length ?? 0) > 0 ? next : undefined,
    count: result?.meta.count ?? undefined,
  };
}
