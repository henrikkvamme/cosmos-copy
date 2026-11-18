// The MCP server for one Cosmos collection. A new instance is made for each HTTP request.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { CosmosError, getCollection, getElement, type Collection, type Reference } from "./cosmos.js";
import { loadVisual } from "./image.js";

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;

export function buildInstructions(username: string, slug: string, collection?: Collection): string {
  const url = `https://www.cosmos.so/${username}/${slug}`;
  const what = collection
    ? `"${collection.name}" by ${collection.ownerName ?? username} (${url}, ${collection.references.length} elements)`
    : url;
  return [
    `This server gives read-only access to the public Cosmos (cosmos.so) collection ${what}.`,
    "The collection holds Henrik's saved design references: images and videos of UI, motion, layout, type and visual style that he saved as examples of what he likes.",
    "Use it when you need visual inspiration for design work, or when Henrik mentions a reference he saved.",
    "search_references and list_references return text only. Call get_reference with an id to see the image.",
  ].join(" ");
}

export function compactText(reference: Reference): string {
  const head = [reference.title, reference.description].filter(Boolean).join(" - ") || "(no description)";
  const lines = [`[${reference.id}] ${reference.animated ? "video (animated)" : reference.kind} - ${head}`];
  const author = [reference.author, reference.authorUsername && `@${reference.authorUsername}`].filter(Boolean).join(" ");
  if (author) lines.push(`  author: ${author}`);
  lines.push(`  pageUrl: ${reference.pageUrl}`);
  if (reference.mediaUrl) lines.push(`  mediaUrl: ${reference.mediaUrl}`);
  if (reference.sourceUrl) lines.push(`  sourceUrl: ${reference.sourceUrl}`);
  return lines.join("\n");
}

export function fullText(reference: Reference): string {
  const rows: [string, string | number | undefined][] = [
    ["id", reference.id],
    ["kind", reference.animated ? "video (short animated loop)" : reference.kind],
    ["title", reference.title],
    ["description", reference.description],
    ["author", reference.author],
    ["authorUsername", reference.authorUsername],
    ["authorUrl", reference.authorUrl],
    ["sourceUrl", reference.sourceUrl],
    ["pageUrl", reference.pageUrl],
    ["mediaUrl", reference.mediaUrl],
    ["thumbnailUrl", reference.kind === "video" ? reference.thumbnailUrl : undefined],
    ["size", reference.width && reference.height ? `${reference.width} x ${reference.height} px` : undefined],
    ["durationSeconds", reference.durationSeconds],
    ["savedAt", reference.savedAt],
    ["createdAt", reference.createdAt],
  ];
  return rows
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
}

export function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function matches(reference: Reference, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = [
    reference.title,
    reference.description,
    reference.text,
    reference.author,
    reference.authorUsername,
    reference.sourceUrl,
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString("base64url");
}

export function decodeCursor(cursor: string): number | undefined {
  try {
    const offset = (JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { o?: unknown }).o;
    return typeof offset === "number" && Number.isInteger(offset) && offset >= 0 ? offset : undefined;
  } catch {
    return undefined;
  }
}

/** Accepts 1754412159, "1754412159", "cosmos-1754412159" and https://www.cosmos.so/e/1754412159. */
export function parseId(value: string | number): string | undefined {
  const text = String(value).trim();
  const match = /^(?:cosmos-)?(\d{1,19})$/.exec(text) ?? /cosmos\.so\/e\/(\d{1,19})(?:[/?#]|$)/.exec(text);
  return match?.[1];
}

export const limitSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_LIMIT)
  .optional()
  .describe(`Maximum number of results. Default ${DEFAULT_LIMIT}, maximum ${MAX_LIMIT}.`);

export const idSchema = z
  .union([z.string().max(200), z.number().int().positive()])
  .describe("The reference id, such as 1754412159. A cosmos.so/e/<id> URL also works.");

export interface VisualInfo {
  width: number;
  height: number;
  mimeType: string;
  sourceUrl: string;
}

/** The get_reference result: the text, then the image when it loads. */
export async function referenceContent(
  reference: Reference,
  text: string,
): Promise<{ content: CallToolResult["content"]; visual: VisualInfo | null }> {
  if (reference.kind === "video") {
    text += `\n\nThis reference is a video. The image below is its thumbnail (one frame). The video is the MP4 at ${reference.mediaUrl}.`;
  }
  const content: CallToolResult["content"] = [];
  let visual: VisualInfo | null = null;
  if (reference.thumbnailUrl) {
    try {
      const loaded = await loadVisual(reference);
      visual = { width: loaded.width, height: loaded.height, mimeType: loaded.mimeType, sourceUrl: loaded.sourceUrl };
      text += `\n\nThe image below is ${loaded.width} x ${loaded.height} px (JPEG, downscaled when the original is larger).`;
      content.push({ type: "image", data: loaded.data, mimeType: loaded.mimeType });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      text += `\n\nNote: the image could not be loaded (${reason}). Open ${reference.pageUrl} to see it.`;
    }
  } else {
    text += "\n\nNote: this reference has no image.";
  }
  content.unshift({ type: "text", text });
  return { content, visual };
}

export function buildServer(username: string, slug: string, instructions: string): McpServer {
  const server = new McpServer({ name: "cosmos-references", version: "0.1.0" }, { instructions });
  const where = `cosmos.so/${username}/${slug}`;

  async function withCollection(run: (collection: Collection) => Promise<CallToolResult> | CallToolResult) {
    let collection: Collection;
    try {
      collection = await getCollection(username, slug);
    } catch (error) {
      if (error instanceof CosmosError && error.code === "not_found") {
        return errorResult(
          `The Cosmos collection ${where} does not exist or is not public. Check the username and the slug in the MCP server URL (/mcp/<username>/<slug>).`,
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      return errorResult(`Could not read the Cosmos collection ${where}: ${message}`);
    }
    return run(collection);
  }

  server.registerTool(
    "search_references",
    {
      title: "Search Cosmos references",
      description:
        "Search Henrik's saved Cosmos design references (images and videos of UI, motion, layout and visual style " +
        "that he saved to a public cosmos.so collection). Use it when you need visual inspiration for a design, or " +
        'the reference Henrik mentioned ("like that reference I saved"). The query matches words in the description, ' +
        "title, author and source URL. Case does not matter and every word must match, so use few words. Many " +
        "references have no description: when a search finds nothing, call list_references and look at the items. " +
        "With no query it returns the newest saved references. The result is text only: call get_reference with an " +
        "id to see the image.",
      inputSchema: {
        query: z.string().max(200).optional().describe("Words to find. Every word must match. Empty returns the newest references."),
        kind: z.enum(["image", "video"]).optional().describe("Return only images or only videos."),
        limit: limitSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ query, kind, limit }) =>
      withCollection((collection) => {
        const tokens = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        const found = collection.references.filter((r) => (!kind || r.kind === kind) && matches(r, tokens));
        const shown = found.slice(0, limit ?? DEFAULT_LIMIT);
        const total = collection.references.length;
        const text =
          shown.length === 0
            ? total === 0
              ? `The collection ${where} is empty.`
              : `No references match. The collection ${where} has ${total} references. Try fewer words, or call list_references.`
            : `${shown.length} of ${found.length} matching references (collection ${where}: ${total}), newest saved first. ` +
              `Call get_reference with an id to see one.\n\n${shown.map(compactText).join("\n\n")}`;
        return {
          content: [{ type: "text", text }],
          structuredContent: { collection: collection.url, total: found.length, returned: shown.length, references: shown },
        };
      }),
  );

  server.registerTool(
    "list_references",
    {
      title: "List Cosmos references",
      description:
        "List Henrik's saved Cosmos design references, newest saved first, one page at a time. Use it to see what the " +
        "collection has, or when search_references finds nothing because a reference has no description. Give the " +
        "nextCursor of a result as cursor to get the next page. The result is text only: call get_reference with an " +
        "id to see the image.",
      inputSchema: {
        limit: limitSchema,
        cursor: z.string().max(200).optional().describe("The nextCursor of the previous page."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ limit, cursor }) =>
      withCollection((collection) => {
        const offset = cursor ? decodeCursor(cursor) : 0;
        if (offset === undefined) return errorResult("The cursor is not valid. Use the nextCursor of a list_references result.");
        const total = collection.references.length;
        const shown = collection.references.slice(offset, offset + (limit ?? DEFAULT_LIMIT));
        const end = offset + shown.length;
        const nextCursor = end < total ? encodeCursor(end) : undefined;
        let text =
          shown.length === 0
            ? `No references at this position. The collection ${where} has ${total} references.`
            : `References ${offset + 1} to ${end} of ${total} in ${where}, newest saved first.\n\n${shown.map(compactText).join("\n\n")}`;
        text += nextCursor ? `\n\nnextCursor: ${nextCursor}` : "\n\nThis is the last page.";
        if (collection.truncated) text += `\nThe collection is larger: only its newest ${total} references are available.`;
        return {
          content: [{ type: "text", text }],
          structuredContent: {
            collection: collection.url,
            total,
            offset,
            returned: shown.length,
            nextCursor: nextCursor ?? null,
            references: shown,
          },
        };
      }),
  );

  server.registerTool(
    "get_reference",
    {
      title: "Get and see one Cosmos reference",
      description:
        "Get one of Henrik's saved Cosmos design references by id, with its metadata and the visual as an image you " +
        "can see. Use it after search_references or list_references, before you describe a reference or copy its " +
        "style, and when Henrik gives you a cosmos.so/e/<id> link. For an image you get the image. For a video you " +
        "get its thumbnail, and the text gives the MP4 URL.",
      inputSchema: { id: idSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id: rawId }) => {
      const id = parseId(rawId);
      if (!id) return errorResult(`"${rawId}" is not a reference id. Use an id from search_references, such as 1754412159.`);

      // The collection read already has the metadata. Read one element only for other ids.
      let reference: Reference | undefined;
      let inCollection = true;
      try {
        reference = (await getCollection(username, slug)).references.find((r) => r.id === id);
      } catch {
        // The element read below still works when the collection read fails.
      }
      if (!reference) {
        inCollection = false;
        try {
          reference = await getElement(id);
        } catch (error) {
          if (error instanceof CosmosError && error.code === "not_found") {
            return errorResult(`No public Cosmos element has the id ${id}. Call search_references to find ids.`);
          }
          return errorResult(`Could not read the Cosmos element ${id}: ${error instanceof Error ? error.message : error}`);
        }
      }

      let text = fullText(reference);
      if (!inCollection) text += `\n\nNote: this element is not in the collection ${where}.`;
      const { content, visual } = await referenceContent(reference, text);
      return { content, structuredContent: { ...reference, inCollection, visual } };
    },
  );

  return server;
}
