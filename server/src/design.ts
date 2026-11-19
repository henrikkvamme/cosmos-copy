// The design flow on the vault endpoint: contact sheets, pick sessions, the variants canvas and the
// pick history. The tool results tell the agent the next step, so every agent with the setup URL
// gets the flow without a skill.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { CosmosError, getElement, getElementWithToken, type Reference } from "./cosmos.js";
import { loadVisual } from "./image.js";
import { errorResult, parseId, parseLabel } from "./mcp.js";
import {
  ID_PATTERN,
  MAX_CANDIDATES,
  MAX_VARIANTS,
  type BoardRef,
  type HistoryEntry,
  type HistoryItem,
  type PickStore,
  type Session,
  type Tile,
} from "./picks.js";
import { mapLimit, PER_SHEET, renderSheet, type SheetCell } from "./sheet.js";
import {
  Budget,
  collectionElementIds,
  decode,
  encode,
  fetchCollections,
  isCount,
  mergeCollections,
  pagedSearch,
  resolveCollection,
  type SearchCursor,
  type VaultContext,
} from "./vault.js";

/** How long one wait_for_picks call waits. PICK_WAIT_MS is for tests. */
export const WAIT_MS = Number(process.env.PICK_WAIT_MS ?? 50_000);
const MAX_SHEET_COUNT = 60;
const HISTORY_TASKS_PER_CALL = 3;
const RESOLVE_CONCURRENCY = 8;

/** A cursor holds a short hash of its query, not the query, so a long query still gives a short cursor. */
function queryKey(term: string): string {
  return createHash("sha256").update(term, "utf8").digest("base64url").slice(0, 16);
}
/** A wait_for_picks call answers within WAIT_MS plus this time, image work included. Agents stop a tool call at 60 s. */
const IMAGE_BUDGET_MS = 8_000;
const MAX_PICK_IMAGES = 12;

type Visual = Awaited<ReturnType<typeof loadVisual>>;
const pickVisuals = new Map<string, Promise<Visual | undefined>>();

/** The image of one pick at the size the result uses. Calls for the same image share one download. */
function pickVisual(tile: Tile, count: number): Promise<Visual | undefined> {
  const edge = count <= 6 ? 1024 : 768;
  const key = `${tile.thumb}#${edge}`;
  let visual = pickVisuals.get(key);
  if (!visual) {
    visual = loadVisual({ thumbnailUrl: tile.thumb, width: tile.w }, edge)
      .catch(() => undefined)
      .finally(() => pickVisuals.delete(key));
    pickVisuals.set(key, visual);
  }
  return visual;
}

function picksOf(session: Session): Tile[] {
  const byId = new Map(session.tiles.map((tile) => [tile.id, tile]));
  return session.picked.map((pickId) => byId.get(pickId)).filter((tile): tile is Tile => tile !== undefined);
}

/** Starts the image downloads when Henrik clicks Done, so the waiting tool call finds them in the cache. */
export function prefetchPickImages(session: Session): void {
  const picks = picksOf(session);
  void mapLimit(picks.slice(0, MAX_PICK_IMAGES), RESOLVE_CONCURRENCY, (tile) => pickVisual(tile, picks.length));
}

export const PLAN_TEXT =
  "Propose at most 3 variants, one line each: a close match of one pick, or a mix such as layout of pick 2, colours of pick 5. " +
  "Henrik can change the plan in words, or let it run. If the picks give too little to work from, choose other candidates and call start_picks again.";

export const BUILD_TEXT =
  "Match the reference closely: layout structure, colour palette, type style, shapes, density, spacing and the style of its imagery. " +
  "A reference can show several screens or a device in a scene. Match the UI design itself, not the presentation scene. " +
  "Keep your own content and brand. Do not copy the text or logo of the reference. " +
  "Then do a side by side comparison, three rounds. In each round: render and take a screenshot, read your screenshot and the reference, " +
  "write down the five largest visible differences in style, and fix them.";

export const SHOW_TEXT = "At the end, show the variants: call show_variants with the picks each variant takes from, and upload a screenshot of each.";

export interface DesignContext extends VaultContext {
  picks: PickStore;
  /** The public origin of this server, such as https://cosmos-mcp.henrikkvamme.no. */
  baseUrl: string;
  log(fields: Record<string, unknown>): void;
}

type WithToken = (what: string, run: (token: string, budget: Budget) => Promise<CallToolResult>) => Promise<CallToolResult>;

interface SheetCursor {
  s: "vault" | "cosmos" | "history";
  /** The next number to give. */
  n: number;
  /** vault without a query: offset in the merged list. history: index of the next task. */
  o?: number;
  /** vault: the collection id. */
  c?: string;
  /** search: the upstream page and the position in it. */
  u?: string | null;
  k?: number;
  /** search: the query, so a cursor is not used with another query. */
  q?: string;
}

function decodeSheetCursor(cursor: string): SheetCursor | undefined {
  return decode<SheetCursor>(
    cursor,
    (v) =>
      (v.s === "vault" || v.s === "cosmos" || v.s === "history") &&
      typeof v.n === "number" &&
      Number.isInteger(v.n) &&
      v.n >= 1 &&
      (v.o === undefined || isCount(v.o)) &&
      (v.k === undefined || isCount(v.k)) &&
      (v.u === undefined || v.u === null || typeof v.u === "string") &&
      (v.c === undefined || typeof v.c === "string") &&
      (v.q === undefined || typeof v.q === "string"),
  );
}

function short(text: string | undefined, max = 90): string {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function referenceLine(number: number, reference: Reference): string {
  const kind = reference.animated ? "video (animated)" : reference.kind;
  const what = short([reference.title, reference.description].filter(Boolean).join(" - "));
  return `${number}. [${reference.id}] ${kind}${what ? `: ${what}` : ""}`;
}

function toTile(reference: Reference, round: number): Tile | undefined {
  if (!reference.thumbnailUrl?.startsWith("https://cdn.cosmos.so/")) return undefined;
  return {
    id: reference.id,
    thumb: reference.thumbnailUrl,
    w: reference.width,
    h: reference.height,
    kind: reference.kind === "video" ? "video" : "image",
    round,
  };
}

/** The session id from an id or a picker link. */
function sessionIdFrom(value: string): string | undefined {
  const match = /([A-Za-z0-9_-]{43})\/?$/.exec(value.trim());
  return match && ID_PATTERN.test(match[1]!) ? match[1] : undefined;
}

export function registerDesignTools(server: McpServer, ctx: DesignContext, withToken: WithToken): void {
  const mine = (owner: string) => owner.toLowerCase() === ctx.username.toLowerCase();

  /** Reads an element as public data, else as the account (a private element). */
  async function resolveReference(id: string): Promise<Reference | undefined> {
    try {
      return await getElement(id);
    } catch (error) {
      const token = error instanceof CosmosError && error.code === "not_found" ? ctx.token() : undefined;
      if (!token) return undefined;
      return getElementWithToken(id, token).catch(() => undefined);
    }
  }

  /** Thumbnails the account showed in a picker lately: no request to Cosmos for those. */
  function knownTiles(): Map<string, Tile> {
    const known = new Map<string, Tile>();
    for (const session of ctx.picks.sessionsOf(ctx.username)) {
      for (const tile of session.tiles) if (!known.has(tile.id)) known.set(tile.id, tile);
    }
    return known;
  }

  async function saveOrFail(): Promise<CallToolResult | undefined> {
    try {
      await ctx.picks.save();
      return undefined;
    } catch (error) {
      ctx.log({ level: "error", event: "picks_write_failed", error: (error as Error).message });
      return errorResult("The server could not store this. Try again later.");
    }
  }

  // ---- contact_sheet ----

  async function sheetsResult(
    heading: string,
    groups: { title?: string; cells: SheetCell[]; lines: string[] }[],
    nextCursor: string | undefined,
    next: string,
    structured: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const content: CallToolResult["content"] = [];
    const lines: string[] = [heading];
    for (const group of groups) {
      const sheet = await renderSheet(group.cells);
      if (group.title) lines.push("", group.title);
      lines.push(...group.lines);
      if (sheet.missing.length) lines.push(`(The image of ${sheet.missing.join(", ")} did not load. Leave it out.)`);
      content.push({ type: "image", data: sheet.data, mimeType: sheet.mimeType });
    }
    lines.push("", nextCursor ? `nextCursor: ${nextCursor}` : "This is the last page.", "", next);
    content.unshift({ type: "text", text: lines.join("\n") });
    return { content, structuredContent: { ...structured, nextCursor: nextCursor ?? null } };
  }

  function chunk<T>(items: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
    return out;
  }

  async function referenceSheets(
    heading: string,
    references: Reference[],
    first: number,
    nextCursor: string | undefined,
    source: string,
  ): Promise<CallToolResult> {
    const numbered = references.map((reference, index) => ({ reference, number: first + index }));
    const groups = chunk(numbered, PER_SHEET).map((part) => ({
      cells: part.map(({ reference, number }) => ({ number, thumb: reference.thumbnailUrl, width: reference.width })),
      lines: part.map(({ reference, number }) => referenceLine(number, reference)),
    }));
    if (groups.length === 0) {
      return {
        content: [{ type: "text", text: `${heading}\n\nNothing here.${nextCursor ? `\n\nnextCursor: ${nextCursor}` : ""}` }],
        structuredContent: { source, references: [], nextCursor: nextCursor ?? null },
      };
    }
    return sheetsResult(
      heading,
      groups,
      nextCursor,
      "Choose candidates by looking: the references the result could look like, likely picks first (use the pick history). " +
        "Then call start_picks with the task and their ids.",
      {
        source,
        references: numbered.map(({ reference, number }) => ({ number, id: reference.id, kind: reference.kind, pageUrl: reference.pageUrl, thumbnailUrl: reference.thumbnailUrl })),
      },
    );
  }

  server.registerTool(
    "contact_sheet",
    {
      title: "See references as a contact sheet",
      description:
        "See many references at once: numbered thumbnails in one image (30 per sheet), with a text list that maps each number to " +
        "an id. Use it at the start of a design task: source history shows Henrik's earlier picks (blue frame) and passes (dimmed) " +
        "per task; source vault shows his saved references, newest first, or ranked by meaning with a query; source cosmos shows " +
        "a search of all of Cosmos. Look at the sheets, choose the candidates and their order, then call start_picks.",
      inputSchema: {
        source: z.enum(["vault", "cosmos", "history"]).describe("vault: Henrik's saves. cosmos: all of Cosmos (needs a query). history: his earlier picks and passes."),
        query: z.string().max(300).optional().describe("vault: optional, ranks by meaning. cosmos: required, what to find in plain words."),
        collection: z.string().min(1).max(300).optional().describe("vault only: a collection name, slug or id."),
        count: z.number().int().min(1).max(MAX_SHEET_COUNT).optional().describe(`vault and cosmos: references to show. Default 30, maximum ${MAX_SHEET_COUNT} (2 sheets).`),
        cursor: z.string().max(4000).optional().describe("The nextCursor of the previous contact_sheet result, with the same source and query."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ source, query, collection, count, cursor }) => {
      const position = cursor ? decodeSheetCursor(cursor) : undefined;
      if (cursor && (!position || position.s !== source)) return errorResult("The cursor is not valid for this source. Use the nextCursor of the previous contact_sheet result.");
      const term = (query ?? "").trim();
      if (position?.q !== undefined && position.q !== queryKey(term)) return errorResult("The cursor belongs to another query. Use the same query, or leave out the cursor.");
      const first = position?.n ?? 1;
      const want = count ?? PER_SHEET;

      if (source === "history") {
        const entries = await ctx.picks.history(ctx.username);
        const start = position?.o ?? 0;
        const shown = entries.slice(start, start + HISTORY_TASKS_PER_CALL);
        if (shown.length === 0) {
          return {
            content: [
              {
                type: "text",
                text:
                  start === 0
                    ? "No pick history yet. Choose the candidates from the vault and Cosmos sheets alone."
                    : "No more pick history.",
              },
            ],
            structuredContent: { source, tasks: [] },
          };
        }
        let number = first;
        const groups = shown.map((entry) => {
          const picked = entry.picked.slice(0, PER_SHEET);
          const passed = entry.passed.slice(0, Math.max(0, PER_SHEET - picked.length));
          const items = [...picked.map((item) => ({ item, state: "picked" as const })), ...passed.map((item) => ({ item, state: "passed" as const }))];
          const cells = items.map(({ item, state }) => ({ number: number++, thumb: item.thumb, state }));
          const pickedNumbers = cells.filter((c) => c.state === "picked").map((c) => c.number);
          const passedNumbers = cells.filter((c) => c.state === "passed").map((c) => c.number);
          const hiddenPassed = entry.passed.length - passed.length;
          const range = (numbers: number[]) => (numbers.length ? `${numbers[0]}-${numbers[numbers.length - 1]}` : "none");
          return {
            title: `Task "${entry.task}" (${entry.at.slice(0, 10)}): picked ${range(pickedNumbers)}, passed ${range(passedNumbers)}${hiddenPassed > 0 ? ` (${hiddenPassed} more passes not shown)` : ""}.`,
            cells,
            lines: items.map(({ item }, index) => `${cells[index]!.number}. [${item.id}]`),
          };
        });
        const end = start + shown.length;
        const nextCursor = end < entries.length ? encode({ s: "history", n: number, o: end } satisfies SheetCursor) : undefined;
        return sheetsResult(
          `Pick history of @${ctx.username}: ${shown.length} of ${entries.length} tasks, newest first. One sheet per task.`,
          groups,
          nextCursor,
          "Use what he picked and passed to choose and order the candidates for the new task. Then look at the vault and Cosmos sheets.",
          { source, tasks: shown.map((entry) => ({ task: entry.task, at: entry.at, picked: entry.picked.map((i) => i.id), passed: entry.passed.length })) },
        );
      }

      if (source === "cosmos") {
        if (!term) return errorResult("source cosmos needs a query: what to find, in plain words.");
        try {
          const searchCursor: SearchCursor | undefined = position ? { u: position.u ?? null, k: position.k ?? 0 } : undefined;
          const result = await pagedSearch({ query: term, limit: want, cursor: searchCursor });
          const inner = result.nextCursor ? decode<SearchCursor>(result.nextCursor, () => true) : undefined;
          const nextCursor = inner ? encode({ s: "cosmos", n: first + result.references.length, u: inner.u, k: inner.k, q: queryKey(term) } satisfies SheetCursor) : undefined;
          return referenceSheets(`Cosmos search "${term}": ${first} to ${first + result.references.length - 1}, best match first.`, result.references, first, nextCursor, source);
        } catch (error) {
          return errorResult(`Could not search Cosmos: ${error instanceof Error ? error.message : error}`);
        }
      }

      return withToken("make the contact sheet", async (token, budget) => {
        const collections = await fetchCollections(ctx, token, budget);
        let chosen = collections;
        let scope = `the vault of @${ctx.username}`;
        if (collection) {
          const { collection: found, error } = resolveCollection(collections, collection);
          if (!found) return errorResult(error!);
          chosen = [found];
          scope = `the collection "${found.name}"`;
        }
        const collectionId = collection ? chosen[0]!.id : undefined;
        if (position && position.c !== collectionId) return errorResult("The cursor belongs to another collection. Use the same collection, or leave out the cursor.");

        if (term) {
          let keep: ((reference: Reference) => boolean) | undefined;
          if (collectionId) {
            const ids = await collectionElementIds(chosen[0]!, token, budget);
            keep = (reference) => ids.has(reference.id);
          }
          const searchCursor: SearchCursor | undefined = position ? { u: position.u ?? null, k: position.k ?? 0 } : undefined;
          const result = await pagedSearch({ query: term, limit: want, cursor: searchCursor, userId: ctx.userId, token, keep });
          const inner = result.nextCursor ? decode<SearchCursor>(result.nextCursor, () => true) : undefined;
          const nextCursor = inner
            ? encode({ s: "vault", n: first + result.references.length, u: inner.u, k: inner.k, c: collectionId, q: queryKey(term) } satisfies SheetCursor)
            : undefined;
          return referenceSheets(
            `${scope} for "${term}": ${first} to ${first + result.references.length - 1}. Cosmos ranks by meaning, which does not sort well: judge by looking.`,
            result.references,
            first,
            nextCursor,
            source,
          );
        }

        const offset = position?.o ?? 0;
        const { references, more, truncated } = await mergeCollections(chosen, token, offset + want, budget);
        const shown = references.slice(offset);
        const nextCursor = more ? encode({ s: "vault", n: first + shown.length, o: offset + shown.length, c: collectionId } satisfies SheetCursor) : undefined;
        let heading = `${scope}, newest saved first: ${first} to ${first + shown.length - 1}.`;
        if (truncated) heading += " The vault is larger than the newest 5,000 references.";
        return referenceSheets(heading, shown, first, nextCursor, source);
      });
    },
  );

  // ---- start_picks ----

  server.registerTool(
    "start_picks",
    {
      title: "Start a pick session",
      description:
        "Open a picker page for a design task: a grid of the candidates you chose. Henrik clicks the references he wants the result " +
        'to look like, can ask for "More like these", and clicks Done. Returns the picker link. Give Henrik the link, then call ' +
        "wait_for_picks. Choose the candidates first with contact_sheet (history, then vault and cosmos).",
      inputSchema: {
        task: z.string().min(1).max(200).describe('The design task in a few words, such as "Onboarding for an iOS travel app".'),
        candidates: z
          .array(z.union([z.string().max(200), z.number().int().positive()]))
          .min(1)
          .max(MAX_CANDIDATES)
          .describe(`Reference ids in the order to show, likely picks first. At most ${MAX_CANDIDATES}.`),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ task, candidates }) => {
      const ids: string[] = [];
      const bad: string[] = [];
      for (const raw of candidates) {
        const id = parseId(raw);
        if (!id) bad.push(String(raw));
        else if (!ids.includes(id)) ids.push(id);
      }
      const known = knownTiles();
      const resolved = await mapLimit(ids, RESOLVE_CONCURRENCY, async (id) => {
        const tile = known.get(id);
        if (tile) return { ...tile, round: 0 };
        const reference = await resolveReference(id);
        return reference ? toTile(reference, 0) : undefined;
      });
      const tiles = resolved.filter((tile): tile is Tile => tile !== undefined);
      const skipped = [...bad, ...ids.filter((id, index) => !resolved[index])];
      if (tiles.length === 0) return errorResult(`None of the candidates could be read from Cosmos (${skipped.join(", ")}). Use ids from contact_sheet.`);
      const { id } = ctx.picks.createSession(ctx.username, task.trim(), tiles);
      const failed = await saveOrFail();
      if (failed) return failed;
      const link = `${ctx.baseUrl}/p/${id}`;
      const lines = [
        `Pick session for "${task.trim()}" with ${tiles.length} candidates.`,
        "",
        `Give Henrik this link: ${link}`,
        "",
        `Then call wait_for_picks with session "${id}". It returns his picks when he clicks Done. Do not ask Henrik to tell you that he is done.`,
      ];
      if (skipped.length) lines.push("", `Left out (could not be read): ${skipped.join(", ")}.`);
      return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: { session: id, link, candidates: tiles.length, skipped } };
    },
  );

  // ---- wait_for_picks ----

  async function picksResult(id: string, session: Session, deadline: number): Promise<CallToolResult> {
    const picks = picksOf(session);
    const passed = session.tiles.filter((tile) => !session.picked.includes(tile.id) && !session.hidden.includes(tile.id)).length;
    if (picks.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `Henrik clicked Done on "${session.task}" without picks: none of the ${passed} candidates fit. Look at other references with contact_sheet, then call start_picks again.`,
          },
        ],
        structuredContent: { session: id, task: session.task, status: "done", picks: [], passed },
      };
    }
    const shown = picks.slice(0, MAX_PICK_IMAGES);
    // An image that is not ready by the deadline is left out; the agent can read it with get_reference.
    const late = new Promise<undefined>((resolve) => setTimeout(resolve, Math.max(1_000, deadline - Date.now())));
    const visuals = await mapLimit(shown, RESOLVE_CONCURRENCY, (tile) => Promise.race([pickVisual(tile, picks.length), late]));
    const content: CallToolResult["content"] = [
      {
        type: "text",
        text: `Henrik picked ${picks.length} of ${passed + picks.length} references for "${session.task}", in the order he picked them. Each pick follows as an image.`,
      },
    ];
    shown.forEach((tile, index) => {
      const visual = visuals[index];
      content.push({
        type: "text",
        text: `Pick ${index + 1}: [${tile.id}] ${tile.kind} - https://www.cosmos.so/e/${tile.id}${visual ? "" : " (the image did not load: call get_reference)"}`,
      });
      if (visual) content.push({ type: "image", data: visual.data, mimeType: visual.mimeType });
    });
    if (picks.length > shown.length) {
      content.push({
        type: "text",
        text: `More picks, not shown (call get_reference to see them): ${picks.slice(shown.length).map((tile, index) => `pick ${shown.length + index + 1} [${tile.id}]`).join(", ")}.`,
      });
    }
    content.push({
      type: "text",
      text: [
        "Next steps:",
        `1. Plan. ${PLAN_TEXT}`,
        `2. Build each variant. ${BUILD_TEXT}`,
        `3. Show. ${SHOW_TEXT}`,
      ].join("\n"),
    });
    return {
      content,
      structuredContent: {
        session: id,
        task: session.task,
        status: "done",
        passed,
        picks: picks.map((tile, index) => ({ number: index + 1, id: tile.id, kind: tile.kind, pageUrl: `https://www.cosmos.so/e/${tile.id}`, thumbnailUrl: tile.thumb })),
      },
    };
  }

  server.registerTool(
    "wait_for_picks",
    {
      title: "Wait for Henrik's picks",
      description:
        `Wait until Henrik clicks Done in the picker, then get his picks as images with their ids and the next steps. A call waits up to ${WAIT_MS / 1000} seconds. ` +
        "When it says that he is not done yet, call it again. Never ask Henrik to tell you that he is done.",
      inputSchema: {
        session: z.string().min(1).max(500).describe("The session from start_picks (or the picker link)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ session: raw }, extra) => {
      const id = sessionIdFrom(raw);
      const found = id ? ctx.picks.session(id) : undefined;
      if (!id || !found || !mine(found.username)) {
        return errorResult("No pick session has this id. Sessions expire 7 days after the last change. Call start_picks for a new one.");
      }
      const deadline = Date.now() + WAIT_MS + IMAGE_BUDGET_MS;
      if (found.status !== "done") await ctx.picks.waitDone(id, WAIT_MS, extra.signal);
      const session = ctx.picks.session(id);
      if (!session) return errorResult("The pick session expired. Call start_picks for a new one.");
      if (session.status === "done") return picksResult(id, session, deadline);
      const seen = session.seenAt ? "Henrik has the picker open" : "Henrik has not opened the picker yet";
      return {
        content: [
          {
            type: "text",
            text: `Not done yet. ${seen}, ${session.picked.length} picked so far. Call wait_for_picks again with the same session.${session.seenAt ? "" : ` If he has not seen it, give him the link again: ${ctx.baseUrl}/p/${id}`}`,
          },
        ],
        structuredContent: { session: id, status: "open", picked: session.picked.length, opened: Boolean(session.seenAt) },
      };
    },
  );

  // ---- show_variants ----

  server.registerTool(
    "show_variants",
    {
      title: "Show the variants on a canvas",
      description:
        "At the end of a design task: make a canvas page that shows each variant beside the references it takes from, with pan and zoom. " +
        "Returns the canvas link and one upload command per variant. Run the upload commands with your screenshots, then give Henrik the link.",
      inputSchema: {
        task: z.string().min(1).max(200).describe("The design task, as in start_picks."),
        variants: z
          .array(
            z.object({
              name: z.string().min(1).max(120).describe('One line, such as "Close match of pick 2" or "Layout of pick 2, colours of pick 5".'),
              takes: z
                .array(
                  z.object({
                    id: z.union([z.string().max(200), z.number().int().positive()]).describe("The id of a reference this variant takes from."),
                    what: z.string().max(60).optional().describe('What it takes, such as "layout" or "colours".'),
                  }),
                )
                .max(6)
                .describe("The references (picks) this variant takes from."),
            }),
          )
          .min(1)
          .max(MAX_VARIANTS)
          .describe(`The variants, at most ${MAX_VARIANTS}.`),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ task, variants }) => {
      const known = knownTiles();
      const cache = new Map<string, BoardRef | undefined>();
      const refFor = async (raw: string | number): Promise<BoardRef | undefined> => {
        const id = parseId(raw);
        if (!id) return undefined;
        if (!cache.has(id)) {
          const tile = known.get(id);
          if (tile) cache.set(id, { id, thumb: tile.thumb, w: tile.w, h: tile.h });
          else {
            const reference = await resolveReference(id);
            const asTile = reference && toTile(reference, 0);
            cache.set(id, asTile ? { id, thumb: asTile.thumb, w: asTile.w, h: asTile.h } : undefined);
          }
        }
        return cache.get(id);
      };
      const missing: string[] = [];
      const built = [];
      for (const variant of variants) {
        const takes: BoardRef[] = [];
        for (const take of variant.takes) {
          const ref = await refFor(take.id);
          if (ref) takes.push({ ...ref, what: take.what?.trim() || undefined });
          else missing.push(String(take.id));
        }
        built.push({ name: variant.name.trim(), takes });
      }
      const { id, uploadId } = ctx.picks.createBoard(ctx.username, task.trim(), built);
      const failed = await saveOrFail();
      if (failed) return failed;
      const link = `${ctx.baseUrl}/v/${id}`;
      const uploads = built.map((variant, index) => ({ variant: index + 1, name: variant.name, url: `${ctx.baseUrl}/u/${uploadId}/${index + 1}` }));
      const lines = [
        `Canvas for "${task.trim()}": ${link}`,
        "",
        "Upload one screenshot per variant (PNG, JPEG or WebP, at most 15 MB) from your shell:",
        ...uploads.map((upload) => `  ${upload.variant}. ${upload.name}\n     curl -sS --fail -T <screenshot of variant ${upload.variant}> '${upload.url}'`),
        "",
        "To replace a screenshot, upload again to the same URL. The page shows each one as it arrives.",
        "Then give Henrik the canvas link. He picks one and continues by prompt: keep it, mix two, or make it more unique.",
      ];
      if (missing.length) lines.push("", `Left out (could not be read): ${missing.join(", ")}.`);
      return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: { link, uploads, missing } };
    },
  );

  // ---- note_references ----

  const MAX_NOTED = 20;

  server.registerTool(
    "note_references",
    {
      title: "Note pasted and rejected references",
      description:
        'Call this first when an image in the chat has a dark strip at its bottom edge with a label such as "cosmos 1850854004-65 · call ' +
        'note_references" (a reference id and two check digits). Henrik copied that image from Cosmos as a reference for the task. Give the ' +
        "labels in pasted. The call returns at once and does not wait for Henrik. It records the references as his picks, so no picker is " +
        "needed, and it returns the next steps. The strip is not part of the design. Call it again with rejected when Henrik says that he " +
        "does not want a reference, or did not like what came of it: it then counts as passed.",
      inputSchema: {
        task: z.string().min(1).max(200).describe('The design task in a few words, such as "Onboarding for an iOS travel app". Use the same words in later calls for this task.'),
        pasted: z
          .array(z.string().min(1).max(60))
          .max(MAX_NOTED)
          .optional()
          .describe('The labels on the strips of the pasted images, read digit by digit, such as "1850854004-65". The check digits are required.'),
        rejected: z
          .array(z.union([z.string().min(1).max(200), z.number().int().positive()]))
          .max(MAX_NOTED)
          .optional()
          .describe("References Henrik rejects: a label from a strip, or a reference id."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ task, pasted = [], rejected = [] }) => {
      if (pasted.length === 0 && rejected.length === 0) return errorResult("Give pasted, rejected or both.");
      const pastedIds: string[] = [];
      const misread: string[] = [];
      for (const raw of pasted) {
        const label = parseLabel(raw);
        if ("bad" in label) misread.push(label.bad);
        else if (!pastedIds.includes(label.id)) pastedIds.push(label.id);
      }
      const rejectedIds: string[] = [];
      for (const raw of rejected) {
        // A plain id is fine here. A label must still pass its check digits.
        const label = parseLabel(raw);
        const id = "id" in label ? label.id : parseId(raw);
        if (!id) misread.push(String(raw));
        else if (!rejectedIds.includes(id)) rejectedIds.push(id);
      }
      if (misread.length) {
        return errorResult(
          `Nothing was recorded. ${misread.map((m) => `"${m}"`).join(", ")} ${misread.length === 1 ? "is not a label with correct check digits" : "are not labels with correct check digits"}. ` +
            'Read the strip at the bottom of that image again, digit by digit, and give the label as it is printed, such as "1850854004-65".',
        );
      }

      // The thumbnail of a reference: from the history or a picker session, else from Cosmos.
      const known = knownTiles();
      const inHistory = new Map<string, HistoryItem>();
      for (const entry of await ctx.picks.history(ctx.username)) {
        for (const item of [...entry.picked, ...entry.passed]) if (!inHistory.has(item.id)) inHistory.set(item.id, item);
      }
      // "absent": Cosmos says that the id does not exist. "failed": Cosmos could not be asked.
      const itemFor = async (id: string): Promise<HistoryItem | "absent" | "failed"> => {
        const thumb = inHistory.get(id)?.thumb ?? known.get(id)?.thumb;
        if (thumb) return { id, thumb };
        const notFound = (error: unknown) => error instanceof CosmosError && error.code === "not_found";
        let reference: Reference;
        try {
          reference = await getElement(id);
        } catch (error) {
          if (!notFound(error)) return "failed";
          // A private element is not found as public data. Read it as the account.
          const token = ctx.token();
          if (!token) return "absent";
          try {
            reference = await getElementWithToken(id, token);
          } catch (inner) {
            return notFound(inner) ? "absent" : "failed";
          }
        }
        const tile = toTile(reference, 0);
        return tile ? { id, thumb: tile.thumb } : "absent";
      };
      const all = [...new Set([...pastedIds, ...rejectedIds])];
      const looked = await mapLimit(all, RESOLVE_CONCURRENCY, itemFor);
      if (looked.includes("failed")) {
        return errorResult("Nothing was recorded: Cosmos did not answer for some of the references. The labels are fine. Call note_references again with the same values in a moment.");
      }
      const items = new Map<string, HistoryItem | undefined>();
      looked.forEach((item, index) => items.set(all[index]!, typeof item === "string" ? undefined : item));
      const missing = all.filter((id) => !items.get(id));
      const found = (ids: string[]) => ids.map((id) => items.get(id)).filter((item): item is HistoryItem => item !== undefined);
      const picks = found(pastedIds.filter((id) => !rejectedIds.includes(id)));
      const passes = found(rejectedIds);
      if (picks.length === 0 && passes.length === 0) {
        return errorResult(`Nothing was recorded: Cosmos has no reference with the id ${missing.join(", ")}. Read the strip again.`);
      }
      try {
        await ctx.picks.noteReferences(ctx.username, task, picks, passes);
      } catch (error) {
        ctx.log({ level: "error", event: "history_write_failed", error: (error as Error).message });
        return errorResult("The server could not store this. Try again later.");
      }
      ctx.log({ event: "references_noted", pasted: picks.length, rejected: passes.length });

      const name = task.trim();
      const list = (noted: HistoryItem[]) => noted.map((item) => `[${item.id}]`).join(", ");
      const lines: string[] = [];
      if (picks.length) lines.push(`Recorded ${picks.length} pasted ${picks.length === 1 ? "reference" : "references"} as Henrik's picks for "${name}": ${list(picks)}.`);
      if (passes.length) lines.push(`Marked ${passes.length} ${passes.length === 1 ? "reference" : "references"} as passed for "${name}": ${list(passes)}. Do not build from ${passes.length === 1 ? "it" : "them"}.`);
      if (missing.length) lines.push(`Left out (Cosmos has no reference with this id): ${missing.join(", ")}.`);
      if (picks.length) {
        lines.push(
          "",
          "These are the picks for this task, so do not open a picker. The strip at the bottom of a pasted image is a label, not part of the design: " +
            "do not copy it. Call get_reference with an id for the original image without the strip.",
          "",
          "Next steps:",
          `1. Plan. ${PLAN_TEXT}`,
          `2. Build each variant. ${BUILD_TEXT}`,
          `3. Show. ${SHOW_TEXT}`,
          "",
          "When Henrik says later that he does not want a reference, or did not like what came of it, call note_references again with it in rejected.",
        );
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: { task: name, picked: picks.map((item) => item.id), passed: passes.map((item) => item.id), missing },
      };
    },
  );

  // ---- clear_pick_history ----

  server.registerTool(
    "clear_pick_history",
    {
      title: "Clear the pick history",
      description:
        "Delete Henrik's pick history: what he picked and passed per task. Use it only when Henrik asks. With a task, only the entries " +
        "of that task (the name as contact_sheet history shows it); without, all of it.",
      inputSchema: {
        task: z.string().min(1).max(200).optional().describe("The task name. Leave it out to delete all."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ task }) => {
      try {
        const removed = await ctx.picks.clearHistory(ctx.username, task);
        const text = task
          ? removed > 0
            ? `Deleted ${removed} history ${removed === 1 ? "entry" : "entries"} of the task "${task}".`
            : `No history entry has the task "${task}". Call contact_sheet with source history to see the task names.`
          : `Deleted the whole pick history (${removed} tasks).`;
        return { content: [{ type: "text", text }], structuredContent: { removed } };
      } catch (error) {
        ctx.log({ level: "error", event: "history_write_failed", error: (error as Error).message });
        return errorResult("The server could not change the history. Try again later.");
      }
    },
  );
}

/** The history entry of a session that is done. */
export function historyEntry(session: Session): HistoryEntry {
  const picked = session.picked
    .map((id) => session.tiles.find((tile) => tile.id === id))
    .filter((tile): tile is Tile => tile !== undefined)
    .map((tile) => ({ id: tile.id, thumb: tile.thumb }));
  const passed = session.tiles
    .filter((tile) => !session.picked.includes(tile.id) && !session.hidden.includes(tile.id))
    .map((tile) => ({ id: tile.id, thumb: tile.thumb }));
  return { task: session.task, at: session.doneAt ?? new Date().toISOString(), picked, passed };
}

