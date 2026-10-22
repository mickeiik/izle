// @ts-check
// The viewing history of the family: what was watched in the last days, the titles with their status, and one
// title's episodes with the owner's marks (seen, not seen), which win over what the TVs reported. A channel has no
// episodes and is never seen: its page lists its viewings, when and how long each ran.

import { api, attempt } from "./api.js";
import { actionButton, card, chip, h, keepFocus, options, page, rowText, setChip, setTitle, slot } from "./dom.js";
import { episodeHistoryLine, episodeName, formatDuration, formatRelative, liveViewingLine, plural, titleLine, titleStatusLabel, triggerLabel } from "./lib.js";
import { watchEvents } from "./events.js";

const DAYS_SHOWN = 7;
const TITLES_LIMIT = 100;
const CHANNEL_VIEWINGS = 50;

/** A remembered filter choice, for the time of the page (localStorage may be off). */
const remembered = { status: "", sort: "recent" };

/** @param {import("./router.js").Scope} scope */
export function historyView(scope) {
  const daysSlot = slot();
  const refreshDays = async () => {
    const { days } = await scope.read("/history/days");
    const recent = days.slice(-DAYS_SHOWN);
    if (recent.length === 0) return daysSlot.show(h("p", { class: "muted" }, "Nothing watched in the last 30 days."));
    const total = recent.reduce((/** @type {number} */ acc, /** @type {any} */ d) => acc + d.watchedMs, 0);
    const count = recent.reduce((/** @type {number} */ acc, /** @type {any} */ d) => acc + d.viewings, 0);
    const summary = h("p", null, h("strong", null, formatDuration(total)), ` over ${plural(count, "viewing")} on the last ${plural(recent.length, "day")} with something watched.`);
    const tr = (/** @type {any} */ d) => {
      const shows = d.items.map((/** @type {any} */ i) => `${i.title} (${formatDuration(i.watchedMs)})`).join(", ");
      return h("tr", null, [d.date, formatDuration(d.watchedMs), String(d.viewings), shows].map((c) => h("td", null, c)));
    };
    const head = h("thead", null, h("tr", null, ["Day", "Watched", "Viewings", "Shows"].map((t) => h("th", { scope: "col" }, t))));
    const table = h("table", null, h("caption", null, "Per calendar day, in the server's time zone; a viewing counts on the day it started."), head, h("tbody", null, recent.reverse().map(tr)));
    daysSlot.show(summary, h("div", { class: "table-wrap", tabindex: "0", role: "region", "aria-label": "Watched per day" }, table));
  };

  const titlesSlot = slot();
  const status = h("select", { id: "h-status", "aria-label": "Status" },
    options([["", "Every status"], ["watching", "Watching"], ["new_episodes", "New episodes"], ["finished", "Finished"], ["idle", "Idle"]], remembered.status));
  const sort = h("select", { id: "h-sort", "aria-label": "Order" },
    options([["recent", "Last watched first"], ["watched", "Most watched first"], ["title", "By title"]], remembered.sort));
  const summary = h("p", { class: "summary muted", role: "status" });
  const refreshTitles = async () => {
    remembered.status = status.value;
    remembered.sort = sort.value;
    const q = new URLSearchParams({ sort: sort.value, limit: String(TITLES_LIMIT) });
    if (status.value) q.set("status", status.value);
    const { titles } = await scope.read(`/history/titles?${q}`);
    summary.textContent = titles.length === 0 ? "No title matches." : titles.length >= TITLES_LIMIT ? `The first ${titles.length} titles.` : plural(titles.length, "title");
    const row = (/** @type {any} */ t) => {
      const s = titleStatusLabel(t.status);
      return h("a", { class: "row link", href: `#/history/${encodeURIComponent(t.itemId)}` },
        rowText(t.title, titleLine(t)), chip(s.label, s.tone));
    };
    titlesSlot.show(titles.length === 0 ? h("p", { class: "muted" }, "Nothing here yet: titles appear once a TV played them or an episode was marked.") : h("div", { class: "list" }, titles.map(row)));
  };
  const titlesJob = scope.poll(refreshTitles, 60_000, (err) => titlesSlot.fail(err, titlesJob.now, "Could not load the titles."));
  const daysJob = scope.poll(refreshDays, 60_000, (err) => daysSlot.fail(err, daysJob.now, "Could not load the days."));
  for (const select of [status, sort]) select.addEventListener("change", () => void titlesJob.now());
  // A viewing that ends, or a mark, changes the titles and the days.
  watchEvents(scope, { types: ["playback.ended", "episode.seen", "history.changed", "catalog.reloaded"] }, () => {
    void titlesJob.now();
    void daysJob.now();
  });

  const filters = h("div", { class: "filters" }, status, sort);
  return page(
    { title: "History" },
    scope.note,
    card({ title: "Last days", intro: "What the TVs played, all of them together." }, daysSlot.element),
    card({ title: "Titles", aside: filters, intro: "Every show with a viewing or a mark. A title is finished when every episode was seen: watched to the end, or past 90 %." }, summary, titlesSlot.element),
  );
}

/** @param {import("./router.js").Scope} scope @param {string} itemId */
export function historyItemView(scope, itemId) {
  const title = h("h1", null, "Title");
  const statusChip = chip("");
  const body = slot();
  const head = h("div", { class: "grow" });
  const episodesList = h("ol", { class: "list episodes-history" });
  /** @type {any} */
  let detail = null;

  /** Sets marks and reloads; the focus stays on the button that was pressed (its twin after the rebuild). */
  const mark = async (/** @type {string[]} */ episodeIds, /** @type {boolean | null} */ seen, /** @type {string} */ done) => {
    const r = await attempt(() => api("POST", "/history/marks", { episodeIds, seen }), done);
    if (r.ok) await keepFocus(() => job.now(), head.querySelector("h2"));
  };

  const episodeRow = (/** @type {any} */ e) => {
    const name = e.inCatalog ? episodeName(e, detail.title.kind) : `${episodeName(e, detail.title.kind)} (no longer in the catalog)`;
    const seenChip = e.seen ? chip("Seen", "ok") : chip(e.viewings > 0 ? "Started" : "Not seen");
    const button = (/** @type {string} */ label, /** @type {boolean | null} */ value, /** @type {boolean} */ pressed) =>
      actionButton(label, { "aria-pressed": String(pressed), "data-focus": `${label}:${e.episodeId}`, "aria-label": `${label}: ${name}` }, () =>
        mark([e.episodeId], pressed ? null : value, pressed ? "Mark removed." : `${name}: ${label.toLowerCase()}.`));
    const buttons = h("div", { class: "buttons" }, button("Seen", true, e.mark === true), button("Not seen", false, e.mark === false));
    return h("li", null, h("div", { class: "row" }, seenChip, rowText(name, episodeHistoryLine(e)), buttons));
  };

  /** The card above the list: the title's facts, its catalog link, then `more`. @param {any} t @param {Array<string | null>} facts @param {string} link @param {...HTMLElement} more */
  const showHead = (t, facts, link, ...more) => {
    const line = [titleLine(t), t.firstWatchedAt ? `first watched ${formatRelative(t.firstWatchedAt)}` : null, ...facts].filter(Boolean).join(" · ");
    const catalogLink = t.inCatalog ? h("p", null, h("a", { href: `#/catalog/items/${encodeURIComponent(itemId)}` }, link)) : null;
    head.replaceChildren(h("div", null, h("p", { class: "muted" }, line), catalogLink, ...more));
    return h("section", { class: "card" }, h("div", { class: "row top-align" }, head));
  };

  /** A channel: its latest viewings, one line each (no marks: a channel is never seen). @param {any} t */
  const loadChannel = async (t) => {
    const { viewings } = await scope.read(`/history/viewings?item=${encodeURIComponent(itemId)}&limit=${CHANNEL_VIEWINGS}`);
    const day = (/** @type {string} */ iso) => new Date(iso).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
    const row = (/** @type {any} */ v) => {
      const by = triggerLabel(v);
      const more = [v.deviceName, by ? `started by ${by}` : null].filter(Boolean).join(" · ");
      return h("li", null, h("div", { class: "row" }, rowText(`${day(v.startedAt)} · ${liveViewingLine(v)}`, more)));
    };
    const list = viewings.length === 0
      ? h("p", { class: "muted" }, "No viewing is kept for this channel.")
      : h("ol", { class: "list episodes-history" }, viewings.map(row));
    const intro = viewings.length >= CHANNEL_VIEWINGS
      ? `The last ${CHANNEL_VIEWINGS} viewings, the latest first: when the channel was on and how long the picture ran.`
      : "Its viewings, the latest first: when the channel was on and how long the picture ran.";
    body.show(showHead(t, [], "Channel in the catalog"), card({ title: "Viewings", intro }, list));
  };

  const load = async () => {
    detail = await scope.read(`/history/titles/${encodeURIComponent(itemId)}`);
    const t = detail.title;
    setTitle(title, t.title);
    const s = titleStatusLabel(t.status);
    setChip(statusChip, s.label, s.tone);
    if (t.kind === "live") return loadChannel(t);
    const ids = detail.episodes.map((/** @type {any} */ e) => e.episodeId);
    const allSeen = actionButton("Mark all seen", { "data-focus": "all-seen" }, () => mark(ids, true, "All episodes marked seen."));
    const clearMarks = actionButton("Clear marks", { "data-focus": "clear-marks" }, () => mark(ids, null, "Marks removed: what the TVs reported counts again."));
    const anyMark = detail.episodes.some((/** @type {any} */ e) => e.mark !== null);
    const facts = [t.rewatches > 0 ? plural(t.rewatches, "rewatch") : null, t.shortViewings > 0 ? `${plural(t.shortViewings, "short viewing")} (gave up early)` : null];
    episodesList.replaceChildren(...detail.episodes.map(episodeRow));
    body.show(
      showHead(t, facts, "Show in the catalog", h("div", { class: "actions" }, allSeen, anyMark ? clearMarks : null)),
      card({ title: t.kind === "movie" ? "The film" : "Episodes", intro: "A mark is the owner's word and wins over what the TVs reported; it changes nothing on the TVs." },
        h("div", { class: "table-wrap", role: "region", "aria-label": "Episodes" }, episodesList)),
    );
  };
  const job = scope.load(load, (err, retry) => body.fail(err, retry, "Could not load this title."));
  watchEvents(scope, { types: ["playback.ended", "episode.seen", "history.changed"] }, () => void job.now());

  return page({ back: ["#/history", "← History"], title, aside: [statusChip] }, scope.note, body.element);
}
