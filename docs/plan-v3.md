# Plan v3: clipboard tray, collection picker, agent vault access

Decided with Henrik (2026-11-18):
- The popup shows only what is relevant: the references on the clipboard now. Settings go behind a gear.
- Settings: "Save to" is a menu of his Cosmos collections (plus "New collection"), "Like on Cosmos", and one "Copy setup prompt" button. The Claude Code and Codex command blocks go away.
- A batch ends when Brave loses focus or the clipboard changes elsewhere (no change).
- The MCP gives agents access to the whole vault (all his collections), search across all of Cosmos, better search in the vault, and saving to his collections.

## Facts checked

- `POST https://api.cosmos.so/graphql` takes plain query text. Without login:
  - `searchElements(searchTerm, filters: {userId}, meta: {pageSize, pageCursor})` ranks the user's own saved elements by meaning (it returned all 13 of Henrik's in a different order per query). Without `filters` it searches all of Cosmos.
  - `user(username) { id }` gives the user id.
  - `cluster(input: {ownerUsername, slug})` and `clusterConnections` (used now) read a public collection.
- `userClusters(userId)` needs a login. With `Authorization: Bearer <csms_accessToken>` the API answers as Henrik (`me` returned henrikkvamme). A cookie header does not work.
- `csms_accessToken` (httpOnly cookie on www.cosmos.so) is a JWT valid 7 days; the browser renews it. `csms_refreshToken` is valid 1 year. No refresh flow is known.
- The extension's write calls (like, save, create) use persisted hashes on www.cosmos.so/api/graphql with cookies. `searchClusters` (hash 5bf09e73…, vars `{userId, searchTerm: ""}`) lists his collections.

## Extension

1. Native helper (done, untested): `{type: "status"}` returns the pasteboard change count; `{type: "set", paths}` rewrites the clipboard with saved files (only files inside `~/Downloads/Cosmos References`).
2. Background (done, untested): the batch in `chrome.storage.session` keeps `{changeCount, items: [{path, kind, thumb, pageUrl}]}`. Popup messages: `popup:batch` (returns items only if the change count still matches), `popup:remove`, `popup:collections`, `popup:set-collection`. The picked collection is stored as `settings.target = {id, name, slug, username}`.
3. Popup: tray view with thumbnails (CDN `?format=webp&w=240`; a video shows its poster), an x on hover removes one item, an empty state that names the shortcut. A gear opens the settings view in the same popup.
4. Check that opening the popup does not fire `windows.onFocusChanged(WINDOW_ID_NONE)` and clear the batch. If it does, ignore focus changes while the popup is open.
5. Link to the server:
   - The extension makes a random device key once (`chrome.storage.local`) and a device name ("Brave on leela").
   - It relays `csms_accessToken` (new `cookies` permission) to `POST https://cosmos-mcp.henrikkvamme.no/link` with `{token, deviceKey, deviceName}`: on install, on startup, on `chrome.cookies.onChanged` for that cookie, and every 6 hours (`chrome.alarms`). A failed relay retries with backoff (1, 5, 30 minutes) through alarms.
   - Reading a cookie does not renew it. When the token is expired or missing, the popup settings show "Visit cosmos.so to renew the agent link" with a link. Visiting Cosmos renews the cookie, and `cookies.onChanged` relays it. Whether a visit renews it is not yet verified; test it.
   - The setup prompt URL becomes `https://cosmos-mcp.henrikkvamme.no/mcp/<username>?key=<deviceKey>`.

## Server

1. `POST /link` with `{token, deviceKey, deviceName}`:
   - The server calls `me` on Cosmos with the token. On success it stores, per username, one account token `{token, exp}` and a list of devices `{keyHash, name, linkedAt, lastSeen}` in a JSON file on a Dokploy volume (mode 600, written atomically).
   - Devices are separate: a new device adds a key and never replaces another. A relay from a known device keeps its key.
   - A token update is accepted only when its `exp` is later than the stored one, so an old device cannot replace a newer token.
   - `POST /unlink` with `{deviceKey}` removes that device. With no devices left, the token is deleted. An expired token is deleted on read.
   - Rate limit by IP. The token and keys never go to logs.
2. Routes:
   - `POST /mcp/:username?key=…` is the vault. A valid device key is required for every request, because its reads use Henrik's token (private collections included). A missing or wrong key gives 401. Results are never shared between users or keys (no cache keyed only by path).
   - `POST /mcp/:username/:slug` stays anonymous and public, as now. It never uses a linked token.
3. Vault tools:
   - `list_collections`: `userClusters` with the token, paginated, private ones marked.
   - `list_references(collection?, cursor, limit)`: newest saved first. Source: `clusterConnections` of each collection (the one given, or all), merged by save time, duplicates across collections shown once with all their collections. Paginate upstream until the page is full; cap at 5,000 elements.
   - `search_references(query, collection?, kind?, limit)`: `searchElements` with `filters: {userId}` and the bearer token, paginated. With a collection, keep only its elements. An empty query is the same as `list_references`, because `searchElements` returns nothing for an empty term.
   - `get_reference(id or URL)`: unchanged.
   - `search_cosmos(query, kind?, limit)`: `searchElements` without filters, anonymous.
   - `save_reference(id, collection)`: the editConnections mutation as plain query text with the token. The collection by name or slug, never created implicitly. Returns the collection link.
4. A missing or expired token gives a clear tool error: "Visit cosmos.so in Brave to renew the link."

## Security

- Trust boundary: the server holds a bearer token that can act as Henrik on all of Cosmos, not only through the MCP tools. A compromised server or container means a compromised Cosmos account until the token expires (at most 7 days, the relay keeps renewing it). Henrik accepted this on 2026-11-18 by choosing agent saves.
- Device keys are stored as SHA-256 hashes and compared in constant time. Each device can be unlinked from its popup ("Disconnect agents"); unlinking all devices deletes the token.
- The volume is not backed up, so a backup cannot leak the token. Losing it only means the next relay links again.
- The setup prompt holds the key. Anyone with it can read the vault and save to it.
- Considered: a local bridge (MCP via the native helper) keeps the token on the Mac, but agents on other machines (fry, cloud) could not use it. The remote server stays.

## Tests

- Helper: status/set round trip; set refuses a path outside the media folder.
- Extension: copy 3, popup shows 3, remove 1 leaves 2 on the clipboard (checked with a pasteboard reader), collection menu lists his collections and a pick is used by the next copy.
- Helper: a removal with a stale change count is refused and leaves the newer clipboard; a GIF that stays after a removal keeps its PNG data (both done).
- Server: smoke script for every tool; vault requests with no key, a wrong key and another username's key give 401; save_reference adds an element to a test collection; link with a bad token is refused; two devices relaying in turn both keep working; an older token does not replace a newer one; list_references orders by save time across collections, shows a duplicate once and pages past the first upstream page.
- Extension: relay on cookie change; retry after a failed relay; expired token shows the renew hint.
- Real client: `claude mcp add` with the new URL, then an agent searches the vault, searches Cosmos and saves one reference.
