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
      if (id) return { elementId: id, el: link.querySelector("img, video") ?? link };
    }
    const pageId = location.hostname.endsWith("cosmos.so") && elementId(location.href);
    return pageId ? { elementId: pageId, el: largestMedia()[0] } : null;
  }

  // The images and videos in view, the largest first.
  const largestMedia = () =>
    [...document.querySelectorAll("img, video")]
      .filter((el) => shown(el) && visibleArea(el) > 100 * 100)
      .sort((a, b) => visibleArea(b) - visibleArea(a));

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
      (el) => !underCursor.includes(el) && holds(el, point) && shown(el) && sharedArea(el, top) <= 3 * area(el),
    );
    if (!near.length) return hit;
    // A second hit test gives the true order, front first: for a moment, the left-out media takes pointer events.
    // The hit test also leaves out media that an ancestor clips away at this point.
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
    if (onCosmos) {
      return { elementId: onCosmos.elementId, copy: mark(onCosmos.el) };
    }

    // 3. Any other site: the image or video at the cursor.
    const atCursor = mediaAtCursor(underCursor);
    // A frame or a canvas draws its own content: there is no file to copy, and a picture from
    // another part of the page is not what the user points at.
    if (isFrame(underCursor[0]) || underCursor[0]?.tagName === "CANVAS") {
      return { error: "Live content has no image or video to copy. Hover an image or a video and try again." };
    }
    // 4. Nothing at the cursor: the largest one in view.
    for (const el of atCursor.length ? atCursor : largestMedia()) {
      // A page can mark media as a demo of TasteRef (the TasteRef landing page does): it is not copied.
      // The page gets an event and shows its own demo of the copy.
      if (el.closest('[data-tasteref="demo"]')) {
        document.dispatchEvent(new CustomEvent("tasteref:shortcut"));
        return { demo: true };
      }
      const media = mediaSource(el);
      if (!media) continue;
      return { media, copy: mark(el) };
    }
    return { error: "No image or video found. Hover one and try again." };
  }

  // ---- What the user sees of a copy: a lime frame on the copied element, and its picture in the toast. ----
  const LIME = "#c6e33a";
  const calm = matchMedia("(prefers-reduced-motion: reduce)");
  // The picture of each copy by its number. Two copies can run at the same time, and each toast
  // must show the picture of its own copy.
  const pictures = new Map();
  let copies = 0;

  // The round corners of the element. Often a parent of the same size cuts them, not the element.
  function cornersOf(el, box) {
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      const r = node.getBoundingClientRect();
      if (Math.abs(r.width - box.width) > 2 || Math.abs(r.height - box.height) > 2) break;
      const radius = getComputedStyle(node).borderRadius;
      if (parseFloat(radius) > 0) return radius;
    }
    return "0px";
  }

  // Shows which element is copied: a frame that closes in on it, and a short flash of light.
  // Returns the number of the copy.
  function mark(el) {
    const copy = ++copies;
    if (!el?.isConnected) return copy;
    pictures.set(copy, preview(el));
    pictures.delete(copy - 8);
    const box = el.getBoundingClientRect();
    if (box.width < 8 || box.height < 8) return copy;
    const frame = document.createElement("div");
    Object.assign(frame.style, {
      position: "fixed",
      left: `${box.left}px`,
      top: `${box.top}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
      zIndex: 2147483646,
      boxSizing: "border-box",
      border: `3px solid ${LIME}`,
      borderRadius: cornersOf(el, box),
      boxShadow: "0 0 0 1px rgba(17,17,19,.5), 0 0 28px rgba(198,227,58,.45)",
      pointerEvents: "none",
      opacity: "0",
    });
    document.documentElement.appendChild(frame);
    const frames = calm.matches
      ? [{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }]
      : [
          { opacity: 0, transform: "scale(1.06)" },
          { opacity: 1, transform: "none", offset: 0.18 },
          { opacity: 1, transform: "none", offset: 0.7 },
          { opacity: 0, transform: "none" },
        ];
    frame.animate(frames, { duration: 1100, easing: "cubic-bezier(.16,1,.3,1)" }).finished.then(
      () => frame.remove(),
      () => frame.remove(),
    );
    if (!calm.matches) {
      // The light goes after the filter that the page has on the element, so a blur stays.
      const own = getComputedStyle(el).filter;
      const lit = `${own === "none" ? "" : `${own} `}brightness(1.35) saturate(1.15)`;
      el.animate([{ filter: own }, { filter: lit, offset: 0.25 }, { filter: own }], { duration: 520, easing: "ease-out" });
    }
    return copy;
  }

  // A small picture of the copied element. A canvas shows the current frame of a video too, and it
  // needs no second download.
  function preview(el) {
    const width = el.naturalWidth || el.videoWidth;
    const height = el.naturalHeight || el.videoHeight;
    if (!el.isConnected || !width || !height) return null;
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = Math.round(Math.min(96, Math.max(48, (128 * height) / width)));
    // Cover: the middle of the picture fills the canvas.
    const scale = Math.max(canvas.width / width, canvas.height / height);
    try {
      canvas.getContext("2d").drawImage(el, (canvas.width - width * scale) / 2, (canvas.height - height * scale) / 2, width * scale, height * scale);
    } catch {
      return null; // a broken image
    }
    Object.assign(canvas.style, { display: "block", width: "64px", height: `${canvas.height / 2}px`, borderRadius: "8px", background: "#0b0b0c" });
    return canvas;
  }

  let toastTimer;
  function toast(text, isError, copy) {
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
        display: "flex",
        alignItems: "center",
        gap: "12px",
        borderRadius: "16px",
        font: "500 14px/1.3 -apple-system, BlinkMacSystemFont, sans-serif",
        color: "#fff",
        pointerEvents: "none",
        maxWidth: "80vw",
      });
      document.documentElement.appendChild(el);
      if (!calm.matches) {
        el.animate([{ opacity: 0, transform: "translate(-50%, 12px)" }, { opacity: 1, transform: "translateX(-50%)" }], { duration: 320, easing: "cubic-bezier(.16,1,.3,1)" });
      }
    }
    // An error shows no picture: nothing was copied.
    const picture = (!isError && pictures.get(copy)) || null;
    const label = document.createElement("span");
    label.textContent = text;
    el.replaceChildren(...(picture ? [picture, label] : [label]));
    el.style.padding = picture ? "8px 18px 8px 8px" : "10px 16px";
    el.style.background = isError ? "#b42318" : "rgba(28, 28, 32, 0.94)";
    el.style.boxShadow = "0 0 0 1px rgba(255,255,255,.1), 0 18px 50px rgba(0,0,0,.55)";
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
        const found = cosmosTarget(elementsUnderCursor());
        if (!found) return;
        const target = { elementId: found.elementId };
        e.preventDefault();
        e.stopImmediatePropagation();
        swallowed = true;
        if (e.repeat) return;
        const copy = mark(found.el);
        chrome.runtime.sendMessage({ type: "cosmos-copy:copy", target, copy, add: e.shiftKey }).catch(() => {
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
    if (msg.type === "cosmos-copy:toast") toast(msg.text, msg.isError, msg.copy);
  });
})();
