# cosmos-mcp

A remote, stateless MCP server (Streamable HTTP) for the elements of a public
Cosmos (cosmos.so) collection. It is read-only and needs no login and no secret.

## Routes

- `POST /mcp/<username>/<slug>`: the MCP endpoint for `https://www.cosmos.so/<username>/<slug>`.
  `GET` and `DELETE` return 405, because the server keeps no session.
- `GET /health`: `ok`.
- `GET /`: usage text.

## Tools

- `search_references { query?, kind?, limit? }`: word match over description, title, author and source URL.
- `list_references { limit?, cursor? }`: newest saved first, in pages.
- `get_reference { id }`: metadata and the image (for a video: its thumbnail and the MP4 URL).

## Run

```sh
npm ci
npm run build
PORT=3000 npm start
claude mcp add --transport http cosmos http://localhost:3000/mcp/<username>/<slug>
```

Docker (the build context is this directory):

```sh
docker build -t cosmos-mcp .
docker run --rm -p 3000:3000 cosmos-mcp
```

## How it reads Cosmos

- The server sends its own GraphQL query text to `https://api.cosmos.so/graphql`. Cosmos answers
  these without a login for public collections. The server does not use the persisted-query hashes
  of the Cosmos web app, so a Cosmos web deploy does not break it. A change of the Cosmos schema
  does: the tool result then shows the Cosmos error, such as `Cannot query field 'x' on type 'Y'`.
  The queries are in `src/cosmos.ts`.
- `clusterConnections` lists a collection in pages of 100, newest saved first.
- For an element that is not in the collection, `elementView` gives the data. If that fails, the
  server reads the JSON-LD block of `https://www.cosmos.so/e/<id>`.
- Images come from `https://cdn.cosmos.so`.
- The server fetches only `api.cosmos.so`, `www.cosmos.so` and `cdn.cosmos.so`.
- Memory caches: a collection for 60 seconds (the last good copy for one hour when Cosmos fails),
  a single element for one hour, a downscaled image for 24 hours (64 MB in total).
