// The vault page: the references saved from other sites, newest first.
(() => {
  const grid = document.getElementById("grid");
  const message = document.getElementById("message");
  const total = document.getElementById("total");
  const more = document.getElementById("more");
  const zoom = document.getElementById("zoom");
  const TRASH = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M6.8 7v3.8M9.2 7v3.8"/></svg>';
  let count = 0;
  let next = null;
  let loading = false;

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === "class") node.className = value;
      else if (value !== false && value !== undefined) node.setAttribute(key, value === true ? "" : value);
    }
    node.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
    return node;
  }

  function say(title, text, action) {
    message.replaceChildren(el("h1", {}, title), el("p", {}, text), action ?? "");
    message.hidden = false;
  }

  function showTotal() {
    total.textContent = count === 0 ? "" : `${count} ${count === 1 ? "reference" : "references"}`;
  }

  const day = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

  function open(item) {
    const media =
      item.kind === "video"
        ? el("video", { src: item.file, poster: item.thumb, controls: true, autoplay: true, loop: true, playsinline: true })
        : el("img", { src: item.thumb, alt: item.description || item.pageTitle || "" });
    media.addEventListener("click", (event) => event.stopPropagation());
    zoom.replaceChildren(media);
    zoom.classList.add("in");
  }
  function close() {
    zoom.classList.remove("in");
    zoom.replaceChildren();
  }
  zoom.addEventListener("click", close);
  addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });

  function tile(item) {
    const image = el("img", { src: `${item.thumb}?w=640`, alt: item.description || item.pageTitle || "", loading: "lazy" });
    image.addEventListener("load", () => image.classList.add("loaded"));
    const view = el("button", { class: "view", type: "button", "aria-label": item.kind === "video" ? "Play the video" : "Show the image" }, image, item.kind === "video" && el("span", { class: "play" }));
    view.addEventListener("click", () => open(item));
    const remove = el("button", { class: "remove", type: "button", title: "Delete", "aria-label": "Delete" });
    remove.innerHTML = TRASH;
    const source = item.pageUrl
      ? el("a", { href: item.pageUrl, target: "_blank", rel: "noreferrer noopener", title: item.pageTitle || item.pageUrl }, item.site || "Source")
      : el("span", {}, item.site || "");
    const node = el("figure", { class: "ref", id: item.id }, view, el("figcaption", {}, source, el("time", { datetime: item.savedAt }, day.format(new Date(item.savedAt))), remove));
    // A very tall or very wide picture is cut, so that no tile is a sliver.
    if (item.width && item.height) node.style.setProperty("--ratio", String(Math.min(Math.max(item.width / item.height, 0.62), 2.2)));
    remove.addEventListener("click", async () => {
      if (remove.disabled || !confirm("Delete this reference permanently?")) return;
      remove.disabled = true;
      const res = await fetch("/account/api/vault/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: item.id }) }).catch(() => null);
      if (res && (res.ok || res.status === 404)) {
        node.remove();
        count = Math.max(count - 1, 0);
        showTotal();
        if (!grid.children.length && !next) empty();
      } else {
        remove.disabled = false;
        node.classList.add("failed");
        remove.title = "Could not delete reference";
      }
    });
    return node;
  }

  function empty() {
    say("No references yet", "Hover an image or video on any site and press ⌥⇧C. TasteRef copies it and saves it here.");
  }

  function skeletons(n) {
    return Array.from({ length: n }, () => el("div", { class: "ref skeleton" }));
  }

  async function load() {
    if (loading) return;
    loading = true;
    const first = grid.children.length === 0;
    const waiting = skeletons(first ? 12 : 4);
    grid.append(...waiting);
    more.replaceChildren();
    message.hidden = true;
    let res = null;
    let data = null;
    try {
      res = await fetch(`/account/api/vault${next ? `?after=${encodeURIComponent(next)}` : ""}`, { cache: "no-store" });
      data = await res.json();
    } catch {
      // Shown below.
    }
    for (const node of waiting) node.remove();
    loading = false;
    if (res?.status === 401) return location.replace("/login");
    if (!res?.ok || !data) {
      const retry = el("button", { class: "btn", type: "button" }, "Retry");
      retry.addEventListener("click", load);
      if (first) say("Could not load references", "Reload the page to try again.", retry);
      else more.replaceChildren(retry);
      return;
    }
    if (!data.linked) return say("No browser connected", 'Open the TasteRef extension and click "Connect account".');
    count = data.total;
    next = data.next;
    showTotal();
    grid.append(...data.items.map(tile));
    if (first && !data.items.length) return empty();
    if (next) {
      const button = el("button", { class: "btn", type: "button" }, "Load more");
      button.addEventListener("click", load);
      more.replaceChildren(button);
    }
    if (first && location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: "center" });
  }

  load();
})();
