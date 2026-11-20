// The design flow on the vault endpoint: contact sheets, pick sessions, the variants canvas and the
// pick history. The tool results tell the agent the next step, so every agent with the setup URL
// gets the flow without a skill.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { z } from "zod";
import { CosmosError, getElement, getElementWithToken, type Reference } from "./cosmos.js";
import { loadVisual } from "./image.js";
import { errorResult, isOwnId, parseFileName, parseId, parseLabel } from "./mcp.js";
import { matchScore, OWN_THUMB_URL, toReference as ownReference } from "./ownvault.js";
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
  RENEW_HINT,
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

/** Starts the image downloads when the user clicks Done, so the waiting tool call finds them in the cache. */
/** The history sheet is the first call of a design task, so its result names the rest of the flow. Some clients do not give the agent the server instructions. */
const AFTER_HISTORY =
  "Next: call contact_sheet with source vault, then with source cosmos and a query for the task. Then call start_picks with the task and the " +
  "candidate ids, and give the user the link. Do not build before they have picked.";

export function prefetchPickImages(session: Session): void {
  const picks = picksOf(session);
  void mapLimit(picks.slice(0, MAX_PICK_IMAGES), RESOLVE_CONCURRENCY, (tile) => pickVisual(tile, picks.length));
}

export const PLAN_TEXT =
  "Propose at most 3 variants, one line each: a close match of one pick, or a mix such as layout of pick 2, colours of pick 5. " +
  "The user can change the plan in words, or let it run. If the picks give too little to work from, choose other candidates and call start_picks again.";

export const BUILD_TEXT =
  "Match the reference closely: layout structure, colour palette, type style, shapes, density, spacing and the style of its imagery. " +
  "A reference can show several screens or a device in a scene. Match the UI design itself, not the presentation scene. " +
  "Keep your own content and brand. Do not copy the text or logo of the reference. " +
  "Then do a side by side comparison, three rounds. In each round: render and take a screenshot, read your screenshot and the reference, " +
  "write down the five largest visible differences in style, and fix them.";

export const SHOW_TEXT =
  "At the end, show the variants: call show_variants with the picks each variant takes from, and upload a screenshot of each. " +
  "When the user accepts a design, call note_result.";

/** The final screenshot of a style record: small enough to send in a tool result, three per history page. */
const RESULT_WIDTH = 1280;
const RESULT_MAX_HEIGHT = 2000;
const RESULT_MAX_BASE64 = 1_200_000;

/** The top of a canvas screenshot as a JPEG within the size limits. A long page loses its lower part. */
async function resultImage(source: Buffer): Promise<{ data: Buffer; w: number; h: number }> {
  for (const [width, quality] of [[RESULT_WIDTH, 80], [RESULT_WIDTH, 60], [960, 60], [720, 50]] as const) {
    const fitted = await sharp(source).resize({ width, withoutEnlargement: true }).toBuffer({ resolveWithObject: true });
    const height = Math.min(fitted.info.height, Math.round((RESULT_MAX_HEIGHT * fitted.info.width) / RESULT_WIDTH));
    const { data, info } = await sharp(fitted.data)
      .extract({ left: 0, top: 0, width: fitted.info.width, height })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    if (Math.ceil(data.length / 3) * 4 <= RESULT_MAX_BASE64) return { data, w: info.width, h: info.height };
  }
  throw new Error("the screenshot stays too large after downscaling");
}

export interface DesignContext extends VaultContext {
  picks: PickStore;
  /** The public origin of this server, such as https://tasteref.henrikkvamme.no. */
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
  /** search: the query, so a cursor is not used with another query. history: the project filter. */
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
  // Tiles come from references that this server resolved: the Cosmos CDN, or the own vault.
  const thumb = reference.thumbnailUrl;
  if (!thumb || (!thumb.startsWith("https://cdn.cosmos.so/") && !OWN_THUMB_URL.test(thumb))) return undefined;
  return {
    id: reference.id,
    thumb,
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
  const mine = (owner: string) => owner === ctx.userId;

  /** A reference from another site, from the own vault. */
  async function ownById(id: string): Promise<Reference | undefined> {
    const item = ctx.own && ctx.userId ? await ctx.own.get(ctx.userId, id).catch(() => undefined) : undefined;
    return item ? ownReference(ctx.baseUrl, ctx.userId, item) : undefined;
  }
  /** The page of a reference: on Cosmos, or on the vault page for a reference from another site. */
  const pageOf = (id: string) => (isOwnId(id) ? `${ctx.baseUrl}/vault#${id}` : `https://www.cosmos.so/e/${id}`);

  /** Reads an element as public data, else as the account (a private element). */
  async function resolveReference(id: string): Promise<Reference | undefined> {
    if (isOwnId(id)) return ownById(id);
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
    for (const session of ctx.picks.sessionsOf(ctx.userId)) {
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
    groups: { title?: string; cells: SheetCell[]; lines: string[]; after?: { lines: string[]; image?: Buffer } }[],
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
      if (group.after) {
        lines.push(...group.after.lines);
        if (group.after.image) content.push({ type: "image", data: group.after.image.toString("base64"), mimeType: "image/jpeg" });
      }
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
        "an id. Use it at the start of a design task: source history shows the user's earlier picks (blue frame) and passes (dimmed) per task, and the style record of a project (its final screenshot; give project to see one project); " +
        "source vault shows their saved references, newest first, or ranked by meaning with a query; source cosmos shows " +
        "a search of all of Cosmos. Look at the sheets, choose the candidates and their order, then call start_picks.",
      inputSchema: {
        source: z.enum(["vault", "cosmos", "history"]).describe("vault: the user's saves. cosmos: all of Cosmos (needs a query). history: their earlier picks and passes."),
        query: z.string().max(300).optional().describe("vault: optional, ranks by meaning. cosmos: required, what to find in plain words."),
        collection: z.string().min(1).max(300).optional().describe("vault only: a collection name, slug or id."),
        count: z.number().int().min(1).max(MAX_SHEET_COUNT).optional().describe(`vault and cosmos: references to show. Default 30, maximum ${MAX_SHEET_COUNT} (2 sheets).`),
        cursor: z.string().max(4000).optional().describe("The nextCursor of the previous contact_sheet result, with the same source and query."),
        project: z.string().min(1).max(80).optional().describe('history only: show the tasks of one project, such as "zug-web". Use it when the user asks for the style of a project.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ source, query, collection, count, cursor, project }) => {
      const position = cursor ? decodeSheetCursor(cursor) : undefined;
      if (cursor && (!position || position.s !== source)) return errorResult("The cursor is not valid for this source. Use the nextCursor of the previous contact_sheet result.");
      const term = source === "history" ? (project ?? "").trim().toLowerCase() : (query ?? "").trim();
      if (position?.q !== undefined && position.q !== queryKey(term)) return errorResult("The cursor belongs to another query. Use the same query, or leave out the cursor.");
      if (source === "history" && position && position.q === undefined && term) return errorResult("The cursor belongs to a history without a project. Leave out the cursor.");
      const first = position?.n ?? 1;
      const want = count ?? PER_SHEET;

      if (source === "history") {
        const all = await ctx.picks.history(ctx.userId);
        const projects = [...new Map(all.filter((e) => e.project).map((e) => [e.project!.toLowerCase(), e.project!])).values()];
        const entries = term ? all.filter((e) => e.project?.toLowerCase() === term) : all;
        const start = position?.o ?? 0;
        const shown = entries.slice(start, start + HISTORY_TASKS_PER_CALL);
        if (shown.length === 0) {
          const none = term
            ? `No task has the project "${project!.trim()}". ${projects.length ? `Projects with a style record: ${projects.join(", ")}.` : "No project has a style record yet."}`
            : start === 0
              ? `No pick history yet. ${AFTER_HISTORY}`
              : "No more pick history.";
          return { content: [{ type: "text", text: none }], structuredContent: { source, tasks: [], projects } };
        }
        let number = first;
        const groups = await Promise.all(
          shown.map(async (entry) => {
            const picked = entry.picked.slice(0, PER_SHEET);
            const passed = entry.passed.slice(0, Math.max(0, PER_SHEET - picked.length));
            const items = [...picked.map((item) => ({ item, state: "picked" as const })), ...passed.map((item) => ({ item, state: "passed" as const }))];
            const cells = items.map(({ item, state }) => ({ number: number++, thumb: item.thumb, state }));
            const pickedNumbers = cells.filter((c) => c.state === "picked").map((c) => c.number);
            const passedNumbers = cells.filter((c) => c.state === "passed").map((c) => c.number);
            const hiddenPassed = entry.passed.length - passed.length;
            const range = (numbers: number[]) => (numbers.length ? `${numbers[0]}-${numbers[numbers.length - 1]}` : "none");
            const result = entry.result;
            // The record names its references by id: the picks of the task can change after it was made.
            const after = result && {
              lines: [
                `Result for the project "${entry.project}" (${result.at.slice(0, 10)}), variant "${result.variant}". The image after this sheet is its final screenshot.`,
                ...result.took.map((take) => `  took from [${take.id}]: ${take.what}`),
                `  deviations: ${result.deviations}`,
              ],
              image: await ctx.picks.readResultImage(ctx.userId, result.file),
            };
            return {
              title: `Task "${entry.task}" (${entry.at.slice(0, 10)})${entry.project ? `, project "${entry.project}"` : ""}: picked ${range(pickedNumbers)}, passed ${range(passedNumbers)}${hiddenPassed > 0 ? ` (${hiddenPassed} more passes not shown)` : ""}.`,
              cells,
              lines: items.map(({ item }, index) => `${cells[index]!.number}. [${item.id}]`),
              after: after || undefined,
            };
          }),
        );
        const end = start + shown.length;
        const nextCursor = end < entries.length ? encode({ s: "history", n: number, o: end, ...(term ? { q: queryKey(term) } : {}) } satisfies SheetCursor) : undefined;
        return sheetsResult(
          `Pick history of @${ctx.username}${term ? `, project "${project!.trim()}"` : ""}: ${shown.length} of ${entries.length} tasks, newest first. One sheet per task.` +
            (projects.length && !term ? `\nProjects with a style record: ${projects.join(", ")}. Give project to see one.` : ""),
          groups,
          nextCursor,
          term
            ? "To design in the style of this project, match the final screenshot, and use the references and the deviations to see what the style keeps and what it changes."
            : `Use what they picked and passed to choose and order the candidates for the new task. ${AFTER_HISTORY}`,
          {
            source,
            projects,
            tasks: shown.map((entry) => ({
              task: entry.task,
              at: entry.at,
              picked: entry.picked.map((i) => i.id),
              passed: entry.passed.length,
              ...(entry.project ? { project: entry.project } : {}),
              ...(entry.result ? { result: { variant: entry.result.variant, took: entry.result.took.map(({ id, what }) => ({ id, what })), deviations: entry.result.deviations } } : {}),
            })),
          },
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

      // The references from other sites, in the whole vault only: a collection is a Cosmos collection.
      const ownAll = collection || !ctx.own || !ctx.userId ? [] : await ctx.own.list(ctx.userId).catch(() => []);
      const ownFound = (term ? ownAll.map((item) => ({ item, score: matchScore(item, term) })).filter((m) => m.score > 0).sort((a, b) => b.score - a.score).map((m) => m.item) : ownAll).map((item) =>
        ownReference(ctx.baseUrl, ctx.userId, item),
      );
      if (!ctx.token() && !collection && ctx.own && ctx.userId) {
        // No Cosmos login: the sheet still shows what this server stores.
        const offset = position?.o ?? 0;
        const shown = ownFound.slice(offset, offset + want);
        const nextCursor = ownFound.length > offset + want ? encode({ s: "vault", n: first + shown.length, o: offset + shown.length, ...(term ? { q: queryKey(term) } : {}) } satisfies SheetCursor) : undefined;
        return referenceSheets(
          `The references from other sites in the vault of @${ctx.username}${term ? ` for "${term}"` : ""}: ${first} to ${first + shown.length - 1}. Cosmos references are not in this result: the Cosmos link has no valid login token. ${RENEW_HINT}`,
          shown,
          first,
          nextCursor,
          source,
        );
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
          // The matches from other sites come first, on the first sheet only: the two sources do not share a cursor.
          // They take their places from the count, and leave one place or more for Cosmos.
          const ownShare = position ? [] : ownFound.slice(0, Math.min(PER_SHEET, want - 1));
          const result = await pagedSearch({ query: term, limit: want - ownShare.length, cursor: searchCursor, userId: ctx.userId, token, keep });
          const found = [...ownShare, ...result.references];
          const inner = result.nextCursor ? decode<SearchCursor>(result.nextCursor, () => true) : undefined;
          const nextCursor = inner
            ? encode({ s: "vault", n: first + found.length, u: inner.u, k: inner.k, c: collectionId, q: queryKey(term) } satisfies SheetCursor)
            : undefined;
          return referenceSheets(
            `${scope} for "${term}": ${first} to ${first + found.length - 1}. Cosmos ranks by meaning, which does not sort well: judge by looking.`,
            found,
            first,
            nextCursor,
            source,
          );
        }

        const offset = position?.o ?? 0;
        const fromCosmos = await mergeCollections(chosen, token, offset + want, budget);
        // The references from other sites are in the whole vault, not in a Cosmos collection.
        const own = ownFound;
        const time = (reference: Reference) => Date.parse(reference.savedAt ?? reference.createdAt ?? "") || 0;
        const references = own.length ? [...fromCosmos.references, ...own].sort((a, b) => time(b) - time(a)) : fromCosmos.references;
        const shown = references.slice(offset, offset + want);
        const more = fromCosmos.more || references.length > offset + want;
        const truncated = fromCosmos.truncated;
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
        "Open a picker page for a design task: a grid of the candidates you chose. The user clicks the references they want the result " +
        'to look like, can ask for "More like these", and clicks Done. Returns the picker link. Give the user the link, then call ' +
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
      const { id } = ctx.picks.createSession(ctx.userId, task.trim(), tiles);
      const failed = await saveOrFail();
      if (failed) return failed;
      const link = `${ctx.baseUrl}/p/${id}`;
      const lines = [
        `Pick session for "${task.trim()}" with ${tiles.length} candidates.`,
        "",
        `Give the user this link: ${link}`,
        "",
        `Then call wait_for_picks with session "${id}". It returns their picks when they click Done. Do not ask the user to tell you that they are done.`,
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
            text: `The user clicked Done on "${session.task}" without picks: none of the ${passed} candidates fit. Look at other references with contact_sheet, then call start_picks again.`,
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
        text: `The user picked ${picks.length} of ${passed + picks.length} references for "${session.task}", in the order they picked them. Each pick follows as an image.`,
      },
    ];
    shown.forEach((tile, index) => {
      const visual = visuals[index];
      content.push({
        type: "text",
        text: `Pick ${index + 1}: [${tile.id}] ${tile.kind} - ${pageOf(tile.id)}${visual ? "" : " (the image did not load: call get_reference)"}`,
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
        picks: picks.map((tile, index) => ({ number: index + 1, id: tile.id, kind: tile.kind, pageUrl: pageOf(tile.id), thumbnailUrl: tile.thumb })),
      },
    };
  }

  server.registerTool(
    "wait_for_picks",
    {
      title: "Wait for the user's picks",
      description:
        `Wait until the user clicks Done in the picker, then get their picks as images with their ids and the next steps. A call waits up to ${WAIT_MS / 1000} seconds. ` +
        "When it says that they are not done yet, call it again. Never ask the user to tell you that they are done.",
      inputSchema: {
        session: z.string().min(1).max(500).describe("The session from start_picks (or the picker link)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ session: raw }, extra) => {
      const id = sessionIdFrom(raw);
      const found = id ? ctx.picks.session(id) : undefined;
      if (!id || !found || !mine(found.owner)) {
        return errorResult("No pick session has this id. Sessions expire 7 days after the last change. Call start_picks for a new one.");
      }
      const deadline = Date.now() + WAIT_MS + IMAGE_BUDGET_MS;
      if (found.status !== "done") await ctx.picks.waitDone(id, WAIT_MS, extra.signal);
      const session = ctx.picks.session(id);
      if (!session) return errorResult("The pick session expired. Call start_picks for a new one.");
      if (session.status === "done") return picksResult(id, session, deadline);
      const seen = session.seenAt ? "The user has the picker open" : "The user has not opened the picker yet";
      return {
        content: [
          {
            type: "text",
            text: `Not done yet. ${seen}, ${session.picked.length} picked so far. Call wait_for_picks again with the same session.${session.seenAt ? "" : ` If they have not seen it, give them the link again: ${ctx.baseUrl}/p/${id}`}`,
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
        "Returns the canvas link and one upload command per variant. Run the upload commands with your screenshots, then give the user the link.",
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
      const { id, uploadId } = ctx.picks.createBoard(ctx.userId, task.trim(), built);
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
        "Then give the user the canvas link. They pick one and continue by prompt: keep it, mix two, or make it more unique.",
        "When they accept a design, call note_result with this canvas link, the number of the variant, the project and the deviations. " +
          "If the accepted design is not on a canvas, call show_variants with it first.",
      ];
      if (missing.length) lines.push("", `Left out (could not be read): ${missing.join(", ")}.`);
      return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: { link, uploads, missing } };
    },
  );

  // ---- note_result ----

  server.registerTool(
    "note_result",
    {
      title: "Record the accepted design",
      description:
        "Call this when the user accepts a design. It keeps a style record for the project: the references the design took from, what it took, " +
        "how it deviates from them, and the final screenshot from the canvas. Later tasks get the record with contact_sheet (source history, " +
        "project). The design must be a variant on a canvas from show_variants, with its screenshot uploaded.",
      inputSchema: {
        canvas: z.string().min(1).max(500).describe("The canvas link from show_variants."),
        variant: z.number().int().min(1).max(MAX_VARIANTS).describe("The number of the accepted variant on the canvas."),
        project: z.string().min(1).max(80).describe('The app or repository the design is for, such as "zug-web". Use the same name each time.'),
        deviations: z
          .string()
          .min(1)
          .max(600)
          .describe("How the accepted design deviates from the references, and what the user changed in words. One to three sentences."),
        took: z
          .array(z.object({ id: z.union([z.string().max(200), z.number().int().positive()]), what: z.string().min(1).max(120) }))
          .max(6)
          .optional()
          .describe("What the design took from each reference. Needed for a reference that has no such note on the canvas. It replaces the note of the canvas."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ canvas, variant, project, deviations, took = [] }) => {
      const id = /([A-Za-z0-9_-]{43})\/?$/.exec(canvas.trim().split(/[?#]/)[0]!)?.[1];
      const found = id ? ctx.picks.boardWithHash(id) : undefined;
      if (!found || found.board.owner !== ctx.userId) {
        return errorResult("No canvas has this link. Canvases expire after 30 days. Call show_variants with the accepted design, then call note_result with the new link.");
      }
      const chosen = found.board.variants[variant - 1];
      if (!chosen) return errorResult(`The canvas has ${found.board.variants.length} variants. Give a variant number from 1 to ${found.board.variants.length}.`);
      if (!chosen.image) return errorResult(`Variant ${variant} has no screenshot yet. Upload it with the command from show_variants, then call note_result again.`);
      const notes = new Map<string, string>();
      for (const take of took) {
        const takeId = parseId(take.id);
        if (takeId && take.what.trim()) notes.set(takeId, take.what.trim());
      }
      const unknown = [...notes.keys()].filter((takeId) => !chosen.takes.some((ref) => ref.id === takeId));
      if (unknown.length) return errorResult(`Variant ${variant} does not take from ${unknown.join(", ")}. Its references are ${chosen.takes.map((ref) => ref.id).join(", ") || "none"}.`);
      if (chosen.takes.length === 0) return errorResult(`Variant ${variant} names no references. Call show_variants with the references it takes from, then call note_result with the new link.`);
      const taken = chosen.takes.map((ref) => ({ id: ref.id, thumb: ref.thumb, what: notes.get(ref.id) ?? ref.what ?? "" }));
      const blank = taken.filter((take) => !take.what).map((take) => take.id);
      if (blank.length) return errorResult(`Say what the design took from ${blank.join(", ")}: give took with an id and what for each, such as "layout" or "colours".`);
      let image: { data: Buffer; w: number; h: number };
      try {
        image = await resultImage(await readFile(ctx.picks.imageFile(found.hash, variant - 1)));
      } catch (error) {
        return errorResult(`Could not read the screenshot of variant ${variant}: ${error instanceof Error ? error.message : error}. Upload it again, then call note_result again.`);
      }
      try {
        // The file is written first, and the history changes in one step after it. A file that no entry names is deleted later.
        const file = await ctx.picks.writeResultImage(ctx.userId, image.data);
        const { replaced } = await ctx.picks.noteResult(ctx.userId, found.board.task, project.trim(), {
          at: new Date().toISOString(),
          board: found.hash,
          variant: chosen.name,
          took: taken,
          deviations: deviations.trim(),
          file,
          image: { w: image.w, h: image.h },
        });
        ctx.log({ event: "result_noted", took: taken.length, replaced });
        return {
          content: [
            {
              type: "text",
              text:
                `${replaced ? "Replaced" : "Recorded"} the style record of "${found.board.task}" for the project "${project.trim()}": variant "${chosen.name}", ` +
                `${taken.length} reference${taken.length === 1 ? "" : "s"} and the final screenshot. ` +
                `A later task gets it with contact_sheet, source history, project "${project.trim()}".`,
            },
          ],
          structuredContent: { task: found.board.task, project: project.trim(), variant: chosen.name, took: taken.map(({ id: takeId, what }) => ({ id: takeId, what })), replaced },
        };
      } catch (error) {
        ctx.log({ level: "error", event: "result_write_failed", error: error instanceof Error ? error.message : String(error) });
        return errorResult("Could not store the style record. Call note_result again in a moment.");
      }
    },
  );

  // ---- note_references ----

  const MAX_NOTED = 20;
  // Some models send one label as a plain value, not as a list. In a test, GPT-6 Luna did so in 9 of 14 runs.
  const oneAsList = (value: unknown): unknown => (typeof value === "string" || typeof value === "number" ? [value] : value);

  server.registerTool(
    "note_references",
    {
      title: "Note pasted and rejected references",
      description:
        'Call this first when an image in the chat has a dark strip at its bottom edge with a label such as "cosmos 1850854004-65 · call ' +
        'note_references" (a reference id and two check digits). The user copied that image from Cosmos as a reference for the task. Give the ' +
        'labels in pasted. Call it also when the user attached a file with a name such as "cosmos-1277394779.mp4" (a video has no strip): give ' +
        "the file name in pasted. The call returns at once and does not wait for the user. It records the references as their picks, so no picker is " +
        "needed, and it returns the next steps. The strip is not part of the design. Call it again with rejected when the user says that they " +
        "does not want a reference, or did not like what came of it: it then counts as passed.",
      inputSchema: {
        task: z.string().min(1).max(200).describe('The design task in a few words, such as "Onboarding for an iOS travel app". Use the same words in later calls for this task.'),
        pasted: z
          .preprocess(oneAsList, z.array(z.string().min(1).max(60)).max(MAX_NOTED))
          .optional()
          .describe(
            'The labels on the strips of the pasted images, read digit by digit, such as "1850854004-65". The check digits are required. ' +
              'For an attached file without a strip, its name, such as "cosmos-1277394779.mp4".',
          ),
        rejected: z
          .preprocess(oneAsList, z.array(z.union([z.string().min(1).max(200), z.number().int().positive()])).max(MAX_NOTED))
          .optional()
          .describe("References the user rejects: a label from a strip, a file name, or a reference id."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ task, pasted = [], rejected = [] }) => {
      if (pasted.length === 0 && rejected.length === 0) return errorResult('Nothing was recorded: give the labels in "pasted", the rejected references in "rejected", or both. Example: {"task": "Travel app home screen", "pasted": ["1850854004-65"]}.');
      const pastedIds: string[] = [];
      const misread: string[] = [];
      for (const raw of pasted) {
        const label = parseLabel(raw);
        const id = "id" in label ? label.id : parseFileName(raw);
        if (!id) misread.push(String(raw).trim());
        else if (!pastedIds.includes(id)) pastedIds.push(id);
      }
      const rejectedIds: string[] = [];
      for (const raw of rejected) {
        // A plain id is fine here. A label must still pass its check digits.
        const label = parseLabel(raw);
        const id = "id" in label ? label.id : (parseFileName(raw) ?? parseId(raw));
        if (!id) misread.push(String(raw));
        else if (!rejectedIds.includes(id)) rejectedIds.push(id);
      }
      if (misread.length) {
        return errorResult(
          `Nothing was recorded. ${misread.map((m) => `"${m}"`).join(", ")} ${misread.length === 1 ? "is not a label with correct check digits" : "are not labels with correct check digits"}. ` +
            'Read the strip at the bottom of that image again, digit by digit, and give the label as it is printed, such as "1850854004-65". ' +
            'For a file without a strip, give its name, such as "cosmos-1277394779.mp4".',
        );
      }

      // The thumbnail of a reference: from the history or a picker session, else from Cosmos.
      const known = knownTiles();
      const inHistory = new Map<string, HistoryItem>();
      for (const entry of await ctx.picks.history(ctx.userId)) {
        for (const item of [...entry.picked, ...entry.passed]) if (!inHistory.has(item.id)) inHistory.set(item.id, item);
      }
      // "absent": Cosmos says that the id does not exist. "failed": Cosmos could not be asked.
      const itemFor = async (id: string): Promise<HistoryItem | "absent" | "failed"> => {
        const thumb = inHistory.get(id)?.thumb ?? known.get(id)?.thumb;
        if (thumb) return { id, thumb };
        const notFound = (error: unknown) => error instanceof CosmosError && error.code === "not_found";
        if (isOwnId(id)) {
          const own = await ownById(id);
          const ownTile = own && toTile(own, 0);
          return ownTile ? { id, thumb: ownTile.thumb } : "absent";
        }
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
        return errorResult(`Nothing was recorded: Cosmos has no reference with the id ${missing.join(", ")}. Read the strip or the file name again.`);
      }
      try {
        await ctx.picks.noteReferences(ctx.userId, task, picks, passes);
      } catch (error) {
        ctx.log({ level: "error", event: "history_write_failed", error: (error as Error).message });
        return errorResult("The server could not store this. Try again later.");
      }
      ctx.log({ event: "references_noted", pasted: picks.length, rejected: passes.length });

      const name = task.trim();
      const list = (noted: HistoryItem[]) => noted.map((item) => `[${item.id}]`).join(", ");
      const lines: string[] = [];
      if (picks.length) lines.push(`Recorded ${picks.length} pasted ${picks.length === 1 ? "reference" : "references"} as the user's picks for "${name}": ${list(picks)}.`);
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
          "When the user says later that they do not want a reference, or did not like what came of it, call note_references again with it in rejected.",
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
        "Delete the user's pick history: what they picked and passed per task. Use it only when the user asks. With a task, only the entries " +
        "of that task (the name as contact_sheet history shows it); without, all of it.",
      inputSchema: {
        task: z.string().min(1).max(200).optional().describe("The task name. Leave it out to delete all."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ task }) => {
      try {
        const removed = await ctx.picks.clearHistory(ctx.userId, task);
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

