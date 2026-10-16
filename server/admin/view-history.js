// @ts-check
// The viewing history of the family: what was watched in the last days, the titles with their status, and one
// title's episodes with the owner's marks (seen, not seen), which win over what the TVs reported.

import { api, attempt } from "./api.js";
import { actionButton, card, chip, h, keepFocus, page, setChip, setTitle, slot } from "./dom.js";
import { episodeHistoryLine, episodeName, formatDuration, formatRelative, plural, titleLine, titleStatusLabel } from "./lib.js";
import { watchEvents } from "./events.js";

const DAYS_SHOWN = 7;
const TITLES_LIMIT = 100;

/** A remembered filter choice, for the time of the page (localStorage may be off). */
const remembered = /** @type {Record<string, string>} */ ({});

/** @param {import("./router.js").Scope} scope */
export function historyView(scope) {
  // Days ---------------------------------------------------------------------------------------------------------
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
      return h("tr", null, h("td", null, d.date), h("td", null, formatDuration(d.watchedMs)), h("td", null, String(d.viewings)), h("td", null, shows));
    };
    const head = h("thead", null, h("tr", null, ["Day", "Watched", "Viewings", "Shows"].map((t) => h("th", { scope: "col" }, t))));
    const table = h("table", null, h("caption", null, "Per calendar day, in the server's time zone; a viewing counts on the day it started."), head, h("tbody", null, recent.reverse().map(tr)));
    daysSlot.show(summary, h("div", { class: "table-wrap", tabindex: "0", role: "region", "aria-label": "Watched per day" }, table));
  };

  // Titles -------------------------------------------------------------------------------------------------------
  const titlesSlot = slot();
  const status = h("select", { id: "h-status", "aria-label": "Status" },
    [["", "Every status"], ["watching", "Watching"], ["new_episodes", "New episodes"], ["finished", "Finished"], ["idle", "Idle"]].map(([v, t]) => h("option", { value: v, selected: v === (remembered.status ?? "") }, t)));
  const sort = h("select", { id: "h-sort", "aria-label": "Order" },
    [["recent", "Last watched first"], ["watched", "Most watched first"], ["title", "By title"]].map(([v, t]) => h("option", { value: v, selected: v === (remembered.sort ?? "recent") }, t)));
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
        h("div", { class: "grow" }, h("strong", null, t.title), h("div", { class: "muted" }, titleLine(t))), chip(s.label, s.tone));
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

  /** @param {any} e */
  const episodeRow = (e) => {
    const name = e.inCatalog ? episodeName(e, detail.title.kind) : `${episodeName(e, detail.title.kind)} (no longer in the catalog)`;
    const seenChip = e.seen ? chip("Seen", "ok") : chip(e.viewings > 0 ? "Started" : "Not seen");
    const button = (/** @type {string} */ label, /** @type {boolean | null} */ value, /** @type {boolean} */ pressed) =>
      actionButton(label, { "aria-pressed": String(pressed), "data-focus": `${label}:${e.episodeId}`, "aria-label": `${label}: ${name}` }, () =>
        mark([e.episodeId], pressed ? null : value, pressed ? "Mark removed." : `${name}: ${label.toLowerCase()}.`));
    const buttons = h("div", { class: "buttons" }, button("Seen", true, e.mark === true), button("Not seen", false, e.mark === false));
    return h("li", null, h("div", { class: "row" }, seenChip, h("div", { class: "grow" }, h("strong", null, name), h("div", { class: "muted" }, episodeHistoryLine(e))), buttons));
  };

  const load = async () => {
    detail = await scope.read(`/history/titles/${encodeURIComponent(itemId)}`);
    const t = detail.title;
    setTitle(title, t.title);
    const s = titleStatusLabel(t.status);
    setChip(statusChip, s.label, s.tone);
    const facts = [titleLine(t), t.firstWatchedAt ? `first watched ${formatRelative(t.firstWatchedAt)}` : null, t.rewatches > 0 ? plural(t.rewatches, "rewatch") : null,
      t.shortViewings > 0 ? `${plural(t.shortViewings, "short viewing")} (gave up early)` : null].filter(Boolean).join(" · ");
    const ids = detail.episodes.map((/** @type {any} */ e) => e.episodeId);
    const allSeen = actionButton("Mark all seen", { "data-focus": "all-seen" }, () => mark(ids, true, "All episodes marked seen."));
    const clearMarks = actionButton("Clear marks", { "data-focus": "clear-marks" }, () => mark(ids, null, "Marks removed: what the TVs reported counts again."));
    const anyMark = detail.episodes.some((/** @type {any} */ e) => e.mark !== null);
    const catalogLink = t.inCatalog ? h("a", { href: `#/catalog/items/${encodeURIComponent(itemId)}` }, "Show in the catalog") : null;
    head.replaceChildren(h("div", null, h("p", { class: "muted" }, facts), catalogLink ? h("p", null, catalogLink) : null,
      h("div", { class: "actions" }, allSeen, anyMark ? clearMarks : null)));
    episodesList.replaceChildren(...detail.episodes.map(episodeRow));
    body.show(
      h("section", { class: "card" }, h("div", { class: "row top-align" }, head)),
      card({ title: t.kind === "movie" ? "The film" : "Episodes", intro: "A mark is the owner's word and wins over what the TVs reported; it changes nothing on the TVs." },
        h("div", { class: "table-wrap", role: "region", "aria-label": "Episodes" }, episodesList)),
    );
  };
  const job = scope.load(load, (err, retry) => body.fail(err, retry, "Could not load this title."));
  watchEvents(scope, { types: ["playback.ended", "episode.seen", "history.changed"] }, () => void job.now());

  return page({ back: ["#/history", "← History"], title, aside: [statusChip] }, scope.note, body.element);
}
