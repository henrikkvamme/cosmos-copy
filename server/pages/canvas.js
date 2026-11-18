// The variants canvas: each variant beside the references it takes from. Pan, pinch zoom, Fit.
// Screenshots arrive while the page is open: it polls until all are in.
"use strict";

const id = location.pathname.split("/")[2] ?? "";
const base = `/v/${encodeURIComponent(id)}`;
const stage = document.getElementById("stage");
const world = document.getElementById("world");
const pct = document.getElementById("pct");
const tools = document.getElementById("tools");
const VIEW_KEY = `cosmos-canvas:${id.slice(0, 12)}`;
const REF_HEIGHT = 420;
const REF_MAX_WIDTH = 640;
const PLACEHOLDER = { w: 960, h: 600 };

let board = null;
let touched = false;

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
    else if (value !== undefined && value !== null) node.setAttribute(key, value);
  }
  node.append(...children.filter((child) => child !== null && child !== undefined));
  return node;
}

/** The size a reference shows at: 420 px high, at most 640 px wide. */
function refSize(ref) {
  const ratio = ref.w && ref.h ? ref.w / ref.h : 4 / 3;
  let h = REF_HEIGHT;
  let w = h * ratio;
  if (w > REF_MAX_WIDTH) {
    w = REF_MAX_WIDTH;
    h = w / ratio;
  }
  return { w: Math.round(w), h: Math.round(h) };
}

/** The size a screenshot shows at: wide shots up to 1200 px, phone shots 760 px high, full pages 720 px wide. */
function shotSize(image) {
  if (!image) return PLACEHOLDER;
  const ratio = image.h / image.w;
  let w;
  if (ratio <= 1) w = Math.min(image.w, 1200);
  else if (ratio <= 2.4) w = Math.min(image.h, 760) / ratio;
  else w = Math.min(image.w, 720);
  return { w: Math.round(w), h: Math.round(w * ratio) };
}

function sized(node, size) {
  node.style.width = `${size.w}px`;
  node.style.height = `${size.h}px`;
  return node;
}

function shotNode(index, variant) {
  const size = shotSize(variant.image);
  if (!variant.image) return sized(el("div", { class: "placeholder" }), size);
  const img = el("img", { alt: "", draggable: "false", src: `${base}/img/${index + 1}?v=${variant.image.version}` });
  return sized(img, size);
}

function render() {
  const rows = board.variants.map((variant, index) => {
    const refs = variant.takes.map((ref) => {
      const img = el("img", { alt: "", draggable: "false", src: cdn(ref.thumb, 1200) });
      img.addEventListener("error", () => img.closest(".cell")?.remove());
      return el("div", { class: "cell" }, el("div", { class: "cap" }, ref.what ?? ""), sized(img, refSize(ref)));
    });
    return el(
      "div",
      { class: "row" },
      el("div", { class: "rowname" }, variant.name),
      refs.length ? el("div", { class: "refs" }, ...refs) : null,
      el("div", { class: "cell", "data-variant": String(index) }, el("div", { class: "cap" }), shotNode(index, variant)),
    );
  });
  world.replaceChildren(el("div", { class: "title" }, board.task), ...rows);
  tools.hidden = false;
}

/** Puts new or replaced screenshots in place, without touching the rest. */
function update(next) {
  next.variants.forEach((variant, index) => {
    const before = board.variants[index]?.image?.version;
    if (variant.image?.version === before) return;
    const cell = world.querySelector(`[data-variant="${index}"]`);
    cell?.lastElementChild?.replaceWith(shotNode(index, variant));
  });
  board = next;
}

// ---- Pan and zoom ----

let z = 1;
let x = 0;
let y = 0;

function apply(save = true) {
  world.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
  pct.textContent = `${Math.round(z * 100)}%`;
  if (!save) return;
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify({ z, x, y }));
  } catch {}
}

function fit(save = true) {
  const w = world.offsetWidth;
  const h = world.offsetHeight - 72;
  z = Math.min(1, Math.min((innerWidth - 80) / w, (innerHeight - 140) / h));
  x = (innerWidth - w * z) / 2;
  y = Math.max(24, (innerHeight - 60 - h * z) / 2);
  apply(save);
}

function zoomAt(cx, cy, factor) {
  const nz = Math.min(4, Math.max(0.05, z * factor));
  x = cx - (cx - x) * (nz / z);
  y = cy - (cy - y) * (nz / z);
  z = nz;
  touched = true;
  apply();
}

stage.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    touched = true;
    // A trackpad pinch arrives as a wheel event with ctrlKey.
    if (event.ctrlKey || event.metaKey) zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * 0.01));
    else {
      x -= event.deltaX;
      y -= event.deltaY;
      apply();
    }
  },
  { passive: false },
);

// Drag with one pointer, pinch with two (touch screens).
const pointers = new Map();
let drag = null;
let pinch = null;

stage.addEventListener("pointerdown", (event) => {
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  stage.setPointerCapture(event.pointerId);
  touched = true;
  if (pointers.size === 1) {
    drag = { px: event.clientX, py: event.clientY, x, y };
    stage.classList.add("drag");
  } else if (pointers.size === 2) {
    drag = null;
    const [a, b] = [...pointers.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  }
});

stage.addEventListener("pointermove", (event) => {
  if (!pointers.has(event.pointerId)) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    x += cx - pinch.cx;
    y += cy - pinch.cy;
    if (pinch.d > 0) zoomAt(cx, cy, d / pinch.d);
    else apply();
    pinch = { d, cx, cy };
  } else if (drag) {
    x = drag.x + event.clientX - drag.px;
    y = drag.y + event.clientY - drag.py;
    apply();
  }
});

function endPointer(event) {
  pointers.delete(event.pointerId);
  if (pointers.size < 2) pinch = null;
  if (pointers.size === 1) {
    const [rest] = [...pointers.values()];
    drag = { px: rest.x, py: rest.y, x, y };
  }
  if (pointers.size === 0) {
    drag = null;
    stage.classList.remove("drag");
  }
}
stage.addEventListener("pointerup", endPointer);
stage.addEventListener("pointercancel", endPointer);

document.getElementById("in").onclick = () => zoomAt(innerWidth / 2, innerHeight / 2, 1.25);
document.getElementById("out").onclick = () => zoomAt(innerWidth / 2, innerHeight / 2, 0.8);
document.getElementById("fit").onclick = () => fit();
addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === "0" || event.key === "f") fit();
  else if (event.key === "1") zoomAt(innerWidth / 2, innerHeight / 2, 1 / z);
  else if (event.key === "+" || event.key === "=") zoomAt(innerWidth / 2, innerHeight / 2, 1.25);
  else if (event.key === "-") zoomAt(innerWidth / 2, innerHeight / 2, 0.8);
});

// ---- Start ----

function message(title, text) {
  world.replaceChildren(el("div", { class: "message" }, el("h1", {}, title), el("p", {}, text)));
  world.style.transform = "none";
  world.style.position = "static";
}

async function fetchBoard() {
  const response = await fetch(`${base}/state`, { cache: "no-store" });
  if (!response.ok) throw Object.assign(new Error(String(response.status)), { status: response.status });
  return response.json();
}

async function poll() {
  const missing = board.variants.some((variant) => !variant.image);
  setTimeout(async () => {
    if (document.visibilityState === "visible") {
      try {
        const next = await fetchBoard();
        const arrived = next.variants.some((variant, index) => variant.image?.version !== board.variants[index]?.image?.version);
        update(next);
        if (arrived && !touched) requestAnimationFrame(() => fit(false));
      } catch {}
    }
    poll();
  }, missing ? 3000 : 15000);
}

async function start() {
  try {
    board = await fetchBoard();
  } catch (error) {
    if (error.status === 404) return message("This link has expired", "Ask the agent to show the variants again.");
    return message("Could not load the variants", "The server did not answer. Reload to try again.");
  }
  document.title = `${board.task} - Variants`;
  render();
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(VIEW_KEY));
  } catch {}
  if (saved && typeof saved.z === "number") {
    ({ z, x, y } = saved);
    touched = true;
    apply(false);
  } else {
    fit(false);
  }
  poll();
}

start();
