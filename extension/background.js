import { cosmos } from "./cosmos.js";
import { DEFAULT_SETTINGS } from "./defaults.js";

const HOST = "com.henrikkvamme.cosmos_copy";

async function settings() {
  const { settings: stored } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...stored };
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "copy-reference") copyReference(tab);
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

// Copies build up a batch on the clipboard. The batch ends when Brave loses focus (you went
// to paste), or when something else changes the clipboard (the helper checks the change count).
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) chrome.storage.session.remove("batch");
});

// One copy at a time, so two fast presses both land in the batch.
let clipboardQueue = Promise.resolve();
function copyToClipboard(media, name) {
  const run = clipboardQueue.then(async () => {
    const { batch } = await chrome.storage.session.get("batch");
    const result = await chrome.runtime.sendNativeMessage(HOST, { ...media, name, appendTo: batch?.changeCount });
    if (!result?.ok) throw new Error(result?.error ?? "The native helper gave no answer");
    await chrome.storage.session.set({ batch: { changeCount: result.changeCount } });
    return result;
  });
  clipboardQueue = run.catch(() => {});
  return run;
}

// Likes the element and saves it to the collection. Returns what worked.
async function keep(elementId, prefs) {
  const done = [];
  const failed = [];
  if (prefs.likeOnCopy) {
    await cosmos.like(elementId).then(() => done.push("liked"), (err) => failed.push(`like: ${err.message}`));
  }
  if (prefs.saveOnCopy && prefs.collection) {
    try {
      const collection = await cosmos.collection(prefs.collection);
      await chrome.storage.local.set({ collection });
      await cosmos.save(elementId, collection.id);
      done.push(`saved to ${prefs.collection}`);
    } catch (err) {
      failed.push(`save: ${err.message}`);
    }
  }
  return { done, failed };
}

async function copyReference(tab) {
  tab = await activeTab(tab);
  if (!tab?.id) return;
  try {
    const target = await askTab(tab.id, { type: "cosmos-copy:target" });
    if (target.error) throw new Error(target.error);
    toast(tab.id, "Copying…");

    const elementId = target.elementId;
    const media = elementId ? await cosmos.media(elementId) : target.media;
    const prefs = await settings();
    // Copy and keep at the same time: the clipboard does not wait for Cosmos.
    const [copied, kept] = await Promise.all([
      copyToClipboard(media, elementId ? `cosmos-${elementId}` : undefined),
      elementId ? keep(elementId, prefs) : { done: [], failed: [] },
    ]);

    const size = (copied.bytes / 1024 / 1024).toFixed(1);
    const extra = kept.done.length ? `, ${kept.done.join(" and ")}` : "";
    const batch = copied.count > 1 ? ` - ${copied.count} on the clipboard` : "";
    toast(tab.id, `Copied ${media.kind} (${size} MB)${batch}${extra}.`);
    if (kept.failed.length) {
      console.warn("Cosmos Copy:", kept.failed);
      setTimeout(() => toast(tab.id, `Copied, but Cosmos failed (${kept.failed.join("; ")})`, true), 2600);
    }
  } catch (err) {
    const msg = String(err?.message ?? err);
    const hint = msg.includes("native messaging host") ? " Run install.sh in cosmos-copy." : "";
    toast(tab.id, `Cosmos Copy: ${msg}${hint}`, true);
    console.error("Cosmos Copy", err);
  }
}

// The popup asks for the collection link it shows in the agent setup.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type !== "popup:collection") return false;
  (async () => {
    const prefs = await settings();
    const collection = await cosmos.collection(prefs.collection);
    await chrome.storage.local.set({ collection });
    return { ok: true, collection };
  })().then(reply, (err) => reply({ ok: false, error: String(err?.message ?? err) }));
  return true;
});

// Lets a DevTools session run the shortcut's action on a given tab, for end-to-end tests.
globalThis.copyReference = copyReference;
