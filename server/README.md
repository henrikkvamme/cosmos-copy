# cosmos-mcp

A remote, stateless MCP server (Streamable HTTP) for Cosmos (cosmos.so). It has two endpoints:

- **Public collection** (`/mcp/<username>/<slug>`): read-only, anonymous, no secret. It never uses
  a linked token.
- **Vault** (`/mcp/<username>?key=<device key>`): all collections of a linked account, private ones
  included, search across all of Cosmos, saves, and the design flow. The Cosmos Copy browser
  extension links the account: it relays the Cosmos login token to `POST /link`.
- **Pages** (`/p/<id>`, `/v/<id>`): the picker and the variants canvas of the design flow. The id in
  the link is the secret.

## Routes

- `POST /mcp/<username>/<slug>`: MCP endpoint for `https://www.cosmos.so/<username>/<slug>`.
- `POST /mcp/<username>?key=<device key>`: the vault. Every request needs a device key that is
  linked to this username. A missing or wrong key gives 401. Many wrong keys from one IP give 429.
- `POST /mcp`: the vault of the signed-in user. The request needs an OAuth access token for the
  resource `PUBLIC_URL/mcp`. Without one the answer is 401 with a `WWW-Authenticate` header that
  names the resource metadata, and an MCP client then starts the sign-in. See "Sign-in".
- `/api/auth/*`, `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`:
  Better Auth. Google sign-in, sessions and the OAuth endpoints.
- `GET /login`, `/consent`, `/account`, `/connect`, `/privacy`: the pages of a signed-in person.
  `/account/api/*` are their JSON endpoints.
- `POST /connect/start` `{deviceKey}`: the extension asks for a connect ticket. `POST /connect/state`
  `{deviceKey}` tells if a signed-in user is linked.
- `POST /link` with `{token, deviceKey, deviceName}`: link a device. See "Linking".
- `POST /unlink` with `{deviceKey}`: remove a device. Gives `{ok, removed}`.
- `GET /p/<id>`: the picker page. `GET`/`PUT /p/<id>/state` reads the session and saves
  `{picked, hidden}`. `POST /p/<id>/more` adds up to 12 similar elements ("More like these", at
  most 5 rounds). `POST /p/<id>/done` stores the picks, writes the history entry and wakes the
  waiting `wait_for_picks` calls. Done is idempotent; after Done, the other writes give 409.
- `GET /v/<id>`: the canvas page. `GET /v/<id>/state` gives the board, `GET /v/<id>/img/<n>` the
  screenshot of variant n.
- `PUT /u/<upload id>/<n>`: upload the screenshot of variant n (PNG, JPEG or WebP, at most 15 MB),
  such as `curl -sS --fail -T shot.png <url>`. The upload id is a second secret, so the canvas link
  cannot upload. A new upload replaces the old one.
- `GET /assets/<file>`: the page scripts and the style sheet.
- `GET /health`: `ok`.
- `GET /`: usage text.

`GET` and `DELETE` on an MCP endpoint return 405, because the server keeps no session.

## Tools

Public collection:

- `search_references { query?, kind?, limit? }`: word match over description, title, author and source URL.
- `list_references { limit?, cursor? }`: newest saved first, in pages.
- `get_reference { id }`: metadata and the image (for a video: its thumbnail and the MP4 URL).

Vault:

- `list_collections { limit?, cursor? }`: the account's collections and subcollections, private ones marked.
- `list_references { collection?, cursor?, limit? }`: newest saved first, from all collections or one.
  An element in more than one collection shows once, with its collections. At most 5,000 elements.
- `search_references { query?, collection?, kind?, cursor?, limit? }`: Cosmos ranks the account's
  saved elements by meaning (`searchElements` with `filters.userId`). With a collection, only its
  elements. An empty query lists the newest saves.
- `get_reference { id }`: as above. A private element of the account is read with the token.
- `search_cosmos { query, kind?, cursor?, limit? }`: all of Cosmos, anonymous.
- `save_reference { id, collection }`: adds an element to an existing collection (name, slug or id).
  It never makes a collection.

Vault, design flow (the server instructions give the agent the order):

- `contact_sheet { source, query?, collection?, count?, cursor? }`: one JPEG of up to 30 numbered
  thumbnails, with the ids in the text. `source` is `vault` (with `query` and `collection` as in
  `search_references`), `cosmos` (`query` required) or `history` (earlier tasks, picks framed in
  blue, passed ones dimmed, 3 tasks per call). `count` is at most 60 (two sheets).
- `start_picks { task, candidates }`: 1 to 60 element ids. Makes a pick session and returns the
  picker link.
- `wait_for_picks { session }`: waits up to 50 seconds for Done, and answers within 58 seconds. Before Done it answers "Not done
  yet" and the agent calls it again. After Done it returns the picks with their images and the next
  steps. The agent never asks Henrik to say that he is done.
- `show_variants { task, variants: [{ name, takes: [{ id, what? }] }] }`: 1 to 6 variants. Returns
  the canvas link and one upload command per variant.
- `note_result { canvas, variant, project, deviations, took? }`: for the design Henrik accepts. It
  keeps a style record with the task in the pick history: the project, the references of the
  variant with what the design took from each, the deviations, and the top of the final screenshot
  (1280 px wide, at most 2000 px high). A record of the same canvas is replaced; a record of another
  canvas is not. `contact_sheet { source: "history", project }` gives the records of one project.
- `note_references { task, pasted?, rejected? }`: for references Henrik pasted into the chat. `pasted`
  holds the labels on the strips of the copied images, such as `1850854004-65` (id and two check
  digits, mod 97). They become the picks of the task in the pick history, and the result gives the
  same next steps as `wait_for_picks`. `rejected` holds labels or ids: they move to passed. A label
  with wrong check digits records nothing, and the agent reads the strip again. A call changes the
  newest history entry of the same task when it is younger than 7 days, else it adds an entry.
- `clear_pick_history { task? }`: deletes the pick history of one task, or all of it.

When the token is missing, expired or refused, a vault tool that needs it gives the error
"Visit cosmos.so in Brave to renew the link."

## Linking

`POST /link` with JSON `{token, deviceKey, deviceName}`:

- `token`: the `csms_accessToken` cookie of www.cosmos.so (a JWT, valid 7 days).
- `deviceKey`: a random key that the device makes once, 32 to 128 characters of `A-Z a-z 0-9 - _`
  (for example 32 random bytes in base64url).
- `deviceName`: such as "Brave on leela". At most 100 characters.

The server calls `{ me { id username } }` on Cosmos with the token. Then it stores, per Cosmos user id,
one token and a list of devices:

- A new device key adds a device. It never replaces another device. A known key updates its name
  and `lastSeen`. A device key belongs to one account.
- The token replaces the stored one only when its `exp` is later, so an old device cannot replace a
  newer token.
- `POST /unlink` removes a device. With no devices and no linked user left, the account, its
  token and its pick data are deleted.
- An expired token is deleted when it is read. A token that Cosmos refuses is deleted too. The
  devices stay, and the next relay links again.

Answers: 200 `{ok, username, userId, deviceName, deviceAdded, tokenUpdated, tokenExpiresAt, mcpPath}`,
400 for a bad body or an expired token, 401 when Cosmos refuses the token, 403 when the username is
not in `LINK_ALLOWED_USERS`, 409 at 20 devices, 429 over the rate limit, 502 when Cosmos cannot be
reached, 503 when the data directory cannot be written.

The extension calls `/link` from its background worker. It needs a host permission for this server.
The server sends no CORS headers.

## Sign-in

A person signs in with Google (Better Auth). An MCP client gets access with OAuth 2.1: it reads the
401 answer of `POST /mcp`, finds the authorization server, sends the person to `/login` and
`/consent`, and gets an access token for the resource `PUBLIC_URL/mcp`.

- Clients name themselves with a Client ID Metadata Document (Claude Code and Codex do). Open
  dynamic client registration is off, so nobody can add client records from the internet.
- An access token lasts 10 minutes and is checked without the database. A refresh token gets the
  next one. `/account` lists the clients, and "Remove" deletes the consent and the tokens of one
  client. Its last access token then works for at most 10 more minutes.
- A sign-in is a Better Auth user. A Cosmos account is a different thing: it is keyed by the
  Cosmos user id, and it holds the token, the devices and the linked users. The username is for
  display and for the key route only, because Cosmos lets a person change it.
- To link the two, the extension calls `POST /connect/start` with its device key and opens
  `/connect#<ticket>`. The ticket is in the URL fragment, so no server and no log gets it. The
  page shows the Cosmos username and the Google email, and "Link" confirms. A ticket lasts 10
  minutes, works once, is kept in memory as a hash, and dies when its device is removed.
- A user with no linked Cosmos account gets the full tool list. Each tool call returns an error
  that tells the agent what the user must do.
- A Cosmos account is deleted when it has no device and no linked user. Its token, pick sessions,
  boards, screenshots, history and history images go with it. "Delete account" on `/account`
  deletes the user, the sessions and the grants, and removes the user from the Cosmos account.
- The device key route (`/mcp/<username>?key=`) stays for a host with no browser.
- `AUTH_TEST_LOGIN=1` turns on sign-in with email and password, and open client registration, for
  the smoke test. The server refuses to start with it in production mode or with a `PUBLIC_URL`
  that is not loopback, and it then listens on 127.0.0.1 only.

## Security

- The server holds a bearer token that can act as the account on all of Cosmos, not only through
  these tools. Anyone who controls the server or its volume controls the Cosmos account until the
  token expires (at most 7 days; the relay keeps renewing it).
- Device keys are stored as SHA-256 hashes and compared in constant time. The MCP URL holds the key:
  anyone with the URL can read the vault and save to it. Unlink the device to stop that key.
- The server never logs a token, a device key, a query string or the body of `/link` and `/unlink`.
- Vault results are never cached. Only public data (public collections, public elements, images)
  is cached in memory.
- `/link` and `/unlink`: 30 requests per IP in 15 minutes. Vault requests with a wrong key: 20 per
  IP in 15 minutes, then 429.
- Picker, canvas and upload links hold 32 random bytes (base64url). The server stores only their
  SHA-256 hash. An unknown id gives 404; 30 unknown ids per IP in 15 minutes give 429. The request
  log shows these paths as `/p/:id`, `/v/:id` and `/u/:id`.
- The pages send a strict Content-Security-Policy (scripts and styles from this server only, images
  from this server and `cdn.cosmos.so`), `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`
  and `Cache-Control: no-store`. Page writes need `Content-Type: application/json`, so a form on
  another site cannot post them.
- Uploads are decoded and stored again as WebP, at most 2880 x 12000 px. A file that is not an
  image gives 400. An image over 50 megapixels gives 413 before it is decoded. Uploads decode one
  at a time, and with 4 waiting the next one gets 503.

## Configuration

| Variable | Default | Use |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port. |
| `DATA_DIR` | `/data` | Directory of `links.json`, `auth.db` and the pick data. It must be writable by the server user. |
| `LINK_ALLOWED_USERS` | empty (all) | Comma-separated Cosmos usernames that may link, such as `henrikkvamme`. Leave it empty when anyone may sign up. |
| `TRUST_PROXY` | on | The client IP is the last `X-Forwarded-For` entry (set by the Dokploy proxy). Set `0` when the server is reachable without a proxy. |
| `LINK_RATE_LIMIT` | `30` | `/link` and `/unlink` requests per IP in 15 minutes. |
| `KEY_FAILURE_LIMIT` | `20` | Vault requests with a wrong key per IP in 15 minutes. |
| `PUBLIC_URL` | from the request | The public origin: the base of picker and canvas links, and the OAuth issuer and resource. Sign-in needs it, such as `https://cosmos-mcp.henrikkvamme.no`. Without it, the server uses the `Host` header and, behind the proxy, `X-Forwarded-Proto`. |
| `BETTER_AUTH_SECRET` | none | Secret of Better Auth (32 random bytes or more). Sign-in is off without it. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | none | The Google OAuth client. Its redirect URI is `PUBLIC_URL/api/auth/callback/google`. Sign-in is off without them, and `POST /mcp` answers 503. |
| `USER_RATE_LIMIT` | `600` | MCP requests of one signed-in user in 15 minutes. |
| `CONNECT_RATE_LIMIT` | `30` | `/connect/start`, `/connect/state` and connect requests per IP in 15 minutes. |
| `PICK_WAIT_MS` | `50000` | How long one `wait_for_picks` call waits. Keep it under the 60-second tool timeout of agents. |
| `PAGE_GUESS_LIMIT` | `30` | Unknown page or upload ids per IP in 15 minutes. |
| `COSMOS_GRAPHQL_URL` | `https://api.cosmos.so/graphql` | For tests only: a fake Cosmos. |

## Storage

`DATA_DIR/links.json` holds the linked accounts. The server writes it to a temporary file with mode
600 and renames it, so a crash never leaves half a file. A file that cannot be read is moved aside
as `links.json.broken-<time>`.

The design flow keeps its data in the same directory, written the same way:

- `picks.json`: pick sessions and canvas boards, keyed by the hash of their id. A session expires 7
  days after its last change, a board 30 days after it was made. At most 20 sessions and 30 boards
  per user: a new one drops the oldest.
- `boards/<board hash>/<n>.webp`: the uploaded screenshots.
- `history/<Cosmos user id>.json`: the pick history, newest task first. Per task: the task, the time,
  the picked elements and up to 300 passed ones. At most 100 tasks, each kept 12 months.
  `clear_pick_history` deletes it. Unlinking a device does not, while a device or a user is left.
- `auth.db` (SQLite): the users, sessions, OAuth clients, grants and signing keys of Better Auth.

A `links.json` of version 1 (keyed by username) is read and saved as version 2 at the start, and
the history file and image folder of each account move from the username to the Cosmos user id.

In Dokploy, mount a **named volume** at `/data` (Advanced, Volumes). A new named volume takes the
owner of `/data` in the image (user `node`). A bind mount needs a host directory owned by uid 1000.
Do not add this volume to backups: it holds the tokens. Losing it loses the pick history, the
sign-ins and the grants: each person must link and sign in again. When `/data` is not writable, the server still serves the public endpoint and logs
`store_unwritable`, and `/link` answers 503.

## Run

```sh
npm ci
npm run build
PORT=3000 DATA_DIR=./data npm start
claude mcp add --transport http cosmos http://localhost:3000/mcp/<username>/<slug>
```

Docker (the build context is this directory):

```sh
docker build -t cosmos-mcp .
docker run --rm -p 3000:3000 -v cosmos-mcp-data:/data cosmos-mcp
```

## Smoke test

```sh
npm run smoke
```

`scripts/smoke-auth.mjs` covers sign-in: the move from version 1, the OAuth flow of an MCP client
with a test sign-in, the connect ticket, and what is deleted when.

`scripts/smoke.mjs` starts a fake Cosmos (`scripts/fake-cosmos.mjs`) and the built server with
`COSMOS_GRAPHQL_URL` pointing at it. Requests with a token get mock data. Requests without a token
go through the fake to the real Cosmos API, so the public endpoint, `search_cosmos` and
`get_reference` are tested against the real API. It needs network access to cosmos.so.

## How it reads Cosmos

- The server sends its own GraphQL query text to `https://api.cosmos.so/graphql`, with the user
  agent `cosmos-mcp/0.1`. It does not use the persisted-query hashes of the Cosmos web app, so a
  Cosmos web deploy does not break it. A change of the Cosmos schema does: the tool result then
  shows the Cosmos error, such as `Cannot query field 'x' on type 'Y'`. The queries are in
  `src/cosmos.ts` and `src/vault.ts`.
- Vault calls send `Authorization: Bearer <token>`. A cookie header does not work.
- `clusterConnections` lists a collection in pages of 100, newest saved first. The vault reads it by
  collection id, so private collections work.
- `userClusters(userId)` lists the collections (it needs the token). The save uses the
  `editElementsConnectionsToClusters` mutation of the Cosmos web app.
- For an element that is not in the collection, `elementView` gives the data. If that fails, the
  server reads the JSON-LD block of `https://www.cosmos.so/e/<id>`.
- Images come from `https://cdn.cosmos.so`.
- The server fetches only `api.cosmos.so`, `www.cosmos.so` and `cdn.cosmos.so`.
- "More like these" uses `similarElements(elementIds: [<id>])`, anonymously. It takes one id, so
  the server asks once per pick and takes the results round robin.
- Memory caches (public data only): a collection for 60 seconds (the last good copy for one hour
  when Cosmos fails), a single element for one hour, a downscaled image for 24 hours (64 MB in total).
