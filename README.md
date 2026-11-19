# Cosmos Copy

Copy a Cosmos image or video with one key, and paste it to an agent.
Each copy also likes the element and saves it to a Cosmos collection.
Agents search all your Cosmos collections, and all of Cosmos, through a remote MCP server.
An agent can also show you references on a picker page, design from the ones you pick, and show
its variants beside them on a canvas page.

## Parts

| Part | Path | What it does |
| --- | --- | --- |
| Extension | `extension/` | Extension for Brave, Chrome or Ardia. On cosmos.so, the `C` key copies the element under the cursor, or the open element page. On other sites, the shortcut (default Option+Shift+C) does. It likes the element and saves it to the collection. The popup shows what is on the clipboard; settings sit behind the gear. |
| Native helper | `host/` | Swift program for native messaging. It downloads the media to `~/Downloads/Cosmos References` and puts the file on the macOS clipboard. Images also go on the clipboard as PNG data. An image from Cosmos gets a thin strip with its id at the bottom. |
| MCP server | `server/` | MCP server over streamable HTTP, hosted at `https://cosmos-mcp.henrikkvamme.no`. The vault at `/mcp/<username>?key=<device key>` reads all your collections, searches all of Cosmos, saves references and runs the design flow (picker, contact sheets, canvas). A public collection is also open without login at `/mcp/<username>/<collection-slug>`. |

## Install the extension (macOS)

1. Run `./install.sh`. It builds the native helper and registers it with Brave, Chrome and Ardia.
2. Open `brave://extensions`, turn on Developer mode, click "Load unpacked" and select `extension/`.
   In Ardia, open Settings, turn on "Show advanced settings", open Extensions and use "Load unpacked extension".
   The extension ID is fixed (`gdkbjkepnfmnonhgfjmklmmnboiamdad`), because `manifest.json` has a `key`.
3. Sign in to cosmos.so in the same browser.
4. To change the shortcut for other sites, open `brave://extensions/shortcuts`. On cosmos.so the key is always `C`.

## Use it

- Hover an element on Cosmos, or open one, and press `C`. A toast confirms the copy. In a text field, `C` types a letter as usual.
- Paste in an agent: an image pastes as an image, and a video pastes as an mp4 file.
- A copied Cosmos image has a thin dark strip at the bottom with a label such as `cosmos 1850854004-65 · call note_references`: the id, two check digits, and the name of the tool that an agent calls. An agent with the vault reads the label and knows which reference it is. The reference in Cosmos does not change. Videos and images from other sites get no strip.
- `C` puts one element on the clipboard and replaces what was there. `Shift+C` adds the element to the clipboard, and the toast shows how many it holds. An add after you copied something else starts a new batch.
- On any other site, Option+Shift+C copies the image or video under the cursor (no like or save), and Option+Shift+A adds it. On cosmos.so these shortcuts work too.
- Click the extension icon to see what is on the clipboard. Click a thumbnail to open it on Cosmos, or the x to take it off the clipboard.
- The gear opens settings: the collection that copies go to ("New collection…" creates one), the like setting, the shortcut and the agent setup.

## Connect agents

Open the extension, click the gear and click "Copy setup prompt". Paste it into any agent.

The prompt adds the server. Claude Code needs no more: it gives the agent the server's own
instructions. Codex does not, so in Codex and other clients the prompt also adds a short rule
to the user-level instructions (Codex: `~/.codex/AGENTS.md`). The rule names the two tools
that a task starts with, and the tool results carry the rest. Codex asks for approval when a
Cosmos tool changes something; allow the tools if you run Codex unattended.

The extension links your Cosmos login to the server for each browser. It sends the
`csms_accessToken` cookie on install, on startup, every 6 hours and when Cosmos renews it.
The setup URL holds this browser's device key, so keep it private. The token lasts 7 days:
visit cosmos.so now and then to keep it fresh.

Vault tools: `list_collections`, `list_references`, `search_references`, `get_reference`,
`search_cosmos`, `save_reference`, and the design flow tools `contact_sheet`, `start_picks`,
`wait_for_picks`, `show_variants`, `note_references`, `note_result` and `clear_pick_history`.

"Disconnect agents on this browser" revokes the key at once. The extension stays
disconnected until you click "Connect agents again", which makes a new key and a new setup URL.

The server only links the Cosmos users in `LINK_ALLOWED_USERS`. It keeps the links in
`DATA_DIR/links.json` (mode 600), on the `cosmos-mcp-data` volume in Dokploy. The pick sessions,
canvas boards, screenshots and pick history are on the same volume.

## Design from references

Ask an agent to design something, such as "a web dashboard for energy trading". The server
instructions tell it the flow:

1. The agent looks at contact sheets: your earlier picks, your vault and all of Cosmos. A contact
   sheet is one image of up to 30 numbered thumbnails.
2. It chooses up to 60 candidates and calls `start_picks`. It gives you a picker link.
3. On the picker, click the references the result should look like. Hold Space over a tile to see
   it at full size. "More like these" adds up to 12 similar elements from Cosmos. Click Done.
   The agent gets the picks at once: you do not tell it that you are done.
4. The agent proposes at most 3 variants, one line each. Change the plan in words, or let it run.
5. It builds each variant against the references, with three rounds of side-by-side comparison.
6. It calls `show_variants`, uploads a screenshot of each variant and gives you a canvas link. The
   canvas shows each variant beside the references it takes from. Drag to pan, pinch or Ctrl+scroll
   to zoom, and press `0` or click Fit to see all.

You can also skip the picker: paste copied references into the chat. The agent reads the label on
each strip and calls `note_references`. The pasted references are then your picks for the task, and
the agent continues at step 4. When you say later that you do not want a reference, or did not like
what came of it, the agent marks it as passed.

Picker and canvas links hold a random id that cannot be guessed. Anyone with the link can open the
page, so keep it private. A picker link expires after 7 days, a canvas link after 30 days.

The server keeps a pick history per user: the task, the picked and passed elements and the time.
The next task starts from it. Ask the agent to clear it ("forget my picks"), for one task or all.
Unlinking a browser does not clear it.

## Notes

- Cosmos has no public API. The extension uses the persisted GraphQL queries of the Cosmos web app, with the browser's Cosmos session. The hashes are in `extension/cosmos.js`. If Cosmos changes them, liking and saving fail with a clear error, and the copy still works.
- Cosmos has no API that lists your liked elements. The collection is the store.
