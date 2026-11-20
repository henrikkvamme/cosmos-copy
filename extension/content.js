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
    if (el.tagName === "IMG") return { kind: "image", url: el.currentSrc || el.src, alt: el.alt || undefined };
    const src = [el.currentSrc, el.src, ...[...el.querySelectorAll("source")].map((s) => s.src)].find(
      (s) => s && /^https?:/.test(s),
    );
    return src ? { kind: "video", url: src, alt: el.getAttribute("aria-label") || el.title || undefined } : null;
  };

  const visibleArea = (el) => {
    const r = el.getBoundingClientRect();
    const w = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
    const h = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
    return w > 0 && h > 0 ? w * h : 0;
  };

  // Right after injection there is no mouse position yet, so use the :hover chain. The page also gets
  // no mouse position while the cursor is in a frame: the last one is from before the cursor went in.
  const isFrame = (el) => !!el?.matches("iframe, object, embed");
  const elementsUnderCursor = () => {
    const hovered = [...document.querySelectorAll(":hover")].reverse();
    return mouse && !isFrame(hovered[0]) ? document.elementsFromPoint(mouse.x, mouse.y) : hovered;
  };

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

  const area = (el) => {
    const r = el.getBoundingClientRect();
    return r.width * r.height;
  };
  // False for an element that takes no space or is hidden, also by an ancestor with opacity 0.
  const shown = (el) => area(el) > 0 && (el.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) ?? true);
  const holds = (el, point) => {
    const r = el.getBoundingClientRect();
    return point.x >= r.left && point.x <= r.right && point.y >= r.top && point.y <= r.bottom;
  };
  const commonParent = (a, b) => {
    let el = a;
    while (el && !el.contains(b)) el = el.parentElement;
    return el;
  };
  // The size of the smallest part of the page that holds both elements. The body is the whole page.
  const sharedArea = (a, b) => {
    const parent = commonParent(a, b);
    return !parent || parent === document.body || parent === document.documentElement ? Infinity : area(parent);
  };
  // True when an ancestor cuts the element off at this point. A clip path counts always: its shape is not known here.
  const clipped = (el, point) => {
    for (let parent = el.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.clipPath !== "none") return true;
      if (style.overflowX !== "visible" && !holds(parent, point)) return true;
    }
    return false;
  };
  const isMedia = (el) => el.tagName === "IMG" || el.tagName === "VIDEO";

  // The images and videos at the cursor, the front one first.
  // elementsFromPoint leaves out an element with pointer-events: none. Many sites play the video of a
  // card in such a layer over the poster image, so the hit test alone finds only the poster.
  function mediaAtCursor(underCursor) {
    const top = underCursor[0];
    // A frame or a canvas on top covers the media behind it.
    if (!top || isFrame(top) || top.tagName === "CANVAS") return [];
    const box = top.getBoundingClientRect();
    const point = mouse ?? { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    const hit = underCursor.filter((el) => isMedia(el) && shown(el));
    // Media that the hit test left out counts only when it is in the same small part of the page as
    // the top element. This keeps out a picture that lies behind a dialog.
    const near = [...document.querySelectorAll("img, video")].filter(
      (el) => !underCursor.includes(el) && holds(el, point) && shown(el) && !clipped(el, point) && sharedArea(el, top) <= 3 * area(el),
    );
    if (!near.length) return hit;
    // A second hit test gives the true order, front first: for a moment, the left-out media takes pointer events.
    const before = near.map((el) => [el, el.style.getPropertyValue("pointer-events"), el.style.getPropertyPriority("pointer-events")]);
    for (const el of near) el.style.setProperty("pointer-events", "auto", "important");
    const ordered = document.elementsFromPoint(point.x, point.y).filter((el) => hit.includes(el) || near.includes(el));
    for (const [el, value, priority] of before) {
      if (value) el.style.setProperty("pointer-events", value, priority);
      else el.style.removeProperty("pointer-events");
    }
    return ordered;
  }

  function findTarget() {
    const underCursor = elementsUnderCursor();
    // 1 and 2. A Cosmos card under the cursor, or the open element page.
    const onCosmos = cosmosTarget(underCursor);
    if (onCosmos) return onCosmos;

    // 3. Any other site: the image or video at the cursor.
    const atCursor = mediaAtCursor(underCursor);
    // A frame or a canvas draws its own content: there is no file to copy, and a picture from
    // another part of the page is not what the user points at.
    if (isFrame(underCursor[0]) || underCursor[0]?.tagName === "CANVAS") {
      return { error: "Live content has no image or video to copy. Hover an image or a video and try again." };
    }
    // 4. Nothing at the cursor: the largest one in view.
    const candidates = atCursor.length
      ? atCursor
      : [...document.querySelectorAll("img, video")]
          .filter((el) => shown(el) && visibleArea(el) > 100 * 100)
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
        // C puts one element on the clipboard. Shift+C adds to what is there.
        if (e.key.toLowerCase() !== "c" || e.altKey || e.ctrlKey || e.metaKey || e.isComposing) return;
        const focused = e.composedPath?.()[0] ?? e.target;
        if (isTextField(focused) || isTextField(document.activeElement)) return;
        const target = cosmosTarget(elementsUnderCursor());
        if (!target) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        swallowed = true;
        if (e.repeat) return;
        chrome.runtime.sendMessage({ type: "cosmos-copy:copy", target, add: e.shiftKey }).catch(() => {
          toast("TasteRef was updated. Reload the page to copy.", true);
        });
      },
      { capture: true },
    );
    // The same key's keypress and keyup must not reach a Cosmos handler either.
    for (const type of ["keypress", "keyup"]) {
      window.addEventListener(
        type,
        (e) => {
          if (!swallowed || e.key.toLowerCase() !== "c") return;
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
