// @ts-check
// A TV's page under sticky tabs, the tab kept in the address (`#/devices/<id>/<tab>`). The view loads the TV once,
// then polls every tab, shown or not: what it plays every 5 s, the rest every 15 s. Controls are built once and only
// enabled, disabled and relabelled, so polling never takes the keyboard focus away.

import { ApiError, api, attempt, devicePath } from "./api.js";
import { companionCard } from "./companion.js";
import { homeCard } from "./device-home.js";
import { actionButton, card, chip, h, keepFocus, onSubmit, page, progressBar, setChip, setOff, setProgress, setTitle, slot, statusChip, tabs, toast } from "./dom.js";
import { watchEvents } from "./events.js";
import {
  LANGUAGES, androidText, appUpdateChip, capabilityText, commandResultText, episodeName, errorText,
  formatClock, formatDuration, formatRelative, installNowBlocked, languageLabel, nowPlayingLine, percent,
  playbackState, problemContext, triggerLabel, viewingEnd, viewingSpan,
} from "./lib.js";

/**
 * What the sections of a TV's page share: the TV's `id` and API `path`; `send` sends a command and resolves with whether the server took it,
 * `reload` re-reads the TV and its home screen and shows them.
 * @typedef {{ id: string, path: string, scope: import("./router.js").Scope, send: (body: any, what: string) => Promise<boolean>,
 *   reload: () => Promise<void> }} DeviceContext
 */

/**
 * A section that the page polls: `refresh` re-reads and shows its data, `fail` shows a first load that failed.
 * @typedef {{ element: HTMLElement, refresh: () => Promise<void>, fail: import("./router.js").OnError }} Section
 */

/** The tabs of a TV's page, in order: the key in the address and the label. */
const TABS = /** @type {const} */ ([["now", "Now playing"], ["home", "Home screen"], ["listen", "Listen along"], ["history", "History"],
  ["settings", "Settings"], ["problems", "Problems"]]);

/** @param {import("./router.js").Scope} scope @param {string} id @param {string} [tab] the tab in the address */
export function deviceView(scope, id, tab) {
  const path = devicePath(id);
  const title = h("h1", null, "TV");
  const chipBox = h("span");
  const seen = h("span", { class: "muted" });
  /** @type {any} */
  let device = null;

  /** @type {DeviceContext} */
  const ctx = {
    id,
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
  const tvApp = appCard(ctx);
  const listenAlong = companionCard({ deviceId: id, signal: scope.signal });
  scope.onCleanup(() => listenAlong.stop());
  const viewings = historyCard(ctx);
  const problems = problemsCard(ctx, (count) => tabBar.setBadge("problems", count));
  /** @type {Record<typeof TABS[number][0], HTMLElement[]>} */
  const content = {
    now: [now.element],
    home: [home.element],
    listen: [listenAlong.element],
    history: [viewings.element],
    settings: [tvApp.element, settings.element, removeCard(ctx, () => device)],
    problems: [problems.element],
  };
  // The tab is kept in the address without a navigation (which would render the page again); Back leaves the page.
  // Scrolled down past the tabs, a new tab starts at its top.
  const tabBar = tabs({
    label: "Sections of this page",
    tabs: TABS.map(([key, label]) => ({ key, label, content: content[key] })),
    selected: tab ?? "now",
    onSelect: (key) => {
      history.replaceState(null, "", `#/devices/${encodeURIComponent(id)}/${key}`);
      const gap = parseFloat(getComputedStyle(top).marginBottom) || 0;
      const under = body.element.getBoundingClientRect().top - top.getBoundingClientRect().bottom - gap;
      if (under < 0) window.scrollBy(0, under);
    },
  });
  const top = h("div", { class: "sticky", hidden: true }, scope.note, tabBar.list);
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
    tvApp.setDevice(device);
    home.update(d.home, device);
  };

  // The TV first; once it is there, the tabs and their polls.
  let started = false;
  scope.load(
    async () => {
      await loadDevice();
      if (started) return;
      started = true;
      settings.update(device);
      body.show(...tabBar.panels);
      top.hidden = false;
      const nowJob = scope.poll(now.refresh, 5000, now.fail);
      scope.poll(listenAlong.refresh, 5000, listenAlong.fail);
      const deviceJob = scope.poll(loadDevice, 15000);
      const historyJob = scope.poll(viewings.refresh, 15000, viewings.fail);
      const problemsJob = scope.poll(problems.refresh, 15000, problems.fail);
      scope.poll(tvApp.refresh, 30_000, tvApp.fail);
      // The polls stay as the fallback; the event stream makes the page follow the TV as things happen.
      watchEvents(scope, { devices: [id] }, (e) => {
        const type = /** @type {string} */ (e.type);
        if (type === "gap" || type.startsWith("device.") || type.startsWith("catalog.")) void deviceJob.now();
        if (type === "gap" || type.startsWith("playback.") || type.startsWith("command.")) void nowJob.now();
        if (type === "home.changed" || type === "cursor.changed") void deviceJob.now();
        if (type === "gap" || type.startsWith("playback.") || type === "episode.seen" || type === "history.changed") void historyJob.now();
        if (type === "gap" || type === "problem.recorded") void problemsJob.now();
        if (type === "command.result") toast(commandResultText(e.data), e.data.result === "done" ? "ok" : "info");
      });
    },
    (err, retry) => body.fail(err, retry, "Could not load this TV."),
  );

  return page({ back: ["#/devices", "← TVs"], title, aside: [chipBox, seen] }, top, body.element);
}

/**
 * The remote control's buttons: the label, the accessible name and the toast's name where they differ from it. While
 * a channel plays, `episodic` ones are unavailable (a channel is never paused or seeked) and `liveLabel` replaces the
 * label (Previous and Next switch between the channels of the TV's home screen).
 * @type {Array<{ label: string, name?: string, what?: string, episodic?: boolean, liveLabel?: string, command: any }>}
 */
const REMOTE = [
  { label: "Pause", episodic: true, command: { type: "pause" } },
  { label: "Resume", episodic: true, command: { type: "resume" } },
  { label: "−30 s", name: "Back 30 seconds", what: "Back 30 s", episodic: true, command: { type: "seek", deltaMs: -30_000 } },
  { label: "+30 s", name: "Forward 30 seconds", what: "Forward 30 s", episodic: true, command: { type: "seek", deltaMs: 30_000 } },
  { label: "Previous episode", liveLabel: "Previous channel", command: { type: "previous" } },
  { label: "Next episode", liveLabel: "Next channel", command: { type: "next" } },
];

/**
 * What the TV plays, the remote control and the message box. The poll only fills in text and enables or disables
 * the buttons, so a half-typed message and the focus survive it. A channel shows "Live" and when its viewing
 * started instead of a position.
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
  /** Whether the last report is a channel's: the remote's labels and buttons follow it. */
  let live = false;
  const remote = REMOTE.map((r) => actionButton(r.label, r.name ? { "aria-label": r.name } : null, () => command(r.command, live && r.liveLabel ? r.liveLabel : (r.what ?? r.label))));
  const stop = actionButton("Stop", { class: "danger" }, () => command({ type: "stop" }, "Stop"));
  const liveHint = h("p", { class: "hint", id: "remote-live-hint", hidden: true }, "A channel plays live: it cannot be paused or seeked. Previous and Next switch to the channel before or after it on the TV's home screen.");
  const controls = h("div", { class: "buttons remote", role: "group", "aria-label": "Remote control", hidden: true }, remote, stop);
  for (const b of [...remote, stop]) setOff(b, true);
  /** When the running viewing started, read once per viewing (a channel's line shows it); null when unknown. */
  let started = /** @type {{ viewingId: number, startedAt: string } | null} */ (null);
  const startOf = async (/** @type {number | null} */ viewingId) => {
    if (viewingId === null || viewingId === undefined) return null;
    if (started?.viewingId !== viewingId) {
      const r = await ctx.scope.read(`/history/viewings/${viewingId}`).catch(() => null);
      if (!r?.viewing?.startedAt) return null; // read again on the next refresh
      started = { viewingId, startedAt: r.viewing.startedAt };
    }
    return started.startedAt;
  };

  const messageText = h("input", { type: "text", id: "m-text", maxlength: 200, autocomplete: "off", placeholder: "e.g. Dinner is ready!", "aria-describedby": "m-hint" });
  const messageSend = h("button", { type: "submit", class: "primary" }, "Send");
  setOff(messageSend, true);
  const messageHint = h("p", { class: "hint", id: "m-hint" }, "Shown in large letters for 15 seconds, on the home screen or over the picture.");
  const messageForm = h("form", { class: "message" }, h("label", { for: "m-text" }, "Message to the TV"), h("div", { class: "row" }, messageText, messageSend), messageHint);
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
    if (!n) {
      liveHint.hidden = true;
      return shown.show(nothing);
    }
    live = n.itemKind === "live";
    const startedAt = live ? await startOf(n.viewingId) : null;
    const s = playbackState(n, r.online);
    setChip(state, s.label, s.tone);
    when.textContent = s.active ? "" : formatRelative(n.updatedAt);
    title.textContent = n.itemTitle ?? n.itemId;
    episode.textContent = n.episodeTitle ?? "";
    episode.hidden = !n.episodeTitle;
    const line = nowPlayingLine(n, startedAt);
    // "Live since 14:05 · source main", or "Live · source main" once the viewing ended.
    if (live) time.replaceChildren(chip("Live", "live"), line ? (startedAt ? ` ${line}` : ` · ${line}`) : "");
    else time.textContent = line;
    const pct = live ? null : percent(n.positionMs, n.durationMs);
    bar.hidden = pct === null;
    if (pct !== null) setProgress(bar, pct, `${formatClock(n.positionMs)} of ${formatClock(n.durationMs)}`);
    // The remote control applies while the TV's last report says it is in the player, playing or paused; a channel
    // is never paused or seeked.
    const inPlayer = n.state === "playing" || n.state === "paused";
    REMOTE.forEach((def, i) => {
      const b = /** @type {HTMLButtonElement} */ (remote[i]);
      const label = live && def.liveLabel ? def.liveLabel : def.label;
      if (b.textContent !== label) b.textContent = label;
      setOff(b, !inPlayer || (live && Boolean(def.episodic)));
      if (live && inPlayer && def.episodic) b.setAttribute("aria-describedby", liveHint.id);
      else b.removeAttribute("aria-describedby");
    });
    liveHint.hidden = !(live && inPlayer);
    setOff(stop, !s.active);
    shown.show(info);
  };

  return {
    element: card("Now playing", shown.element, controls, liveHint, messageForm),
    refresh,
    fail: (err, retry) => shown.fail(err, retry, "Could not load what the TV plays."),
    setDevice: (device) => setOff(messageSend, device.status !== "active"),
  };
}

/**
 * Name, languages and subtitles (saved together with "Save settings") and autoplay (saved on its own, at once). The
 * form is filled when the page loads and after a save, never by the poll, so edits in progress stay. The home grid's
 * size is set on the Home screen tab, next to its preview.
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
    if (current && !options.some(([v]) => v === current)) options.push([current, current]);
    select.replaceChildren(...options.map(([v, text]) => h("option", { value: v, selected: v === (current ?? "") }, text)));
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

  // Autoplay is saved at once. A second click while the first is saving is undone: one request at a time.
  autoplay.addEventListener("change", () => {
    if (autoplay.getAttribute("aria-busy") === "true") {
      autoplay.checked = !autoplay.checked;
      return;
    }
    const on = autoplay.checked;
    autoplay.setAttribute("aria-busy", "true");
    const done = on ? "Autoplay is on: it starts the next time the app opens on the TV." : "Autoplay is off.";
    void attempt(() => api("PATCH", ctx.path, { autoplayOnStart: on }), done).then((r) => {
      autoplay.removeAttribute("aria-busy");
      if (r.ok) device = r.value.device;
      else autoplay.checked = !on;
    });
  });

  const field = (/** @type {HTMLElement} */ control, /** @type {string} */ text) => [h("label", { for: control.id }, text), control];
  const audioHint = h("p", { class: "hint", id: "s-audio-hint" }, "Sources with this audio language are tried first, and the player picks it when a stream has several.");
  const form = h("form", { class: "form" }, field(name, "Name"), field(ui, "Menu language"), field(audio, "Preferred audio language"), audioHint, field(subs, "Subtitles"),
    h("div", { class: "actions" }, save));
  // "Save settings": what differs from the TV's settings is saved in one request.
  onSubmit(form, save, () => {
    if (!device) return;
    /** @type {Record<string, string | null>} */
    const patch = {};
    const typed = name.value.trim();
    if (typed && typed !== device.name) patch.name = typed;
    for (const [key, select] of /** @type {const} */ ([["uiLanguage", ui], ["preferredAudioLanguage", audio], ["subtitlesLanguage", subs]])) {
      const value = select.value || null;
      if (value !== device.settings[key]) patch[key] = value;
    }
    if (Object.keys(patch).length === 0) return toast("Nothing changed.", "info");
    return async () => {
      const r = await attempt(() => api("PATCH", ctx.path, patch), "Settings saved. The TV applies them right away.");
      if (!r.ok) return;
      update(r.value.device);
      await ctx.reload().catch(() => {});
    };
  });
  const autoplayHint = h("p", { class: "hint", id: "s-autoplay-hint" }, "When the app opens, the show the viewer watched last (else the first tile) starts after a 10-second countdown. Any key stops the countdown.");
  const toggle = h("div", { class: "toggle" }, h("label", { class: "check", for: "s-autoplay" }, autoplay, "Autoplay when the TV starts"), autoplayHint);
  return { element: card("Settings", form, toggle), update };
}

/**
 * The TV's app: its installed version, its Android version, how it takes updates, and "Install now" (the same rules
 * as on the TV app page). It reads whether the server stores an APK on its own poll; the TV comes with the page's.
 * @param {DeviceContext} ctx
 * @returns {Section & { setDevice(device: any): void }}
 */
function appCard(ctx) {
  /** @type {any} */
  let device = null;
  /** Whether the server stores an APK; null before it was read; "unsupported" on a server without TV app updates. */
  let stored = /** @type {boolean | null | "unsupported"} */ (null);
  /** The server's `appUpdates.auto`; on until it was read. */
  let auto = true;
  const version = h("dd");
  const android = h("dd");
  const how = h("dd");
  const state = chip("");
  const facts = h("dl", { class: "facts" }, h("dt", null, "Installed"), version, h("dt", null, "Android"), android,
    h("dt", null, "Updates"), how, h("dt", null, "State"), h("dd", null, state));
  const why = h("p", { class: "hint", id: "app-install-why" });
  const guided = h("p", { class: "hint", hidden: true }, "Someone at the TV has to press OK when the screen appears.");
  const install = actionButton("Install now", { "aria-describedby": "app-install-why" }, () => ctx.send({ type: "update" }, "Install now"));
  setOff(install, true);

  const show = () => {
    if (!device) return;
    const a = device.app;
    version.textContent = a?.version ? `${a.version}${a.versionCode !== null && a.versionCode !== undefined ? ` (code ${a.versionCode})` : ""}` : "unknown";
    android.textContent = androidText(a?.androidSdk);
    how.textContent = capabilityText(a, auto);
    const c = appUpdateChip(a);
    setChip(state, c.text, c.tone);
    guided.hidden = a?.capability !== "guided";
    const blocked = stored === null ? "Looking for the server's TV app…" : stored === "unsupported" ? "This server has no TV app updates." : installNowBlocked(device, stored);
    setOff(install, blocked !== null);
    why.textContent = blocked ?? "Asks the TV to update now.";
  };

  const refresh = async () => {
    try {
      const app = await ctx.scope.read("/app");
      stored = Boolean(app.apk);
      auto = app.auto !== false;
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) throw err;
      stored = "unsupported";
    }
    show();
  };
  const link = h("a", { href: "#/app" }, "TV app page");
  return {
    element: card({ title: "TV app", aside: link }, facts, h("div", { class: "actions" }, install), why, guided),
    refresh,
    fail: () => {
      if (stored === null) why.textContent = "Could not read the server's TV app.";
    },
    setDevice(d) {
      device = d;
      show();
    },
  };
}

/**
 * The TV's viewings: what it played, who started it, how much was watched and how each ended. A channel's viewing
 * has no episode or position: it ends with when it ran.
 * @param {DeviceContext} ctx @returns {Section}
 */
function historyCard(ctx) {
  const shown = slot();
  const list = rebuiltOnChange();
  const refresh = async () => {
    const id = ctx.path.slice("/devices/".length);
    const { viewings } = await ctx.scope.read(`/history/viewings?device=${id}&limit=30`);
    const content = list.content(viewings, (time) => {
      if (viewings.length === 0) return h("p", { class: "muted" }, "Nothing watched yet.");
      const tr = (/** @type {any} */ v) => {
        const live = v.itemKind === "live";
        const episode = v.itemKind === "movie" || live ? "" : episodeName({ season: v.season, number: v.number, title: v.episodeTitle }, v.itemKind);
        const ended = live ? `${viewingSpan(v)} · ${viewingEnd(v)}` : viewingEnd(v);
        const cells = [v.itemTitle ?? v.itemId, episode, v.imported ? "–" : formatDuration(v.watchedMs), ended, triggerLabel(v)].map((c) => h("td", null, c));
        return h("tr", null, time(h("td", { class: "muted" }), () => formatRelative(v.startedAt)), cells);
      };
      const caption = h("caption", null, "The last 30 viewings on this TV, the latest first; every viewing is kept in the history.");
      const head = h("thead", null, h("tr", null, ["Started", "Show", "Episode", "Watched", "Ended", "Started by"].map((t) => h("th", { scope: "col" }, t))));
      const table = h("table", null, caption, head, h("tbody", null, viewings.map(tr)));
      return h("div", { class: "table-wrap", tabindex: "0", role: "region", "aria-label": "History" }, table);
    });
    shown.show(content);
  };
  const all = h("a", { href: "#/history" }, "All history");
  const element = card({ title: "History", aside: all }, shown.element);
  return { element, refresh, fail: (err, retry) => shown.fail(err, retry, "Could not load the history.") };
}

/** How many problems the card reads (the latest). */
const PROBLEMS_SHOWN = 50;

/**
 * @param {DeviceContext} ctx @param {(count: string) => void} counted runs after each read with the count for the tab
 *   ("3", "50+" when the read was full, "" for none)
 * @returns {Section}
 */
function problemsCard(ctx, counted) {
  const shown = slot();
  const list = rebuiltOnChange();
  const clear = actionButton("Clear", { class: "danger", hidden: true, "aria-label": "Clear the problems" }, async () => {
    const r = await attempt(() => api("DELETE", `${ctx.path}/problems`), "Problems cleared.");
    // The button goes with the list: the focus moves to the card's heading.
    if (r.ok) await keepFocus(() => refresh().catch(() => {}), element.querySelector("h2"));
  });
  const refresh = async () => {
    const { problems } = await ctx.scope.read(`${ctx.path}/problems?limit=${PROBLEMS_SHOWN}`);
    clear.hidden = problems.length === 0;
    counted(problems.length >= PROBLEMS_SHOWN ? `${PROBLEMS_SHOWN}+` : problems.length > 0 ? String(problems.length) : "");
    const content = list.content(problems, (time) => {
      if (problems.length === 0) return h("p", { class: "muted" }, "No problems recorded.");
      const li = (/** @type {any} */ p) => {
        const context = problemContext(p);
        const at = new Date(p.at).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
        const when = time(h("time", { class: "muted", datetime: p.at }), () => `${formatRelative(p.at)} · ${at}`);
        const origin = chip(p.origin === "tv" ? "TV" : p.origin, p.origin === "server" ? "server" : "");
        const row = h("div", { class: "row" }, origin, h("strong", { class: "grow" }, `${p.kind} · ${p.code}`), when);
        return h("li", null, row, context ? h("div", null, context) : null, p.detail ? h("div", { class: "muted detail" }, p.detail) : null);
      };
      return h("ul", { class: "list problems" }, problems.map(li));
    });
    shown.show(content);
  };
  const element = card(
    { title: "Problems", aside: clear, intro: "What went wrong on this TV: its own reports, and what the server ran into while finding or relaying its streams." },
    shown.element,
  );
  return { element, refresh, fail: (err, retry) => shown.fail(err, retry, "Could not load the problems.") };
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
      return (content = build(time));
    },
  };
}

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
