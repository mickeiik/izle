// @ts-check
// The catalog browser shared by the Catalog page and a TV's "Add shows": a title search with filters (kind, genre,
// years, playable only, new since a build and, for a TV, not on its Home), an order, and the matching shows 50 at a
// time ("Show more"). The caller draws each row; the browser owns the controls, the requests and the paging.

import { actionButton, focusFirst, h, keyedRows, loadError, loading, setOff, toast, uid } from "./dom.js";
import { BROWSE_PAGE, BROWSE_SORTS, DEFAULT_FILTERS, browsePath, browseSummary, errorText, foldText, isFiltered, newSinceOptions, sinceAt } from "./lib.js";

/** How long the search and year boxes wait after the last keystroke. */
const TYPING_MS = 200;

/** @typedef {import("./lib.js").BrowseFilters} BrowseFilters */
/** @typedef {{ element: HTMLElement, update(item: any, index: number, all: any[]): void }} BrowserRow */

/**
 * @param {string} label @param {ReadonlyArray<readonly [string, string]>} options @param {string} value
 */
function select(label, options, value) {
  const el = h("select", { "aria-label": label });
  setOptions(el, options, value);
  return el;
}

/** @param {HTMLSelectElement} el @param {ReadonlyArray<readonly [string, string]>} options @param {string} value */
function setOptions(el, options, value) {
  el.replaceChildren(...options.map(([v, text]) => h("option", { value: v }, text)));
  el.value = options.some(([v]) => v === value) ? value : (options[0]?.[0] ?? "");
}

/** @param {string} text @param {boolean} checked */
function checkbox(text, checked) {
  const input = h("input", { type: "checkbox" });
  input.checked = checked;
  return { input, label: h("label", { class: "check" }, input, text) };
}

/**
 * @param {import("./router.js").Scope} scope
 * @param {{
 *   row: (item: any) => BrowserRow,
 *   label: string,
 *   heading?: boolean,
 *   notOnDevice?: string | null,
 *   initial?: BrowseFilters,
 *   onFilters?: (f: BrowseFilters) => void,
 *   above?: HTMLElement,
 * }} o `label` names the search box (shown as a heading with `heading`, else for screen readers only);
 *   `notOnDevice` offers "Not on this Home" for that TV; `onFilters` hears every change of the filters; `above` goes
 *   between the filters and the results (a TV's "Add to")
 */
export function catalogBrowser(scope, o) {
  /** @type {BrowseFilters} */
  let filters = { ...DEFAULT_FILTERS, ...o.initial };
  if (!o.notOnDevice) filters.notOnHome = false;
  /** @type {any} the answer of GET /catalog (facets and builds), null until it came */
  let info = null;
  /** @type {any[]} every result shown so far */
  let items = [];
  let total = 0;
  let seq = 0;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  scope.onCleanup(() => clearTimeout(timer));

  const searchId = uid("browse");
  const search = h("input", {
    type: "search", id: searchId, placeholder: "Search titles", autocomplete: "off", spellcheck: "false", value: filters.q,
    "aria-label": o.heading ? null : o.label,
  });
  const kind = select("Kind", [["", "Every kind"], ["movie", "Films"], ["series", "Series"], ["live", "Channels"]], filters.kind);
  const genre = select("Genre", [["", "Every genre"]], "");
  genre.hidden = true;
  const year = (/** @type {string} */ label, /** @type {string} */ value) =>
    h("input", { type: "number", class: "year", inputmode: "numeric", min: "1870", max: "2200", step: "1", placeholder: label, "aria-label": label, value });
  const yearFrom = year("From year", filters.yearFrom);
  const yearTo = year("To year", filters.yearTo);
  const years = h("span", { class: "years", hidden: true }, yearFrom, yearTo);
  const playable = checkbox("Playable only", filters.playable);
  const notOnHome = o.notOnDevice ? checkbox("Not on this Home", filters.notOnHome) : null;
  const since = select("New in the catalog", [["", "Any time"]], "");
  since.hidden = true;
  const sort = select("Order", BROWSE_SORTS, filters.sort);
  const reset = actionButton("Reset", null, async () => {
    search.value = "";
    kind.value = genre.value = since.value = "";
    yearFrom.value = yearTo.value = "";
    playable.input.checked = false;
    if (notOnHome) notOnHome.input.checked = false;
    // Before the facets came, the genre and "new since" choices from the address live only in `filters`.
    filters = { ...filters, genre: "", since: "" };
    search.focus();
    await run();
  });

  const summary = h("p", { class: "summary muted", "aria-live": "polite" });
  const list = h("div", { class: "list results" });
  const rows = keyedRows(list, (/** @type {any} */ i) => i.id, o.row, () => search);
  const resultsArea = h("div", null, loading());
  const more = actionButton("Show more", null, async () => {
    const before = items.length;
    await load(before);
    // Everything is listed: the button went away, the keyboard goes on with the first new show.
    const first = list.children[before];
    if (moreBox.hidden && first instanceof HTMLElement) focusFirst(first, "add");
  });
  const moreBox = h("div", { class: "more", hidden: true }, more);

  /** The controls into `filters`; until the facets came, the genre and "new since" selects are empty and the address's choices stay. */
  const readControls = () => {
    filters = {
      q: search.value, kind: kind.value, genre: info ? genre.value : filters.genre, yearFrom: yearFrom.value, yearTo: yearTo.value,
      playable: playable.input.checked, notOnHome: notOnHome?.input.checked ?? false, since: info ? since.value : filters.since, sort: sort.value,
    };
  };

  /** The facets and builds of the loaded catalog into the selects; a choice they no longer offer goes back to "any". */
  const fillFacets = () => {
    const f = info.facets;
    const count = (/** @type {number} */ n) => ` (${n.toLocaleString("en-US")})`;
    setOptions(kind, [["", "Every kind"], ["movie", `Films${count(f.kinds.movie)}`], ["series", `Series${count(f.kinds.series)}`], ["live", `Channels${count(f.kinds.live)}`]], filters.kind);
    /** @type {Array<[string, string]>} */
    const genres = f.genres.map((/** @type {{ name: string, count: number }} */ g) => [g.name, `${g.name}${count(g.count)}`]);
    // A genre from the address that the catalog spells differently (or no longer has) stays chosen.
    const wanted = foldText(filters.genre);
    if (wanted && !genres.some(([name]) => foldText(name) === wanted)) genres.unshift([filters.genre, filters.genre]);
    const match = genres.find(([name]) => foldText(name) === wanted);
    setOptions(genre, [["", "Every genre"], ...genres], match ? match[0] : "");
    genre.hidden = genres.length === 0;
    years.hidden = f.years === null;
    if (f.years) {
      yearFrom.placeholder = `From ${f.years.min}`;
      yearTo.placeholder = `To ${f.years.max}`;
    }
    const options = newSinceOptions(info.builds ?? []);
    setOptions(since, options, filters.since);
    since.hidden = options.length === 1;
    readControls();
  };

  /** Lists the shows from `offset` on (0: a new list, else the next page under the shown ones). */
  const load = async (/** @type {number} */ offset) => {
    const mine = ++seq;
    const path = browsePath(filters, {
      offset, limit: BROWSE_PAGE, sinceAt: sinceAt(filters.since, info?.builds ?? []), notOnDevice: filters.notOnHome ? (o.notOnDevice ?? null) : null,
    });
    /** @type {any} */
    let r;
    try {
      r = await scope.read(path);
    } catch (err) {
      if (mine !== seq || !scope.alive()) return;
      // A later page that failed leaves the shown ones; "Show more" tries again.
      if (offset > 0) return toast(errorText(err), "error");
      summary.textContent = "";
      moreBox.hidden = true;
      resultsArea.replaceChildren(loadError(err, () => load(offset), "Could not search the catalog."));
      return;
    }
    if (mine !== seq || !scope.alive()) return;
    if (offset > 0) {
      // A catalog reloaded between two pages may repeat a show: it is listed once.
      const have = new Set(items.map((i) => i.id));
      items = [...items, ...r.items.filter((/** @type {any} */ i) => !have.has(i.id))];
    } else items = r.items;
    total = r.total;
    rows.set(items);
    summary.textContent = browseSummary(items.length, total, filters);
    moreBox.hidden = items.length >= total;
    if (resultsArea.firstChild !== list) resultsArea.replaceChildren(list);
  };

  /** Applies the controls at once: a new first page. */
  const run = async () => {
    clearTimeout(timer);
    readControls();
    setOff(reset, !isFiltered(filters));
    o.onFilters?.(filters);
    // No "Show more" of the old list while its new first page loads.
    moreBox.hidden = true;
    await load(0);
  };
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void run(), TYPING_MS);
  };
  for (const box of [search, yearFrom, yearTo]) box.addEventListener("input", later);
  for (const control of [kind, genre, since, sort, playable.input, notOnHome?.input]) control?.addEventListener("change", () => void run());

  /** Reads the catalog's facets and builds (unless given: the answer of GET /catalog or of a reload), then the first page. */
  const start = async (/** @type {any} */ given = null) => {
    try {
      info = given ?? (await scope.read("/catalog"));
    } catch (err) {
      if (!scope.alive()) return;
      resultsArea.replaceChildren(loadError(err, () => start(), "Could not load the catalog."));
      return;
    }
    if (!scope.alive()) return;
    fillFacets();
    setOff(reset, !isFiltered(filters));
    await load(0);
  };
  setOff(reset, !isFiltered(filters));
  void start();

  const filterBar = h("div", { class: "filters" }, kind, genre, years, since, sort, playable.label, notOnHome?.label, reset);
  const head = o.heading ? h("h3", null, h("label", { for: searchId }, o.label)) : null;
  const element = h("div", { class: "browser" }, head, search, filterBar, o.above, summary, resultsArea, moreBox);

  return {
    element,
    /** The search box: where the keyboard goes when nothing else is left. */
    search,
    run,
    /** Redraws the shown rows (their state changed, such as "On Home"), with no request. */
    refresh: () => rows.set(items),
    /** After a reload of the catalog: its facets and builds (the reload's answer), then the first page. */
    reload: start,
    /** The shows listed now, in order. */
    items: () => items,
  };
}
