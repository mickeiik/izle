// @ts-check
// izle admin UI: a small single-page app over the admin API (docs/spec/server-api-v1.md). No dependencies, no
// build step, no inline scripts (the page is served with a strict Content-Security-Policy). All text from the
// server is inserted with textContent, never as HTML.

import { companionCard } from "./companion.js";
import {
  HOME_MAX,
  LANGUAGES,
  RESUME_MIN_MS,
  continueText,
  episodeName,
  episodeStates,
  errorMessage,
  formatClock,
  formatCode,
  formatCountdown,
  formatRelative,
  isActive,
  languageLabel,
  moveItem,
  percent,
  plural,
  serverAddress,
  tokenFromHash,
  triedText,
} from "./lib.js";

const TOKEN_KEY = "izle.adminToken";
const app = /** @type {HTMLElement} */ (document.getElementById("app"));
const nav = /** @type {HTMLElement} */ (document.getElementById("nav"));

// --- tiny DOM helper ----------------------------------------------------------------------------------------------

/**
 * @typedef {Node | string | number | null | undefined | false} Child
 */

/**
 * Creates an element. `on*` props become listeners, `class` the class name, `value`/`checked`/`disabled`/`selected`
 * are set as properties, everything else as attributes.
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {Record<string, any> | null} [props]
 * @param {...(Child | Child[])} children
 * @returns {HTMLElementTagNameMap[K]}
 */
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "class") el.className = v;
    else if (k === "value" || k === "checked" || k === "disabled" || k === "selected") /** @type {any} */ (el)[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

/** @param {string} text @param {"ok" | "error" | "info"} [kind] */
function toast(text, kind = "ok") {
  const box = /** @type {HTMLElement} */ (document.getElementById("toasts"));
  const t = h("div", { class: `toast ${kind}`, role: kind === "error" ? "alert" : "status" }, text);
  box.append(t);
  setTimeout(() => t.remove(), kind === "error" ? 7000 : 3500);
}

// --- API ----------------------------------------------------------------------------------------------------------

class ApiError extends Error {
  /** @param {number} status @param {string} code @param {any} body */
  constructor(status, code, body) {
    super(code);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

const token = () => {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
};

/**
 * @param {string} method
 * @param {string} path below /api/v1/admin
 * @param {unknown} [body]
 * @param {string | null} [withToken]
 * @param {AbortSignal} [signal]
 * @returns {Promise<any>}
 */
async function api(method, path, body, withToken = token(), signal) {
  let res;
  try {
    res = await fetch(`/api/v1/admin${path}`, {
      method,
      headers: { Authorization: `Bearer ${withToken ?? ""}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });
  } catch {
    throw new ApiError(0, "network", null);
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (res.status === 401 && withToken === token()) {
    signOut("Your admin token is not valid any more. Sign in again.");
  }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `http_${res.status}`, data);
  return data;
}

/**
 * Runs an action, reporting failures (and, if given, success) as a toast. Returns the result, or undefined after
 * an error.
 * @param {() => Promise<any>} fn
 * @param {string} [success]
 */
async function attempt(fn, success) {
  try {
    const r = await fn();
    if (success) toast(success);
    return r;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return undefined;
    toast(err instanceof ApiError ? errorMessage(err.code) : "Something went wrong.", "error");
    return undefined;
  }
}

/** Disables a button while `fn` runs. */
async function busy(/** @type {HTMLButtonElement} */ button, /** @type {() => Promise<unknown>} */ fn) {
  button.disabled = true;
  try {
    await fn();
  } finally {
    button.disabled = false;
  }
}

// --- routing, polling ---------------------------------------------------------------------------------------------

/** @type {Array<() => void>} */
let cleanups = [];

/** Calls `fn` now and every `ms` while the view is shown and the page visible. */
function poll(/** @type {() => Promise<void>} */ fn, /** @type {number} */ ms) {
  let stopped = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const tick = async () => {
    if (stopped) return;
    if (!document.hidden) await fn().catch(() => {});
    if (!stopped) timer = setTimeout(tick, ms);
  };
  const wake = () => {
    if (!document.hidden && !stopped) {
      clearTimeout(timer);
      void tick();
    }
  };
  document.addEventListener("visibilitychange", wake);
  void tick();
  cleanups.push(() => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", wake);
  });
}

function signOut(/** @type {string} */ message = "") {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage unavailable: nothing to forget
  }
  location.hash = "#/login";
  if (message) toast(message, "info");
}

/** A sign-in link (`#token=…`) signs the browser in; the token leaves the address bar and history first. */
async function signInFromLink() {
  const linked = tokenFromHash(location.hash);
  if (!linked) return;
  history.replaceState(null, "", `${location.pathname}${location.search}#/devices`);
  try {
    await api("GET", "/catalog", undefined, linked);
    localStorage.setItem(TOKEN_KEY, linked);
    toast("Signed in.");
  } catch (err) {
    toast(
      err instanceof ApiError && err.status === 401
        ? "This sign-in link is not valid any more. Print a new one with izle-server admin-token --link."
        : errorMessage(err instanceof ApiError ? err.code : "network"),
      "error",
    );
  }
}

async function route() {
  for (const c of cleanups) c();
  cleanups = [];
  await signInFromLink();
  const path = location.hash.replace(/^#/, "") || "/devices";
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  const signedIn = Boolean(token());
  nav.hidden = !signedIn;
  for (const a of nav.querySelectorAll("a")) a.classList.toggle("active", path.startsWith(a.getAttribute("href")?.slice(1) ?? "-"));
  if (!signedIn || parts[0] === "login") return render(loginView());
  window.scrollTo(0, 0);
  if (parts[0] === "devices" && parts[1]) return render(deviceView(parts[1]));
  if (parts[0] === "catalog" && parts[1] === "items" && parts[2]) return render(itemView(parts[2]));
  if (parts[0] === "catalog") return render(catalogView());
  return render(devicesView());
}

function render(/** @type {HTMLElement} */ view) {
  app.replaceChildren(view);
  const heading = view.querySelector("h1");
  if (heading) document.title = `${heading.textContent} · izle admin`;
}

// --- shared bits --------------------------------------------------------------------------------------------------

/** @param {string} title @param {...(Child | Child[])} children */
const card = (title, ...children) => h("section", { class: "card" }, h("h2", null, title), ...children);

/** @param {string | null} url @param {string} alt */
const poster = (url, alt = "") => (url ? h("img", { class: "poster", src: url, alt, loading: "lazy" }) : h("div", { class: "poster empty", "aria-hidden": "true" }));

/** @param {any} device */
function statusChip(device) {
  if (device.status === "pending") return h("span", { class: "chip warn" }, "Waiting for the TV");
  return device.online ? h("span", { class: "chip ok" }, "Online") : h("span", { class: "chip" }, "Offline");
}

/** @param {number | null} value */
const progressBar = (value) => (value === null ? null : h("div", { class: "bar", role: "img", "aria-label": `${value}%` }, h("span", { "data-w": value })));

/** Applies `data-w` widths (the CSP forbids inline style attributes; CSSOM is fine). */
function applyBars(/** @type {ParentNode} */ root) {
  for (const el of root.querySelectorAll("[data-w]")) /** @type {HTMLElement} */ (el).style.width = `${el.getAttribute("data-w")}%`;
}

const loading = () => h("p", { class: "muted" }, "Loading…");

// --- views --------------------------------------------------------------------------------------------------------

function loginView() {
  const input = h("input", { type: "password", id: "token", autocomplete: "current-password", required: true, spellcheck: "false" });
  const error = h("p", { class: "error", role: "alert", hidden: true });
  const button = h("button", { type: "submit", class: "primary" }, "Sign in");
  const form = h(
    "form",
    {
      class: "card narrow",
      onsubmit: async (/** @type {SubmitEvent} */ e) => {
        e.preventDefault();
        const value = input.value.trim();
        await busy(button, async () => {
          try {
            await api("GET", "/catalog", undefined, value);
            localStorage.setItem(TOKEN_KEY, value);
            location.hash = "#/devices";
          } catch (err) {
            error.hidden = false;
            error.textContent = err instanceof ApiError && err.status === 401 ? "That token is not valid." : errorMessage(err instanceof ApiError ? err.code : "network");
          }
        });
      },
    },
    h("h1", null, "Sign in"),
    h("p", null, "Paste the admin token of this izle server. Print it on the server with ", h("code", null, "izle-server admin-token"), "."),
    h("label", { for: "token" }, "Admin token"),
    input,
    error,
    h("div", { class: "actions" }, button),
  );
  queueMicrotask(() => input.focus());
  return h("div", { class: "page" }, form);
}

function devicesView() {
  const pending = h("div", { class: "list" }, loading());
  const devices = h("div", { class: "list" }, loading());

  /** One row per open code; rows are kept while they exist so a half-typed name survives the polling. */
  const pendingRow = (/** @type {any} */ c) => {
    const name = h("input", { type: "text", maxlength: 60, placeholder: "Name (optional), e.g. Living room", "aria-label": `Name for the TV showing ${c.code}` });
    const countdown = h("span", { class: "muted" });
    const approve = h("button", { class: "primary", type: "submit" }, "Approve");
    const row = h(
      "form",
      {
        class: "row pair",
        onsubmit: async (/** @type {SubmitEvent} */ e) => {
          e.preventDefault();
          const n = name.value.trim();
          await busy(approve, async () => {
            const r = await attempt(() => api("POST", "/pair/approve", { code: c.code, ...(n ? { name: n } : {}) }));
            if (r) {
              toast(`Approved as “${r.name}”. The TV will show its home screen in a moment.`);
              await refresh();
            }
          });
        },
      },
      h("div", { class: "code", "aria-label": `Code ${c.code}` }, formatCode(c.code)),
      h("div", { class: "grow" }, name, countdown),
      approve,
    );
    /** @param {any} code */
    const update = (code) => {
      const approved = code.approved;
      name.disabled = approved;
      approve.disabled = approved;
      countdown.textContent = approved ? "Approved — waiting for the TV to pick it up" : `Expires in ${formatCountdown(code.expiresAt)}`;
    };
    update(c);
    return { row, update };
  };
  /** @type {Map<string, {row: HTMLElement, update: (c: any) => void}>} */
  const pendingRows = new Map();

  const refresh = async () => {
    const [codes, list] = await Promise.all([api("GET", "/pair/pending"), api("GET", "/devices")]);
    // Pending codes
    const open = new Set(codes.codes.map((/** @type {any} */ c) => c.code));
    for (const [code, r] of pendingRows) if (!open.has(code)) (r.row.remove(), pendingRows.delete(code));
    for (const c of codes.codes) {
      let r = pendingRows.get(c.code);
      if (!r) {
        r = pendingRow(c);
        pendingRows.set(c.code, r);
      }
      r.update(c);
    }
    if (pendingRows.size === 0) {
      pending.replaceChildren(
        h("p", { class: "muted" }, "No TV is waiting. Open izle on the TV and enter ", h("code", null, serverAddress(location.origin, location.pathname)), " as the server address: it then shows a 6-digit code."),
      );
    }
    else pending.replaceChildren(...[...pendingRows.values()].map((r) => r.row));
    // Devices
    if (list.devices.length === 0) devices.replaceChildren(h("p", { class: "muted" }, "No TV is paired yet."));
    else {
      devices.replaceChildren(
        ...list.devices.map((/** @type {any} */ d) =>
          h(
            "a",
            { class: "row link", href: `#/devices/${encodeURIComponent(d.id)}` },
            h("div", { class: "grow" }, h("strong", null, d.name), h("div", { class: "muted" }, `${d.homeCount} show${d.homeCount === 1 ? "" : "s"} on Home · seen ${formatRelative(d.lastSeenAt)}`)),
            statusChip(d),
          ),
        ),
      );
    }
  };
  poll(refresh, 3000);
  return h(
    "div",
    { class: "page" },
    h("h1", null, "TVs"),
    card("Pair a TV", h("p", { class: "muted" }, "Approve only the code that your TV shows."), pending),
    card("Paired TVs", devices),
  );
}

/** @param {string} id */
function deviceView(id) {
  const title = h("h1", null, "TV");
  const chip = h("span");
  const seen = h("span", { class: "muted" });
  const now = h("div", null, loading());
  const home = h("div", null, loading());
  const settings = h("div", null, loading());
  const history = h("div", null, loading());
  /** @type {any} */
  let device = null;
  /** @type {any[]} */
  let entries = [];
  /** Item id whose "continue from" panel is open. */
  let openPicker = /** @type {string | null} */ (null);

  // "Listen along": the owner's phone plays another source of what the TV plays, in sync (companion.js).
  const listenAlong = companionCard({ deviceId: id, h, api, toast, busy });
  cleanups.push(() => listenAlong.stop());

  const sendCommand = async (/** @type {any} */ body, /** @type {string} */ what) => {
    const r = await attempt(() => api("POST", `/devices/${encodeURIComponent(id)}/commands`, body));
    if (r) toast(r.online ? `${what} sent to the TV.` : `${what} queued: the TV is offline and gets it if it connects within 2 minutes.`, r.online ? "ok" : "info");
  };

  const loadDevice = async () => {
    try {
      const d = await api("GET", `/devices/${encodeURIComponent(id)}`);
      device = d.device;
      entries = d.home;
    } catch (err) {
      if (err instanceof ApiError && err.code === "unknown_device") {
        toast(errorMessage("unknown_device"), "info");
        location.hash = "#/devices";
      }
      throw err;
    }
    title.textContent = device.name;
    document.title = `${device.name} · izle admin`;
    chip.replaceChildren(statusChip(device));
    seen.textContent = device.status === "active" ? `last seen ${formatRelative(device.lastSeenAt)}` : "approved, waiting for the TV to collect its token";
  };

  const saveHome = async (/** @type {string[]} */ itemIds, /** @type {string} */ message) => {
    const r = await attempt(() => api("PUT", `/devices/${encodeURIComponent(id)}/home`, { itemIds }), message);
    if (r) entries = r.home;
    renderHome();
  };

  // Now playing ---------------------------------------------------------------------------------------------------
  const refreshNow = async () => {
    const r = await api("GET", `/devices/${encodeURIComponent(id)}/now`);
    const n = r.nowPlaying;
    const active = isActive(n, r.online);
    if (!n) return now.replaceChildren(h("p", { class: "muted" }, "Nothing played yet."));
    const pct = percent(n.positionMs, n.durationMs);
    const stop = h("button", { class: "danger", onclick: () => sendCommand({ type: "stop" }, "Stop") }, "Stop");
    now.replaceChildren(
      h(
        "div",
        { class: "row" },
        h(
          "div",
          { class: "grow" },
          h("div", { class: "muted" }, active ? (n.state === "paused" ? "Paused" : n.state === "starting" ? "Starting" : "Playing") : `Last played · ${formatRelative(n.updatedAt)}`),
          h("strong", null, n.itemTitle ?? n.itemId),
          n.episodeTitle ? h("div", null, n.episodeTitle) : null,
          h("div", { class: "muted" }, `${formatClock(n.positionMs)} / ${formatClock(n.durationMs)}${n.sourceId ? ` · source ${n.sourceId}` : ""}`),
          progressBar(pct),
        ),
        active ? stop : null,
      ),
    );
    applyBars(now);
  };

  // Home list -----------------------------------------------------------------------------------------------------
  const search = h("input", { type: "search", placeholder: "Search the catalog", "aria-label": "Search the catalog" });
  const results = h("div", { class: "list" });
  const homeList = h("ol", { class: "list home" });
  const counter = h("span", { class: "muted" });

  const picker = async (/** @type {any} */ entry, /** @type {HTMLElement} */ box) => {
    box.replaceChildren(loading());
    const [item, prog] = await Promise.all([
      api("GET", `/catalog/items/${encodeURIComponent(entry.itemId)}`),
      api("GET", `/devices/${encodeURIComponent(id)}/progress`),
    ]);
    const states = episodeStates(item.item.episodes, entry.continue?.episodeId ?? null, prog.progress.filter((/** @type {any} */ p) => p.itemId === entry.itemId));
    box.replaceChildren(
      h("p", { class: "muted" }, "OK on the TV plays the episode marked “next”. Choose where it continues; that episode starts from its beginning."),
      h(
        "ul",
        { class: "episodes" },
        states.map((s) => {
          const e = /** @type {any} */ (s.episode);
          const state = !e.playbackAllowed ? "not allowed" : s.current ? "next" : s.watched ? "watched" : s.percent !== null ? `${s.percent}%` : "";
          return h(
            "li",
            { class: s.current ? "current" : "" },
            h("span", { class: "grow" }, episodeName(e, item.item.kind)),
            h("span", { class: `chip${s.current ? " ok" : ""}` }, state || "new"),
            e.playbackAllowed && !s.current
              ? h(
                  "button",
                  {
                    onclick: async () => {
                      const r = await attempt(
                        () => api("PUT", `/devices/${encodeURIComponent(id)}/cursor`, { itemId: entry.itemId, episodeId: e.id }),
                        `${entry.title} continues from ${episodeName(e, item.item.kind)}.`,
                      );
                      if (r) {
                        openPicker = null;
                        await loadDevice();
                        renderHome();
                      }
                    },
                  },
                  "Continue from here",
                )
              : null,
            e.playbackAllowed ? h("button", { onclick: () => sendCommand({ type: "play", episodeId: e.id }, "Play") }, "Play now") : null,
          );
        }),
      ),
    );
  };

  const renderHome = () => {
    counter.textContent = `${entries.length} / ${HOME_MAX}`;
    const ids = entries.map((e) => e.itemId);
    if (entries.length === 0) homeList.replaceChildren(h("li", { class: "muted" }, "The TV shows “Nothing here yet”. Add shows below."));
    else
      homeList.replaceChildren(
        ...entries.map((entry, i) => {
          const box = h("div", { class: "picker" });
          if (openPicker === entry.itemId) void picker(entry, box).catch(() => box.replaceChildren(h("p", { class: "error" }, "Could not load the episodes.")));
          const c = entry.continue;
          return h(
            "li",
            null,
            h(
              "div",
              { class: "row" },
              poster(entry.posterUrl),
              h(
                "div",
                { class: "grow" },
                h("strong", null, entry.title ?? entry.itemId),
                entry.missing ? h("span", { class: "chip warn" }, "Missing from the catalog — hidden on the TV") : h("div", { class: "muted" }, continueText(c, entry.kind)),
                c && c.status === "watching" && c.positionMs >= RESUME_MIN_MS ? progressBar(percent(c.positionMs, c.durationMs)) : null,
              ),
              h(
                "div",
                { class: "buttons" },
                h("button", { "aria-label": `Move ${entry.title} up`, title: "Move up", disabled: i === 0, onclick: () => saveHome(moveItem(ids, i, -1), "Order saved.") }, "▲"),
                h("button", { "aria-label": `Move ${entry.title} down`, title: "Move down", disabled: i === entries.length - 1, onclick: () => saveHome(moveItem(ids, i, 1), "Order saved.") }, "▼"),
                c ? h("button", { onclick: () => sendCommand({ type: "play", episodeId: c.episodeId }, "Play") }, "Play") : null,
                entry.kind === "series"
                  ? h(
                      "button",
                      {
                        "aria-expanded": String(openPicker === entry.itemId),
                        onclick: () => {
                          openPicker = openPicker === entry.itemId ? null : entry.itemId;
                          renderHome();
                        },
                      },
                      "Episodes…",
                    )
                  : null,
                h("button", { class: "danger", "aria-label": `Remove ${entry.title}`, title: "Remove", onclick: () => saveHome(ids.filter((x) => x !== entry.itemId), `${entry.title ?? entry.itemId} removed.`) }, "✕"),
              ),
            ),
            box,
          );
        }),
      );
    applyBars(homeList);
    void runSearch();
  };

  let searchSeq = 0;
  const runSearch = async () => {
    const seq = ++searchSeq;
    const r = await api("GET", `/catalog/search?limit=50&q=${encodeURIComponent(search.value)}`).catch(() => null);
    if (!r || seq !== searchSeq) return;
    const onHome = new Set(entries.map((e) => e.itemId));
    if (r.items.length === 0) return results.replaceChildren(h("p", { class: "muted" }, "No show matches."));
    results.replaceChildren(
      ...r.items.map((/** @type {any} */ item) => {
        const reason = onHome.has(item.id) ? "On Home" : item.playableCount === 0 ? "Not playable" : entries.length >= HOME_MAX ? "Home is full" : null;
        return h(
          "div",
          { class: "row" },
          poster(item.posterUrl),
          h(
            "div",
            { class: "grow" },
            h("strong", null, item.title),
            h("div", { class: "muted" }, [item.kind === "series" ? `Series · ${item.episodeCount} episodes` : "Film", item.year].filter(Boolean).join(" · ")),
          ),
          reason
            ? h("span", { class: "chip" }, reason)
            : h("button", { class: "primary", onclick: () => saveHome([...entries.map((e) => e.itemId), item.id], `${item.title} added to Home.`) }, "Add"),
        );
      }),
    );
  };
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let debounce;
  search.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(runSearch, 200);
  });

  // Settings ------------------------------------------------------------------------------------------------------
  const renderSettings = () => {
    const s = device.settings;
    const eff = device.effective;
    const name = h("input", { type: "text", id: "s-name", maxlength: 60, required: true, value: device.name });
    const select = (/** @type {string} */ sid, /** @type {Array<[string, string]>} */ options, /** @type {string | null} */ current) => {
      const opts = [...options];
      if (current && !opts.some(([v]) => v === current)) opts.push([current, current]);
      return h("select", { id: sid }, opts.map(([v, label]) => h("option", { value: v, selected: v === (current ?? "") }, label)));
    };
    const langs = /** @type {Array<[string, string]>} */ (LANGUAGES.map(([t, n]) => [t, `${n} (${t})`]));
    const ui = select("s-ui", [["", `Server default${s.uiLanguage ? "" : ` — ${languageLabel(eff.uiLanguage)}`}`], ["en", "English"], ["tr", "Türkçe"]], s.uiLanguage);
    const audio = select("s-audio", [["", `Server default${s.preferredAudioLanguage ? "" : ` — ${languageLabel(eff.preferredAudioLanguage, "none")}`}`], ...langs], s.preferredAudioLanguage);
    const subs = select("s-subs", [["", "Off"], ...langs], s.subtitlesLanguage);
    const save = h("button", { class: "primary", type: "submit" }, "Save settings");
    settings.replaceChildren(
      h(
        "form",
        {
          class: "form",
          onsubmit: async (/** @type {SubmitEvent} */ e) => {
            e.preventDefault();
            /** @type {Record<string, string | null>} */
            const patch = {};
            const v = (/** @type {HTMLSelectElement} */ el) => el.value || null;
            if (name.value.trim() && name.value.trim() !== device.name) patch.name = name.value.trim();
            if (v(ui) !== s.uiLanguage) patch.uiLanguage = v(ui);
            if (v(audio) !== s.preferredAudioLanguage) patch.preferredAudioLanguage = v(audio);
            if (v(subs) !== s.subtitlesLanguage) patch.subtitlesLanguage = v(subs);
            if (Object.keys(patch).length === 0) return toast("Nothing changed.", "info");
            await busy(save, async () => {
              const r = await attempt(() => api("PATCH", `/devices/${encodeURIComponent(id)}`, patch), "Settings saved. The TV applies them right away.");
              if (r) {
                await loadDevice();
                renderSettings();
              }
            });
          },
        },
        h("label", { for: "s-name" }, "Name"),
        name,
        h("label", { for: "s-ui" }, "Menu language"),
        ui,
        h("label", { for: "s-audio" }, "Preferred audio language"),
        audio,
        h("p", { class: "hint" }, "Sources with this audio language are tried first, and the player picks it when a stream has several."),
        h("label", { for: "s-subs" }, "Subtitles"),
        subs,
        h("div", { class: "actions" }, save),
      ),
    );
  };

  // Progress ------------------------------------------------------------------------------------------------------
  const refreshHistory = async () => {
    const p = await api("GET", `/devices/${encodeURIComponent(id)}/progress`);
    if (p.progress.length === 0) return history.replaceChildren(h("p", { class: "muted" }, "Nothing watched yet."));
    history.replaceChildren(
      h(
        "table",
        null,
        h("thead", null, h("tr", null, h("th", null, "Show"), h("th", null, "Episode"), h("th", null, "Where"), h("th", null, "When"))),
        h(
          "tbody",
          null,
          p.progress.slice(0, 30).map((/** @type {any} */ r) =>
            h(
              "tr",
              null,
              h("td", null, r.itemTitle ?? r.itemId),
              h("td", null, r.missing ? "(no longer in the catalog)" : episodeName({ season: r.season, number: r.number, title: r.episodeTitle }, r.kind)),
              h("td", null, r.status === "finished" ? "watched" : `${formatClock(r.positionMs)} / ${formatClock(r.durationMs)}`),
              h("td", { class: "muted" }, formatRelative(r.updatedAt)),
            ),
          ),
        ),
      ),
    );
  };

  const forget = h(
    "button",
    {
      class: "danger",
      onclick: async () => {
        if (!confirm(`Forget “${device?.name ?? "this TV"}”? It will show a new pairing code and has to be approved again. Its home screen and progress are deleted.`)) return;
        const r = await attempt(() => api("DELETE", `/devices/${encodeURIComponent(id)}`), "The TV was forgotten.");
        if (r !== undefined) location.hash = "#/devices";
      },
    },
    "Forget this TV",
  );

  void (async () => {
    try {
      await loadDevice();
    } catch {
      return;
    }
    renderHome();
    renderSettings();
    poll(async () => {
      await refreshNow();
      await listenAlong.refresh();
    }, 5000);
    poll(async () => {
      const before = JSON.stringify(entries.map((e) => [e.itemId, e.continue?.episodeId, e.continue?.status, e.continue?.positionMs]));
      await loadDevice();
      if (JSON.stringify(entries.map((e) => [e.itemId, e.continue?.episodeId, e.continue?.status, e.continue?.positionMs])) !== before) renderHome();
      await refreshHistory();
    }, 15000);
  })();

  return h(
    "div",
    { class: "page" },
    h("p", null, h("a", { href: "#/devices" }, "← TVs")),
    h("div", { class: "title" }, title, chip, seen),
    card("Now playing", now),
    listenAlong.element,
    h(
      "section",
      { class: "card" },
      h("div", { class: "card-head" }, h("h2", null, "Home screen"), counter),
      h("p", { class: "muted" }, "What the TV shows, in this order. The first four fit on the screen without scrolling."),
      homeList,
      h("h3", null, "Add shows"),
      search,
      results,
    ),
    card("Settings", settings),
    card("Recently watched", history),
    card("Remove", h("p", { class: "muted" }, "Forgetting a TV signs it out; it shows a pairing code again."), forget),
  );
}

function catalogView() {
  const info = h("div", null, loading());
  const items = h("div", { class: "list" }, loading());
  const search = h("input", { type: "search", placeholder: "Search titles", "aria-label": "Search titles" });

  const renderInfo = (/** @type {any} */ c) => {
    const reload = h(
      "button",
      {
        onclick: () =>
          busy(reload, async () => {
            try {
              const r = await api("POST", "/catalog/reload");
              toast(`Catalog reloaded: build ${r.catalog.buildId}. Every TV refreshes its home screen.`);
              renderInfo(r.catalog);
              await refreshItems();
            } catch (err) {
              if (!(err instanceof ApiError)) return toast("Something went wrong.", "error");
              if (err.code !== "invalid_catalog") return toast(errorMessage(err.code), "error");
              const issues = /** @type {any[]} */ (err.body?.issues ?? []).filter((i) => i.severity === "error");
              info.append(
                h(
                  "div",
                  { class: "callout error", role: "alert" },
                  h("strong", null, "The catalog on disk is invalid; the previous build stays active."),
                  h("ul", null, issues.slice(0, 20).map((i) => h("li", null, `${i.file}${i.path ? ` ${i.path}` : ""}: ${i.message}`))),
                ),
              );
            }
          }),
      },
      "Reload from disk",
    );
    const s = c.stats;
    info.replaceChildren(
      h(
        "dl",
        { class: "facts" },
        h("dt", null, "Name"),
        h("dd", null, c.name),
        h("dt", null, "Catalog id"),
        h("dd", null, h("code", null, c.id)),
        h("dt", null, "Build"),
        h("dd", null, h("code", null, c.buildId), h("span", { class: "muted" }, ` built ${formatRelative(c.builtAt)}, loaded ${formatRelative(c.loadedAt)}`)),
        h("dt", null, "Contents"),
        h("dd", null, `${s.items} shows (${s.movies} films, ${s.series} series) · ${s.episodes} episodes, ${s.playableEpisodes} playable · ${s.sources} sources`),
        h("dt", null, "Adapters"),
        h("dd", null, c.adapters.length ? c.adapters.join(", ") : "none"),
        h("dt", null, "Resolver module"),
        h("dd", null, c.resolver ? [`provides ${c.resolver.adapters.join(", ") || "nothing"} · `, h("code", { title: c.resolver.sha256 }, c.resolver.sha256.slice(0, 16))] : "none configured"),
        h("dt", null, "Server"),
        h("dd", null, `izle-server ${c.server.version}`),
      ),
      h(
        "details",
        { hidden: c.warnings.length === 0 },
        h("summary", null, `${c.warnings.length} warning${c.warnings.length === 1 ? "" : "s"}`),
        h("ul", null, c.warnings.map((/** @type {any} */ w) => h("li", null, `${w.file}${w.path ? ` ${w.path}` : ""}: ${w.message}`))),
      ),
      h("div", { class: "actions" }, reload),
    );
  };

  let seq = 0;
  const refreshItems = async () => {
    const mine = ++seq;
    const r = await api("GET", `/catalog/search?limit=200&q=${encodeURIComponent(search.value)}`);
    if (mine !== seq) return;
    items.replaceChildren(
      ...(r.items.length
        ? r.items.map((/** @type {any} */ item) =>
            h(
              "a",
              { class: "row link", href: `#/catalog/items/${encodeURIComponent(item.id)}` },
              poster(item.posterUrl),
              h(
                "div",
                { class: "grow" },
                h("strong", null, item.title),
                h("div", { class: "muted" }, [item.kind === "series" ? "Series" : "Film", item.year, `${item.playableCount}/${item.episodeCount} playable`].filter(Boolean).join(" · ")),
              ),
            ),
          )
        : [h("p", { class: "muted" }, "No show matches.")]),
    );
  };
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let debounce;
  search.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => void refreshItems().catch(() => {}), 200);
  });
  void (async () => {
    renderInfo(await api("GET", "/catalog"));
    await refreshItems();
  })().catch(() => {});
  return h("div", { class: "page" }, h("h1", null, "Catalog"), card("Bundle", info), card("Shows", search, items));
}

/** @param {string} itemId */
function itemView(itemId) {
  const body = h("div", null, loading());
  const title = h("h1", null, "Show");

  /** @param {any} report */
  const reportView = (report) =>
    h(
      "ul",
      { class: "diag" },
      report.sources.map((/** @type {any} */ s) => {
        const st = s.stream;
        const p = s.probe;
        const lines = [];
        if (!s.ok) lines.push(triedText(s.code, s.name));
        if (st) {
          lines.push(`${st.kind.toUpperCase()}${st.inline ? " (inline playlist)" : ""} from ${st.host ?? "?"} · ${st.delivery === "proxy" ? "through the proxy" : st.delivery === "direct" ? "direct to the TV" : "cannot be served"}`);
          if (st.headerNames.length) lines.push(`upstream headers: ${st.headerNames.join(", ")}`);
          if (st.languages) lines.push(`audio ${st.languages.audio?.join(", ") || "unknown"} · subtitles ${st.languages.subtitles?.join(", ") || "unknown"}`);
          if (st.expiresAt) lines.push(`expires ${new Date(st.expiresAt).toLocaleString()}`);
        }
        if (p) {
          const pl = p.playlist;
          lines.push(
            p.ok
              ? `probe ok (${[p.status ? `HTTP ${p.status}` : null, pl ? (pl.master ? `${plural(pl.variants, "variant")}, ${plural(pl.renditions, "rendition")}` : plural(pl.segments, "segment")) : null, `${p.ms} ms`].filter(Boolean).join(", ")})`
              : `probe failed: ${p.error ?? `HTTP ${p.status}`}${p.name ? ` (${p.name})` : ""}`,
          );
        }
        return h(
          "li",
          { class: s.ok && (!p || p.ok) ? "ok" : "bad" },
          h("strong", null, `${s.ok && (!p || p.ok) ? "✔" : "✖"} ${s.sourceId}`),
          h("span", { class: "muted" }, ` ${s.type === "adapter" ? `adapter ${s.adapterId}` : "direct"} · ${s.ms} ms`),
          h("div", null, lines.map((l) => h("div", null, l))),
        );
      }),
    );

  void (async () => {
    const { item } = await api("GET", `/catalog/items/${encodeURIComponent(itemId)}`);
    title.textContent = item.title;
    document.title = `${item.title} · izle admin`;
    body.replaceChildren(
      h(
        "div",
        { class: "row top" },
        poster(item.posterUrl, item.title),
        h(
          "div",
          { class: "grow" },
          h("div", { class: "muted" }, [item.kind === "series" ? "Series" : "Film", item.year, item.originalTitle && item.originalTitle !== item.title ? item.originalTitle : null, item.genres.join(", ")].filter(Boolean).join(" · ")),
          item.synopsis ? h("p", null, item.synopsis) : null,
          h("p", { class: "muted" }, item.autoAdvance ? "Episodes advance on their own." : "Episodes do not advance on their own."),
        ),
      ),
      h(
        "ol",
        { class: "list" },
        item.episodes.map((/** @type {any} */ e) => {
          const out = h("div");
          const test = h(
            "button",
            {
              onclick: () =>
                busy(test, async () => {
                  out.replaceChildren(h("p", { class: "muted" }, "Testing every source… (adapters may take a few seconds)"));
                  const r = await attempt(() => api("POST", "/diagnostics/resolve", { episodeId: e.id }));
                  out.replaceChildren(r ? reportView(r) : h("p", { class: "error" }, "The test could not run."));
                }),
            },
            "Test sources",
          );
          return h(
            "li",
            null,
            h(
              "div",
              { class: "row" },
              h(
                "div",
                { class: "grow" },
                h("strong", null, episodeName(e, item.kind)),
                h(
                  "div",
                  { class: "muted" },
                  [e.durationMs ? formatClock(e.durationMs) : null, e.playbackAllowed ? null : "playback not allowed", e.autoAdvance === false ? "no auto-advance after this one" : null].filter(Boolean).join(" · "),
                ),
                h(
                  "ul",
                  { class: "sources" },
                  e.sources.map((/** @type {any} */ s) =>
                    h(
                      "li",
                      null,
                      h("code", null, s.id),
                      ` ${s.type === "adapter" ? `adapter ${s.adapter}` : s.kind.toUpperCase()}${s.needsProxy ? " · proxied" : ""}${s.label ? ` · ${s.label}` : ""} · audio ${s.languages.audio === null ? "unknown" : s.languages.audio.join(", ") || "none"}`,
                    ),
                  ),
                ),
              ),
              e.sources.length ? test : null,
            ),
            out,
          );
        }),
      ),
    );
  })().catch(() => body.replaceChildren(h("p", { class: "error" }, "This show is not in the catalog.")));
  return h("div", { class: "page" }, h("p", null, h("a", { href: "#/catalog" }, "← Catalog")), title, card("Episodes", body));
}

// --- start --------------------------------------------------------------------------------------------------------

/** @type {HTMLButtonElement} */ (document.getElementById("signout")).addEventListener("click", () => signOut());
window.addEventListener("hashchange", () => void route());
void route();
