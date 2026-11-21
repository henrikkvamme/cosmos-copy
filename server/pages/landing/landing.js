// Motion of the landing page: layers that move with the scroll and the pointer, parts that come in,
// buttons that follow the pointer, and a demo of the copy shortcut. The page works without this file.
(function () {
  const root = document.documentElement;
  root.classList.add("js");
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const fine = matchMedia("(hover: hover) and (pointer: fine)").matches;
  const hero = document.getElementById("hero");
  const closing = document.getElementById("closing");

  // ---- Parts come in when they enter the view. Children of one row come in one after another. ----
  const reveals = [...document.querySelectorAll("[data-reveal]")];
  for (const el of reveals) {
    const row = el.parentElement.querySelectorAll(":scope > [data-reveal]");
    el.style.setProperty("--i", String([...row].indexOf(el)));
  }
  if ("IntersectionObserver" in window && !still) {
    const seen = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("in");
          seen.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -8% 0px" },
    );
    for (const el of reveals) seen.observe(el);
  } else {
    for (const el of reveals) el.classList.add("in");
  }

  // ---- Layers. One frame loop writes the scroll and the pointer into CSS variables, and only while something moves. ----
  if (!still) {
    const columns = [...document.querySelectorAll("[data-speed]")].map((el) => ({ el, speed: Number(el.dataset.speed), middle: 0 }));
    let closingMiddle = 0;
    const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
    let queued = false;

    // Positions in the document, without the transforms this script sets.
    function measure() {
      for (const column of columns) {
        column.el.style.transform = "";
        const rect = column.el.getBoundingClientRect();
        column.middle = rect.top + scrollY + rect.height / 2;
      }
      const rect = closing.getBoundingClientRect();
      closingMiddle = rect.top + scrollY + rect.height / 2;
      request();
    }

    function frame() {
      queued = false;
      const view = innerHeight;
      const middle = scrollY + view / 2;
      if (scrollY < hero.offsetHeight + 200) hero.style.setProperty("--sy", String(Math.round(scrollY)));
      closing.style.setProperty("--sy", String(Math.round(Math.max(-view, Math.min(view, closingMiddle - middle)))));
      for (const column of columns) {
        const away = column.middle - middle;
        if (Math.abs(away) < view * 1.5) column.el.style.transform = `translate3d(0, ${(away * column.speed).toFixed(1)}px, 0)`;
      }
      pointer.x += (pointer.tx - pointer.x) * 0.07;
      pointer.y += (pointer.ty - pointer.y) * 0.07;
      for (const panel of [hero, closing]) {
        panel.style.setProperty("--mx", pointer.x.toFixed(3));
        panel.style.setProperty("--my", pointer.y.toFixed(3));
      }
      if (Math.abs(pointer.tx - pointer.x) + Math.abs(pointer.ty - pointer.y) > 0.002) request();
    }
    function request() {
      if (queued) return;
      queued = true;
      requestAnimationFrame(frame);
    }

    addEventListener("scroll", request, { passive: true });
    addEventListener("resize", measure);
    addEventListener("load", measure);
    if ("ResizeObserver" in window) new ResizeObserver(measure).observe(document.body);
    if (fine) {
      addEventListener("pointermove", (event) => {
        pointer.tx = (event.clientX / innerWidth) * 2 - 1;
        pointer.ty = (event.clientY / innerHeight) * 2 - 1;
        request();
      });

      // The scene of How it works leans toward the pointer.
      const sceneWrap = document.querySelector(".scene-wrap");
      const tilted = sceneWrap.firstElementChild;
      sceneWrap.addEventListener("pointermove", (event) => {
        const rect = sceneWrap.getBoundingClientRect();
        tilted.style.setProperty("--rx", (((event.clientX - rect.left) / rect.width) * 2 - 1).toFixed(3));
        tilted.style.setProperty("--ry", (((event.clientY - rect.top) / rect.height) * 2 - 1).toFixed(3));
      });
      sceneWrap.addEventListener("pointerleave", () => {
        tilted.style.setProperty("--rx", "0");
        tilted.style.setProperty("--ry", "0");
      });

      // The aurora of the closing gets brighter under the pointer.
      closing.addEventListener("pointermove", (event) => {
        const rect = closing.getBoundingClientRect();
        closing.style.setProperty("--px", `${Math.round(event.clientX - rect.left)}px`);
        closing.style.setProperty("--py", `${Math.round(event.clientY - rect.top)}px`);
        closing.classList.add("lit");
      });
      closing.addEventListener("pointerleave", () => closing.classList.remove("lit"));
    }
    measure();
  }

  // ---- How it works: the step at the middle of the view is the active one, and the scene shows its layout. ----
  const scene = document.getElementById("scene");
  const steps = [...document.querySelectorAll(".how-step")];
  if ("IntersectionObserver" in window) {
    // On a narrow page the scene stays at the top and the steps pass under it, so the line is lower there.
    const narrow = matchMedia("(max-width: 900px)");
    let active;
    const watch = () => {
      active?.disconnect();
      active = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            scene.dataset.step = entry.target.dataset.step;
            scene.classList.add("go"); // the copy in step 1 plays from here, not at page load
            for (const step of steps) step.classList.toggle("on", step === entry.target);
          }
        },
        { rootMargin: narrow.matches ? "-78% 0px -22% 0px" : "-50% 0px -50% 0px" },
      );
      for (const step of steps) active.observe(step);
    };
    narrow.addEventListener("change", watch);
    watch();
  }

  // ---- The background videos of the hero and the closing: the same view as the still, with moving light.
  // Each loads when its part comes into view, fades in over the still, and stops while out of view.
  // Not with reduced motion or data saving. ----
  if (!still && !navigator.connection?.saveData && "IntersectionObserver" in window) {
    for (const film of document.querySelectorAll("video[data-src]")) {
      film.addEventListener("playing", () => film.classList.add("on"), { once: true });
      new IntersectionObserver(([entry]) => {
        if (!entry.isIntersecting) return film.pause();
        // The large file is for a panel wider than the small video (1632 px) in device pixels.
        if (!film.src) film.src = innerWidth * devicePixelRatio > 1700 ? film.dataset.srcLarge : film.dataset.src;
        film.play().catch(() => {}); // a browser that refuses autoplay keeps the still
      }).observe(film.closest("section, header"));
    }
  }

  // ---- The install prompt: the button copies it. A page without https has no clipboard API, so the
  // old way is the fallback: select the text and run the copy command. ----
  const copyButton = document.getElementById("copy");
  const copyLabel = document.getElementById("copy-label");
  const prompt = document.getElementById("prompt");
  const copyText = copyLabel.textContent;
  let copyTimer = 0;
  copyButton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(prompt.textContent);
    } catch {
      prompt.closest("details").open = true; // hidden text cannot be selected
      const range = document.createRange();
      range.selectNodeContents(prompt);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      if (!document.execCommand("copy")) return; // the text stays selected, so Cmd+C works
      selection.removeAllRanges();
    }
    copyButton.classList.add("done");
    copyLabel.textContent = copyButton.dataset.done;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copyButton.classList.remove("done");
      copyLabel.textContent = copyText;
    }, 2000);
  });

  // ---- The copy demo: Option+Shift+C on this page, a tap on a picture of the wall, or a click on the keycaps.
  // The picture under the pointer gets the lime frame, else the hero does. The picture then flies into the tray,
  // and the accent of the page moves toward the colour of the picks. This script copies and saves nothing. ----
  const keys = document.getElementById("keys");
  const [optionKey, shiftKey, cKey] = keys.querySelectorAll("kbd");
  const tray = document.getElementById("tray");
  const trayPicks = document.getElementById("tray-picks");
  const LIME = 70; // the hue of the accent and of the light in the hero, in degrees
  const KEEP = 5; // the tray shows the last picks
  const picks = []; // { x, y }: the hue of each pick as a point on the colour circle, null for a grey picture
  let hovered = null;
  document.addEventListener("pointerover", (event) => {
    hovered = event.target instanceof Element ? event.target.closest(".wall figure, .ref") : null;
  });

  // The colour of a picture: the mean of its strong colours, as a point on the colour circle. Greys do not count.
  function hueOf(picture) {
    const size = 64; // small, but a thin coloured line still counts
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(picture, 0, 0, size, size);
    const { data } = context.getImageData(0, 0, size, size);
    let x = 0;
    let y = 0;
    let weight = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b), spread = max - min;
      if (spread < 0.25 || max < 0.35) continue;
      const hue = max === r ? ((g - b) / spread) % 6 : max === g ? (b - r) / spread + 2 : (r - g) / spread + 4;
      x += Math.cos((hue * Math.PI) / 3) * spread;
      y += Math.sin((hue * Math.PI) / 3) * spread;
      weight += spread;
    }
    return weight < 3 ? null : { x: x / weight, y: y / weight };
  }

  // Each pick counts two times the pick before it, so the page follows the visitor and older picks still pull a little.
  function restyle() {
    let x = 0;
    let y = 0;
    picks.forEach((pick, i) => {
      if (!pick) return;
      x += pick.x * 2 ** i;
      y += pick.y * 2 ** i;
    });
    if (!x && !y) return root.classList.toggle("tasted", picks.length > 0);
    const hue = Math.round(((Math.atan2(y, x) * 180) / Math.PI + 360) % 360);
    // The short way round the circle, so lime to orange does not pass through blue.
    const turn = ((hue - LIME + 540) % 360) - 180;
    root.style.setProperty("--pick", `hsl(${hue} 78% 56%)`);
    root.style.setProperty("--turn", `${turn}deg`);
    root.classList.add("tasted");
  }

  // A small square copy of a picture: the middle of the picture fills it.
  function tile(source, size) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size * 2;
    const width = source.naturalWidth || source.width;
    const height = source.naturalHeight || source.height;
    const scale = Math.max(canvas.width / width, canvas.height / height);
    canvas.getContext("2d").drawImage(source, (canvas.width - width * scale) / 2, (canvas.height - height * scale) / 2, width * scale, height * scale);
    return canvas;
  }

  // source: the picture, an img or a canvas. from: the element that the picture flies from.
  function pick(source, from) {
    if (source instanceof HTMLImageElement && (!source.complete || !source.naturalWidth)) return;
    picks.push(hueOf(source));
    const thumb = tile(source, 40);
    trayPicks.append(thumb);
    while (trayPicks.children.length > KEEP) trayPicks.firstElementChild.remove();
    tray.classList.add("in");
    tray.setAttribute("aria-hidden", "false");
    restyle();
    if (still || !thumb.animate) return;
    // The picture flies from its place to its slot in the tray.
    const start = from.getBoundingClientRect();
    const end = thumb.getBoundingClientRect();
    const flyer = tile(source, 40);
    flyer.className = "flyer";
    document.body.append(flyer);
    thumb.classList.add("coming");
    const frames = [
      { transform: `translate(${start.left}px, ${start.top}px) scale(${start.width / end.width}, ${start.height / end.height})` },
      { transform: `translate(${end.left}px, ${end.top}px)` },
    ];
    const land = () => {
      thumb.classList.remove("coming");
      flyer.remove();
    };
    flyer.animate(frames, { duration: 750, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "forwards" }).finished.then(land, land);
  }

  document.getElementById("tray-reset").addEventListener("click", () => {
    picks.length = 0;
    trayPicks.replaceChildren();
    tray.classList.remove("in");
    tray.setAttribute("aria-hidden", "true");
    root.classList.remove("tasted");
    root.style.removeProperty("--pick");
    root.style.removeProperty("--turn");
  });

  function demo(target) {
    target.classList.remove("snap");
    void target.offsetWidth; // start the animation again when the demo runs twice
    target.classList.add("snap");
    setTimeout(() => target.classList.remove("snap"), 1100);
    if (target === hero) pick(hero.querySelector(".back img"), keys);
    else pick(target.querySelector("img"), target);
  }
  // A tap or a click on a picture of the wall picks it: a phone has no Option key.
  for (const figure of document.querySelectorAll(".wall figure")) {
    figure.addEventListener("click", () => demo(figure));
    figure.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault(); // Space does not scroll the page
      demo(figure);
    });
  }

  addEventListener("keydown", (event) => {
    optionKey.classList.toggle("down", event.altKey);
    shiftKey.classList.toggle("down", event.shiftKey);
    // event.code, not event.key: with Option held, the C key types another character.
    if (event.code !== "KeyC" || !event.altKey || !event.shiftKey || event.metaKey || event.ctrlKey || event.repeat) return;
    cKey.classList.add("down");
    demo(hovered ?? hero);
  });
  addEventListener("keyup", (event) => {
    optionKey.classList.toggle("down", event.altKey);
    shiftKey.classList.toggle("down", event.shiftKey);
    if (event.code === "KeyC") cKey.classList.remove("down");
  });
  addEventListener("blur", () => {
    for (const key of [optionKey, shiftKey, cKey]) key.classList.remove("down");
  });
  // With the extension installed, the browser gives the shortcut to the extension and this page gets no key event.
  // The extension then adds its toast (#cosmos-copy-toast) to the page: that is the sign of a real copy.
  // The extension shows the frame itself, so the page presses the keys and adds the pick. A red toast is an error.
  let lastReal = 0;
  function realCopy(node) {
    if (node.style.background.includes("180") || Date.now() - lastReal < 1500) return;
    lastReal = Date.now();
    // The extension took the key event, so the pick starts here. Its toast holds a small picture of what it copied:
    // the pointer can be on another picture by now, so that small picture is the pick.
    const copied = node.querySelector("canvas");
    if (copied) pick(copied, copied);
    [optionKey, shiftKey, cKey].forEach((key) => {
      key.classList.add("down");
      setTimeout(() => key.classList.remove("down"), 420);
    });
  }
  const extensionToast = new MutationObserver((changes) => {
    for (const change of changes) {
      if (change.target.id === "cosmos-copy-toast") realCopy(change.target);
      for (const node of change.addedNodes) {
        if (node.id !== "cosmos-copy-toast") continue;
        extensionToast.observe(node, { childList: true }); // the extension sets the text again on the next copy
        realCopy(node);
      }
    }
  });
  extensionToast.observe(root, { childList: true });

  // A click presses the three keys in turn.
  keys.addEventListener("click", () => {
    [optionKey, shiftKey, cKey].forEach((key, index) => {
      setTimeout(() => key.classList.add("down"), index * 110);
      setTimeout(() => key.classList.remove("down"), 620);
    });
    setTimeout(() => demo(hero), 240);
  });
})();
