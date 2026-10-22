// @ts-check
// A show of the catalog: what it is, its episodes (a film, a channel: its sources) and "Test sources", which runs
// every source of an episode or a channel through the server's resolve path and shows what came back (no URLs: hosts
// and header names only).

import { ApiError, api, attempt, sendCommand } from "./api.js";
import { actionButton, card, h, page, poster, setTitle, slot, srOnly } from "./dom.js";
import { episodeName, errorText, formatClock, mediaKindLabel, plural, showMeta, sourceReport } from "./lib.js";

/** @param {any} report the answer of POST /admin/diagnostics/resolve */
function reportView(report) {
  const sources = report.sources.map((/** @type {any} */ s) => sourceReport(s));
  const item = (/** @type {ReturnType<typeof sourceReport>} */ r) => {
    const name = h("strong", null, h("span", { "aria-hidden": "true" }, r.ok ? "✔ " : "✖ "), srOnly(r.ok ? "Works: " : "Fails: "), r.sourceId);
    return h("li", { class: r.ok ? "ok" : "bad" }, name, h("span", { class: "muted" }, ` ${r.how}`), h("div", null, r.lines.map((l) => h("div", null, l))));
  };
  const working = sources.filter((/** @type {any} */ r) => r.ok).length;
  const summary = h("p", { class: "summary" }, `Working: ${working} of ${plural(sources.length, "source")}.`);
  return h("div", null, summary, h("ul", { class: "diag" }, sources.map(item)));
}

/**
 * One episode (or the only entry of a film or a channel): what it is, its sources, and "Test sources". A channel is
 * tested by its item id; `e` is then the item itself, which carries `playbackAllowed` and `sources`.
 * @param {any} e @param {any} item
 */
function episodeEntry(e, item) {
  const single = item.kind === "movie" || item.kind === "live";
  const label = single ? item.title : episodeName(e, item.kind);
  const out = h("div", { "aria-live": "polite" });
  const test = actionButton("Test sources", { "aria-label": `Test sources of ${label}` }, async () => {
    out.replaceChildren(h("p", { class: "muted" }, "Testing every source… (adapters may take a few seconds)"));
    const body = item.kind === "live" ? { itemId: item.id } : { episodeId: e.id };
    const r = await attempt(() => api("POST", "/diagnostics/resolve", body));
    out.replaceChildren(r.ok ? reportView(r.value) : h("p", { class: "error" }, "The test could not run."));
  });
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
  const what = h("div", { class: "grow" }, single ? null : h("strong", null, label), factsLine, h("ul", { class: "sources" }, e.sources.map(source)));
  return h(single ? "div" : "li", null, h("div", { class: "row top-align" }, what, e.sources.length ? test : null), out);
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
      const entries = live
        ? card({ title: "Sources", intro: "Where the channel is played from, in the order the TV tries them." }, episodeEntry(item, item))
        : item.kind === "movie" && item.episodes.length === 1
          ? card({ title: "Sources", intro: "Where the film is played from, in the order the TV tries them." }, episodeEntry(item.episodes[0], item))
          : card({ title: "Episodes", intro: "In play order, with their sources in the order the TV tries them." }, h("ol", { class: "list" }, item.episodes.map((/** @type {any} */ e) => episodeEntry(e, item))));
      body.show(head, ...[playOnCard(item, devices)].filter((c) => c !== null), entries);
    },
    (err, retry) => {
      if (err instanceof ApiError && err.code === "unknown_item") body.show(h("p", { class: "error" }, errorText(err)));
      else body.fail(err, retry, "Could not load this show.");
    },
  );

  return page({ back: ["#/catalog", "← Catalog"], title }, scope.note, body.element);
}
