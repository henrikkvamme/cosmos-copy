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

      // A button leans toward the pointer and springs back.
      for (const pill of document.querySelectorAll(".pill")) {
        pill.addEventListener("pointermove", (event) => {
          const rect = pill.getBoundingClientRect();
          pill.style.setProperty("--tx", `${((event.clientX - rect.left - rect.width / 2) * 0.22).toFixed(1)}px`);
          pill.style.setProperty("--ty", `${((event.clientY - rect.top - rect.height / 2) * 0.3).toFixed(1)}px`);
        });
        pill.addEventListener("pointerleave", () => {
          pill.style.setProperty("--tx", "0px");
          pill.style.setProperty("--ty", "0px");
        });
      }
    }
    measure();
  }

  // ---- How it works: the step at the middle of the view is the active one, and the scene shows its layout. ----
  const scene = document.getElementById("scene");
  // For review: ?chat=b, c or d shows a variant of the chat box.
  const chat = new URLSearchParams(location.search).get("chat");
  if (chat) scene.dataset.chat = chat;
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

  // ---- The hero video: the same view as the still, with moving cloud. It loads after the page, fades in over
  // the still, and stops while the hero is out of view. Not with reduced motion or data saving. ----
  const film = document.getElementById("film");
  if (!still && !navigator.connection?.saveData && "IntersectionObserver" in window) {
    film.addEventListener("playing", () => film.classList.add("on"), { once: true });
    new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return film.pause();
      if (!film.src) film.src = film.dataset.src;
      film.play().catch(() => {}); // a browser that refuses autoplay keeps the still
    }).observe(hero);
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

  // ---- The copy demo: Option+Shift+C on this page, or a click on the keycaps. The picture under the
  // pointer gets the lime frame, else the hero does, and a toast shows. This script copies nothing. ----
  const keys = document.getElementById("keys");
  const [optionKey, shiftKey, cKey] = keys.querySelectorAll("kbd");
  const toast = document.getElementById("toast");
  const toastImage = document.getElementById("toast-img");
  let hovered = null;
  let toastTimer = 0;
  document.addEventListener("pointerover", (event) => {
    hovered = event.target instanceof Element ? event.target.closest(".wall figure, .ref") : null;
  });

  function demo(target) {
    target.classList.remove("snap");
    void target.offsetWidth; // start the animation again when the demo runs twice
    target.classList.add("snap");
    setTimeout(() => target.classList.remove("snap"), 1100);
    const picture = target === hero ? hero.querySelector(".back img") : target.querySelector("img");
    toastImage.src = picture.currentSrc || picture.src;
    toast.classList.add("in");
    toast.setAttribute("aria-hidden", "false");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove("in");
      toast.setAttribute("aria-hidden", "true");
    }, 2600);
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
  // The extension shows the frame and the picture itself, so the page only presses the keys. A red toast is an error.
  let lastReal = 0;
  function realCopy(node) {
    if (node.style.background.includes("180") || Date.now() - lastReal < 1500) return;
    lastReal = Date.now();
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
