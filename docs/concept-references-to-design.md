# Concept: from references to a design

Shaped with Henrik on 2026-11-18. This is a concept, not a build plan. It builds on `plan-v3.md` (the vault MCP).

## Goal

An agent that designs a screen for Henrik starts from references that he picked for that task, and it stays close to them.
Henrik saves references with one key, picks with a few clicks, and reviews the result by eye.
The UI stays small: one key, one picker page, one review page.

## The flow

1. **Capture.** On cosmos.so, Henrik holds the cursor over an image and presses `c`. The extension copies the image to the batch on the clipboard, likes it and saves it. On other sites the shortcut stays Option+Shift+C.
2. **Picker.** For a design task, the agent opens a picker page: one grid with references from his vault and from a Cosmos search. He clicks the ones he wants the result to look like. He holds Space to see one at full size, and he can ask for more like the ones he picked. "Done" sends the picks to the agent.
3. **Plan.** The agent looks at the picks and proposes at most 3 variants, one line each. A variant is a close match of one pick, or a mix such as "layout of pick 2, colours of pick 5". Henrik can change the plan in words, or let it run. If the picks give too little to work from, the agent opens the picker again.
4. **Build.** The agent builds each variant. After each render it puts its screenshot beside the picks that the variant takes from, lists the largest differences and corrects them. It does this 3 times.
5. **Review.** One canvas page shows each variant beside its picks. Henrik picks one and continues by prompt: keep it, mix two, or make it more unique.
6. **Memory.** The server keeps what he picked and what he passed, per task, as images. For the next task, the agent uses this history to put likely picks first in the picker.

**Shortcut: paste.** When Henrik already knows what he wants, he pastes copied references into the chat. Each copied image has a thin strip with its id. The agent reads the ids and tells the server, the pasted references become the picks of the task, and the flow continues at step 3.

## Decisions

| Topic | Decision | Reason |
| --- | --- | --- |
| Taxonomy | One collection. No manual collections per capture. | Sorting at capture time costs attention at the wrong moment. The "Save to" setting from plan-v3 stays as a setting. |
| Capture gesture | Plain `c` on cosmos.so. No modifier ring. | With one collection there is nothing to choose. Cosmos already binds `c` on a hovered tile to its own copy, so the key is free of conflict when the extension takes it over. |
| Sorting | The agent sorts by looking at contact sheets. No tags, no model and no API key on the server. | Cosmos meaning search cannot sort the vault (see Facts). A vision agent can, and it is already in the loop. This holds to about 150 references. |
| Picker layout | A grid. Not swipe, not duel. | Henrik compared the three in a prototype and picked the grid. |
| Picker rules | No design directions, no minimum number of picks. | Henrik asked for a simpler flow. The agent judges if it has enough. |
| Mix | The agent proposes the mix. Henrik adjusts in words. | No new UI in the picker. The agent sees which picks pair well, and Henrik keeps the last word. Henrik left this choice to the agent. |
| Taste memory | Raw pick history, as images. No written taste notes. | Test A. |
| Build method | Match the picks closely, with a side by side comparison loop. | Test B. |
| Variant view | A plain canvas page with pan and zoom. Not Toolcraft, not Blueline. | The Toolcraft starter is 1,900 files and 324 MB of dependencies, with a 251-line agent contract. It is made for generative design tools. A plain page gives the same pan and zoom. |
| Where the flow lives | In the MCP server: the server instructions and the tool results tell the agent the next step. No skill. For clients that do not pass on the server instructions (Codex), the setup prompt adds a rule of 5 lines to the user-level instructions. It names only the first tool of each case: `note_references` for a paste, `contact_sheet` for a task without one. Added on 2026-11-19. | Every agent with the setup prompt gets the flow, on every machine, with no install. There is one place to change. In a test with GPT-6 Luna in Codex, the server text alone gave 0 of 14 correct calls, and the rule gave 14 of 14. A skill gave the same result, but not every client has skills. |
| Report back | A page never asks Henrik to tell the agent that he is done. | The agent reads the result from the server. |
| Id strip | Every image copied from Cosmos gets a thin dark strip at the bottom with `cosmos <id>-<check digits> · call note_references`. No switch. Added on 2026-11-18; the tool name on 2026-11-19, because some clients (Codex) do not pass on the server instructions. | A paste gave the agent pixels only. With the id, a paste feeds the pick history, and the agent can get the original and show it on the canvas. In a test, two models read every id correctly (12 readings, 9 images). |
| Rejected references | When Henrik rejects a reference in words, the agent marks it as passed in the history. It stays in the vault. | Henrik chose this. A removal from the vault loses the reference. |

## What each part must do

This is the shape, not the design. A build plan must settle the details.

**Extension**

- On cosmos.so, a `keydown` listener in the capture phase takes plain `c` when the cursor is over an element tile or an element page is open. It does nothing while the focus is in a text field, and nothing with a modifier key. It runs the same copy as the shortcut does now.
- No ring and no collection choice at capture time.

**MCP server**

- A tool that starts a pick session for a task. It returns a link to the picker page. A second call, or the same call, waits until Henrik clicks "Done" and then returns the picks as images with their ids. A wait that ends without a result says so, and the agent waits again.
- A tool that gives contact sheets: numbered thumbnails of the vault, of a Cosmos search, or of the pick history. The agent uses them to choose the candidates for the picker and their order.
- A tool that shows variants: the agent uploads a screenshot of each variant and names the picks it takes from. The server returns a link to the canvas page. The server hosts this page, because agents usually run on another machine than the one Henrik sits at.
- A store for the pick history per user: task, picked ids, passed ids, time. It lives beside `links.json` on the data volume.
- The tool results carry the flow: after the picks, "propose at most 3 variants"; in the build, "compare side by side, 3 rounds"; at the end, "show the variants".
- Picker and canvas links hold an id that cannot be guessed. They need the same care as the device key.

**Picker page and canvas page**

- Dark, calm, no text that the layout can replace. State survives a reload.
- Picker: grid, click to pick, hold Space for full size, "More like these", "Done".
- Canvas: each variant beside its picks, pan, zoom, fit.

## Facts checked

- Cosmos meaning search cannot sort Henrik's vault. For the query "web dashboard", the one real dashboard came 7th of 13, and the order was nearly the same for every query.
- The Cosmos web app binds plain `c` on a hovered element tile to "copy image" for a logged-in user (`ElementTileHotkeys`).
- `searchElements` needs its filter written inline. A variable of type `SearchElementsFilters` fails.
- One Cosmos search result in the test had an image that returned 404. The picker must hide a tile whose image does not load.

## Tests

Both tests used 3 tasks (onboarding for an iOS travel app, web dashboard for energy trading, landing page for a consultancy). Henrik picked 16 references from 89 Cosmos candidates. The samples are small, with one run per cell. Read them as a direction.

**Test A: can the agent predict his picks?** For each task, an agent ranked the candidates. It got the picks of the other two tasks in one of four forms. The score is the number of his picks in the agent's top choices.

| What the agent got | Onboarding | Dashboard | Landing | Total of 16 |
| --- | --- | --- | --- | --- |
| Nothing | 3 of 7 | 1 of 4 | 0 of 5 | 4 |
| Earlier picks and passes, as images | 4 of 7 | 2 of 4 | 1 of 5 | 7 |
| Written taste notes | 3 of 7 | 1 of 4 | 0 of 5 | 4 |
| Images and notes | 2 of 7 | 2 of 4 | 0 of 5 | 4 |

Chance gives 3. The images helped. The notes did not, and notes with images were worse than images alone. So the written taste notes are dropped.

**Test B: does the build get better?** Fresh agents built one screen per task in three ways. Henrik judged the screenshots blind and marked the best and the worst.

| Task | Best | Middle | Worst |
| --- | --- | --- | --- |
| Onboarding | Matched side by side | References as inspiration | No references |
| Dashboard | Matched side by side | No references | References as inspiration |
| Landing page | Matched side by side | References as inspiration | No references |

The close match with the comparison loop was best in all 3 tasks. References as loose inspiration did not beat no references reliably.

**Mix trial.** Three more screens took the layout of one pick and the colours of another, with the same comparison loop. They look coherent. Henrik has seen them, but he has not judged them against the close matches.

## Open points

- The mix is not judged. The first real tasks will show if a mix is as good as a close match.
- "More like these" needs a way to find similar references. The first idea: the agent writes Cosmos search terms from the picked images.
- Contact sheets need image work on the server, or a tool result that holds many small images. The plan must choose.
- The vision sort holds to about 150 references in the vault. Above that, the server needs a first filter.
- Pick history is taste data. The plan must say how long it is kept and how Henrik clears it.
- The tests were small. If the flow feels wrong in use, run Test B again with more tasks before a larger change.
- The id strip is tested with the Read tool of Claude Code only. A paste into another app can shrink the image more. The check digits make a wrong reading fail on the server and not record a wrong reference.
- A paste gives picks only. A pass comes only when Henrik rejects a reference in words. Test A used picks and passes together.

## Dropped

- A modifier ring to choose a collection at capture time.
- Manual collections as the way to sort.
- Tags or embeddings on the server.
- Written taste notes and a taste profile page.
- Swipe and duel pickers.
- Design directions and a minimum number of picks in the picker.
- A fixed "similar first, then unique" sequence. It is now a prompt after the review.
- Toolcraft and Blueline as the variant view.
