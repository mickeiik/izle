// @ts-check
// A TV's page: now playing with the remote control and a message, the home screen (device-home.js), settings,
// Listen along (companion.js), history and problems, under a sticky section nav. Each section is a component
// returning its element and what refreshes it; the view loads the TV once, then polls: what it plays every 5 s,
// the rest every 15 s. Controls are built once and only enabled, disabled and relabelled, so polling never takes
// the keyboard focus away.

import { ApiError, api, attempt, devicePath } from "./api.js";
import { companionCard } from "./companion.js";
import { homeCard } from "./device-home.js";
import { actionButton, card, chip, h, keepFocus, onSubmit, page, progressBar, setChip, setOff, setProgress, setTitle, slot, statusChip, toast } from "./dom.js";
import {
  LANGUAGES,
  canControlPlayback,
  episodeName,
  errorText,
  formatClock,
  formatRelative,
  languageLabel,
  originLabel,
  percent,
  playbackState,
  problemContext,
} from "./lib.js";

/**
 * What the sections of a TV's page share.
 * @typedef {object} DeviceContext
 * @property {string} path `/devices/<id>`
 * @property {import("./router.js").Scope} scope
 * @property {(body: any, what: string) => Promise<boolean>} send sends a command; whether the server took it
 * @property {() => Promise<void>} reload re-reads the TV and its home screen and shows them
 */

/**
 * A section of a TV's page that the page polls: `refresh` re-reads and shows its data, `fail` shows a first load
 * that failed (with Retry).
 * @typedef {object} Section
 * @property {HTMLElement} element
 * @property {() => Promise<void>} refresh
 * @property {import("./router.js").OnError} fail
 */

/**
 * @param {import("./router.js").Scope} scope
 * @param {string} id
 */
export function deviceView(scope, id) {
  const path = devicePath(id);
  const title = h("h1", null, "TV");
  const chipBox = h("span");
  const seen = h("span", { class: "muted" });
  /** @type {any} */
  let device = null;

  /** @type {DeviceContext} */
  const ctx = {
    path,
    scope,
    async send(body, what) {
      const r = await attempt(() => api("POST", `${path}/commands`, body));
      if (r.ok) toast(r.value.online ? `${what} sent to the TV.` : `${what} queued: the TV is offline and gets it if it connects within 2 minutes.`, r.value.online ? "ok" : "info");
      return r.ok;
    },
    reload: () => loadDevice(),
  };

  const now = nowPlayingCard(ctx);
  const home = homeCard(ctx);
  const settings = settingsCard(ctx);
  // "Listen along": the owner's phone plays another source of what the TV plays, in sync (companion.js).
  const listenAlong = companionCard({ deviceId: id, signal: scope.signal });
  scope.onCleanup(() => listenAlong.stop());
  const history = historyCard(ctx);
  const problems = problemsCard(ctx);
  /** @type {Array<[string, HTMLElement]>} */
  const sections = [
    ["Now playing", now.element],
    ["Home screen", home.element],
    ["Settings", settings.element],
    ["Listen along", listenAlong.element],
    ["History", history.element],
    ["Problems", problems.element],
  ];
  sections.forEach(([label, el]) => (el.id = `sec-${label.toLowerCase().replace(/\s+/g, "-")}`));
  const nav = sectionNav(scope, sections);
  const top = h("div", { class: "sticky", hidden: true }, nav.element, scope.note);
  const body = slot();

  const loadDevice = async () => {
    let d;
    try {
      d = await scope.read(path);
    } catch (err) {
      if (err instanceof ApiError && err.code === "unknown_device" && scope.alive()) {
        toast(errorText(err), "info");
        scope.go("#/devices");
      }
      throw err;
    }
    device = d.device;
    setTitle(title, device.name);
    chipBox.replaceChildren(statusChip(device));
    seen.textContent = device.status === "active" ? `last seen ${formatRelative(device.lastSeenAt)}` : "approved, waiting for the TV to collect its token";
    now.setDevice(device);
    home.update(d.home);
  };

  // The TV first; once it is there, the sections and their polls.
  let started = false;
  scope.load(
    async () => {
      await loadDevice();
      if (started) return;
      started = true;
      settings.update(device);
      body.show(...sections.map(([, el]) => el), removeCard(ctx, () => device));
      top.hidden = false;
      nav.update();
      scope.poll(now.refresh, 5000, now.fail);
      scope.poll(listenAlong.refresh, 5000, listenAlong.fail);
      scope.poll(loadDevice, 15000);
      scope.poll(history.refresh, 15000, history.fail);
      scope.poll(problems.refresh, 15000, problems.fail);
    },
    (err, retry) => body.fail(err, retry, "Could not load this TV."),
  );

  return page({ back: ["#/devices", "← TVs"], title, aside: [chipBox, seen] }, top, body.element);
}

// --- section nav ---------------------------------------------------------------------------------------------

/**
 * Buttons that scroll to the page's sections (and move the focus to their heading); the section in view is marked
 * with `aria-current` (`update()` marks it now: the page calls it once the sections are shown). Buttons, not
 * `#anchor` links: a hash change would re-run the router.
 * @param {import("./router.js").Scope} scope
 * @param {Array<[string, HTMLElement]>} sections
 */
function sectionNav(scope, sections) {
  const buttons = sections.map(([label, section]) =>
    h(
      "button",
      {
        type: "button",
        onclick: () => {
          const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;
          section.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
          section.querySelector("h2")?.focus({ preventScroll: true });
        },
      },
      label,
    ),
  );
  const nav = h("nav", { class: "sections-nav", "aria-label": "Sections of this page" }, buttons);
  let current = -1;
  let queued = false;
  const mark = () => {
    queued = false;
    if (!nav.isConnected || nav.closest("[hidden]")) return;
    const line = nav.getBoundingClientRect().bottom + 32;
    // The last section whose top passed under the bar; at the bottom of the page, where the last sections never
    // reach the bar, the last one in view (if any is).
    let at = 0;
    let inView = -1;
    sections.forEach(([, s], i) => {
      const top = s.getBoundingClientRect().top;
      if (top <= line) at = i;
      if (top < window.innerHeight) inView = i;
    });
    if (inView >= 0 && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) at = inView;
    if (at === current) return;
    current = at;
    buttons.forEach((b, i) => (i === at ? b.setAttribute("aria-current", "true") : b.removeAttribute("aria-current")));
    const b = buttons[at];
    // Keep the marked button in view when the nav scrolls sideways (phones).
    if (b && (b.offsetLeft < nav.scrollLeft || b.offsetLeft + b.offsetWidth > nav.scrollLeft + nav.clientWidth)) nav.scrollLeft = b.offsetLeft - 16;
  };
  const onScroll = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(mark);
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);
  scope.onCleanup(() => {
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", onScroll);
  });
  return { element: nav, update: onScroll };
}

// --- now playing -----------------------------------------------------------------------------------------------

/**
 * The remote control's buttons: the label, the accessible name and what the toast calls it where they are not the
 * label, and the command.
 * @type {Array<{ label: string, name?: string, what?: string, command: any }>}
 */
const REMOTE = [
  { label: "Pause", command: { type: "pause" } },
  { label: "Resume", command: { type: "resume" } },
  { label: "−30 s", name: "Back 30 seconds", what: "Back 30 s", command: { type: "seek", deltaMs: -30_000 } },
  { label: "+30 s", name: "Forward 30 seconds", what: "Forward 30 s", command: { type: "seek", deltaMs: 30_000 } },
  { label: "Previous episode", command: { type: "previous" } },
  { label: "Next episode", command: { type: "next" } },
];

/**
 * What the TV plays, the remote control (Stop with it) and the message box. Built once: the poll only fills in
 * text and enables or disables the buttons, so a half-typed message and the focus survive it.
 * @param {DeviceContext} ctx
 * @returns {Section & { setDevice(device: any): void }}
 */
function nowPlayingCard(ctx) {
  const state = chip("");
  const when = h("span", { class: "muted" });
  const title = h("strong");
  const episode = h("div");
  const time = h("div", { class: "muted" });
  const bar = /** @type {HTMLElement} */ (progressBar(0, "Position"));
  const info = h("div", { class: "now" }, h("div", { class: "now-state" }, state, when), title, episode, time, bar);
  const nothing = h("p", { class: "muted" }, "Nothing played yet.");
  const shown = slot();

  /** Sends a command; the TV reports its new state right away, so the card looks again 1.5 s later. */
  const command = async (/** @type {any} */ body, /** @type {string} */ what) => {
    if (await ctx.send(body, what)) ctx.scope.later(() => void refresh().catch(() => {}), 1500);
  };
  const remote = REMOTE.map((r) => actionButton(r.label, r.name ? { "aria-label": r.name } : null, () => command(r.command, r.what ?? r.label)));
  const stop = actionButton("Stop", { class: "danger" }, () => command({ type: "stop" }, "Stop"));
  const controls = h("div", { class: "buttons remote", role: "group", "aria-label": "Remote control", hidden: true }, remote, stop);
  for (const b of [...remote, stop]) setOff(b, true);

  const messageText = h("input", { type: "text", id: "m-text", maxlength: 200, autocomplete: "off", placeholder: "e.g. Dinner is ready!", "aria-describedby": "m-hint" });
  const messageSend = h("button", { type: "submit", class: "primary" }, "Send");
  setOff(messageSend, true);
  const messageForm = h(
    "form",
    { class: "message" },
    h("label", { for: "m-text" }, "Message to the TV"),
    h("div", { class: "row" }, messageText, messageSend),
    h("p", { class: "hint", id: "m-hint" }, "Shown in large letters for 15 seconds, on the home screen or over the picture."),
  );
  onSubmit(messageForm, messageSend, () => {
    const text = messageText.value.trim();
    if (!text) return toast("Type a message first.", "info");
    return async () => {
      if (await ctx.send({ type: "message", text }, "Message")) messageText.value = "";
    };
  });

  const refresh = async () => {
    const r = await ctx.scope.read(`${ctx.path}/now`);
    const n = r.nowPlaying;
    controls.hidden = !n;
    if (!n) return shown.show(nothing);
    const s = playbackState(n, r.online);
    setChip(state, s.label, s.tone);
    when.textContent = s.active ? "" : formatRelative(n.updatedAt);
    title.textContent = n.itemTitle ?? n.itemId;
    episode.textContent = n.episodeTitle ?? "";
    episode.hidden = !n.episodeTitle;
    time.textContent = `${formatClock(n.positionMs)} / ${formatClock(n.durationMs)}${n.sourceId ? ` · source ${n.sourceId}` : ""}`;
    const pct = percent(n.positionMs, n.durationMs);
    bar.hidden = pct === null;
    if (pct !== null) setProgress(bar, pct, `${formatClock(n.positionMs)} of ${formatClock(n.durationMs)}`);
    for (const b of remote) setOff(b, !canControlPlayback(n));
    setOff(stop, !s.active);
    shown.show(info);
  };

  return {
    element: card("Now playing", shown.element, controls, messageForm),
    refresh,
    fail: (err, retry) => shown.fail(err, retry, "Could not load what the TV plays."),
    setDevice: (device) => setOff(messageSend, device.status !== "active"),
  };
}

// --- settings --------------------------------------------------------------------------------------------------

/**
 * Name, languages and subtitles (saved together with "Save settings") and autoplay (saved on its own, at once).
 * The form is filled when the page loads and after a save, never by the poll, so edits in progress stay.
 * @param {DeviceContext} ctx
 */
function settingsCard(ctx) {
  /** @type {any} */
  let device = null;
  const name = h("input", { type: "text", id: "s-name", maxlength: 60, required: true });
  const ui = h("select", { id: "s-ui" });
  const audio = h("select", { id: "s-audio", "aria-describedby": "s-audio-hint" });
  const subs = h("select", { id: "s-subs" });
  const save = h("button", { class: "primary", type: "submit" }, "Save settings");
  const autoplay = h("input", { type: "checkbox", id: "s-autoplay", "aria-describedby": "s-autoplay-hint" });

  /** @param {HTMLSelectElement} select @param {Array<[string, string]>} options @param {string | null} current */
  const fillSelect = (select, options, current) => {
    const opts = [...options];
    if (current && !opts.some(([v]) => v === current)) opts.push([current, current]);
    select.replaceChildren(...opts.map(([v, label]) => h("option", { value: v, selected: v === (current ?? "") }, label)));
  };
  const langs = /** @type {Array<[string, string]>} */ (LANGUAGES.map(([t, n]) => [t, `${n} (${t})`]));

  /** @param {any} d */
  const update = (d) => {
    device = d;
    const s = d.settings;
    const eff = d.effective;
    name.value = d.name;
    fillSelect(ui, [["", `Server default${s.uiLanguage ? "" : ` — ${languageLabel(eff.uiLanguage)}`}`], ["en", "English"], ["tr", "Türkçe"]], s.uiLanguage);
    fillSelect(audio, [["", `Server default${s.preferredAudioLanguage ? "" : ` — ${languageLabel(eff.preferredAudioLanguage, "none")}`}`], ...langs], s.preferredAudioLanguage);
    fillSelect(subs, [["", "Off"], ...langs], s.subtitlesLanguage);
    autoplay.checked = Boolean(s.autoplayOnStart);
  };

  /** Autoplay is saved at once. A second click while the first is saving is undone: one request at a time. */
  const saveAutoplay = () => {
    if (autoplay.getAttribute("aria-busy") === "true") {
      autoplay.checked = !autoplay.checked;
      return;
    }
    const on = autoplay.checked;
    autoplay.setAttribute("aria-busy", "true");
    void attempt(
      () => api("PATCH", ctx.path, { autoplayOnStart: on }),
      on ? "Autoplay is on: it starts the next time the app opens on the TV." : "Autoplay is off.",
    ).then((r) => {
      autoplay.removeAttribute("aria-busy");
      if (r.ok) device = r.value.device;
      else autoplay.checked = !on;
    });
  };
  autoplay.addEventListener("change", saveAutoplay);

  /** "Save settings": what differs from the TV's settings is saved in one request. */
  const submit = () => {
    if (!device) return;
    const s = device.settings;
    /** @type {Record<string, string | null>} */
    const patch = {};
    const typed = name.value.trim();
    if (typed && typed !== device.name) patch.name = typed;
    for (const [key, select] of /** @type {const} */ ([["uiLanguage", ui], ["preferredAudioLanguage", audio], ["subtitlesLanguage", subs]])) {
      const value = select.value || null;
      if (value !== s[key]) patch[key] = value;
    }
    if (Object.keys(patch).length === 0) return toast("Nothing changed.", "info");
    return async () => {
      const r = await attempt(() => api("PATCH", ctx.path, patch), "Settings saved. The TV applies them right away.");
      if (!r.ok) return;
      update(r.value.device);
      await ctx.reload().catch(() => {});
    };
  };

  const form = h(
    "form",
    { class: "form" },
    h("label", { for: "s-name" }, "Name"),
    name,
    h("label", { for: "s-ui" }, "Menu language"),
    ui,
    h("label", { for: "s-audio" }, "Preferred audio language"),
    audio,
    h("p", { class: "hint", id: "s-audio-hint" }, "Sources with this audio language are tried first, and the player picks it when a stream has several."),
    h("label", { for: "s-subs" }, "Subtitles"),
    subs,
    h("div", { class: "actions" }, save),
  );
  onSubmit(form, save, submit);
  const toggle = h(
    "div",
    { class: "toggle" },
    h("label", { class: "check", for: "s-autoplay" }, autoplay, "Autoplay when the TV starts"),
    h("p", { class: "hint", id: "s-autoplay-hint" }, "When the app opens, the show the viewer watched last (else the first tile) starts after a 10-second countdown. Any key stops the countdown."),
  );
  return { element: card("Settings", form, toggle), update };
}

// --- history ---------------------------------------------------------------------------------------------------

/**
 * @param {DeviceContext} ctx
 * @returns {Section}
 */
function historyCard(ctx) {
  const shown = slot();
  const list = rebuiltOnChange();
  const refresh = async () => {
    const p = await ctx.scope.read(`${ctx.path}/progress`);
    const rows = p.progress.slice(0, 30);
    shown.show(
      list.content(rows, (time) =>
        rows.length === 0
          ? h("p", { class: "muted" }, "Nothing watched yet.")
          : h(
              "div",
              { class: "table-wrap", tabindex: "0", role: "region", "aria-label": "History" },
              h(
                "table",
                null,
                h("caption", null, "The last 30 episodes this TV played, the latest first."),
                h("thead", null, h("tr", null, h("th", { scope: "col" }, "Show"), h("th", { scope: "col" }, "Episode"), h("th", { scope: "col" }, "Where"), h("th", { scope: "col" }, "When"))),
                h(
                  "tbody",
                  null,
                  rows.map((/** @type {any} */ r) =>
                    h(
                      "tr",
                      null,
                      h("td", null, r.itemTitle ?? r.itemId),
                      h("td", null, r.missing ? "(no longer in the catalog)" : episodeName({ season: r.season, number: r.number, title: r.episodeTitle }, r.kind)),
                      h("td", null, r.status === "finished" ? "watched" : `${formatClock(r.positionMs)} / ${formatClock(r.durationMs)}`),
                      time(h("td", { class: "muted" }), () => formatRelative(r.updatedAt)),
                    ),
                  ),
                ),
              ),
            ),
      ),
    );
  };
  return {
    element: card("History", shown.element),
    refresh,
    fail: (err, retry) => shown.fail(err, retry, "Could not load the history."),
  };
}

// --- problems --------------------------------------------------------------------------------------------------

/**
 * @param {DeviceContext} ctx
 * @returns {Section}
 */
function problemsCard(ctx) {
  const shown = slot();
  const list = rebuiltOnChange();
  const clear = actionButton("Clear", { class: "danger", hidden: true, "aria-label": "Clear the problems" }, async () => {
    const r = await attempt(() => api("DELETE", `${ctx.path}/problems`), "Problems cleared.");
    // The button goes with the list: the focus moves to the card's heading.
    if (r.ok) await keepFocus(() => refresh().catch(() => {}), element.querySelector("h2"));
  });
  const refresh = async () => {
    const r = await ctx.scope.read(`${ctx.path}/problems?limit=50`);
    clear.hidden = r.problems.length === 0;
    shown.show(
      list.content(r.problems, (time) =>
        r.problems.length === 0
          ? h("p", { class: "muted" }, "No problems recorded.")
          : h(
              "ul",
              { class: "list problems" },
              r.problems.map((/** @type {any} */ p) => {
                const context = problemContext(p);
                const at = new Date(p.at);
                return h(
                  "li",
                  null,
                  h(
                    "div",
                    { class: "row" },
                    chip(originLabel(p.origin), p.origin === "server" ? "server" : ""),
                    h("strong", { class: "grow" }, `${p.kind} · ${p.code}`),
                    time(h("time", { class: "muted", datetime: p.at }), () => `${formatRelative(p.at)} · ${at.toLocaleString([], { dateStyle: "short", timeStyle: "short" })}`),
                  ),
                  context ? h("div", null, context) : null,
                  p.detail ? h("div", { class: "muted detail" }, p.detail) : null,
                );
              }),
            ),
      ),
    );
  };
  const element = card(
    { title: "Problems", aside: clear, intro: "What went wrong on this TV: its own reports, and what the server ran into while finding or relaying its streams." },
    shown.element,
  );
  return {
    element,
    refresh,
    fail: (err, retry) => shown.fail(err, retry, "Could not load the problems."),
  };
}

/**
 * A list rebuilt only when its data changed. `content(data, build)` returns the content built for equal data again,
 * as it is (nothing in it loses the focus), with only its relative times ("5 min ago") moved on; otherwise `build`
 * makes it anew, registering each element that shows a relative time with `time(el, text)`.
 */
function rebuiltOnChange() {
  let key = "";
  /** @type {HTMLElement | null} */
  let content = null;
  /** @type {Array<[HTMLElement, () => string]>} */
  let times = [];
  /** @template {HTMLElement} E @param {E} el @param {() => string} text @returns {E} */
  const time = (el, text) => {
    el.textContent = text();
    times.push([el, text]);
    return el;
  };
  return {
    /** @param {unknown} data @param {(t: typeof time) => HTMLElement} build */
    content(data, build) {
      const k = JSON.stringify(data);
      if (content && k === key) {
        for (const [el, text] of times) {
          const t = text();
          if (el.textContent !== t) el.textContent = t;
        }
        return content;
      }
      key = k;
      times = [];
      content = build(time);
      return content;
    },
  };
}

// --- remove ----------------------------------------------------------------------------------------------------

/** @param {DeviceContext} ctx @param {() => any} device */
function removeCard(ctx, device) {
  const forget = actionButton("Forget this TV", { class: "danger" }, async () => {
    const name = device()?.name ?? "this TV";
    if (!confirm(`Forget “${name}”? It will show a new pairing code and has to be approved again. Its home screen and progress are deleted.`)) return;
    const r = await attempt(() => api("DELETE", ctx.path), "The TV was forgotten.");
    if (r.ok) ctx.scope.go("#/devices");
  });
  return card({ title: "Remove", intro: "Forgetting a TV signs it out; it shows a pairing code again." }, h("div", { class: "actions" }, forget));
}
