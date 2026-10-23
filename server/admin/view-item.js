// @ts-check
// A show of the catalog: what it is, its episodes (a film, a channel: its sources) and their checks. "Check sources"
// runs every source of an episode or a channel through the server's resolve path and follows each the way the TV would
// fetch it, showing what came back (no URLs: hosts and header names only); "Check all episodes" checks the whole show.
// Each entry's chip is its last stored result, and "Last result" shows it again without checking.

import { ApiError, api, attempt, sendCommand } from "./api.js";
import { CHECK_NOTE, checkChip, checkRun, setCheckChip } from "./checks.js";
import { actionButton, card, h, loading, page, poster, setOff, setTitle, slot, srOnly } from "./dom.js";
import {
  checkSummaryText, episodeName, errorText, formatClock, formatRelative, mediaKindLabel, plural, showMeta, sourceReport, verdictChip,
} from "./lib.js";

/**
 * The sources of a check, each with its verdict, how it was tried, what came back, its warnings and every step it
 * fetched. Stored ones carry `checkedAt` and `stale` (the source changed since).
 * @param {any[]} sources @param {string} summary
 */
function reportView(sources, summary) {
  const mark = (/** @type {string} */ m) => h("span", { "aria-hidden": "true" }, `${m} `);
  const item = (/** @type {any} */ s) => {
    const r = sourceReport(s);
    const c = verdictChip(r.verdict);
    const name = h("strong", null, mark(c.mark), srOnly(`${c.text}: `), r.sourceId);
    const when = s.checkedAt ? ` · checked ${formatRelative(s.checkedAt)}${s.stale ? " · the source changed since" : ""}` : "";
    const warnings = r.warnings.map((w) => h("div", { class: "warning" }, mark("⚠"), `Warning: ${w}`));
    const steps = r.steps.length > 0
      ? h("ul", { class: "steps", "aria-label": `Steps of ${r.sourceId}` }, r.steps.map((st) => h("li", { class: st.ok ? "ok" : "bad" }, mark(st.ok ? "✔" : "✖"), st.text)))
      : null;
    return h("li", { class: r.verdict }, name, h("span", { class: "muted" }, ` ${r.how}${when}`), h("div", null, r.lines.map((l) => h("div", null, l))), warnings, steps);
  };
  return h("div", null, h("p", { class: "summary" }, summary), h("ul", { class: "diag" }, sources.map(item)));
}

/** "Working: 1 of 2 sources." @param {any[]} sources */
const workingText = (sources) => `Working: ${sources.filter((s) => s.verdict !== "fail").length} of ${plural(sources.length, "source")}.`;

/**
 * One episode (or the only entry of a film or a channel): what it is, its sources, its last check's chip, "Check
 * sources" and "Last result". A channel is checked by its item id; `e` is then the item itself, which carries
 * `playbackAllowed`, `sources` and `check`. `setCheck` shows another stored check.
 * @param {any} e @param {any} item
 */
function episodeEntry(e, item) {
  const single = item.kind === "movie" || item.kind === "live";
  const label = single ? item.title : episodeName(e, item.kind);
  const playableId = item.kind === "live" ? item.id : e.id;
  const out = h("div", { "aria-live": "polite" });
  const status = checkChip(e.check ?? null);
  const check = actionButton("Check sources", { "aria-label": `Check sources of ${label}` }, async () => {
    out.replaceChildren(h("p", { class: "muted" }, "Checking every source… (adapters may take a few seconds, a source at most 20 s)"));
    const body = item.kind === "live" ? { itemId: item.id } : { episodeId: e.id };
    const r = await attempt(() => api("POST", "/diagnostics/resolve", body));
    if (!r.ok) return out.replaceChildren(h("p", { class: "error" }, "The check could not run."));
    const a = r.value;
    out.replaceChildren(reportView(a.sources, workingText(a.sources)));
    const working = a.sources.filter((/** @type {any} */ s) => s.verdict !== "fail").length;
    setCheck({ verdict: a.verdict, checkedAt: a.checkedAt, working, total: a.sources.length, stale: false });
  });
  // The stored result, as it was: nothing is checked again.
  const last = actionButton("Last result", { "aria-label": `Last result of ${label}` }, async () => {
    out.replaceChildren(loading());
    const r = await attempt(() => api("GET", `/checks/playables/${encodeURIComponent(playableId)}`));
    if (!r.ok) return out.replaceChildren(h("p", { class: "error" }, "The last result could not be read."));
    const { check: c, sources } = r.value;
    if (sources.length === 0) return out.replaceChildren(h("p", { class: "muted" }, "Not checked yet."));
    out.replaceChildren(reportView(sources, `Last check: ${checkSummaryText(c).text}. ${workingText(sources)}`));
  });
  /** @param {any} next a CheckSummary, or null */
  const setCheck = (next) => {
    setCheckChip(status, next);
    last.hidden = next === null;
  };
  setCheck(e.check ?? null);
  const facts = [
    e.durationMs ? formatClock(e.durationMs) : null,
    e.playbackAllowed ? null : "playback not allowed",
    e.sources.length === 0 ? "no sources" : null,
    e.autoAdvance === false ? "no auto-advance after this one" : null,
  ].filter(Boolean).join(" · ");
  const source = (/** @type {any} */ s) => {
    const audio = s.languages.audio === null ? "unknown" : s.languages.audio.join(", ") || "none";
    return h("li", null, h("code", null, s.id), ` ${s.type === "adapter" ? `adapter ${s.adapter}` : mediaKindLabel(s.kind)}${s.needsProxy ? " · proxied" : ""}${s.label ? ` · ${s.label}` : ""} · audio ${audio}`);
  };
  const factsLine = facts ? h("div", { class: "muted" }, item.kind === "movie" && e.durationMs ? `Duration ${facts}` : facts) : null;
  const checked = e.sources.length ? h("div", { class: "checked" }, status) : null;
  const what = h("div", { class: "grow" }, single ? null : h("strong", null, label), factsLine, checked, h("ul", { class: "sources" }, e.sources.map(source)));
  const buttons = e.sources.length ? h("div", { class: "buttons" }, check, last) : null;
  const element = h(single ? "div" : "li", null, h("div", { class: "row top-align" }, what, buttons), out);
  return { element, playableId, setCheck };
}

/**
 * "Play on": one button per paired TV, which plays what OK would play for the show, or the channel live, whether it
 * is on its home screen or not. Nothing for a channel the catalog does not allow.
 * @param {any} item @param {any[]} devices
 */
function playOnCard(item, devices) {
  const active = devices.filter((d) => d.status === "active");
  if (active.length === 0 || (item.kind === "live" && !item.playbackAllowed)) return null;
  const button = (/** @type {any} */ d) =>
    actionButton(d.name, { "aria-label": `Play on ${d.name}` }, () => sendCommand(d.id, { type: "play", itemId: item.id }, "Play", d.name));
  const intro = item.kind === "live"
    ? "The TV plays this channel live, whether it is on its home screen or not."
    : "The TV plays the episode OK would play for this show, whether it is on its home screen or not.";
  return card({ title: "Play on", intro }, h("div", { class: "buttons play-on" }, active.map(button)));
}

/** @param {import("./router.js").Scope} scope @param {string} itemId */
export function itemView(scope, itemId) {
  const title = h("h1", null, "Show");
  const body = slot();
  /** Each entry's `setCheck`, by playable id (an episode's, a channel's item id). @type {Map<string, (check: any) => void>} */
  const entryChecks = new Map();
  // Once a check of the show ends, every chip shows what it found.
  const refreshChecks = async () => {
    const { item } = await scope.read(`/catalog/items/${encodeURIComponent(itemId)}`);
    for (const e of item.kind === "live" ? [item] : item.episodes) entryChecks.get(e.id)?.(e.check ?? null);
  };
  const checks = checkRun(scope, {
    mine: (target) => target.itemId === itemId,
    changed: (running) => setOff(checkAll, running),
    ended: () => void refreshChecks().catch(() => {}),
  });
  const checkAll = actionButton("Check all episodes", null, () => checks.start({ itemId }));

  scope.load(
    async () => {
      const [{ item }, { devices }] = await Promise.all([scope.read(`/catalog/items/${encodeURIComponent(itemId)}`), scope.read("/devices")]);
      setTitle(title, item.title);
      const live = item.kind === "live";
      const episodeCount = item.kind === "series" ? item.episodes.length : undefined;
      const meta = [
        showMeta({ kind: item.kind, year: item.year, episodeCount }),
        item.originalTitle && item.originalTitle !== item.title ? item.originalTitle : null,
        item.genres.join(", "),
      ];
      const advance = item.kind === "series" ? h("p", { class: "muted" }, item.autoAdvance ? "Episodes advance on their own." : "Episodes do not advance on their own.") : null;
      const channel = live
        ? h("p", { class: "muted" }, item.playbackAllowed ? "Plays live: the TV always joins it where the broadcast is now." : "Playback not allowed by the catalog: the TVs do not show this channel.")
        : null;
      const about = h("div", { class: "grow" }, h("p", { class: "muted" }, meta.filter(Boolean).join(" · ")), item.synopsis ? h("p", null, item.synopsis) : null, advance, channel);
      const head = h("section", { class: "card show-head" }, h("div", { class: "row top-align" }, poster(item.posterUrl, item.title), about));
      const entry = (/** @type {any} */ e) => {
        const x = episodeEntry(e, item);
        entryChecks.set(x.playableId, x.setCheck);
        return x.element;
      };
      const note = h("p", { class: "muted hint check-note" }, CHECK_NOTE);
      checkAll.setAttribute("aria-label", `Check all episodes of ${item.title}`);
      const entries = live
        ? card({ title: "Sources", intro: "Where the channel is played from, in the order the TV tries them." }, note, checks.element, entry(item))
        : item.kind === "movie" && item.episodes.length === 1
          ? card({ title: "Sources", intro: "Where the film is played from, in the order the TV tries them." }, note, checks.element, entry(item.episodes[0]))
          : card({ title: "Episodes", aside: checkAll, intro: "In play order, with their sources in the order the TV tries them." },
            note, checks.element, h("ol", { class: "list" }, item.episodes.map(entry)));
      body.show(head, ...[playOnCard(item, devices)].filter((c) => c !== null), entries);
    },
    (err, retry) => {
      if (err instanceof ApiError && err.code === "unknown_item") body.show(h("p", { class: "error" }, errorText(err)));
      else body.fail(err, retry, "Could not load this show.");
    },
  );

  return page({ back: ["#/catalog", "← Catalog"], title }, scope.note, body.element);
}
