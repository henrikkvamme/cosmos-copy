# Plan v5: a local TasteRef with a simple install

Agreed with Henrik on 2026-11-27. TasteRef runs on the user's Mac: the vault is a folder there, agents
connect to a local MCP server, and the install needs no account. Cosmos becomes an optional extra. The
hosted vault stays up for existing users; a cloud option comes later as a project of its own.

## Today (what we replace)

Eight steps: a coding agent clones the repo, Xcode Command Line Tools build the Swift helper,
`install.sh` registers it, the user loads the extension unpacked in Developer mode, signs in to
cosmos.so, opens the popup gear, signs in with Google, copies a setup prompt and pastes it into the
agent. The account is the Cosmos username. Nothing tells the user which step failed.

## Goal

Three things for the user to do, and one page that checks itself:

1. Download and open **TasteRef Setup** (a signed, notarized Mac app). No admin password, Xcode or git.
2. Add the extension: one click in the Chrome Web Store (free listing, Henrik's existing developer
   account). Until the listing is approved, the welcome page guides Load unpacked with the folder ready.
3. On the **welcome page**, connect an agent with one command or button, and try a copy.

## Parts

### 1. The local runtime

The local runtime is the existing server in a local mode, not a rewrite. The vault, MCP tools,
keyword search, pick pages, contact sheets and canvas already run without AI or accounts. One
codebase serves both hosted and local, so the later cloud option stays the same code.

- `LOCAL=1` mode in `server/src/index.ts`:
  - Listens on `127.0.0.1:47827` only (fixed port, so agent configs stay valid).
  - One owner, `local`. No better-auth, no OAuth, no Google, no `/link`, no `/connect`, no `/account`,
    no landing page.
  - `/mcp` needs no key. It refuses a request whose `Host` is not `127.0.0.1:47827` or
    `localhost:47827` (DNS rebinding), and a request with an `Origin` header that is not a local
    page of the server (a web page in the browser).
  - The vault upload API (`/vault/...`) stays as it is; the device key is a local secret that the
    setup writes to `config.json` (mode 0600). The helper sends it, as today.
  - Cosmos is optional: if the extension relays a Cosmos token (as `link.js` does today, to the
    local server), the Cosmos tools work. Without one, they answer with one line: sign in to cosmos.so
    in the browser to use Cosmos.
  - Records each MCP `initialize` (client name and time) in `config.json`, so the welcome page can
    show that an agent connected.
- `GET /status` (local only): version, vault count, agents seen, Cosmos linked or not.
- Video frames: `ownvault.ts` runs a frame tool. Hosted: ffmpeg, as today. Local: the Swift helper's
  new `frame <in> <out>` command (AVFoundation). So the Mac app ships no ffmpeg.
- `sharp` stays. The app ships the prebuilt `@img/sharp-darwin-arm64` and `-x64` packages.

### 2. The Mac app (`TasteRef Setup.app`)

Built by `scripts/package-mac.ts` on fry, the way Sift builds its setup app:

- Contents: a universal Node runtime (official arm64 and x64 binaries, joined with `lipo`), the built
  server (`dist/`) with production `node_modules`, the universal Swift helper, and the extension folder.
- Signed with "Developer ID Application: Henrik Kvamme (BTE6QWN2W2)", hardened runtime, with the
  JIT entitlement that Node needs. Every Mach-O file is signed (node, helper, `.node`, dylibs).
  Notarized with the `sift-notary` profile, stapled, zipped with `ditto`.
- Published as a GitHub release asset (the repo is open source). The landing page links the latest one.

When the user opens it, the app (a small Swift program, no window beyond a progress and done sheet):

1. Copies the runtime to `~/Library/Application Support/TasteRef/` (replaces an older copy).
2. Writes `config.json` with a new device key, unless one exists.
3. Writes the native messaging host manifest for Chrome, Brave, Ardia, Edge and Arc, where the
   browser's folder exists. `allowed_origins` lists both extension ids (unpacked key and store).
4. Installs and starts the LaunchAgent `no.henrikkvamme.tasteref` (`RunAtLoad`, `KeepAlive`), which
   runs the local server. Logs to `~/Library/Logs/TasteRef/`.
5. Opens the default browser at `https://tasteref.henrikkvamme.no/welcome`.

`--uninstall` removes all of this, except the vault folder unless the user says so.

The helper answers a new native message `config`: the local server URL and the device key. The
extension reads its server URL and key from there, not from `defaults.js`.

### 3. The extension

- `onInstalled` (install, not update) opens the welcome page.
- `externally_connectable` for `https://tasteref.henrikkvamme.no/*`: the welcome page asks the
  extension for its status (version, helper answers, local server answers, Cosmos signed in, last copy).
- The popup gear loses the Google connect and setup prompt flow. Its agent section links to the
  welcome page. The vault page link goes to the local server.
- Store build: `scripts/package-extension.ts` makes the store zip (no `key` field). Version bump per
  release.

### 4. The welcome page (`/welcome`, hosted, static)

A live checklist. Each row ticks itself. If it cannot, it shows the one action that fixes it:

1. Extension installed (else: the store button, or the Load unpacked guide with pictures).
2. TasteRef Setup installed: the helper and the local server answer (else: the download button).
3. Connect your agent: tabs with a copy button each:
   - Claude Code: `claude mcp add --scope user --transport http tasteref http://127.0.0.1:47827/mcp`
   - Codex: `codex mcp add tasteref --url http://127.0.0.1:47827/mcp`
   - Cursor and VS Code: their MCP install links.
   - Claude Desktop: a stdio bridge command, `~/Library/Application Support/TasteRef/bin/tasteref-mcp`
     (proxies stdio to the local HTTP server).
   Ticks when the server has seen an agent connect.
4. Try it: hover a picture on the page, press Option+Shift+C, paste into the agent. Ticks on the first
   real copy.
5. Optional: Cosmos. Sign in to cosmos.so to press C there, and to search your Cosmos collections.

Without the extension, the page cannot read the status. It then shows steps 1 and 2 as plain steps.

### 5. The landing page and docs

- The Install section becomes "Download for Mac" plus "Get it from the Chrome Web Store", the same
  checklist preview, and a short "or let your agent do it" prompt (download, open the app, run one
  `mcp add` command).
- README: install, local vault, uninstall, build from source (`install.sh` stays for developers).
- `/privacy`: the local vault stores nothing on our server.
- Gemini 4 Neon writes the copy for the welcome page, install section, README and store listing.

### 6. Chrome Web Store

Listing text (Neon), screenshots, privacy answers (single purpose; data stays on the device), and the
store zip. Submitted from Henrik's account. Load unpacked stays the fallback until it is approved.

## Order

1. Local mode in the server, with smoke tests for it (`scripts/smoke-local.mjs`).
2. Helper: `config` and `frame` commands.
3. Setup app and packaging, signed and notarized; test install and uninstall on fry.
4. Extension: config from the helper, welcome on install, external status, popup changes.
5. Welcome page and landing changes, copy by Neon.
6. End-to-end on a clean macOS user account on fry: download, open, load the extension, connect Claude
   Code, copy, paste, search the vault.
7. Store zip and listing, then submit.

## Risks

- Node in a notarized app needs the right entitlements; Sift's setup app is the pattern for the signing
  steps, but it has no Node. Test notarization early (step 3 before step 4).
- A local web server is reachable from browser pages. The Host and Origin checks, plus Chrome's Private
  Network Access, are the guard. Sol reviews this part.
- The store review can ask for changes; Load unpacked covers the wait.
- Existing users of the hosted vault (Henrik): their hosted vault keeps working. Moving it to local is
  an export/import step, not in this plan.

## Changes after review round 1 (Sol, 2026-11-27)

These replace the matching lines above where they differ.

| Id | Change |
| --- | --- |
| S1 | Local uploads do not go through Cosmos. In local mode `vaultTarget()` uses the server URL and key from the helper's `config` answer, with no `link` check. `/vault/upload` authenticates the key directly against `config.json` and maps it to owner `local`. |
| S2 | The bundle ships `server/pages/` (the pick, canvas and vault pages and their assets). In local mode the server does not construct `Landing`, `AccountPages`, better-auth or `LinkStore`. |
| S3 | Local vault routes: `GET /vault` (page), list, file, thumbnail and delete for owner `local`. Writes (delete) need the same Host check plus an `Origin` equal to the local server, and a per-run CSRF token in the page. |
| S4 | Local Cosmos relay: `POST /local/cosmos` with the device key (token in, unlink with an empty body). `link.js` calls it in local mode in place of `/link` and `/unlink`. |
| S5 | Two identities in the context: `owner: "local"` for storage, and `cosmos: { userId: number, username } | undefined` for Cosmos calls. Cosmos tools read only `cosmos`. |
| S6 | Video frames: the helper's `frame` command (AVFoundation) handles MP4 and MOV. For WebM, and when the helper fails, the extension sends the frame it already draws for the toast preview as a JPEG with the upload. If neither works, the video is saved with a plain video thumbnail, not refused. No ffmpeg in the app. |
| S7 | Manifest `host_permissions` add `http://127.0.0.1:47827/*`. The extension uses only that address. |
| S8 | Setup creates the `NativeMessagingHosts` folder for each supported browser that is installed in `/Applications` or `~/Applications`, even before its first launch. The LaunchAgent server repeats the registration at each start, so a browser installed later is covered. |
| S9 | Claude Code command: `claude mcp add --scope user --transport http tasteref http://127.0.0.1:47827/mcp`. Codex config is global already; check each agent's scope in step 5. |
| S10 | New step 0: upload a draft to the Chrome Web Store and record the store extension id before the setup app is packaged. `allowed_origins` lists the store id and the unpacked id. The welcome page tries both ids. |
| S11 | Install and upgrade: `launchctl bootout` the job, write the new runtime to a temporary folder, rename it into place, `launchctl bootstrap` again, then poll `/status` until the version matches. State (`config.json`, the vault) lives in `~/Library/Application Support/TasteRef/data/`, outside the replaced `runtime/` folder. |
| S12 | The Host check runs for every request before any route. Origin rules: requests with no `Origin` (agents, the helper) pass; a request whose `Origin` is the local server passes; the extension origin passes for `/status` and the relay; all other origins are refused. No reliance on Local Network Access. |
| S13 | Store privacy answers declare: website content (the copied image or video and its page URL and title), authentication information (the optional cosmos.so session token, sent only to the local server and to cosmos.so), and that copies are processed and stored on the user's device. |

Order, updated: 0 (store draft id), then 1 to 7 as above.

## Changes after review round 2

| Id | Change |
| --- | --- |
| N1 (S6) | The WebM fallback frame is its own capture, not the toast preview: the whole frame, uncropped, long edge at most 1024 px, JPEG at quality 0.85. The content script draws it once per copy and sends it with the copy number. A tainted canvas or an export error falls back to the plain video thumbnail. |
| N2 (S8) | Repair on demand: when the extension's native message fails with "host not found", it calls `POST /local/repair` on the local server (Host and Origin rules apply), which writes the host manifests for every installed browser, then the extension retries once. The welcome page shows the same repair as a button. The server also re-registers at each start. |
| N3 (S11) | Upgrade: write the new runtime to `runtime.new/` and check it (`node --version`, and `node runtime.new/dist/index.js --self-check`, which loads the server without listening). Then `launchctl bootout`, rename `runtime/` to `runtime.old/`, rename `runtime.new/` to `runtime/`, `launchctl bootstrap`, and poll `/status` for the new version for up to 15 seconds. On any failure, rename back, bootstrap the old runtime, and show the error. On success, delete `runtime.old/`. |
