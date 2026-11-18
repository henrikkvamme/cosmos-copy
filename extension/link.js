// Links Henrik's Cosmos login to the remote MCP server, so agents can read his whole vault and
// save to it. The extension relays the csms_accessToken cookie; the server checks it with Cosmos.
// Each browser is a device with its own key; the key goes into the agent setup URL.
import { SERVER } from "./defaults.js";

const COOKIE = { url: "https://www.cosmos.so", name: "csms_accessToken" };
const REFRESH_MINUTES = 6 * 60;
const RETRY_MINUTES = [1, 5, 30];

function randomKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function device() {
  const { device: stored } = await chrome.storage.local.get("device");
  if (stored?.key) return stored;
  const platform = navigator.userAgentData?.platform || "Mac";
  const created = { key: randomKey(), name: `Brave on ${platform} (${new Date().toISOString().slice(0, 10)})` };
  await chrome.storage.local.set({ device: created });
  return created;
}

// The JWT's expiry, read without checking the signature (the server checks it with Cosmos).
function tokenExpiry(token) {
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload.exp * 1000;
  } catch {
    return 0;
  }
}

async function setState(state) {
  await chrome.storage.local.set({ link: { ...state, at: Date.now() } });
}

let running = null;
export function relay(reason) {
  // One relay at a time; a cookie change during a relay waits for the next trigger.
  running ??= (async () => {
    try {
      // After "Disconnect", nothing links again until Henrik connects again on purpose.
      const { linkDisabled, unlinkPending } = await chrome.storage.local.get(["linkDisabled", "unlinkPending"]);
      if (linkDisabled) {
        await setState({ ok: false, reason: unlinkPending ? "unlink-pending" : "disconnected" });
        return;
      }
      const cookie = await chrome.cookies.get(COOKIE);
      const exp = cookie ? tokenExpiry(cookie.value) : 0;
      if (!cookie || exp <= Date.now()) {
        await setState({ ok: false, reason: "signed-out" });
        return;
      }
      const { key, name } = await device();
      const res = await fetch(`${SERVER}/link`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: cookie.value, deviceKey: key, deviceName: name }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 401 || res.status === 400) {
        // Cosmos refused the token, or it expired: only a fresh sign-in or visit can fix it.
        await setState({ ok: false, reason: "signed-out" });
        return;
      }
      if (res.status === 403 || res.status === 409) {
        // Not allowed on this server, or too many devices: retrying does not help.
        await setState({ ok: false, reason: "refused", error: body.error ?? `HTTP ${res.status}` });
        return;
      }
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      await setState({ ok: true, username: body.username, tokenExp: exp });
      await chrome.alarms.clear("link-retry");
      await chrome.storage.local.remove("linkRetry");
    } catch (err) {
      // A network or server error: retry with backoff, then fall back to the 6-hour refresh.
      const { linkRetry = 0 } = await chrome.storage.local.get("linkRetry");
      if (linkRetry < RETRY_MINUTES.length) {
        chrome.alarms.create("link-retry", { delayInMinutes: RETRY_MINUTES[linkRetry] });
        await chrome.storage.local.set({ linkRetry: linkRetry + 1 });
      }
      await setState({ ok: false, reason: "error", error: String(err?.message ?? err) });
      console.warn("Cosmos Copy link failed", reason, err);
    } finally {
      running = null;
    }
  })();
  return running;
}

// Removes this device from the server. Agents set up with its key lose access.
// Order matters: block new relays first, let a running relay finish, then revoke the key.
// Otherwise a relay that lands after the unlink would make the old key valid again.
// Until the server confirms, "unlinkPending" stays set: no relay, and reconnecting first
// finishes the revocation, so the old key can never come back.
export async function unlink() {
  await chrome.storage.local.set({ linkDisabled: true, unlinkPending: true });
  await chrome.alarms.clear("link-retry");
  await running?.catch(() => {});
  const { key } = await device();
  const res = await fetch(`${SERVER}/unlink`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceKey: key }),
  }).catch(() => null);
  if (!res?.ok) {
    await setState({ ok: false, reason: "unlink-pending" });
    throw new Error(`The server did not confirm (${res ? `HTTP ${res.status}` : "no connection"}). Try again.`);
  }
  // Use a new key on reconnection, so old setup URLs stay dead.
  await chrome.storage.local.remove(["device", "link", "linkRetry", "unlinkPending"]);
  await setState({ ok: false, reason: "disconnected" });
}

export async function reconnect() {
  const { unlinkPending } = await chrome.storage.local.get("unlinkPending");
  if (unlinkPending) await unlink();
  await chrome.storage.local.remove("linkDisabled");
  return relay("reconnect");
}

export function startLinking() {
  chrome.runtime.onInstalled.addListener(() => relay("installed"));
  chrome.runtime.onStartup.addListener(() => relay("startup"));
  chrome.alarms.get("link-refresh").then((alarm) => {
    if (!alarm) chrome.alarms.create("link-refresh", { periodInMinutes: REFRESH_MINUTES });
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "link-refresh" || alarm.name === "link-retry") relay(alarm.name);
  });
  // Cosmos renews the cookie when Henrik visits the site; send the new token at once.
  chrome.cookies.onChanged.addListener(({ cookie, removed }) => {
    if (!removed && cookie.name === COOKIE.name && cookie.domain.endsWith("cosmos.so")) relay("cookie");
  });
}
