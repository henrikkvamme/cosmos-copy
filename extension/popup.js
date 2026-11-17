import { DEFAULT_SETTINGS } from "./defaults.js";

const MCP_BASE = "https://cosmos-mcp.henrikkvamme.no/mcp";
const $ = (id) => document.getElementById(id);
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

function setupPrompt(url, collectionUrl) {
  return `Add my Cosmos design references as an MCP server, so you can search and view them.

- Server: ${url}
- Transport: streamable HTTP, no auth, read-only.
- It serves my public Cosmos collection ${collectionUrl}: images and videos I saved as references.

Steps:
1. Add it for your harness at user scope, named "cosmos". Claude Code: claude mcp add --transport http --scope user cosmos ${url}
   Codex: codex mcp add cosmos --url ${url}
   Other clients: add a streamable HTTP MCP server with that URL.
2. Check that it connects (for example claude mcp list or codex mcp list).
3. Tell me if I must restart the session to load it.

Use it when I mention a Cosmos reference or ask for visual inspiration: search_references to find, get_reference to see one.`;
}

async function copy(text, label) {
  await navigator.clipboard.writeText(text);
  status(`Copied ${label}`);
}

async function showAgents() {
  const res = await chrome.runtime.sendMessage({ type: "popup:collection" });
  if (!res?.ok) {
    status(res?.error ?? "Could not reach Cosmos", true);
    return;
  }
  const { username, slug } = res.collection;
  const url = `${MCP_BASE}/${username}/${slug}`;
  const collectionUrl = `https://www.cosmos.so/${username}/${slug}`;
  $("open").href = collectionUrl;

  const claude = `claude mcp add --transport http --scope user cosmos ${url}`;
  const codex = `codex mcp add cosmos --url ${url}`;
  $("copy-claude").querySelector("code").textContent = claude;
  $("copy-codex").querySelector("code").textContent = codex;
  $("copy-claude").onclick = () => copy(claude, "Claude Code command");
  $("copy-codex").onclick = () => copy(codex, "Codex command");
  $("copy-prompt").onclick = () => copy(setupPrompt(url, collectionUrl), "setup prompt");
  for (const id of ["copy-prompt", "copy-claude", "copy-codex"]) $(id).disabled = false;
  status("");
}

async function init() {
  const prefs = await settings();
  const collection = $("collection");
  collection.value = prefs.collection;
  collection.onchange = async () => {
    const name = collection.value.trim() || DEFAULT_SETTINGS.collection;
    collection.value = name;
    await saveSettings({ collection: name });
    status("Finding the collection…");
    showAgents();
  };
  $("like").checked = prefs.likeOnCopy;
  $("like").onchange = () => saveSettings({ likeOnCopy: $("like").checked });

  const [command] = (await chrome.commands.getAll()).filter((c) => c.name === "copy-reference");
  $("shortcut").textContent = command?.shortcut || "Set shortcut";
  $("shortcut").onclick = () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" });

  status("Finding the collection…");
  showAgents();
}

init();
