# Plan v4: from references to a design

Build plan for `concept-references-to-design.md` (agreed with Henrik on 2026-11-18). It builds on `plan-v3.md`.
The concept is the source of truth for scope. This plan settles its open points and the details.

## Decisions on the open points

| Open point | Decision | Reason |
| --- | --- | --- |
| How "More like these" finds references | The server asks Cosmos `similarElements` for each pick and adds new tiles to the grid at once. The agent takes no part. | Cosmos has its own visual similarity for one element (see Facts). It answers in about a second, so the page works without an agent turn, and the server needs no model or key. The concept's first idea (the agent writes search terms) needs a round trip through a waiting agent. |
| How contact sheets are made | On the server with `sharp`: one JPEG per 30 references (6 by 5 cells), each cell numbered. The numbers are drawn as vector strokes, not with a font. | One image of 30 thumbnails costs about as many tokens as one full-size reference. A tool result with 30 small images costs more and has no numbers. The Docker image has no fonts, so text in an SVG would not render. |
| Limits of the pick history | Per user: the newest 100 tasks, none older than 12 months. At most 300 passed references per task. Henrik clears it by asking any agent ("clear my pick history"), which calls `clear_pick_history`, for all tasks or one. Unlinking a device does not clear it. | 100 tasks is far more than Test A needed (2 earlier tasks). The history holds ids and CDN thumbnail URLs, not credentials, so it does not follow the device link. |
| The wait for Done | `wait_for_picks` waits up to 50 seconds. Then it answers "not done yet", with the number of picks so far and whether the page was opened, and the agent calls it again. When Henrik clicks Done, every waiting call returns at once. A later call returns the same picks. | Codex stops an MCP tool call after 60 seconds by default, and the HTTP server closes a quiet socket after 65 seconds. 50 seconds stays under both. |

## Other decisions

- **Uploads.** An agent cannot put a screenshot into a tool argument: the base64 text would cost more than a million tokens. So `show_variants` returns one upload command per variant (`curl -T shot.png <upload URL>`), and the agent runs it in its shell. The canvas page shows a grey placeholder until the image arrives, and loads it without a reload.
- **Two secrets per board.** The canvas link holds the view id. The upload URL holds a second id. Henrik can share the canvas link, and it cannot change the board.
- **Done with no picks** is allowed. It tells the agent that nothing fits, and the agent opens a new picker. The concept drops a minimum number of picks.
- **No "Change picks" after Done.** The done state only confirms that the picks are saved, with their thumbnails. Henrik changes the plan in words, as the concept says.
- **Pick images in the result.** `wait_for_picks` returns each pick as an image (1024 px long edge for up to 6 picks, 768 px for up to 12, the first 12 for more), with its number, id and link. The numbers are the ones the plan uses ("layout of pick 2").
- **Candidates.** The agent passes up to 60 ids in the order to show, likely picks first. The server reads each element (public read, then the token for a private one) and skips an id it cannot read. The page shows no source label: vault and Cosmos tiles look the same.

## Facts checked (2026-11-18)

- `similarElements(elementIds: [<one id>])` on `https://api.cosmos.so/graphql` works without login. It takes exactly one id ("The API is intended to support only one element at the moment"). It returns `items { id type url videoUrl image { url width height } }` and `meta { count nextPageCursor }`. For a dashboard element it gave 488 items, the first ones dashboards. `pageSize` has no effect and there is no next page.
- Introspection is off. The field names above come from the error hints.
- The rest is in the concept and in `plan-v3.md`: plain query text, `filters:{userId}` inline, thumbnails at `https://cdn.cosmos.so/<uuid>?format=webp&w=<n>`.

## Extension

1. `content.js` runs at `document_start`, so its listener is registered before the Cosmos app's listeners.
2. A `keydown` listener on `window` in the capture phase. It acts on `c` when: the page is www.cosmos.so, no modifier key is down (Shift, Alt, Ctrl, Meta), the event is not a repeat and not composing, the focus is not in an `input`, `textarea`, `select` or content-editable element, and a Cosmos element is under the cursor or an element page is open. Then it calls `preventDefault` and `stopImmediatePropagation`, so the Cosmos `c` handler (copy image, with its toast) does not run, and it asks the background to copy that element.
3. The background runs the same `copyReference` as the shortcut, with the target the content script found.
4. Option+Shift+C stays the command for every site. The popup empty state names both keys.

## Server

### Tools (vault endpoint only)

- `contact_sheet { source: "vault" | "cosmos" | "history", query?, collection?, cursor?, count? }`
  - `vault`: newest saved first, or ranked by meaning with a query; optional collection.
  - `cosmos`: all of Cosmos for a query (required).
  - `history`: one sheet per task, newest task first. A picked cell has a blue frame and a check; a passed cell is dimmed.
  - `count` default 30, maximum 60 (2 sheets). The text maps each number to the id, kind and a short description. `nextCursor` gives the next page; the numbers go on across pages.
  - A thumbnail that does not load gets a dark cell with a cross, and the text says so.
- `start_picks { task, candidates }`: makes a pick session and returns the picker link. The result tells the agent to give Henrik the link and to call `wait_for_picks`, and never to ask Henrik to say that he is done.
- `wait_for_picks { session }`: as above. With the picks, the result carries the next steps (see Flow).
- `show_variants { task, variants: [{ name, takes: [{ id, what? }] }] }`: 1 to 6 variants. `takes` names the references the variant takes from (ids), and optionally what it takes ("layout", "colours"). Returns the canvas link and one upload command per variant.
- `clear_pick_history { task? }`: deletes the history of one task (by name) or all of it. Use it only when Henrik asks.

### Flow text

The server instructions name the flow for a design task. The tool results carry the next step:

- `contact_sheet` (history and candidates): choose candidates by looking, likely picks first, then `start_picks`.
- `wait_for_picks` with picks: "Propose at most 3 variants, one line each: a close match of one pick, or a mix such as layout of pick 2, colours of pick 5." Then the build text, word for word: "Match the reference closely: layout structure, colour palette, type style, shapes, density, spacing and the style of its imagery. A reference can show several screens or a device in a scene. Match the UI design itself, not the presentation scene. Keep your own content and brand. Do not copy the text or logo of the reference. Then do a side by side comparison, three rounds. In each round: render and take a screenshot, read your screenshot and the reference, write down the five largest visible differences in style, and fix them." Then: "At the end, show the variants: call show_variants."
- `wait_for_picks` with no picks: nothing fits; choose other candidates and call `start_picks` again.
- `show_variants`: give Henrik the link after the uploads; he picks one and continues by prompt.

### Pages and routes

| Route | Use |
| --- | --- |
| `GET /p/<id>` | Picker page. |
| `GET /p/<id>/state`, `PUT /p/<id>/state` | Read the session; save `{picked, hidden}` after each click. |
| `POST /p/<id>/more` | "More like these": up to 12 new tiles from `similarElements` of the picks, round robin, no repeats. At most 5 rounds. |
| `POST /p/<id>/done` | Done. Stores the picks, writes the history entry and wakes the waiting tool calls. Idempotent. |
| `GET /v/<id>` | Canvas page. |
| `GET /v/<id>/state`, `GET /v/<id>/img/<n>` | The board and its screenshots. |
| `PUT /u/<upload id>/<n>` | Upload the screenshot of variant n (PNG, JPEG or WebP, at most 15 MB). A new upload replaces the old one. |
| `GET /assets/<file>` | The page scripts and styles. |

- Ids are 32 random bytes in base64url. The store keeps only their SHA-256 hash. An unknown id gives 404. More than 30 unknown ids from one IP in 15 minutes give 429.
- Pages send `referrer-policy: no-referrer` (the CDN must not see the link), a strict CSP (`script-src 'self'`, images from `self` and `cdn.cosmos.so`), `cache-control: no-store` and `x-robots-tag: noindex`.
- Writes from the pages need `content-type: application/json`. The server sends no CORS headers, so another site cannot write.
- The request log replaces each id with `:id` (`/p/:id/state`). Ids, keys and tokens never go to logs.
- The uploaded image is decoded and encoded again as WebP (quality 90, at most 2880 px wide and 12000 px tall), so the server never serves the uploaded bytes.

### Pages

Both pages keep the prototype look: dark (`#0d0d0e`), one blue accent, calm, no text that the layout can replace.

- **Picker**: task name as the heading, one line under it, the grid (`minmax(230px, 1fr)`, 4:3 tiles, contain), click to pick (blue frame and check), hold Space over a tile for full size (1600 px), the bottom bar with the count, "More like these" and "Done". New tiles from "More like these" come after a thin rule. A tile whose image fails to load is removed and counts as hidden, not passed. The state lives on the server, so it survives a reload and another browser. The done state shows "Saved" with the pick thumbnails and nothing to do.
- **Canvas**: one row per variant: name, the references it takes from (each with its "what" under it), then the screenshot. Pan by drag or two-finger scroll, zoom by pinch (trackpad and touch), Ctrl or Cmd with the wheel, the + and - buttons and keys, Fit (`0` or `f`). The view is kept per board in `localStorage`. A variant without a screenshot shows a grey box at true size, and the page polls every 3 seconds until all screenshots are in.

### Storage

On the `cosmos-mcp-data` volume, beside `links.json`, each file mode 600 and written atomically:

- `picks.json`: sessions and boards, keyed by id hash. A session expires 7 days after its last change, a board 30 days after its creation. At most 20 sessions and 30 boards per user: a new one drops the oldest.
- `boards/<board hash>/<n>.webp`: the screenshots.
- `history/<username>.json`: `{task, at, picked: [{id, thumb}], passed: [{id, thumb}]}` per task, newest first.

Expired sessions and boards are pruned at start and every hour.

## Security

- The picker and canvas links are bearer links, like the setup URL. Anyone with a picker link can see the candidates and pick for that task. Anyone with a canvas link can see the screenshots.
- The pages never show the device key, the token or the username.
- The pages hold no Cosmos login. They read the CDN directly.
- `similarElements` and the thumbnail reads are anonymous. Only `start_picks` uses the token, for a private element of the account.

## Tests

- Smoke (fake Cosmos and real Cosmos): every new tool; a picker session end to end over HTTP (state, more, done, the tool call returns the picks while it waits); the history entry and `clear_pick_history`; a board with two uploads and their images; no key, a wrong key and a guessed session or board id give 401 or 404; the log holds no id; the current vault tools still pass.
- Real MCP client: start a session, open the picker in a browser, pick, click Done, the tool call returns the picks with no chat message; upload two test variants and open the canvas link.
- Extension: on cosmos.so, `c` over a tile copies, likes and saves once, and the Cosmos toast does not show; `c` in the search field types a letter; Option+Shift+C still works on another site.
- Pages: probe with the `ui-design` probe, console clean, state survives a reload.
