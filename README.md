# Cosmos Copy

Copy a Cosmos image or video with one shortcut, and paste it to an agent.
Each copy also likes the element and saves it to a public Cosmos collection.
Agents search that collection through a remote MCP server.

## Parts

| Part | Path | What it does |
| --- | --- | --- |
| Extension | `extension/` | Brave or Chrome extension. The shortcut (default Option+Shift+C) copies the element under the cursor, or the open element page. It likes the element and saves it to the collection. The popup shows the agent setup. |
| Native helper | `host/` | Swift program for native messaging. It downloads the media to `~/Downloads/Cosmos References` and puts the file on the macOS clipboard. Images also go on the clipboard as PNG data. |
| MCP server | `server/` | Stateless MCP server over streamable HTTP. It reads a public Cosmos collection without login. Hosted at `https://cosmos-mcp.henrikkvamme.no/mcp/<username>/<collection-slug>`. |

## Install the extension (macOS)

1. Run `./install.sh`. It builds the native helper and registers it with Brave and Chrome.
2. Open `brave://extensions`, turn on Developer mode, click "Load unpacked" and select `extension/`.
   The extension ID is fixed (`gdkbjkepnfmnonhgfjmklmmnboiamdad`), because `manifest.json` has a `key`.
3. Sign in to cosmos.so in the same browser.
4. To change the shortcut, open `brave://extensions/shortcuts`.

## Use it

- Hover an element on Cosmos, or open one, and press the shortcut. A toast confirms the copy.
- Paste in an agent: an image pastes as an image, and a video pastes as an mp4 file.
- Press the shortcut on more elements to copy several at once. Each copy adds to the clipboard, and the toast shows how many it holds. A new batch starts when you leave the browser (for example to paste), or when you copy something else.
- On any other site, the shortcut copies the image or video under the cursor (no like or save).
- The popup sets the collection name and the like setting. The collection is created as public if it does not exist.

## Connect agents

Open the extension popup and click "Copy setup prompt". Paste it into any agent.
Or run one command:

```sh
claude mcp add --transport http --scope user cosmos https://cosmos-mcp.henrikkvamme.no/mcp/henrikkvamme/agent-references
codex mcp add cosmos --url https://cosmos-mcp.henrikkvamme.no/mcp/henrikkvamme/agent-references
```

## Notes

- Cosmos has no public API. The extension uses the persisted GraphQL queries of the Cosmos web app, with the browser's Cosmos session. The hashes are in `extension/cosmos.js`. If Cosmos changes them, liking and saving fail with a clear error, and the copy still works.
- Cosmos has no API that lists your liked elements. The collection is the store.
