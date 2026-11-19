import { DEFAULT_SETTINGS } from "./defaults.js";

const NEW = "__new__";
const $ = (id) => document.getElementById(id);
const ask = async (message) => {
  const res = await chrome.runtime.sendMessage(message);
  if (!res?.ok) throw new Error(res?.error ?? "No answer from the extension");
  return res;
};
const status = (text, isError = false) => {
  $("status").textContent = text;
  $("status").classList.toggle("error", isError);
};

async function settings() {
  const { settings: stored } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...stored };
}
async function saveSettings(patch) {
  await chrome.storage.local.set({ settings: { ...(await settings()), ...patch } });
}

// ---- Tray: what is on the clipboard now ----

// Small thumbnails from the Cosmos CDN; other sites give the image itself.
function thumbUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname === "cdn.cosmos.so") return `${u.origin}${u.pathname}?format=webp&w=240`;
  } catch {}
  return url;
}

const X_ICON = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2 2 8"/></svg>';

function renderTray(items) {
  const grid = $("grid");
  grid.replaceChildren(
    ...items.map((item) => {
      const cell = document.createElement("div");
      cell.className = "thumb";
      const link = document.createElement("a");
      link.href = item.pageUrl ?? "#";
      link.target = "_blank";
      link.rel = "noreferrer";
      link.title = item.pageUrl ?? "";
      const isVideoFile = item.kind === "video" && /\.(mp4|webm|mov)(\?|$)/i.test(item.thumb ?? "");
      const media = document.createElement(isVideoFile ? "video" : "img");
      media.src = thumbUrl(item.thumb);
      if (isVideoFile) Object.assign(media, { muted: true, preload: "metadata" });
      else media.alt = "";
      link.append(media);
      cell.append(link);
      if (item.kind === "video") cell.insertAdjacentHTML("beforeend", '<span class="play"></span>');
      const remove = document.createElement("button");
      remove.className = "remove";
      remove.title = "Remove from the clipboard";
      remove.setAttribute("aria-label", "Remove from the clipboard");
      remove.innerHTML = X_ICON;
      remove.onclick = async () => {
        try {
          renderTray((await ask({ type: "popup:remove", path: item.path })).items);
        } catch (err) {
          trayError(err.message);
        }
      };
      cell.append(remove);
      return cell;
    }),
  );
  $("empty").hidden = items.length > 0;
  $("count").classList.remove("error");
  $("count").textContent = items.length ? `${items.length} on the clipboard` : "";
}

function trayError(text) {
  $("count").textContent = text;
  $("count").classList.add("error");
}

async function loadTray() {
  // Grey squares at true size while the helper answers, so nothing moves when the items land.
  const { batch } = await chrome.storage.session.get("batch");
  const expected = Math.min(batch?.items?.length ?? 0, 9);
  $("grid").replaceChildren(...Array.from({ length: expected }, () => Object.assign(document.createElement("div"), { className: "thumb loading" })));
  try {
    renderTray((await ask({ type: "popup:batch" })).items);
  } catch (err) {
    $("grid").replaceChildren();
    const hint = err.message.includes("native messaging host") ? " Run install.sh in cosmos-copy." : "";
    trayError(`Could not read the clipboard: ${err.message}.${hint}`);
  }
}

// ---- Settings ----

// Claude Code gives the agent the server's own instructions, so it needs the server only. Codex
// does not, so other clients get a short rule that names the two tools a task starts with. The
// tool results carry the rest of the flow. Tested with GPT-6 Luna in Codex on 2026-11-19.
function setupPrompt(url) {
  return `Set up my Cosmos (cosmos.so) design references as an MCP server.

Server: ${url}
The key in the URL is the login. Keep the URL private: do not print it, log it or commit it.

1. Add it at user scope with the name "cosmos". If a server with that name exists, replace it.
   Claude Code: claude mcp add --transport http --scope user cosmos "${url}"
   Codex: codex mcp add cosmos --url "${url}"
   Other clients: add a streamable HTTP MCP server with that URL.
2. Check that it connects (for example claude mcp list or codex mcp list).
3. Claude Code is now ready. In Codex and every other client, also add this rule to my user-level instructions (Codex: ~/.codex/AGENTS.md). If the rule is there, replace it.

## Cosmos references

- When an image in the chat has a dark strip at its bottom edge with a label such as \`cosmos 1850854004-65 · call note_references\`, call the tool \`note_references\` of the \`cosmos\` MCP server before other work, with \`task\` (the task in a few words) and \`pasted\` (the labels, such as \`["1850854004-65"]\`). The strip is not part of the design.
- When I say that I do not want a reference, call \`note_references\` again with the same \`task\` and the reference in \`rejected\`.
- When I ask for a new screen, page or UI and gave no such image, call the tool \`contact_sheet\` of the \`cosmos\` MCP server with source \`history\` first.
- Search the tools when they are not listed. Follow the steps in each tool result.

4. Tell me if I must restart the session to load it.`;
}

function showCurrent(current) {
  $("open").href = `https://www.cosmos.so/${current.username}/${current.slug}`;
  $("open").hidden = false;
}

async function loadAgents() {
  try {
    const { url, link } = await ask({ type: "popup:agents" });
    const disconnected = link?.reason === "disconnected";
    const pending = link?.reason === "unlink-pending";
    $("renew").hidden = !(link?.reason === "signed-out");
    // A disconnect the server has not confirmed must finish before anything else.
    $("unlink").hidden = !(link?.ok || pending);
    $("unlink").textContent = pending ? "Retry disconnect" : "Disconnect agents on this browser";
    $("copy-prompt").hidden = pending;
    if (pending) status("Disconnect is not finished. Old setup URLs may still work.", true);
    $("copy-prompt").textContent = disconnected ? "Connect agents again" : "Copy setup prompt";
    $("copy-prompt").onclick = async () => {
      if (disconnected) {
        await ask({ type: "popup:reconnect" });
        status("Connected with a new key. Copy the setup prompt for your agents.");
        return loadAgents();
      }
      await navigator.clipboard.writeText(setupPrompt(url));
      status(link?.ok ? "Copied. Paste it into your agent." : "Copied. Agents can connect when the link works again.");
    };
    $("copy-prompt").disabled = false;
    if (link?.reason === "error") status(`Could not reach the agent server: ${link.error}`, true);
    $("unlink").onclick = async () => {
      if (!pending && !confirm("Agents set up from this browser lose access. Disconnect?")) return;
      try {
        await ask({ type: "popup:unlink" });
        status("Disconnected. Agents set up from this browser have no access now.");
      } catch (err) {
        status(err.message, true);
      }
      loadAgents();
    };
  } catch (err) {
    status(`Could not set up agents: ${err.message}`, true);
  }
}

function fillCollections(collections, current) {
  const select = $("collection");
  const list = collections.some((c) => c.id === current.id) ? collections : [current, ...collections];
  select.replaceChildren(
    ...list.map((c) => new Option(c.isPrivate ? `${c.name} (private)` : c.name, String(c.id))),
    new Option("New collection…", NEW),
  );
  select.value = String(current.id);
  select.disabled = false;
  select.onchange = async () => {
    if (select.value === NEW) {
      $("new-form").hidden = false;
      $("new-name").focus();
      return;
    }
    $("new-form").hidden = true;
    const picked = list.find((c) => String(c.id) === select.value);
    const res = await ask({ type: "popup:set-collection", collection: picked });
    showCurrent(res.current);
    status(`New copies are saved to ${res.current.name}.`);
  };
  $("new-form").onsubmit = async (event) => {
    event.preventDefault();
    const name = $("new-name").value.trim();
    if (!name) return;
    status("Creating the collection…");
    try {
      const res = await ask({ type: "popup:set-collection", name });
      $("new-form").hidden = true;
      $("new-name").value = "";
      fillCollections([res.current, ...list.filter((c) => c.id !== res.current.id)], res.current);
      showCurrent(res.current);
      status(`New copies are saved to ${res.current.name}.`);
    } catch (err) {
      status(err.message, true);
    }
  };
}

let settingsLoaded = false;
async function loadSettings() {
  if (settingsLoaded) return;
  settingsLoaded = true;
  const prefs = await settings();
  $("like").checked = prefs.likeOnCopy;
  $("like").onchange = () => saveSettings({ likeOnCopy: $("like").checked });
  loadAgents();
  try {
    const { collections, current } = await ask({ type: "popup:collections" });
    fillCollections(collections, current);
    showCurrent(current);
  } catch (err) {
    settingsLoaded = false;
    status(`Could not reach Cosmos: ${err.message}`, true);
  }
}

function show(view) {
  document.body.dataset.view = view;
  $("title").textContent = view === "settings" ? "Settings" : "Cosmos Copy";
  if (view === "settings") loadSettings();
}

async function init() {
  $("gear").onclick = () => show("settings");
  $("back").onclick = () => show("tray");
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.body.dataset.view === "settings") {
      e.preventDefault();
      show("tray");
    }
  });

  const [command] = (await chrome.commands.getAll()).filter((c) => c.name === "copy-reference");
  const shortcut = command?.shortcut || "";
  $("shortcut").textContent = shortcut || "Set shortcut";
  $("empty-shortcut").textContent = shortcut || "the shortcut";
  $("shortcut").onclick = () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" });

  loadTray();
}

init();
