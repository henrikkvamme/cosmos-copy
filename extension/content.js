// Finds what to copy: the element under the cursor, else the open element page.
// It also shows a short toast with the result.
(() => {
  if (window.__cosmosCopy) return;
  window.__cosmosCopy = true;

  let mouse = null;
  document.addEventListener("mousemove", (e) => (mouse = { x: e.clientX, y: e.clientY }), {
    passive: true,
    capture: true,
  });
  document.documentElement.addEventListener("mouseleave", () => (mouse = null));

  const elementId = (href) => {
    try {
      const url = new URL(href, location.href);
      if (!url.hostname.endsWith("cosmos.so")) return null;
      return url.pathname.match(/^\/e\/(\d+)/)?.[1] ?? null;
    } catch {
      return null;
    }
  };

  const mediaSource = (el) => {
    if (el.tagName === "IMG") return { kind: "image", url: el.currentSrc || el.src };
    const src = [el.currentSrc, el.src, ...[...el.querySelectorAll("source")].map((s) => s.src)].find(
      (s) => s && /^https?:/.test(s),
    );
    return src ? { kind: "video", url: src } : null;
  };

  const visibleArea = (el) => {
    const r = el.getBoundingClientRect();
    const w = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
    const h = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
    return w > 0 && h > 0 ? w * h : 0;
  };

  // Right after injection there is no mouse position yet, so use the :hover chain.
  const elementsUnderCursor = () =>
    mouse ? document.elementsFromPoint(mouse.x, mouse.y) : [...document.querySelectorAll(":hover")].reverse();

  // A Cosmos card under the cursor, else the element page that is open.
  function cosmosTarget(underCursor) {
    for (const el of underCursor) {
      const link = el.closest?.('a[href*="/e/"]');
      const id = link && elementId(link.getAttribute("href"));
      if (id) return { elementId: id };
    }
    const pageId = location.hostname.endsWith("cosmos.so") && elementId(location.href);
    return pageId ? { elementId: pageId } : null;
  }

  function findTarget() {
    const underCursor = elementsUnderCursor();
    // 1 and 2. A Cosmos card under the cursor, or the open element page.
    const onCosmos = cosmosTarget(underCursor);
    if (onCosmos) return onCosmos;

    // 3. Any other site: the image or video under the cursor, else the largest visible one.
    const hovered = underCursor.find((el) => el.tagName === "IMG" || el.tagName === "VIDEO");
    const candidates = hovered
      ? [hovered]
      : [...document.querySelectorAll("img, video")]
          .filter((el) => visibleArea(el) > 100 * 100)
          .sort((a, b) => visibleArea(b) - visibleArea(a));
    for (const el of candidates) {
      const media = mediaSource(el);
      if (media) return { media };
    }
    return { error: "No image or video found. Hover one and try again." };
  }

  let toastTimer;
  function toast(text, isError) {
    let el = document.getElementById("cosmos-copy-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "cosmos-copy-toast";
      Object.assign(el.style, {
        position: "fixed",
        left: "50%",
        bottom: "32px",
        transform: "translateX(-50%)",
        zIndex: 2147483647,
        padding: "10px 16px",
        borderRadius: "10px",
        font: "500 13px/1.3 -apple-system, BlinkMacSystemFont, sans-serif",
        color: "#fff",
        boxShadow: "0 6px 24px rgba(0,0,0,.3)",
        pointerEvents: "none",
        maxWidth: "80vw",
      });
      document.documentElement.appendChild(el);
    }
    el.textContent = text;
    el.style.background = isError ? "#b42318" : "#111";
    el.style.opacity = "1";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), isError ? 5000 : 2500);
  }

  // On cosmos.so, plain "c" copies too. The Cosmos web app binds "c" on a hovered tile to its own
  // "copy image". This listener runs first (window, capture phase, registered at document_start)
  // and stops the event, so only one copy happens.
  const isTextField = (el) =>
    !!el &&
    (el.isContentEditable ||
      el.tagName === "TEXTAREA" ||
      el.tagName === "SELECT" ||
      (el.tagName === "INPUT" && !/^(button|checkbox|color|file|image|radio|range|reset|submit)$/i.test(el.type)));
  if (location.hostname === "www.cosmos.so") {
    let swallowed = false;
    window.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "c" || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || e.isComposing) return;
        const focused = e.composedPath?.()[0] ?? e.target;
        if (isTextField(focused) || isTextField(document.activeElement)) return;
        const target = cosmosTarget(elementsUnderCursor());
        if (!target) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        swallowed = true;
        if (e.repeat) return;
        chrome.runtime.sendMessage({ type: "cosmos-copy:copy", target }).catch(() => {
          toast("Cosmos Copy was updated. Reload the page to copy.", true);
        });
      },
      { capture: true },
    );
    // The same key's keypress and keyup must not reach a Cosmos handler either.
    for (const type of ["keypress", "keyup"]) {
      window.addEventListener(
        type,
        (e) => {
          if (!swallowed || e.key !== "c") return;
          e.preventDefault();
          e.stopImmediatePropagation();
          if (type === "keyup") swallowed = false;
        },
        { capture: true },
      );
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.type === "cosmos-copy:target") reply(findTarget());
    if (msg.type === "cosmos-copy:toast") toast(msg.text, msg.isError);
  });
})();
