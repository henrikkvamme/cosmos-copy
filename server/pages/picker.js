// The picker: click the references the result should look like, hold Space for full size,
// "More like these", Done. The state lives on the server, so it survives a reload.
"use strict";

const id = location.pathname.split("/")[2] ?? "";
const base = `/p/${encodeURIComponent(id)}`;
const view = document.getElementById("view");
const zoom = document.getElementById("zoom");

let state = null;
let picked = [];
let hidden = [];

const cdn = (url, w) => {
  const u = new URL(url);
  u.search = "";
  u.searchParams.set("format", "webp");
  u.searchParams.set("w", String(w));
  return u.toString();
};

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value === true ? "" : value);
  }
  node.append(...children.filter((child) => child !== null && child !== undefined));
  return node;
}

const CHECK = () => {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 12 12");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M2.5 6.2 5 8.6l4.5-5");
  svg.append(path);
  return el("span", { class: "check" }, svg);
};

async function api(path, method = "GET", body) {
  const response = await fetch(base + path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

// ---- Views ----

function renderMessage(title, text, retry) {
  view.replaceChildren(
    el("div", { class: "message" }, el("h1", {}, title), el("p", {}, text), retry ? el("button", { class: "btn", onclick: retry }, "Retry") : null),
  );
}

function renderLoading() {
  const grid = el("div", { class: "grid" });
  for (let i = 0; i < 12; i++) grid.append(el("div", { class: "tile skeleton" }));
  view.replaceChildren(el("h1", {}, " "), el("p", { class: "sub" }, " "), grid);
}

function tileNode(tile) {
  const img = el("img", { alt: "", loading: "lazy", decoding: "async", src: cdn(tile.thumb, 560) });
  img.addEventListener("load", () => img.classList.add("loaded"));
  img.addEventListener("error", () => hideTile(tile.id));
  return el(
    "div",
    { class: `tile${picked.includes(tile.id) ? " picked" : ""}`, dataset: { id: tile.id } },
    img,
    tile.kind === "video" ? el("span", { class: "play" }) : null,
    CHECK(),
  );
}

function roundNode() {
  return el("div", { class: "round" }, "More like your picks");
}

function renderOpen() {
  const grid = el("div", { class: "grid", id: "grid" });
  let round = 0;
  for (const tile of state.tiles) {
    if (hidden.includes(tile.id)) continue;
    if (tile.round > round) {
      round = tile.round;
      grid.append(roundNode());
    }
    grid.append(tileNode(tile));
  }
  const bar = el(
    "div",
    { class: "bar" },
    el("span", { class: "count", id: "count" }),
    el("button", { class: "btn", id: "more", onclick: more }, "More like these"),
    el("button", { class: "btn primary", id: "done", onclick: done }, "Done"),
  );
  view.replaceChildren(
    el("h1", {}, state.task),
    el("p", { class: "sub" }, "Pick the ones you want the result to look like."),
    grid,
    bar,
  );
  paint();
}

function renderDone() {
  const byId = new Map(state.tiles.map((tile) => [tile.id, tile]));
  const thumbs = el("div", { class: "thumbs" });
  for (const pickId of state.picked) {
    const tile = byId.get(pickId);
    if (!tile) continue;
    const img = el("img", { alt: "", src: cdn(tile.thumb, 400) });
    img.addEventListener("error", () => img.remove());
    thumbs.append(img);
  }
  view.replaceChildren(
    el(
      "div",
      { class: "done" },
      el("h1", {}, state.task),
      el("p", { class: "sub" }, state.picked.length ? "Saved for the agent." : "Saved for the agent: none of these fit."),
      thumbs,
    ),
  );
  zoom.classList.remove("in");
}

function render() {
  if (state.status === "done") renderDone();
  else renderOpen();
}

let saveError = false;
let busyMore = false;

function paint() {
  const count = document.getElementById("count");
  if (!count) return;
  count.textContent = saveError ? "Not saved. Retrying…" : `${picked.length} picked`;
  count.classList.toggle("error", saveError);
  const moreButton = document.getElementById("more");
  moreButton.disabled = busyMore || picked.length === 0 || state.rounds >= state.maxRounds;
  moreButton.setAttribute("aria-busy", busyMore ? "true" : "false");
}

// ---- Saving ----

let saving = null;
let again = false;
let retryTimer = null;

function sync() {
  if (saving) {
    again = true;
    return saving;
  }
  saving = (async () => {
    do {
      again = false;
      try {
        const { status, data } = await api("/state", "PUT", { picked, hidden });
        if (status === 409 && data.status === "done") {
          state = data;
          render();
          return;
        }
        if (status !== 200) throw new Error(String(status));
        saveError = false;
      } catch {
        saveError = true;
        clearTimeout(retryTimer);
        retryTimer = setTimeout(sync, 3000);
        break;
      }
    } while (again);
    paint();
  })().finally(() => {
    saving = null;
  });
  return saving;
}

function hideTile(tileId) {
  if (hidden.includes(tileId)) return;
  hidden.push(tileId);
  picked = picked.filter((p) => p !== tileId);
  document.querySelector(`.tile[data-id="${CSS.escape(tileId)}"]`)?.remove();
  // A round rule without tiles after it goes too.
  for (const rule of document.querySelectorAll(".round")) {
    const next = rule.nextElementSibling;
    if (!next || next.classList.contains("round")) rule.remove();
  }
  paint();
  sync();
}

// ---- Actions ----

view.addEventListener("click", (event) => {
  const tile = event.target.closest(".tile");
  if (!tile || tile.classList.contains("skeleton") || state?.status !== "open") return;
  const tileId = tile.dataset.id;
  picked = picked.includes(tileId) ? picked.filter((p) => p !== tileId) : [...picked, tileId];
  tile.classList.toggle("picked", picked.includes(tileId));
  paint();
  sync();
});

async function more() {
  if (busyMore) return;
  busyMore = true;
  paint();
  try {
    await saving;
    const { status, data } = await api("/more", "POST", { picked, hidden });
    if (status === 409 && data.status === "done") {
      state = data;
      return render();
    }
    if (status !== 200) throw new Error(String(status));
    state = data;
    const grid = document.getElementById("grid");
    const added = new Set(data.added ?? []);
    if (added.size > 0) {
      const rule = roundNode();
      grid.append(rule);
      for (const tile of state.tiles) if (added.has(tile.id)) grid.append(tileNode(tile));
      const top = rule.getBoundingClientRect().top;
      if (top > innerHeight - 160) rule.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      state.rounds = state.maxRounds;
    }
  } catch {
    saveError = true;
    setTimeout(() => {
      saveError = false;
      paint();
    }, 3000);
  } finally {
    busyMore = false;
    paint();
  }
}

async function done() {
  const button = document.getElementById("done");
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    await saving;
    const { status, data } = await api("/done", "POST", { picked, hidden });
    if (status !== 200) throw new Error(String(status));
    state = data;
    picked = data.picked;
    render();
    scrollTo(0, 0);
  } catch {
    button.disabled = false;
    button.setAttribute("aria-busy", "false");
    saveError = true;
    paint();
    setTimeout(() => {
      saveError = false;
      paint();
    }, 3000);
  }
}

// ---- Hold Space for full size ----

let mouse = { x: -1, y: -1 };
document.addEventListener("mousemove", (event) => (mouse = { x: event.clientX, y: event.clientY }), { passive: true });
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") return zoom.classList.remove("in");
  if (event.key !== " " || event.metaKey || event.ctrlKey || event.altKey) return;
  event.preventDefault();
  if (event.repeat || state?.status !== "open") return;
  const tile = document.elementFromPoint(mouse.x, mouse.y)?.closest?.(".tile:not(.skeleton)");
  const item = tile && state.tiles.find((t) => t.id === tile.dataset.id);
  if (!item) return;
  zoom.querySelector("img").src = cdn(item.thumb, 1600);
  zoom.classList.add("in");
});
document.addEventListener("keyup", (event) => {
  if (event.key === " ") zoom.classList.remove("in");
});
zoom.addEventListener("click", () => zoom.classList.remove("in"));
addEventListener("blur", () => zoom.classList.remove("in"));

// ---- Start ----

async function load() {
  renderLoading();
  try {
    const { status, data } = await api("/state");
    if (status === 404) return renderMessage("This link has expired", "Ask the agent for a new picker link.");
    if (status === 429) return renderMessage("Too many tries", "Wait 15 minutes, then reload.");
    if (status !== 200) throw new Error(String(status));
    state = data;
    picked = data.picked;
    hidden = data.hidden;
    document.title = `${data.task} - Pick references`;
    render();
  } catch {
    renderMessage("Could not load the picks", "The server did not answer.", load);
  }
}

load();
