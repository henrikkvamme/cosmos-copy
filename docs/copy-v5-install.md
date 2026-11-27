# TasteRef v5 Local Install Copy

Ready-to-paste user-facing copy for the local TasteRef install flow.

---

## 1. Landing page Install section

**h2**

Install TasteRef

**Lede**

Everything runs on your Mac. No account, no cloud storage, free and open source.

**Primary button**

Download for Mac

**Secondary button**

Chrome Web Store

**3-step preview list**

1. **Open TasteRef Setup** - Download and open the Mac app. It sets up your local vault and starts the local server in seconds.
2. **Add the extension** - Install TasteRef from the Chrome Web Store, or load it from the folder TasteRef Setup creates.
3. **Connect your agent** - Follow the welcome page to run one command for your agent, then copy your first reference.

**"Or let your agent do it" line**

Or let your agent install it for you.

**Agent prompt**

```text
Install TasteRef on this Mac.

1. Download TasteRef Setup from <DOWNLOAD_URL>, unzip it, and open TasteRef Setup.app.
2. Wait for TasteRef Setup to finish and confirm the local server responds at http://127.0.0.1:47827/status.
3. Add TasteRef as an MCP server for yourself:
   - Claude Code: claude mcp add --transport http tasteref http://127.0.0.1:47827/mcp
   - Codex: codex mcp add tasteref --url http://127.0.0.1:47827/mcp
   - Other MCP clients: add http://127.0.0.1:47827/mcp (streamable HTTP) or ~/Library/Application Support/TasteRef/bin/tasteref-mcp (stdio).
4. Tell me when you are ready so I can add the extension on the welcome page and press Option+Shift+C on a test image.
```

**Requirements line**

Requires macOS, a supported browser (Chrome, Brave, Ardia, Edge or Arc), and an agent that supports MCP. No account, Xcode or admin password needed.

---

## 2. Closing section

**h2**

Start your local vault

**One line**

Download TasteRef Setup, add the extension, and let your agent learn what you like.

**Button label**

Download for Mac

---

## 3. Welcome page (`/welcome`)

**Page title**

TasteRef - Welcome

**h1**

Set up TasteRef

**Lede**

Each step below checks itself. Finish any open step and your local vault is ready.

**Fallback note (when the extension is not installed yet)**

The extension is not active in this browser yet, so this page cannot check your Mac automatically. Install TasteRef Setup and add the extension below, then reload this page.

### Checklist rows

#### 1. Extension installed

- **Row title:** Extension installed
- **Done-state line:** The TasteRef extension is active in this browser.
- **Not-done line:** Add the extension so Option+Shift+C works on any site.
- **Action button label:** Chrome Web Store

#### 2. TasteRef Setup installed

- **Row title:** TasteRef Setup installed
- **Done-state line:** TasteRef Setup is installed and the local server is running.
- **Not-done line:** Download and open TasteRef Setup to install the clipboard helper and start your local vault.
- **Action button label:** Download for Mac

#### 3. Connect your agent

- **Row title:** Connect your agent
- **Done-state line:** Your agent is connected to your local vault.
- **Not-done line:** Pick your agent below and add the local TasteRef MCP server.
- **Action button label:** Copy command *(use `Open in Cursor` / `Open in VS Code` on the one-click tabs)*

**Agent tabs**

- **Claude Code:** Run this command in your terminal to connect Claude Code to your local vault.
  - Command: `claude mcp add --transport http tasteref http://127.0.0.1:47827/mcp`
- **Codex:** Run this command in your terminal to connect Codex to your local vault.
  - Command: `codex mcp add tasteref --url http://127.0.0.1:47827/mcp`
- **Cursor:** Click the button to add TasteRef directly to Cursor.
- **VS Code:** Click the button to add TasteRef directly to VS Code.
- **Claude Desktop:** Add this command to your Claude Desktop MCP config file, then restart Claude Desktop.
  - Command: `~/Library/Application Support/TasteRef/bin/tasteref-mcp`

#### 4. Try it

- **Row title:** Try it
- **Done-state line:** Your first reference is saved in your vault.
- **Not-done line:** Hover the sample image below, press Option+Shift+C, and paste it into your agent.
- **Action button label:** Open vault *(or `Change shortcut` while not done, if Option+Shift+C conflicts)*

#### 5. Optional: Cosmos

- **Row title:** Optional: Cosmos
- **Done-state line:** Cosmos is connected. Press C on cosmos.so and search your collections from your agent.
- **Not-done line:** Sign in to cosmos.so in this browser to press C on Cosmos and search your collections.
- **Action button label:** Sign in to Cosmos

### Load unpacked guide

1. Open your browser's extensions page: go to `chrome://extensions` (or `brave://extensions`, `edge://extensions`, `arc://extensions`). In Ardia, open Settings, turn on "Show advanced settings", and open Extensions.
2. Turn on **Developer mode** in the top-right corner.
3. Click **Load unpacked**.
4. Choose `~/Library/Application Support/TasteRef/extension` and click **Select**.

### Final "you're all set" message

**Heading:** You are all set

**Body:** Hover any image or video on the web, press Option+Shift+C, and paste it into your agent. Every copy stays in your vault on this Mac.

---

## 4. Setup app (`TasteRef Setup`)

**Window title**

TasteRef Setup

**Progress lines**

- **Copying files:** Copying TasteRef files to your Mac...
- **Registering with browsers:** Registering with your browsers...
- **Starting the local server:** Starting the local vault server...
- **Opening the welcome page:** Opening the welcome page...

**Done message**

- **Heading:** TasteRef Setup is done
- **Body:** Your local vault server is running in the background. Finish setup on the welcome page that just opened in your browser.
- **Primary button:** Done
- **Secondary button:** Open welcome page

**Error messages**

- **No supported browser found**
  - **Heading:** No supported browser found
  - **Body:** TasteRef works with Chrome, Brave, Ardia, Edge and Arc. Install one of these browsers, open it once, then run TasteRef Setup again.
- **Could not start the local server**
  - **Heading:** Could not start the local server
  - **Body:** TasteRef could not start the background server on port 47827. Close any app using that port, check `~/Library/Logs/TasteRef/` for details, and run TasteRef Setup again.
- **Generic error**
  - **Heading:** Setup could not finish
  - **Body:** TasteRef Setup ran into a problem and stopped. Check `~/Library/Logs/TasteRef/` for details, then open TasteRef Setup again.

**Uninstall confirmation text**

- **Heading:** Uninstall TasteRef?
- **Body:** This removes TasteRef's app files, browser registration, and background server from your Mac. Your vault folder and saved references stay on your Mac unless you choose to delete them too.
- **Optional checkbox:** Also delete my vault folder and all saved references
- **Primary button:** Uninstall
- **Secondary button:** Cancel
- **Done line:** TasteRef has been removed from your Mac. You can also remove the extension from your browser.

---

## 5. Extension popup

**Agent section (replaces Google connect flow)**

- **Heading:** Connect agents
- **One line:** Connect Claude Code, Codex, Cursor, VS Code or Claude Desktop to your local vault.
- **Link label:** Open setup page

**Toast when the local server is not running**

Copied to clipboard, but the local server is not running. Open TasteRef Setup to save to your vault.

---

## 6. Chrome Web Store listing

**Name**

TasteRef

**Short description**

Copy any image or video with Option+Shift+C and paste it into your AI agent. Saved to a local vault on your Mac.

Character count: 112 / 132

**Full description**

TasteRef is ⌘C ⌘V that learns. Hover over an image or video on any website, press Option+Shift+C, and paste it straight into Claude Code, Codex, Cursor, VS Code or Claude Desktop as a design reference.

Every copy includes a small reference ID strip and saves automatically to a local vault on your Mac. When you paste a reference into your agent, your agent looks it up in your vault through MCP, reads the source details, and records where and why you used it. Over time, your agent remembers what you liked and what you passed on, so it can design from your taste even when you paste nothing.

TasteRef runs completely on your Mac. There is no account, no cloud storage, and nothing sent to our servers. Your agent does all AI work using the subscription you already pay for. TasteRef is free and open source.

Cosmos is optional. If you sign in to cosmos.so in your browser, you can press C on Cosmos to copy, like, and save elements to your collections, and let your agent search your Cosmos collections alongside your local vault.

Requires macOS and the free TasteRef Setup app from tasteref.henrikkvamme.no.

*(195 words)*

**Single-purpose statement**

Copy images and videos from web pages as design references and save them to a local vault on the user's Mac for AI coding agents.

**Permission justifications**

- **`nativeMessaging`:** Talks to the local TasteRef helper on the user's Mac to download the hovered image or video, place it on the macOS clipboard with its reference ID strip, and read the local server configuration.
- **`activeTab`:** Reads the image or video element under the user's cursor in the current tab when the user presses the Option+Shift+C or Option+Shift+A shortcut.
- **`scripting`:** Injects the short hover-lookup script into the active tab when the user triggers a copy shortcut, and displays a brief confirmation toast on the page.
- **`storage`:** Stores the user's local extension settings, such as whether to save copies to the vault, the selected Cosmos collection, and the current clipboard tray items.
- **`cookies`:** Reads only the session cookie for `cosmos.so`, and only to power the optional Cosmos features (liking, saving to collections, and letting the user's local server search their Cosmos collections). Cookies for other sites are never read.
- **`alarms`:** Periodically refreshes the optional Cosmos session link with the user's local server so Cosmos collection search stays working without manual steps.
- **Host permission (`https://www.cosmos.so/*`):** Enables the `C` and `Shift+C` shortcuts on `cosmos.so` and supports optional liking and saving to the user's Cosmos collections.
- **Host permission (`https://tasteref.henrikkvamme.no/*`):** Lets the TasteRef welcome page check setup status with the extension and supports the interactive copy demo on the TasteRef landing page.

---

## 7. README Install and Uninstall sections

```markdown
## Install

TasteRef runs locally on macOS (Apple Silicon and Intel) with Chrome, Brave, Ardia, Edge or Arc. No account, Xcode or admin password is required.

1. Download and open **TasteRef Setup** from the [latest release](https://github.com/henrikkvamme/cosmos-copy/releases/latest). It copies the runtime to `~/Library/Application Support/TasteRef/`, registers the native messaging helper with your browsers, starts the local MCP server at `http://127.0.0.1:47827/mcp`, and opens the welcome page.
2. Add the TasteRef extension from the Chrome Web Store. Until the store listing is live, load `~/Library/Application Support/TasteRef/extension` unpacked in your browser's extensions page (Developer mode).
3. Follow the welcome page at `https://tasteref.henrikkvamme.no/welcome` to connect your agent (Claude Code, Codex, Cursor, VS Code or Claude Desktop) and try your first copy with Option+Shift+C.

Logs are written to `~/Library/Logs/TasteRef/`.

If you prefer to build from source instead of using TasteRef Setup, clone this repository and run `./install.sh` (requires Xcode Command Line Tools).

## Uninstall

1. Run TasteRef Setup with `--uninstall` in Terminal (adjust the path if you moved the app):

   ```sh
   "$HOME/Downloads/TasteRef Setup.app/Contents/MacOS/TasteRef Setup" --uninstall
   ```

   This stops and removes the background server, browser registration, and app files in `~/Library/Application Support/TasteRef/`. Your vault folder stays on your Mac unless you choose to delete it during uninstall.
2. Remove the **TasteRef** extension from your browser's extensions page.
3. Remove the `tasteref` MCP server from your agent (for example, `claude mcp remove tasteref` or `codex mcp remove tasteref`).
```

---

## 8. `/privacy` page summary

1. **Everything stays on your Mac.** Your vault, copied images and videos, pick history, and local MCP server run on your own computer (`127.0.0.1`) and nowhere else.
2. **No account and no tracking.** TasteRef requires no sign-in, collects no analytics, and stores nothing about you on our server.
3. **Our website is static.** `tasteref.henrikkvamme.no` serves only the landing, welcome, and privacy pages. When the welcome page checks your setup, the extension reads status directly in your browser without sending data to us.
4. **Private windows are never saved.** TasteRef does not save copies made in private or incognito browser windows.
5. **Cosmos is optional and local.** If you sign in to `cosmos.so`, the extension shares your Cosmos session token only with your local server on your Mac so your agent can search your collections. It is never sent to our server.
6. **Delete anytime.** Delete any reference in your local vault, or run TasteRef Setup with `--uninstall` and remove the vault folder to delete everything.
