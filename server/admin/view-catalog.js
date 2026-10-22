// @ts-check
// Catalog: the loaded bundle (with "Reload from disk"), its build history with what each build changed, and the
// catalog browser, whose filters live in the address (`#/catalog?…`) so that Back from a show returns to the same list.

import { ApiError, api, isUnauthorized } from "./api.js";
import { catalogBrowser } from "./catalog-browser.js";
import { actionButton, card, factList, h, loadError, loading, page, rowText, showRow, slot, toast } from "./dom.js";
import { browseHash, buildSummary, catalogContents, errorText, formatRelative, groupEpisodeChanges, issueLine, parseBrowseHash, plural, shortId, showMeta } from "./lib.js";

/** Builds listed before the rest fold away. */
const BUILDS_SHOWN = 5;

/** What a build changed: new and removed shows and episodes. @param {any} b @param {any} changes */
function buildDetail(b, changes) {
  const head = h("h3", null, "Changes in build ", h("code", null, b.buildId));
  if (b.baseline) {
    return h("div", null, head, h("p", { class: "muted" }, "The first build this server loaded for this catalog: everything in it was already there, so nothing in it counts as new."));
  }
  // Shows that are new (or gone) are listed as shows; their episodes are not repeated under episodes.
  const newShows = new Set(changes.items.added.map((/** @type {any} */ i) => i.id));
  const goneShows = new Set(changes.items.removed.map((/** @type {any} */ i) => i.id));
  const added = groupEpisodeChanges(changes.episodes.added);
  const episodeCount = new Map(added.map((g) => [g.itemId, g.episodes.length]));
  const groupLine = (/** @type {{ title: string, episodes: string[] }} */ g) => h("div", null, h("strong", null, g.title), ` — ${g.episodes.join(", ")}`);
  const newShow = (/** @type {any} */ i) =>
    h("div", null, h("strong", null, i.title), i.kind === "live" ? " · channel" : i.kind === "series" && episodeCount.has(i.id) ? ` · ${plural(episodeCount.get(i.id) ?? 0, "episode")}` : null);
  /** @type {Array<[string, HTMLElement[]]>} */
  const sections = [
    ["New episodes", added.filter((g) => !newShows.has(g.itemId)).map(groupLine)],
    ["New shows", changes.items.added.map(newShow)],
    ["Removed shows", changes.items.removed.map((/** @type {any} */ i) => h("div", null, h("strong", null, i.title ?? i.id)))],
    ["Removed episodes", groupEpisodeChanges(changes.episodes.removed).filter((g) => !goneShows.has(g.itemId)).map(groupLine)],
  ];
  const shown = sections.filter(([, lines]) => lines.length > 0);
  const cut = ["added", "removed"].some((k) => changes.items[k].length < b[k].items || changes.episodes[k].length < b[k].episodes);
  const list = shown.length
    ? factList(shown)
    : h("p", { class: "muted" }, "No show or episode was added or removed: this build changed something else, such as titles or sources.");
  return h("div", null, head, list, cut ? h("p", { class: "hint" }, "Long lists are cut short; the counts in the list above are exact.") : null);
}

/** @param {import("./router.js").Scope} scope @param {URLSearchParams} [query] */
export function catalogView(scope, query) {
  const infoSlot = slot();
  const buildsSlot = slot();
  const warnings = h("details", { hidden: true });
  const problem = h("div");

  const reload = actionButton("Reload from disk", null, async () => {
    problem.replaceChildren();
    try {
      const r = await api("POST", "/catalog/reload");
      toast(`Catalog reloaded: build ${r.catalog.buildId}. Every TV refreshes its home screen.`);
      renderInfo(r.catalog);
      await shows.reload(r.catalog);
    } catch (err) {
      if (isUnauthorized(err)) return; // signed out
      if (!(err instanceof ApiError && err.code === "invalid_catalog")) return toast(errorText(err), "error");
      const issues = /** @type {any[]} */ (err.body?.issues ?? []).filter((i) => i.severity === "error");
      const why = h("strong", null, "The catalog on disk is invalid; the previous build stays active.");
      const list = h("ul", null, issues.slice(0, 20).map((i) => h("li", null, issueLine(i))));
      problem.replaceChildren(h("div", { class: "callout error", role: "alert" }, why, list));
    }
  });

  /** @param {any} c the answer of GET /admin/catalog */
  const renderInfo = (c) => {
    const facts = factList([
      ["Name", c.name],
      ["Catalog id", h("code", null, c.id)],
      ["Build", [h("code", null, c.buildId), h("span", { class: "muted" }, ` built ${formatRelative(c.builtAt)}, loaded ${formatRelative(c.loadedAt)}`)]],
      ["Contents", catalogContents(c.stats)],
      ["Adapters", c.adapters.length ? c.adapters.join(", ") : "none"],
      ["Resolver module", c.resolver ? [`provides ${c.resolver.adapters.join(", ") || "nothing"}`, h("br"), h("code", { class: "hash" }, `sha256 ${c.resolver.sha256}`)] : "none configured"],
      ["Server", `izle-server ${c.server.version}`],
    ]);
    warnings.hidden = c.warnings.length === 0;
    warnings.replaceChildren(h("summary", null, plural(c.warnings.length, "warning")), h("ul", null, c.warnings.map((/** @type {any} */ w) => h("li", null, issueLine(w)))));
    infoSlot.show(facts, warnings, problem, h("div", { class: "actions" }, reload));
    renderBuilds(c);
  };

  // The build history, newest first; below it what the selected build changed (by default the latest one after the
  // first load, whose changes come with GET /catalog; older ones are fetched on demand).
  /** @type {any[]} */
  let buildList = [];
  /** @type {Map<string, any>} changes fetched so far, by build id */
  let changesById = new Map();
  /** @type {Map<string, { li: HTMLElement, button: HTMLButtonElement }>} */
  let buildRows = new Map();
  const detail = h("div", { class: "build-detail", "aria-live": "polite" });
  let detailSeq = 0;

  const selectBuild = async (/** @type {string} */ buildId) => {
    for (const [id, row] of buildRows) {
      row.li.classList.toggle("current", id === buildId);
      row.button.setAttribute("aria-pressed", String(id === buildId));
    }
    const build = buildList.find((b) => b.buildId === buildId);
    if (!build) return;
    const mine = ++detailSeq;
    let changes = changesById.get(buildId);
    if (!changes && !build.baseline) {
      detail.replaceChildren(loading());
      try {
        changes = (await scope.read(`/catalog/builds/${encodeURIComponent(buildId)}`)).changes;
      } catch (err) {
        if (mine === detailSeq && scope.alive()) detail.replaceChildren(loadError(err, () => selectBuild(buildId), "Could not load what this build changed."));
        return;
      }
      if (mine !== detailSeq) return;
      changesById.set(buildId, changes);
    }
    detail.replaceChildren(buildDetail(build, changes));
  };

  /** @param {any} c */
  const renderBuilds = (c) => {
    buildList = c.builds ?? [];
    const latest = buildList.find((b) => !b.baseline);
    changesById = new Map(latest && c.changes ? [[latest.buildId, c.changes]] : []);
    buildRows = new Map();
    if (buildList.length === 0) return buildsSlot.show(h("p", { class: "muted" }, "No build recorded yet."));
    const row = (/** @type {any} */ b) => {
      const button = h("button", { type: "button", "aria-pressed": "false", "aria-label": `What changed in build ${shortId(b.buildId)}`, onclick: () => void selectBuild(b.buildId) }, "What changed");
      const when = ` · built ${formatRelative(b.builtAt)} · loaded ${formatRelative(b.loadedAt)}`;
      const meta = [h("code", null, shortId(b.buildId)), when];
      const li = h("li", null, h("div", { class: "row" }, rowText(buildSummary(b), meta), button));

      buildRows.set(b.buildId, { li, button });
      return li;
    };
    const older = buildList.slice(BUILDS_SHOWN);
    buildsSlot.show(
      h("ol", { class: "list builds" }, buildList.slice(0, BUILDS_SHOWN).map(row)),
      h("details", { hidden: older.length === 0 }, h("summary", null, plural(older.length, "older build")), h("ol", { class: "list builds" }, older.map(row))),
      detail,
    );
    void selectBuild((latest ?? buildList[0]).buildId);
  };

  scope.load(
    async () => renderInfo(await scope.read("/catalog")),
    (err, retry) => {
      infoSlot.fail(err, retry, "Could not load the catalog.");
      buildsSlot.fail(err, null, "Could not load the catalog.");
    },
  );

  // The filters go into the address without a new history entry (and without re-rendering the view).
  const shows = catalogBrowser(scope, {
    row: (/** @type {any} */ item) => ({ element: showRow(item, { meta: showMeta(item, { playable: true }), href: `#/catalog/items/${encodeURIComponent(item.id)}` }), update() {} }),
    label: "Search the shows",
    initial: parseBrowseHash(query ?? ""),
    onFilters: (f) => history.replaceState(null, "", browseHash(f)),
  });

  return page(
    { title: "Catalog" },
    scope.note,
    card("Bundle", infoSlot.element),
    card({ title: "Builds", intro: "Each build this server loaded, newest first, with what it added and removed compared with the build before it." }, buildsSlot.element),
    card("Shows", shows.element),
  );
}
