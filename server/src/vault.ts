// The vault: an MCP server for all collections of one linked Cosmos account.
//
// Its reads and its save use the account's bearer token, so they also see private collections.
// Nothing here is cached between requests, because results must never pass from one account or
// device key to another. Only search_cosmos and get_reference read anonymously (shared caches
// hold public data only).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  CosmosError,
  ELEMENT_FIELDS,
  getElement,
  getElementWithToken,
  graphql,
  searchElements,
  toReference,
  type RawElement,
  type Reference,
} from "./cosmos.js";
import { registerDesignTools, type DesignContext } from "./design.js";
import {
  compactText,
  DEFAULT_LIMIT,
  errorResult,
  fullText,
  idSchema,
  limitSchema,
  parseId,
  referenceContent,
} from "./mcp.js";

export const RENEW_HINT = "Visit cosmos.so in Brave to renew the link.";

const CLUSTER_PAGE_SIZE = 50;
const MAX_CLUSTER_PAGES = 20;
const CONNECTION_PAGE_SIZE = 100;
const SEARCH_PAGE_SIZE = 50;
const MAX_SEARCH_PAGES = 10;
/** The most elements list_references reads, across all collections. */
export const MAX_ELEMENTS = 5_000;
/** The most upstream requests one tool call may send. */
const MAX_UPSTREAM_REQUESTS = 300;

export interface VaultContext {
  username: string;
  userId: string;
  /** The current token, or undefined when it is missing or expired. Read it again for each call. */
  token(): string | undefined;
  /** Forget a token that Cosmos refused. */
  dropToken(token: string): void;
}

// ---------------------------------------------------------------------------------------------
// Cosmos operations that need the token

const ME_QUERY = `query CosmosMcpMe { me { id username } }`;

/** Checks a token. Throws CosmosError "auth" when Cosmos does not accept it. */
export async function fetchMe(token: string): Promise<{ id: string; username: string }> {
  const data = await graphql<{ me: { id: number | string; username: string } | null }>(ME_QUERY, {}, token);
  if (!data.me?.username) throw new CosmosError("auth", "Cosmos returned no user for the token.");
  return { id: String(data.me.id), username: data.me.username };
}

const CLUSTER_FIELDS = "id name slug description isPrivate numberOfElements owner { username }";

// The Cosmos web app lists collections with GetUserClusters (userClusters with these arguments).
const USER_CLUSTERS_QUERY = `
query CosmosMcpUserClusters($userId: UserId!, $pageCursor: String, $pageSize: Int) {
  userClusters(userId: $userId, meta: { pageSize: $pageSize, pageCursor: $pageCursor }) {
    items { ${CLUSTER_FIELDS} subClusters { items { ${CLUSTER_FIELDS} } } }
    meta { nextPageCursor count }
  }
}`;

const CONNECTIONS_QUERY = `
query CosmosMcpClusterConnections($clusterId: ClusterId!, $pageCursor: String, $pageSize: Int) {
  clusterConnections(clusterId: $clusterId, meta: { pageSize: $pageSize, pageCursor: $pageCursor }) {
    items { createdAt element { ...Element } }
    meta { nextPageCursor }
  }
}${ELEMENT_FIELDS}`;

// The Cosmos web app saves to collections with EditElementsConnectionsToClusters.
const SAVE_MUTATION = `
mutation CosmosMcpSaveReference($userId: UserId!, $elementIds: [ElementId!]!, $clusterIdsToConnect: [ClusterId!]!, $clusterIdsToDisconnect: [ClusterId!]!) {
  element {
    editElementsConnectionsToClusters(
      input: { userId: $userId, elementIds: $elementIds, clusterIdsToConnect: $clusterIdsToConnect, clusterIdsToDisconnect: $clusterIdsToDisconnect }
    ) { success }
  }
}`;

export interface VaultCollection {
  id: string;
  name: string;
  slug: string;
  description?: string;
  isPrivate: boolean;
  numberOfElements?: number;
  ownerUsername: string;
  parent?: { id: string; name: string; slug: string };
  url: string;
}

interface RawCluster {
  id: number | string;
  name?: string | null;
  slug?: string | null;
  description?: string | null;
  isPrivate?: boolean | null;
  numberOfElements?: number | null;
  owner?: { username?: string | null } | null;
  subClusters?: { items?: RawCluster[] | null } | null;
}

/** Counts upstream requests of one tool call, so a Cosmos fault cannot make a call run forever. */
export class Budget {
  used = 0;
  spend(): void {
    this.used += 1;
    if (this.used > MAX_UPSTREAM_REQUESTS) {
      throw new CosmosError("upstream", `Stopped after ${MAX_UPSTREAM_REQUESTS} requests to Cosmos.`);
    }
  }
}

function toCollection(raw: RawCluster, fallbackOwner: string, parent?: VaultCollection): VaultCollection {
  const ownerUsername = raw.owner?.username ?? parent?.ownerUsername ?? fallbackOwner;
  const slug = raw.slug ?? String(raw.id);
  const path = parent ? `${parent.slug}/${slug}` : slug;
  return {
    id: String(raw.id),
    name: raw.name ?? slug,
    slug,
    description: raw.description?.trim() || undefined,
    isPrivate: raw.isPrivate === true,
    numberOfElements: raw.numberOfElements ?? undefined,
    ownerUsername,
    parent: parent ? { id: parent.id, name: parent.name, slug: parent.slug } : undefined,
    url: `https://www.cosmos.so/${encodeURIComponent(ownerUsername)}/${path}`,
  };
}

export async function fetchCollections(ctx: VaultContext, token: string, budget = new Budget()): Promise<VaultCollection[]> {
  const collections: VaultCollection[] = [];
  const seen = new Set<string>();
  const add = (collection: VaultCollection) => {
    if (seen.has(collection.id)) return;
    seen.add(collection.id);
    collections.push(collection);
  };
  let cursor: string | null = null;
  for (let page = 0; page < MAX_CLUSTER_PAGES; page++) {
    budget.spend();
    const data: { userClusters: { items: RawCluster[]; meta: { nextPageCursor?: string | null } } | null } = await graphql(
      USER_CLUSTERS_QUERY,
      { userId: Number(ctx.userId), pageCursor: cursor, pageSize: CLUSTER_PAGE_SIZE },
      token,
    );
    const items = data.userClusters?.items ?? [];
    for (const raw of items) {
      const top = toCollection(raw, ctx.username);
      add(top);
      for (const sub of raw.subClusters?.items ?? []) add(toCollection(sub, ctx.username, top));
    }
    const next: string | null = data.userClusters?.meta.nextPageCursor ?? null;
    if (!next || next === cursor || items.length === 0) break;
    cursor = next;
  }
  return collections;
}

/** Finds a collection by id, slug, name or cosmos.so URL. Case does not matter. */
export function resolveCollection(
  collections: VaultCollection[],
  wanted: string,
): { collection?: VaultCollection; error?: string } {
  const value = wanted.trim();
  const fromUrl = /cosmos\.so\/[^/?#]+\/([^?#]+)/.exec(value)?.[1]?.replace(/\/+$/, "").split("/").pop();
  const needle = (fromUrl ?? value).toLowerCase();
  const byId = collections.find((c) => c.id === needle);
  if (byId) return { collection: byId };
  const bySlug = collections.filter((c) => c.slug.toLowerCase() === needle);
  const byName = collections.filter((c) => c.name.trim().toLowerCase() === needle);
  const found = bySlug.length > 0 ? bySlug : byName;
  if (found.length === 1) return { collection: found[0] };
  const names = collections.map((c) => `"${c.name}" (slug ${c.slug})`).join(", ") || "none";
  if (found.length > 1) {
    return { error: `More than one collection matches "${wanted}": ${found.map((c) => `${c.name} (id ${c.id})`).join(", ")}. Use the id.` };
  }
  return { error: `No collection matches "${wanted}". The collections are: ${names}. Call list_collections to see them.` };
}

/** Reads one collection page by page, newest saved first. */
class ConnectionStream {
  private buffer: Reference[] = [];
  private cursor: string | null = null;
  private started = false;
  private done = false;

  constructor(
    readonly collection: VaultCollection,
    private readonly token: string,
    private readonly budget: Budget,
  ) {}

  async peek(): Promise<Reference | undefined> {
    while (this.buffer.length === 0 && !this.done) await this.fetchPage();
    return this.buffer[0];
  }

  shift(): Reference | undefined {
    return this.buffer.shift();
  }

  /** The references already read but not yet taken. */
  buffered(): readonly Reference[] {
    return this.buffer;
  }

  private async fetchPage(): Promise<void> {
    if (this.started && !this.cursor) {
      this.done = true;
      return;
    }
    this.budget.spend();
    const data: {
      clusterConnections: {
        items: { createdAt?: string | null; element: RawElement | null }[];
        meta: { nextPageCursor?: string | null };
      } | null;
    } = await graphql(
      CONNECTIONS_QUERY,
      { clusterId: Number(this.collection.id), pageCursor: this.cursor, pageSize: CONNECTION_PAGE_SIZE },
      this.token,
    );
    const items = data.clusterConnections?.items ?? [];
    for (const item of items) {
      if (item.element) this.buffer.push(toReference(item.element, item.createdAt));
    }
    const next = data.clusterConnections?.meta.nextPageCursor ?? null;
    this.cursor = next && next !== this.cursor && items.length > 0 ? next : null;
    this.started = true;
    if (!this.cursor && this.buffer.length === 0) this.done = true;
  }
}

export interface CollectionRef {
  id: string;
  name: string;
  slug: string;
  url: string;
}

export type VaultReference = Reference & { collections: CollectionRef[] };

function collectionRef(collection: VaultCollection): CollectionRef {
  return { id: collection.id, name: collection.name, slug: collection.slug, url: collection.url };
}

function savedTime(reference: Reference): number {
  const time = reference.savedAt ? Date.parse(reference.savedAt) : NaN;
  return Number.isNaN(time) ? -Infinity : time;
}

/**
 * Merges collections into one list, newest saved first. An element in more than one collection
 * shows once, at its newest save, with all its collections. Reads upstream pages only until the
 * list has `want` elements and the next distinct element is known.
 */
export async function mergeCollections(
  collections: VaultCollection[],
  token: string,
  want: number,
  budget = new Budget(),
): Promise<{ references: VaultReference[]; more: boolean; truncated: boolean }> {
  const streams = collections.map((collection) => new ConnectionStream(collection, token, budget));
  const byId = new Map<string, VaultReference>();
  const references: VaultReference[] = [];
  let more = false;
  let truncated = false;

  for (;;) {
    const heads = await Promise.all(streams.map((stream) => stream.peek()));
    let pick = -1;
    for (let index = 0; index < heads.length; index++) {
      const head = heads[index];
      if (head && (pick < 0 || savedTime(head) > savedTime(heads[pick]!))) pick = index;
    }
    if (pick < 0) break;
    const stream = streams[pick]!;
    const reference = stream.shift()!;
    const known = byId.get(reference.id);
    if (known) {
      if (!known.collections.some((c) => c.id === stream.collection.id)) known.collections.push(collectionRef(stream.collection));
      continue;
    }
    if (references.length >= want) {
      more = true;
      break;
    }
    if (byId.size >= MAX_ELEMENTS) {
      truncated = true;
      break;
    }
    const entry: VaultReference = { ...reference, collections: [collectionRef(stream.collection)] };
    byId.set(entry.id, entry);
    references.push(entry);
  }

  // Older saves of a shown element can wait in the buffers: name their collections too.
  for (const stream of streams) {
    for (const reference of stream.buffered()) {
      const known = byId.get(reference.id);
      if (known && !known.collections.some((c) => c.id === stream.collection.id)) {
        known.collections.push(collectionRef(stream.collection));
      }
    }
  }
  return { references, more, truncated };
}

/** All element ids of one collection, up to MAX_ELEMENTS. */
export async function collectionElementIds(collection: VaultCollection, token: string, budget: Budget): Promise<Set<string>> {
  const stream = new ConnectionStream(collection, token, budget);
  const ids = new Set<string>();
  while (ids.size < MAX_ELEMENTS) {
    const reference = await stream.peek();
    if (!reference) break;
    stream.shift();
    ids.add(reference.id);
  }
  return ids;
}

async function saveToCollection(userId: string, elementId: string, collection: VaultCollection, token: string): Promise<void> {
  const data = await graphql<{ element: { editElementsConnectionsToClusters: { success?: boolean | null } | null } | null }>(
    SAVE_MUTATION,
    {
      userId: Number(userId),
      elementIds: [Number(elementId)],
      clusterIdsToConnect: [Number(collection.id)],
      clusterIdsToDisconnect: [],
    },
    token,
  );
  if (data.element?.editElementsConnectionsToClusters?.success !== true) {
    throw new CosmosError("upstream", "Cosmos did not confirm the save (success is not true).");
  }
}

// ---------------------------------------------------------------------------------------------
// Cursors

export interface ListCursor {
  o: number;
  c?: string;
}

export interface SearchCursor {
  /** The upstream cursor of the page to read, null for the first page. */
  u: string | null;
  /** Items of that page that were already looked at. */
  k: number;
}

export function encode(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function decode<T>(cursor: string, check: (value: Record<string, unknown>) => boolean): T | undefined {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    return value && typeof value === "object" && check(value) ? (value as T) : undefined;
  } catch {
    return undefined;
  }
}

export const isCount = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0;

function decodeListCursor(cursor: string): ListCursor | undefined {
  return decode<ListCursor>(cursor, (v) => isCount(v.o) && (v.c === undefined || typeof v.c === "string"));
}

function decodeSearchCursor(cursor: string): SearchCursor | undefined {
  return decode<SearchCursor>(cursor, (v) => (v.u === null || typeof v.u === "string") && isCount(v.k));
}

/**
 * Runs searchElements page by page until `limit` references pass the filter. The cursor marks the
 * upstream page and the position in it, so no result is skipped between calls.
 */
export async function pagedSearch(options: {
  query: string;
  kind?: "image" | "video";
  limit: number;
  cursor?: SearchCursor;
  userId?: string;
  token?: string;
  keep?: (reference: Reference) => boolean;
}): Promise<{ references: Reference[]; nextCursor?: string; count?: number }> {
  const references: Reference[] = [];
  let upstream = options.cursor?.u ?? null;
  let skip = options.cursor?.k ?? 0;
  let count: number | undefined;
  for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
    const result = await searchElements({
      searchTerm: options.query,
      userId: options.userId,
      kind: options.kind,
      pageSize: SEARCH_PAGE_SIZE,
      cursor: upstream ?? undefined,
      token: options.token,
    });
    count ??= result.count;
    const items = result.references;
    for (let index = skip; index < items.length; index++) {
      const reference = items[index]!;
      if (options.keep && !options.keep(reference)) continue;
      references.push(reference);
      if (references.length >= options.limit) {
        const rest = index + 1 < items.length;
        const nextCursor = rest
          ? encode({ u: upstream, k: index + 1 } satisfies SearchCursor)
          : result.nextCursor
            ? encode({ u: result.nextCursor, k: 0 } satisfies SearchCursor)
            : undefined;
        return { references, nextCursor, count };
      }
    }
    if (!result.nextCursor) return { references, count };
    upstream = result.nextCursor;
    skip = 0;
  }
  // Many pages without enough matches: give back what there is, with a cursor to go on.
  return { references, nextCursor: encode({ u: upstream, k: 0 } satisfies SearchCursor), count };
}

// ---------------------------------------------------------------------------------------------
// Text

function vaultText(reference: VaultReference): string {
  const where = reference.collections.map((c) => c.name).join(", ");
  return `${compactText(reference)}${where ? `\n  collections: ${where}` : ""}${reference.savedAt ? `\n  savedAt: ${reference.savedAt}` : ""}`;
}

function collectionText(collection: VaultCollection): string {
  const count = collection.numberOfElements !== undefined ? ` - ${collection.numberOfElements} elements` : "";
  const lines = [`[${collection.id}] ${collection.name} (${collection.isPrivate ? "private" : "public"})${count}`];
  lines.push(`  slug: ${collection.slug}${collection.parent ? ` (inside "${collection.parent.name}")` : ""}`);
  if (collection.ownerUsername) lines.push(`  owner: @${collection.ownerUsername}`);
  lines.push(`  url: ${collection.url}`);
  if (collection.description) lines.push(`  description: ${collection.description}`);
  return lines.join("\n");
}

export function buildVaultInstructions(username: string): string {
  return [
    `This server gives access to the Cosmos (cosmos.so) vault of @${username}: all collections, private ones included.`,
    "The vault holds Henrik's saved design references: images and videos of UI, motion, layout, type and visual style that he saved as examples of what he likes.",
    "Use search_references to find saved references by meaning, list_references to see the newest saves, and list_collections to see the collections.",
    "Use search_cosmos to find new references on all of Cosmos. Use save_reference only when Henrik asks you to save something.",
    "The list and search tools return text only. Call get_reference with an id to see the image.",
    "",
    "First look at the images in Henrik's message. An image that he copied with Cosmos Copy has a thin dark strip at its bottom edge with a label such as \"cosmos 1850854004-65 · call note_references\": the reference id and two check digits. The strip is not part of the design.",
    "When a message has such images, call note_references with the task and the labels before you do other work. The call returns at once and needs no answer from Henrik, so make it also when he is away. The images are his picks: do not open a picker, and follow the steps in the result.",
    "When Henrik says that he does not want a reference, or that he did not like what came of it, call note_references with it in rejected.",
    "",
    "When you design a screen, page or UI for Henrik and he pasted no such image, start from references he picks for that task:",
    "1. Candidates: call contact_sheet with source history (his earlier picks and passes), then with source vault, and with source cosmos and a query for the task. Choose up to 40 candidates by looking, likely picks first.",
    "2. Picks: call start_picks with the task and the candidate ids, and give Henrik the link. Then call wait_for_picks until it returns his picks. Never ask Henrik to tell you that he is done: the server tells you.",
    "3. Plan, build and show: follow the steps in the wait_for_picks result. At the end, call show_variants.",
    "",
    "When Henrik accepts a design, call note_result with the canvas link, the variant, the project and the deviations. It keeps the style of the project.",
    "When Henrik asks for the style of an earlier project, call contact_sheet with source history and that project, and design from its final screenshot and references.",
    "",
    "Use clear_pick_history only when Henrik asks.",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// Server

export function buildVaultServer(ctx: DesignContext): McpServer {
  const server = new McpServer({ name: "cosmos-vault", version: "0.3.0" }, { instructions: buildVaultInstructions(ctx.username) });
  const kindSchema = z.enum(["image", "video"]).optional().describe("Return only images or only videos (videos include animated GIFs).");
  const collectionSchema = z
    .string()
    .min(1)
    .max(300)
    .optional()
    .describe("A collection name, slug or id from list_collections. Leave it out for the whole vault.");

  function failure(error: unknown, what: string): CallToolResult {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(`Could not ${what}: ${message}`);
  }

  /** Runs a tool body with the token. Gives the renew hint when the token is missing or refused. */
  async function withToken(what: string, run: (token: string, budget: Budget) => Promise<CallToolResult>): Promise<CallToolResult> {
    const token = ctx.token();
    if (!token) return errorResult(`The Cosmos link of @${ctx.username} has no valid login token. ${RENEW_HINT}`);
    try {
      return await run(token, new Budget());
    } catch (error) {
      if (error instanceof CosmosError && error.code === "auth") {
        // Check that the token itself is the problem before it is deleted.
        const refused = await fetchMe(token).then(
          () => false,
          (meError: unknown) => meError instanceof CosmosError && meError.code === "auth",
        );
        if (refused) {
          ctx.dropToken(token);
          return errorResult(`Cosmos no longer accepts the linked login token. ${RENEW_HINT}`);
        }
      }
      return failure(error, what);
    }
  }

  server.registerTool(
    "list_collections",
    {
      title: "List Cosmos collections",
      description:
        `List the Cosmos collections of @${ctx.username}, private ones included (marked private). Use the name or ` +
        "slug with list_references, search_references or save_reference. Give the nextCursor of a result as cursor " +
        "to get the next page.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("Maximum number of collections. Default 50, maximum 100."),
        cursor: z.string().max(200).optional().describe("The nextCursor of the previous page."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ limit, cursor }) =>
      withToken("list the collections", async (token, budget) => {
        const position = cursor ? decodeListCursor(cursor) : { o: 0 };
        if (!position) return errorResult("The cursor is not valid. Use the nextCursor of a list_collections result.");
        const collections = await fetchCollections(ctx, token, budget);
        const shown = collections.slice(position.o, position.o + (limit ?? 50));
        const end = position.o + shown.length;
        const nextCursor = end < collections.length ? encode({ o: end } satisfies ListCursor) : undefined;
        let text =
          collections.length === 0
            ? `@${ctx.username} has no collections.`
            : `Collections ${position.o + 1} to ${end} of ${collections.length} of @${ctx.username}.\n\n${shown.map(collectionText).join("\n\n")}`;
        text += nextCursor ? `\n\nnextCursor: ${nextCursor}` : "";
        return {
          content: [{ type: "text", text }],
          structuredContent: { total: collections.length, returned: shown.length, nextCursor: nextCursor ?? null, collections: shown },
        };
      }),
  );

  async function listReferences(
    token: string,
    budget: Budget,
    options: { collection?: string; cursor?: string; limit?: number },
  ): Promise<CallToolResult> {
    const position = options.cursor ? decodeListCursor(options.cursor) : { o: 0 };
    if (!position) return errorResult("The cursor is not valid. Use the nextCursor of a list_references result.");
    const collections = await fetchCollections(ctx, token, budget);
    let chosen = collections;
    let scope = `the vault of @${ctx.username}`;
    if (options.collection) {
      const { collection, error } = resolveCollection(collections, options.collection);
      if (!collection) return errorResult(error!);
      chosen = [collection];
      scope = `the collection "${collection.name}"`;
    }
    const collectionId = options.collection ? chosen[0]!.id : undefined;
    if (options.cursor && position.c !== collectionId) {
      return errorResult("The cursor belongs to another collection. Use the nextCursor with the same collection.");
    }
    const limit = options.limit ?? DEFAULT_LIMIT;
    const { references, more, truncated } = await mergeCollections(chosen, token, position.o + limit, budget);
    const shown = references.slice(position.o);
    const end = position.o + shown.length;
    const nextCursor = more ? encode({ o: end, c: collectionId } satisfies ListCursor) : undefined;
    let text =
      shown.length === 0
        ? `No references at this position in ${scope}.`
        : `References ${position.o + 1} to ${end} in ${scope}, newest saved first.\n\n${shown.map(vaultText).join("\n\n")}`;
    text += nextCursor ? `\n\nnextCursor: ${nextCursor}` : "\n\nThis is the last page.";
    if (truncated) text += `\nThe vault is larger: only its newest ${MAX_ELEMENTS} references are available.`;
    return {
      content: [{ type: "text", text }],
      structuredContent: { offset: position.o, returned: shown.length, nextCursor: nextCursor ?? null, truncated, references: shown },
    };
  }

  server.registerTool(
    "list_references",
    {
      title: "List saved Cosmos references",
      description:
        `List the references @${ctx.username} saved on Cosmos, newest saved first, from all collections or one. An ` +
        "element in more than one collection shows once, with its collections. Give the nextCursor of a result as " +
        "cursor to get the next page. The result is text only: call get_reference with an id to see the image.",
      inputSchema: {
        collection: collectionSchema,
        cursor: z.string().max(500).optional().describe("The nextCursor of the previous page."),
        limit: limitSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ collection, cursor, limit }) =>
      withToken("list the references", (token, budget) => listReferences(token, budget, { collection, cursor, limit })),
  );

  server.registerTool(
    "search_references",
    {
      title: "Search saved Cosmos references",
      description:
        `Search the references @${ctx.username} saved on Cosmos (Henrik's design references: UI, motion, layout, ` +
        "type and visual style). Cosmos ranks the results by meaning, so describe what you look for in plain words, " +
        'such as "dark dashboard with charts" or "playful onboarding animation". Use it when you need visual ' +
        'inspiration, or to find the reference Henrik mentioned ("like that reference I saved"). With no query it ' +
        "lists the newest saves. Give the nextCursor of a result as cursor to get more. The result is text only: " +
        "call get_reference with an id to see the image.",
      inputSchema: {
        query: z.string().max(300).optional().describe("What to find, in plain words. Empty lists the newest saves."),
        collection: collectionSchema,
        kind: kindSchema,
        cursor: z.string().max(1000).optional().describe("The nextCursor of the previous result, with the same query."),
        limit: limitSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ query, collection, kind, cursor, limit }) =>
      withToken("search the references", async (token, budget) => {
        const term = (query ?? "").trim();
        if (!term && !kind) return listReferences(token, budget, { collection, cursor, limit });
        if (!term) {
          // Cosmos returns nothing for an empty term: filter the newest saves by kind here.
          const listed = await listReferences(token, budget, { collection, cursor, limit: 50 });
          const structured = listed.structuredContent as { references?: VaultReference[]; nextCursor?: string | null } | undefined;
          if (listed.isError || !structured?.references) return listed;
          const shown = structured.references.filter((r) => r.kind === kind).slice(0, limit ?? DEFAULT_LIMIT);
          let text =
            shown.length === 0
              ? `No ${kind}s among these saves.`
              : `${shown.length} ${kind}s among the newest saves.\n\n${shown.map(vaultText).join("\n\n")}`;
          if (structured.nextCursor) text += `\n\nnextCursor: ${structured.nextCursor} (call list_references with it for older saves)`;
          return { content: [{ type: "text", text }], structuredContent: { returned: shown.length, references: shown } };
        }

        const position = cursor ? decodeSearchCursor(cursor) : undefined;
        if (cursor && !position) return errorResult("The cursor is not valid. Use the nextCursor of a search_references result.");
        let keep: ((reference: Reference) => boolean) | undefined;
        let scope = `the vault of @${ctx.username}`;
        if (collection) {
          const { collection: found, error } = resolveCollection(await fetchCollections(ctx, token, budget), collection);
          if (!found) return errorResult(error!);
          const ids = await collectionElementIds(found, token, budget);
          keep = (reference) => ids.has(reference.id);
          scope = `the collection "${found.name}"`;
        }
        const result = await pagedSearch({
          query: term,
          kind,
          limit: limit ?? DEFAULT_LIMIT,
          cursor: position,
          userId: ctx.userId,
          token,
          keep,
        });
        let text =
          result.references.length === 0
            ? `No references in ${scope} match "${term}". Try other words, or call list_references.`
            : `${result.references.length} references in ${scope} for "${term}", best match first. Call get_reference with an id to see one.\n\n${result.references.map(compactText).join("\n\n")}`;
        if (result.nextCursor) text += `\n\nnextCursor: ${result.nextCursor}`;
        return {
          content: [{ type: "text", text }],
          structuredContent: { query: term, returned: result.references.length, nextCursor: result.nextCursor ?? null, references: result.references },
        };
      }),
  );

  server.registerTool(
    "get_reference",
    {
      title: "Get and see one Cosmos reference",
      description:
        "Get one Cosmos reference by id, with its metadata and the visual as an image you can see. Use it after " +
        "search_references, list_references or search_cosmos, before you describe a reference or copy its style, and " +
        "when Henrik gives you a cosmos.so/e/<id> link. For a video you get its thumbnail, and the text gives the MP4 URL.",
      inputSchema: { id: idSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id: rawId }) => {
      const id = parseId(rawId);
      if (!id) return errorResult(`"${rawId}" is not a reference id. Use an id from search_references, such as 1754412159.`);
      let reference: Reference;
      try {
        reference = await getElement(id);
      } catch (error) {
        const token = error instanceof CosmosError && error.code === "not_found" ? ctx.token() : undefined;
        if (!token) {
          if (error instanceof CosmosError && error.code === "not_found") {
            return errorResult(`No public Cosmos element has the id ${id}. Call search_references to find ids.`);
          }
          return failure(error, `read the Cosmos element ${id}`);
        }
        // Not public: it can be a private element of this account.
        try {
          reference = await getElementWithToken(id, token);
        } catch (tokenError) {
          if (tokenError instanceof CosmosError && tokenError.code !== "upstream") {
            return errorResult(`No Cosmos element has the id ${id}, or it is private to another account.`);
          }
          return failure(tokenError, `read the Cosmos element ${id}`);
        }
      }
      const { content, visual } = await referenceContent(reference, fullText(reference));
      return { content, structuredContent: { ...reference, visual } };
    },
  );

  server.registerTool(
    "search_cosmos",
    {
      title: "Search all of Cosmos",
      description:
        "Search all public elements on Cosmos (cosmos.so), not only Henrik's saves. Cosmos ranks the results by " +
        "meaning, so describe what you look for in plain words. Use it to find new visual references for a design. " +
        "Save a good one with save_reference only when Henrik asks. Give the nextCursor of a result as cursor to get " +
        "more. The result is text only: call get_reference with an id to see the image.",
      inputSchema: {
        query: z.string().min(1).max(300).describe("What to find, in plain words."),
        kind: kindSchema,
        cursor: z.string().max(1000).optional().describe("The nextCursor of the previous result, with the same query."),
        limit: limitSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, kind, cursor, limit }) => {
      const term = query.trim();
      if (!term) return errorResult("Give a query: Cosmos returns nothing for an empty search.");
      const position = cursor ? decodeSearchCursor(cursor) : undefined;
      if (cursor && !position) return errorResult("The cursor is not valid. Use the nextCursor of a search_cosmos result.");
      try {
        const result = await pagedSearch({ query: term, kind, limit: limit ?? DEFAULT_LIMIT, cursor: position });
        let text =
          result.references.length === 0
            ? `Nothing on Cosmos matches "${term}".`
            : `${result.references.length} Cosmos elements for "${term}", best match first. Call get_reference with an id to see one.\n\n${result.references.map(compactText).join("\n\n")}`;
        if (result.nextCursor) text += `\n\nnextCursor: ${result.nextCursor}`;
        return {
          content: [{ type: "text", text }],
          structuredContent: { query: term, returned: result.references.length, nextCursor: result.nextCursor ?? null, references: result.references },
        };
      } catch (error) {
        return failure(error, "search Cosmos");
      }
    },
  );

  server.registerTool(
    "save_reference",
    {
      title: "Save a reference to a Cosmos collection",
      description:
        `Save a Cosmos element to one of the collections of @${ctx.username}. Use it only when Henrik asks you to ` +
        "save something. The collection must exist: give its name, slug or id from list_collections. This tool never " +
        "makes a new collection. Saving an element that is already in the collection changes nothing.",
      inputSchema: {
        id: idSchema,
        collection: z.string().min(1).max(300).describe("The collection name, slug or id from list_collections."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ id: rawId, collection }) =>
      withToken("save the reference", async (token, budget) => {
        const id = parseId(rawId);
        if (!id) return errorResult(`"${rawId}" is not a reference id. Use an id such as 1754412159.`);
        const { collection: target, error } = resolveCollection(await fetchCollections(ctx, token, budget), collection);
        if (!target) return errorResult(error!);
        await saveToCollection(ctx.userId, id, target, token);
        return {
          content: [{ type: "text", text: `Saved ${id} (https://www.cosmos.so/e/${id}) to "${target.name}": ${target.url}` }],
          structuredContent: { saved: true, id, pageUrl: `https://www.cosmos.so/e/${id}`, collection: target, url: target.url },
        };
      }),
  );

  registerDesignTools(server, ctx, withToken);
  return server;
}
