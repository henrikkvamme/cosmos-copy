// Sign-in, consent, account, connect and privacy: one script, one view per path.
(() => {
  const view = document.getElementById("view");
  const path = location.pathname.replace(/\/+$/, "") || "/";
  const TICKET_KEY = "cosmos-copy-ticket";

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === "class") node.className = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else if (value !== false && value !== undefined) node.setAttribute(key, value === true ? "" : value);
    }
    for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child);
    return node;
  }

  function show(...children) {
    view.replaceChildren(...children.flat().filter(Boolean));
  }

  function foot() {
    return el("p", { class: "foot" }, el("a", { href: "/privacy" }, "What this server stores"));
  }

  async function api(url, body) {
    const res = await fetch(url, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    let data = {};
    try {
      data = await res.json();
    } catch {
      // An empty body.
    }
    return { ok: res.ok, status: res.status, data };
  }

  /** Runs a click handler once at a time and shows a failure under the buttons. */
  function action(button, run) {
    return async () => {
      if (button.disabled) return;
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      view.querySelector(".error")?.remove();
      try {
        await run();
      } catch (error) {
        view.append(el("p", { class: "error" }, error instanceof Error ? error.message : "It did not work. Try again."));
      }
      button.disabled = false;
      button.removeAttribute("aria-busy");
    };
  }

  function button(label, kind, run) {
    const node = el("button", { class: `btn ${kind}`, type: "button" }, label);
    node.addEventListener("click", action(node, run));
    return node;
  }

  /** The signed query that Better Auth put on this page. It continues the OAuth flow after the step. */
  const oauthQuery = new URLSearchParams(location.search).has("sig") ? location.search.slice(1) : undefined;

  async function googleSignIn(callbackURL) {
    const { ok, data } = await api("/api/auth/sign-in/social", { provider: "google", callbackURL, ...(oauthQuery ? { oauth_query: oauthQuery } : {}) });
    if (!ok || !data.url) throw new Error("Could not start the Google sign-in. Try again.");
    location.assign(data.url);
  }

  // ---- /login ----
  async function login() {
    document.title = "Sign in";
    // A signed-in person has nothing to do here, unless an app waits for the sign-in.
    if (!oauthQuery && (await api("/account/api/me")).data.user) return location.replace(sessionStorage.getItem(TICKET_KEY) ? "/connect" : "/account");
    show(
      el("h1", {}, "Sign in"),
      el("p", {}, oauthQuery ? "An app asks for access to your references. Sign in to continue." : "Sign in to manage your account."),
      el("div", { class: "actions" }, button("Continue with Google", "primary wide", () => googleSignIn(sessionStorage.getItem(TICKET_KEY) ? "/connect" : "/account"))),
      foot(),
    );
  }

  // ---- /consent ----
  async function consent() {
    document.title = "Allow access";
    const query = new URLSearchParams(location.search);
    const clientId = query.get("client_id") ?? "";
    const [me, client] = await Promise.all([api("/account/api/me"), api(`/api/auth/oauth2/public-client?client_id=${encodeURIComponent(clientId)}`)]);
    if (!me.data.user) return location.replace(`/login${location.search}`);
    const name = client.data.client_name || client.data.name || "An app";
    const decide = async (accept) => {
      const { ok, data } = await api("/api/auth/oauth2/consent", { accept, oauth_query: oauthQuery });
      const next = data.url || data.redirect_uri || data.redirectURI;
      if (!ok || !next) throw new Error("The request has expired. Start the sign-in again from the app.");
      location.assign(next);
    };
    show(
      el("h1", {}, `Allow ${name}?`),
      el("p", {}, "It will be able to read your saved references and your pick history, save references to your collections, and delete pick history. It acts as ", el("strong", {}, me.data.user.email), "."),
      el("section", {}, el("h2", {}, "The app says it is"), el("code", {}, clientId), el("h2", {}, "It gets the answer at"), el("code", {}, query.get("redirect_uri") ?? "")),
      el("p", { class: "foot" }, "The name is what the app says about itself. Allow it only when you started this sign-in yourself."),
      el("div", { class: "actions" }, button("Allow", "primary", () => decide(true)), button("Deny", "", () => decide(false))),
    );
  }

  // ---- /account ----
  async function account() {
    document.title = "Account";
    const { data } = await api("/account/api/me");
    if (!data.user) return location.replace("/login");
    const reload = () => account();
    const cosmos = data.cosmos
      ? el(
          "div",
          { class: "line" },
          el("span", { class: "what" }, `@${data.cosmos.username}`, el("small", {}, data.cosmos.token ? `${data.cosmos.devices} linked ${data.cosmos.devices === 1 ? "browser" : "browsers"}` : "The Cosmos login has expired. Open cosmos.so in a linked browser.")),
          button("Unlink", "", async () => {
            const res = await api("/account/api/unlink", {});
            if (!res.ok) throw new Error(res.data.error || "Could not unlink.");
            await reload();
          }),
        )
      : el("p", {}, "No Cosmos account is linked. Open the TasteRef extension in your browser and click ", el("strong", {}, "Connect account"), ".");
    const clients = data.clients.length
      ? data.clients.map((client) =>
          el(
            "div",
            { class: "line" },
            el("span", { class: "what" }, client.name, el("small", {}, client.clientId)),
            button("Remove", "", async () => {
              const res = await api("/account/api/revoke", { clientId: client.clientId });
              if (!res.ok) throw new Error(res.data.error || "Could not remove it.");
              await reload();
            }),
          ),
        )
      : el("p", {}, "No app has access yet.");
    show(
      el("h1", {}, "Account"),
      el("p", {}, "Signed in as ", el("strong", {}, data.user.email), "."),
      el("section", {}, el("h2", {}, "Cosmos"), cosmos),
      el("section", {}, el("h2", {}, "Add to an agent"), el("p", {}, "Give this URL to Claude Code, Codex or another MCP client. It holds no secret: the app asks you to sign in."), el("code", {}, data.mcpUrl)),
      el("section", {}, el("h2", {}, "Apps with access"), clients, data.clients.length ? el("p", { class: "foot" }, `A removed app can still read for up to ${data.tokenMinutes} minutes.`) : null),
      el(
        "div",
        { class: "actions" },
        button("Sign out", "", async () => {
          await api("/api/auth/sign-out", {});
          location.replace("/login");
        }),
        button("Delete account", "danger", async () => {
          if (!confirm("Delete your account? Your sign-in, the access of all apps and the link to Cosmos are removed. When no browser is linked, your pick history is deleted too.")) return;
          const res = await api("/api/auth/delete-user", {});
          if (!res.ok) throw new Error(res.status === 400 || res.status === 403 ? "Sign out, sign in again, and then delete the account. This check protects the account." : "Could not delete the account.");
          location.replace("/login");
        }),
      ),
      foot(),
    );
  }

  // ---- /connect ----
  async function connect() {
    document.title = "Connect Cosmos";
    // The ticket comes in the fragment. Keep it for this tab only and take it out of the URL.
    if (/^#[A-Za-z0-9_-]{43}$/.test(location.hash)) {
      sessionStorage.setItem(TICKET_KEY, location.hash.slice(1));
      history.replaceState(null, "", "/connect");
    }
    const ticket = sessionStorage.getItem(TICKET_KEY);
    const expired = () => {
      sessionStorage.removeItem(TICKET_KEY);
      show(el("h1", {}, "Start again from the extension"), el("p", {}, "This link has expired or was used. Open the TasteRef extension and click Connect account."), foot());
    };
    if (!ticket) return expired();
    const me = await api("/account/api/me");
    if (!me.data.user) return location.replace("/login");
    const peek = await api("/account/api/connect", { ticket });
    if (!peek.ok) return expired();
    show(
      el("h1", {}, "Connect Cosmos"),
      el("p", {}, "Link the Cosmos account ", el("strong", {}, `@${peek.data.username}`), " to ", el("strong", {}, peek.data.email), "? Apps that you allow can then read its saved references and save to it."),
      peek.data.current && peek.data.current !== peek.data.username ? el("p", {}, `This replaces the link to @${peek.data.current}.`) : null,
      el(
        "div",
        { class: "actions" },
        button("Link", "primary", async () => {
          const res = await api("/account/api/connect", { ticket, confirm: true });
          if (res.status === 410) return expired();
          if (!res.ok) throw new Error(res.data.error || "Could not link.");
          sessionStorage.removeItem(TICKET_KEY);
          location.replace("/account");
        }),
        button("Cancel", "", async () => {
          sessionStorage.removeItem(TICKET_KEY);
          location.replace("/account");
        }),
      ),
    );
  }

  // ---- /privacy ----
  function privacy() {
    document.title = "What this server stores";
    show(
      el("h1", {}, "What this server stores"),
      el(
        "ul",
        {},
        el("li", {}, "Your Google name, email address and picture link, to sign you in."),
        el("li", {}, "Your Cosmos login token, when you link Cosmos from the extension. With it the server reads your saved references and saves to your collections for the apps you allow. It expires after at most 7 days and the extension renews it."),
        el("li", {}, "Your pick history: which references you picked, passed and pasted per task, and the style records of your projects with one screenshot each."),
        el("li", {}, "The apps you allowed, and their access tokens."),
      ),
      el("p", {}, "The server does not sell or share this data. The request log holds paths, status codes and times, and no tokens."),
      el("p", {}, "To remove everything: unlink the browser in the extension (Disconnect), then delete your account on the ", el("a", { href: "/account" }, "account page"), "."),
    );
  }

  const pages = { "/login": login, "/consent": consent, "/account": account, "/connect": connect, "/privacy": privacy };
  Promise.resolve((pages[path] ?? login)()).catch(() => show(el("h1", {}, "Something went wrong"), el("p", {}, "Reload the page.")));
})();
