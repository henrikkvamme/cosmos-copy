import { cosmos } from "./cosmos.js";
import { DEFAULT_SETTINGS, SERVER } from "./defaults.js";
import { device, reconnect, relay, startLinking, unlink } from "./link.js";

const HOST = "com.henrikkvamme.cosmos_copy";
startLinking();

async function settings() {
  const { settings: stored } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...stored };
}
async function saveSettings(patch) {
  await chrome.storage.local.set({ settings: { ...(await settings()), ...patch } });
}

// The collection copies are saved to. The popup stores the picked one; the first time, the
// default name is looked up (or created) once.
async function target() {
  const prefs = await settings();
  if (prefs.target?.id) return prefs.target;
  const found = await cosmos.collection(prefs.collection);
  await saveSettings({ target: found });
  return found;
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "copy-reference") copyReference(tab);
  if (command === "add-reference") copyReference(tab, undefined, true);
});

async function activeTab(tab) {
  if (tab?.id) return tab;
  const [current] = await chrome.tabs.query({ active: true, currentWindow: true });
  return current;
}

async function askTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // No content script yet (another site, or the tab was open before install).
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

function toast(tabId, text, isError = false) {
  chrome.tabs.sendMessage(tabId, { type: "cosmos-copy:toast", text, isError }).catch(() => {});
}

async function native(message) {
  const result = await chrome.runtime.sendNativeMessage(HOST, message);
  if (!result?.ok) throw new Error(result?.error ?? "The native helper gave no answer");
  return result;
}

// A copy replaces the clipboard. An add (Shift+C) keeps the batch that is on it. The batch is
// gone when something else changed the clipboard (the helper checks the change count).

// The batch as it is on the clipboard now: empty when something else was copied since.
async function currentBatch() {
  const { batch } = await chrome.storage.session.get("batch");
  if (!batch?.items?.length) return null;
  const { changeCount } = await native({ type: "status" });
  return changeCount === batch.changeCount ? batch : null;
}

// One clipboard change at a time, so two fast presses both land in the batch.
let clipboardQueue = Promise.resolve();
function serial(task) {
  const run = clipboardQueue.then(task);
  clipboardQueue = run.catch(() => {});
  return run;
}

// A copy takes its place in the queue when the key press arrives, before the lookups. Without
// this, C on one element and Shift+C on the next can land in the wrong order when the second
// lookup ends first, and the replace then erases the add.
function reserveClipboard() {
  let release;
  const turn = clipboardQueue;
  const done = new Promise((resolve) => (release = resolve));
  // The next in line waits for the ones before this copy and for this copy: a copy that fails
  // early must not let a later one pass an earlier one that is still at work.
  clipboardQueue = turn.then(() => done);
  return { turn, release };
}

// A lookup that never ends must not hold the queue. After the limit the copy fails, and the
// late answer is dropped, because the copy step is never reached.
const LOOKUP_MS = 20_000;
function withLimit(promise, what) {
  let timer;
  const limit = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} took too long`)), LOOKUP_MS)));
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

async function copyToClipboard(slot, media, name, meta, add) {
  await slot.turn;
  const batch = add ? (await chrome.storage.session.get("batch")).batch : undefined;
  const result = await native({ url: media.url, kind: media.kind, name, appendTo: batch?.changeCount });
  const item = { path: result.path, kind: media.kind, thumb: media.thumb ?? media.url, ...meta };
  const kept = result.count > 1 ? (batch?.items ?? []).filter((i) => i.path !== item.path) : [];
  await chrome.storage.session.set({ batch: { changeCount: result.changeCount, items: [...kept, item] } });
  return result;
}

function removeFromClipboard(path) {
  return serial(async () => {
    const batch = await currentBatch();
    if (!batch) return [];
    const items = batch.items.filter((i) => i.path !== path);
    const { changeCount } = await native({ type: "set", paths: items.map((i) => i.path), expect: batch.changeCount });
    await chrome.storage.session.set({ batch: { changeCount, items } });
    return items;
  });
}

// Likes the element and saves it to the collection. Returns what worked.
async function keep(elementId, prefs) {
  const done = [];
  const failed = [];
  if (prefs.likeOnCopy) {
    await cosmos.like(elementId).then(() => done.push("liked"), (err) => failed.push(`like: ${err.message}`));
  }
  if (prefs.saveOnCopy) {
    try {
      const collection = await target();
      await cosmos.save(elementId, collection.id);
      done.push(`saved to ${collection.name}`);
    } catch (err) {
      failed.push(`save: ${err.message}`);
    }
  }
  return { done, failed };
}

// `found` is the target the content script already found (plain "c" on cosmos.so).
async function copyReference(tab, found, add = false) {
  const slot = reserveClipboard();
  try {
    tab = await withLimit(activeTab(tab), "The tab lookup");
    if (!tab?.id) return;
    found ??= await withLimit(askTab(tab.id, { type: "cosmos-copy:target" }), "The page");
    if (found.error) throw new Error(found.error);
    toast(tab.id, "Copying…");

    const elementId = found.elementId;
    const media = elementId ? await withLimit(cosmos.media(elementId), "Cosmos") : found.media;
    const meta = elementId ? { pageUrl: `https://www.cosmos.so/e/${elementId}` } : { pageUrl: tab.url };
    const prefs = await settings();
    // Copy and keep at the same time: the clipboard does not wait for Cosmos.
    const [copied, kept] = await Promise.all([
      copyToClipboard(slot, media, elementId ? `cosmos-${elementId}` : undefined, meta, add).finally(slot.release),
      elementId ? keep(elementId, prefs) : { done: [], failed: [] },
    ]);

    const size = (copied.bytes / 1024 / 1024).toFixed(1);
    const batch = copied.count > 1 ? ` - ${copied.count} on the clipboard` : "";
    const extra = kept.done.length ? `, ${kept.done.join(" and ")}` : "";
    toast(tab.id, `Copied ${media.kind} (${size} MB)${batch}${extra}.`);
    if (kept.failed.length) {
      console.warn("Cosmos Copy:", kept.failed);
      setTimeout(() => toast(tab.id, `Copied, but Cosmos failed (${kept.failed.join("; ")})`, true), 2600);
    }
  } catch (err) {
    const msg = String(err?.message ?? err);
    const hint = msg.includes("native messaging host") ? " Run install.sh in cosmos-copy." : "";
    if (tab?.id) toast(tab.id, `Cosmos Copy: ${msg}${hint}`, true);
    console.error("Cosmos Copy", err);
  } finally {
    slot.release(); // Also when a lookup failed before the copy.
  }
}

// Requests from the popup.
// A JSON POST to the agent server. Null when the server gives no usable answer.
async function post(path, body) {
  const res = await fetch(`${SERVER}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  return res?.ok ? res.json().catch(() => null) : null;
}

const popupHandlers = {
  async "popup:batch"() {
    return { items: (await currentBatch())?.items ?? [] };
  },
  async "popup:remove"({ path }) {
    return { items: await removeFromClipboard(path) };
  },
  async "popup:collections"() {
    const [collections, current] = await Promise.all([cosmos.collections(), target()]);
    return { collections, current };
  },
  // The agent setup: the vault URL with this device's key, and whether the link works.
  async "popup:agents"() {
    const { key } = await device();
    let { link } = await chrome.storage.local.get("link");
    if (!link?.ok) link = (await relay("popup"), (await chrome.storage.local.get("link")).link);
    const { username } = await cosmos.me();
    // Is a Google account connected? Null when the server cannot tell (no link, or an old server).
    const state = link?.ok ? await post("/connect/state", { deviceKey: key }) : null;
    return { url: `${SERVER}/mcp`, keyUrl: `${SERVER}/mcp/${username}?key=${key}`, link, connected: state?.connected ?? null };
  },
  // Starts the link of this browser's Cosmos account to a Google sign-in, in a new tab.
  async "popup:connect"() {
    const { key } = await device();
    const started = await post("/connect/start", { deviceKey: key });
    if (!started?.url?.startsWith(`${SERVER}/connect#`)) throw new Error("The agent server did not answer. Try again.");
    await chrome.tabs.create({ url: started.url });
    return {};
  },
  async "popup:unlink"() {
    await unlink();
    return {};
  },
  async "popup:reconnect"() {
    await reconnect();
    return {};
  },
  async "popup:set-collection"({ collection, name }) {
    const picked = collection ?? (await cosmos.collection(name));
    await saveSettings({ target: picked, collection: picked.name });
    return { current: picked };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // "c" or Shift+"c" on cosmos.so: the content script found a Cosmos element under the cursor.
  if (msg?.type === "cosmos-copy:copy" && sender.tab?.id && /^\d+$/.test(String(msg.target?.elementId ?? ""))) {
    copyReference(sender.tab, { elementId: String(msg.target.elementId) }, msg.add === true);
    return false;
  }
  const handler = popupHandlers[msg?.type];
  if (!handler) return false;
  handler(msg).then(
    (result) => reply({ ok: true, ...result }),
    (err) => reply({ ok: false, error: String(err?.message ?? err) }),
  );
  return true;
});

// Lets a DevTools session run the shortcut's action on a given tab, for end-to-end tests.
globalThis.copyReference = copyReference;
