// @ts-check
// The "Home screen" tab of a TV's page: the TV's Home drawn to scale (the same grid, cards, chips and titles), its
// grid size, what the TV hides, the selected show's controls (Play, Episodes…, moves, Remove) and "Add shows". A
// channel plays live: it has no "continue", progress or episodes. Every edit saves the whole list at once
// (`PUT …/home`). Everything is built once and updated in place, so a refresh never takes the focus away.

import { api, attempt } from "./api.js";
import { catalogBrowser } from "./catalog-browser.js";
import { actionButton, card, chip, h, keepFocus, keyedRows, loadError, loading, progressBar, setOff, setProgress, showRow, uid } from "./dom.js";
import {
  HOME_COLUMNS, HOME_MAX, HOME_ROWS, continueText, episodeName, episodeStateLabel, episodeStates, formatClock, gridSummary, moveItem, onTv,
  percent, plural, resumes, showMeta, tvCard, tvGrid,
} from "./lib.js";

/** The TV's screen in dp: the mirror draws it at this size and scales it to fit. */
const SCREEN_W = 960;

/** @param {import("./view-device.js").DeviceContext} ctx */
export function homeCard(ctx) {
  /** @type {any[]} */
  let entries = [];
  /** What the TV shows, in order. */
  /** @type {any[]} */
  let shown = [];
  let saving = false;
  /** The selected card's item, kept while it is on the TV. */
  let selected = /** @type {string | null} */ (null);

  const counter = h("span", { class: "muted count" });

  /** Saves the list. While a save runs, other edits are ignored (each is computed from the list it saw). */
  const save = async (/** @type {string[]} */ itemIds, /** @type {string} */ message) => {
    if (saving) return;
    saving = true;
    grid.setAttribute("aria-busy", "true");
    try {
      const r = await attempt(() => api("PUT", `${ctx.path}/home`, { itemIds }), message);
      if (r.ok) update(r.value.home);
    } finally {
      saving = false;
      grid.removeAttribute("aria-busy");
    }
  };
  const ids = () => entries.map((e) => e.itemId);

  // --- the grid's size: previewed on the mirror as soon as it is chosen, saved with "Save grid" ---------------------
  /** The TV's saved grid; null until the TV was read. */
  let savedGrid = /** @type {{ columns: number, rows: number } | null} */ (null);
  const columns = h("select", { id: uid("columns") }, HOME_COLUMNS.map((n) => h("option", { value: String(n) }, String(n))));
  const rows = h("select", { id: uid("rows") }, HOME_ROWS.map((n) => h("option", { value: String(n) }, String(n))));
  const gridHint = h("p", { class: "hint", id: uid("grid-hint"), role: "status" });
  columns.setAttribute("aria-describedby", gridHint.id);
  rows.setAttribute("aria-describedby", gridHint.id);
  const chosenGrid = () => ({ columns: Number(columns.value), rows: Number(rows.value) });
  const gridChanged = () => savedGrid !== null && (chosenGrid().columns !== savedGrid.columns || chosenGrid().rows !== savedGrid.rows);
  const saveGrid = actionButton("Save grid", null, async () => {
    if (!gridChanged()) return;
    const r = await attempt(() => api("PATCH", ctx.path, { homeColumns: chosenGrid().columns, homeRows: chosenGrid().rows }), "Grid saved. The TV applies it right away.");
    if (r.ok) await ctx.reload().catch(() => {});
  });
  // Undo hides itself: the focus goes back to the columns.
  const undoGrid = actionButton("Undo", null, async () => {
    if (!savedGrid) return;
    columns.value = String(savedGrid.columns);
    rows.value = String(savedGrid.rows);
    draw();
    columns.focus();
  });
  columns.addEventListener("change", () => draw());
  rows.addEventListener("change", () => draw());
  const gridControls = h("div", { class: "grid-size" },
    h("label", { for: columns.id }, "Columns"), columns, h("label", { for: rows.id }, "Rows"), rows, saveGrid, undoGrid);

  // --- the mirror: the TV's screen, 960 × 540 dp scaled to the card's width ------------------------------------------
  const tvEmpty = h("div", { class: "tv-empty" }, h("strong", null, "Nothing here yet"), h("span", null, "The owner adds shows from the izle admin page."));
  const grid = h("div", { class: "tv-grid", role: "listbox", "aria-label": "Home on the TV", "aria-describedby": gridHint.id });
  const canvas = h("div", { class: "tv-canvas" }, tvEmpty, grid);
  const screen = h("div", { class: "tv-screen" }, canvas);
  // Also when the tab is shown again: a hidden grid cannot scroll, so its selected row is brought into view then.
  const scale = new ResizeObserver(() => {
    canvas.style.transform = `scale(${screen.clientWidth / SCREEN_W})`;
    markSelected();
  });
  scale.observe(screen);
  ctx.scope.onCleanup(() => scale.disconnect());
  /** The layout drawn last. */
  let layout = tvGrid(4, 2);

  /** @param {any} first */
  const tile = (first) => {
    const itemId = first.itemId;
    const picture = h("div", { class: "tv-picture" });
    let pictureKey = "";
    const badge = h("span", { class: "tv-chip" });
    const bar = h("div", { class: "tv-bar" }, h("span"));
    const shade = h("div", { class: "tv-shade" }, badge, bar);
    const fresh = h("span", { class: "tv-new" });
    const title = h("span", { class: "tv-title" });
    const element = h("div", { class: "tv-tile", role: "option", id: uid("tile"), tabindex: "-1", "aria-selected": "false" },
      h("div", { class: "tv-card" }, picture, shade, fresh), title);
    element.addEventListener("click", () => select(itemId, true));
    return {
      element,
      /** @param {any} e */
      update(e) {
        const name = e.title ?? itemId;
        // The backdrop, else the poster cut around its upper part, else the title in the card.
        const url = e.backdropUrl ?? e.posterUrl ?? null;
        const key = JSON.stringify([url, e.backdropUrl ? "" : name]);
        if (key !== pictureKey) {
          pictureKey = key;
          picture.replaceChildren(url ? h("img", { src: url, alt: "", loading: "lazy", class: e.backdropUrl ? "" : "poster-cut" }) : h("span", null, name));
        }
        const c = tvCard(e);
        badge.textContent = c.chip;
        badge.className = c.tone ? `tv-chip ${c.tone}` : "tv-chip";
        bar.hidden = c.progress === null;
        /** @type {HTMLElement} */ (bar.firstElementChild).style.width = `${c.progress ?? 0}%`;
        fresh.hidden = c.newEpisodes === 0;
        fresh.textContent = `${c.newEpisodes} new`;
        title.textContent = name;
        element.setAttribute("aria-label", `${name}: ${c.chip}${c.progress !== null ? `, ${c.progress}% watched` : ""}${c.newEpisodes > 0 ? `, ${c.newEpisodes} new` : ""}`);
      },
    };
  };
  const tiles = keyedRows(grid, (/** @type {any} */ e) => e.itemId, tile);

  /** Selects a card (and with `focus`, moves the focus to it), and brings its row into the TV's view. */
  const select = (/** @type {string} */ itemId, /** @type {boolean} */ focus) => {
    selected = itemId;
    markSelected();
    showInspector();
    const t = tiles.rows.get(itemId)?.element;
    if (focus) t?.focus({ preventScroll: true });
  };

  /** Marks the selected card (the one Tab reaches) and scrolls the TV's grid as little as shows its row, as the TV does. */
  const markSelected = () => {
    for (const [id, t] of tiles.rows) {
      const on = id === selected;
      t.element.setAttribute("aria-selected", String(on));
      t.element.tabIndex = on ? 0 : -1;
    }
    const at = shown.findIndex((e) => e.itemId === selected);
    if (at < 0) return;
    const row = Math.floor(at / layout.columns);
    const top = row * (layout.cellHeight + layout.gap);
    const scrolled = grid.scrollTop;
    const view = layout.viewportHeight - 2 * layout.padding;
    if (top < scrolled) grid.scrollTop = top;
    else if (top + layout.cellHeight > scrolled + view) grid.scrollTop = top + layout.cellHeight - view;
  };

  // ← → ↑ ↓ Home End move the selection, as the remote moves the focus on the TV.
  grid.addEventListener("keydown", (ev) => {
    const at = shown.findIndex((e) => e.itemId === selected);
    if (at < 0) return;
    const to = { ArrowLeft: at - 1, ArrowRight: at + 1, ArrowUp: at - layout.columns, ArrowDown: at + layout.columns, Home: 0, End: shown.length - 1 }[ev.key];
    if (to === undefined) return;
    ev.preventDefault();
    if (to >= 0 && to < shown.length) select(shown[to].itemId, true);
  });

  /** Lays out the mirror for the chosen grid and the hint under it. */
  const draw = () => {
    const g = chosenGrid();
    layout = tvGrid(g.columns, g.rows);
    grid.style.setProperty("--columns", String(layout.columns));
    grid.style.setProperty("--card-w", `${layout.cardWidth}px`);
    grid.style.setProperty("--title-lines", String(layout.titleLines));
    grid.style.width = `${layout.viewportWidth}px`;
    grid.style.height = `${layout.viewportHeight}px`;
    const summary = gridSummary(layout.columns, layout.rows, shown.length);
    gridHint.textContent = gridChanged() ? `${summary}. Preview: not saved yet.` : summary;
    setOff(saveGrid, !gridChanged());
    undoGrid.hidden = !gridChanged();
    markSelected();
    showInspector();
  };

  // --- what the TV hides ------------------------------------------------------------------------------------------
  const hiddenList = h("ul", { class: "list" });
  /** @param {any} first */
  const hiddenRow = (first) => {
    const itemId = first.itemId;
    let entry = first;
    const name = h("strong");
    const why = chip("", "warn");
    const remove = actionButton("Remove", { class: "danger", "data-control": "remove" }, () => save(ids().filter((x) => x !== itemId), `${entry.title ?? itemId} removed.`));
    return {
      element: h("li", { class: "row" }, h("div", { class: "grow" }, name, why), remove),
      /** @param {any} e */
      update(e) {
        entry = e;
        name.textContent = e.title ?? itemId;
        why.textContent = e.missing ? "Missing from the catalog" : "Not playable";
        remove.setAttribute("aria-label", `Remove ${e.title ?? itemId}`);
      },
    };
  };
  const hiddenRows = keyedRows(hiddenList, (/** @type {any} */ e) => e.itemId, hiddenRow, () => browser.search);
  const hiddenBox = h("div", { class: "callout warn hidden-on-tv", hidden: true },
    h("p", null, h("strong", null, "Hidden on the TV"), " — a catalog reload took these away. They come back if the catalog has them again."), hiddenList);

  // --- the selected card: what OK plays, Play, Episodes…, moves and Remove --------------------------------------------
  const where = h("p", { class: "muted where" });
  const name = h("h3", { tabindex: "-1" });
  const line = h("div", { class: "muted" });
  const progress = /** @type {HTMLElement} */ (progressBar(0, "How far"));
  const entryNow = () => shown.find((e) => e.itemId === selected);
  const play = actionButton("Play", { class: "primary" }, () => {
    const e = entryNow();
    if (!e) return Promise.resolve();
    if (e.kind === "live") return ctx.send({ type: "play", itemId: e.itemId }, "Play");
    return e.continue ? ctx.send({ type: "play", episodeId: e.continue.episodeId }, "Play") : Promise.resolve();
  });
  /** The selected series' "continue from" picker: one per show, made when the show is selected. */
  let picker = /** @type {ReturnType<typeof episodePicker> | null} */ (null);
  let pickerFor = /** @type {string | null} */ (null);
  let pickerOpen = false;
  const pickerBox = h("div");
  const episodes = h("button", { type: "button", "aria-expanded": "false" }, "Episodes…");
  episodes.addEventListener("click", () => {
    pickerOpen = !pickerOpen;
    showInspector();
  });
  /** Moves the selected card to where the card at `to` (of those shown) is. @param {number} to */
  const moveTo = (to) => {
    const e = entryNow();
    if (!e || to < 0 || to >= shown.length) return Promise.resolve();
    const all = ids();
    const from = all.indexOf(e.itemId);
    return save(moveItem(all, from, all.indexOf(shown[to].itemId) - from), "Order saved.");
  };
  const at = () => shown.findIndex((e) => e.itemId === selected);
  const left = actionButton("◀", { class: "icon", "aria-label": "Move left" }, () => moveTo(at() - 1));
  const right = actionButton("▶", { class: "icon", "aria-label": "Move right" }, () => moveTo(at() + 1));
  const up = actionButton("▲", { class: "icon", "aria-label": "Move up a row" }, () => moveTo(at() - layout.columns));
  const down = actionButton("▼", { class: "icon", "aria-label": "Move down a row" }, () => moveTo(at() + layout.columns));
  const first = actionButton("Move to first", null, () => moveTo(0));
  // The card that takes its place is selected next (see `update`); with none left, the focus goes to "Add shows".
  const remove = actionButton("Remove from Home", { class: "danger" }, async () => {
    const e = entryNow();
    if (e) await keepFocus(() => save(ids().filter((x) => x !== e.itemId), `${e.title ?? e.itemId} removed.`), browser.search);
  });
  const inspector = h("section", { class: "inspector", "aria-label": "Selected show", hidden: true },
    where, h("div", { class: "row top-align" }, h("div", { class: "grow" }, name, line, progress), h("div", { class: "buttons" }, play, episodes)),
    h("div", { class: "buttons moves", role: "group", "aria-label": "Move the card" }, h("span", { class: "muted" }, "Move"), left, right, up, down, first,
      h("span", { class: "grow" }), remove),
    pickerBox);

  /** Shows the selected card in the inspector (or hides it with no card selected). */
  const showInspector = () => {
    const e = entryNow();
    inspector.hidden = !e;
    if (!e) {
      picker?.sync(null, false);
      picker = null;
      pickerFor = null;
      pickerBox.replaceChildren();
      return;
    }
    const i = at();
    const cols = layout.columns;
    const row = Math.floor(i / cols) + 1;
    where.textContent = `Card ${i + 1} of ${shown.length} · row ${row}, column ${(i % cols) + 1}${row > layout.rows ? " · below the first screen" : ""}`;
    const title = e.title ?? e.itemId;
    name.textContent = title;
    const c = e.continue;
    const live = e.kind === "live";
    line.replaceChildren(live ? chip("Live", "live") : continueText(c, e.kind), ...(!live && e.newEpisodes > 0 ? [" ", chip(plural(e.newEpisodes, "new episode"), "info")] : []));
    const pct = !live && resumes(c) ? percent(c.positionMs, c.durationMs) : null;
    progress.hidden = pct === null;
    if (pct !== null) setProgress(progress, pct, `${formatClock(c.positionMs)} of ${formatClock(c.durationMs)}`);
    play.setAttribute("aria-label", `Play ${title}`);
    setOff(play, live ? !e.playable : !c);
    setOff(left, i === 0);
    setOff(right, i === shown.length - 1);
    setOff(up, i - cols < 0);
    setOff(down, i + cols >= shown.length);
    setOff(first, i === 0);
    remove.setAttribute("aria-label", `Remove ${title} from Home`);
    // A series has the "continue from" picker.
    episodes.hidden = e.kind !== "series";
    if (pickerFor !== e.itemId) {
      picker?.sync(null, false);
      pickerOpen = false;
      pickerFor = e.itemId;
      // "Continue from here" closes the picker: the focus goes to its toggle.
      picker = e.kind === "series" ? episodePicker(ctx, e.itemId, async () => {
        pickerOpen = false;
        await keepFocus(async () => {
          showInspector();
          await ctx.reload();
        }, episodes);
      }) : null;
      pickerBox.replaceChildren(...(picker ? [picker.element] : []));
      if (picker) episodes.setAttribute("aria-controls", picker.element.id);
    }
    episodes.setAttribute("aria-expanded", String(pickerOpen));
    episodes.textContent = pickerOpen ? "Hide episodes" : "Episodes…";
    picker?.sync(e, pickerOpen);
  };

  // --- Add shows: the catalog browser, with an Add on each show (or why it cannot be added) --------------------------
  /** @param {any} item */
  const resultRow = (item) => {
    const add = actionButton("Add", { "data-control": "add", "data-focus": `add:${item.id}`, "aria-label": `Add ${item.title}` }, async () => {
      const after = browser.items().map((/** @type {any} */ r) => `add:${r.id}`);
      const at = after.indexOf(`add:${item.id}`);
      // The row's Add turns into "On Home": the focus goes to the next show's Add, else to the nearest one above, else
      // to the search box.
      await keepFocus(() => save([...ids(), item.id], `${item.title} added to Home.`), ...after.slice(at + 1), ...after.slice(0, at).reverse(), browser.search);
    });
    const reason = chip("");
    const element = showRow(item, { meta: showMeta(item), end: h("div", { class: "end" }, add, reason) });
    return {
      element,
      /** @param {any} next */
      update(next) {
        const onHome = entries.some((e) => e.itemId === next.id);
        const why = onHome ? "On Home" : next.playable === false ? "Not playable" : entries.length >= HOME_MAX ? "Home is full" : null;
        add.hidden = why !== null;
        reason.hidden = why === null;
        reason.textContent = why ?? "";
      },
    };
  };
  const browser = catalogBrowser(ctx.scope, { row: resultRow, label: "Add shows", heading: true, notOnDevice: ctx.id });

  /**
   * Shows the TV's home list and, with `device`, its saved grid (a grid being previewed stays until it is saved or
   * undone).
   * @param {any[]} home @param {any} [device]
   */
  const update = (home, device) => {
    // A selected card that went away (removed here or elsewhere, or hidden by a catalog reload) hands the selection,
    // and the focus if it had it, to the card that takes its place, else the one before it.
    const was = shown.findIndex((e) => e.itemId === selected);
    const hadFocus = grid.contains(document.activeElement);
    entries = home;
    shown = home.filter(onTv);
    if (device) {
      const before = savedGrid;
      savedGrid = { columns: device.settings.homeColumns, rows: device.settings.homeRows };
      if (!before || (chosenGrid().columns === before.columns && chosenGrid().rows === before.rows)) {
        columns.value = String(savedGrid.columns);
        rows.value = String(savedGrid.rows);
      }
    }
    counter.textContent = plural(entries.length, "show");
    tiles.set(shown);
    tvEmpty.hidden = shown.length > 0;
    grid.hidden = shown.length === 0;
    hiddenRows.set(entries.filter((e) => !onTv(e)));
    hiddenBox.hidden = shown.length === entries.length;
    if (!shown.some((e) => e.itemId === selected)) selected = shown[Math.min(Math.max(was, 0), shown.length - 1)]?.itemId ?? null;
    draw();
    if (hadFocus && !grid.contains(document.activeElement)) {
      const t = selected ? tiles.rows.get(selected)?.element : null;
      (t ?? browser.search).focus({ preventScroll: true });
    }
    browser.refresh();
  };

  const element = card(
    { title: "Home screen", aside: counter, intro: "The TV's Home, to scale: left to right, row by row; further rows scroll into view. Select a card to play it, move it, choose its episode or remove it." },
    gridControls, gridHint, h("div", { class: "tv" }, screen), hiddenBox, inspector, browser.element,
  );
  return { element, update };
}

/**
 * The "continue from" picker of a series: its episodes with what the TV did with each, "Continue from here" and
 * "Play now". `sync(entry, open)` shows or hides it for the row's home entry; an open picker reloads when what OK
 * plays changed.
 * @param {import("./view-device.js").DeviceContext} ctx
 * @param {string} itemId
 * @param {() => Promise<void>} continued runs once "Continue from here" moved where OK continues
 */
function episodePicker(ctx, itemId, continued) {
  const element = h("div", { class: "picker", id: uid("episodes"), hidden: true });
  /** @type {any} the home entry as of the last `sync` */
  let entry = null;
  let key = "";
  let seq = 0;

  const load = async () => {
    const mine = ++seq;
    if (!element.firstChild) element.replaceChildren(loading());
    let states;
    let kind;
    try {
      const [item, prog] = await Promise.all([ctx.scope.read(`/catalog/items/${encodeURIComponent(itemId)}`), ctx.scope.read(`${ctx.path}/progress`)]);
      kind = item.item.kind;
      const episodes = /** @type {Array<import("./lib.js").EpisodeLike & { id: string, playbackAllowed: boolean }>} */ (item.item.episodes);
      states = episodeStates(episodes, entry.continue?.episodeId ?? null, prog.progress.filter((/** @type {any} */ p) => p.itemId === itemId));
    } catch (err) {
      if (mine === seq && ctx.scope.alive()) element.replaceChildren(loadError(err, load, "Could not load the episodes."));
      return;
    }
    if (mine !== seq || element.hidden) return;
    const rows = states.map((s) => {
      const e = s.episode;
      const label = episodeName(e, kind);
      const continueHere = e.playbackAllowed && !s.current ? actionButton("Continue from here", { "data-focus": `continue:${e.id}`, "aria-label": `Continue from here: ${label}` }, async () => {
        const r = await attempt(() => api("PUT", `${ctx.path}/cursor`, { itemId, episodeId: e.id }), `${entry.title ?? itemId} continues from ${label}.`);
        if (r.ok) await continued();
      }) : null;
      const playNow = e.playbackAllowed ? actionButton("Play now", { "data-focus": `now:${e.id}`, "aria-label": `Play now: ${label}` }, () => ctx.send({ type: "play", episodeId: e.id }, "Play")) : null;
      return h("li", { class: s.current ? "current" : "" }, h("span", { class: "grow" }, label), chip(episodeStateLabel(s), s.current ? "ok" : ""), continueHere, playNow);
    });
    await keepFocus(() =>
      element.replaceChildren(
        h("p", { class: "muted" }, "OK on the TV plays the episode marked “next”. Choose where it continues; that episode starts from its beginning."),
        h("ul", { class: "episodes" }, rows),
      ),
    );
  };

  return {
    element,
    /** @param {any} next the row's home entry @param {boolean} open */
    sync(next, open) {
      entry = next;
      const k = JSON.stringify([entry.continue?.episodeId, entry.continue?.status, entry.continue?.positionMs]);
      if (!open) {
        element.hidden = true;
        element.replaceChildren();
        key = "";
        seq++;
      } else if (element.hidden || k !== key) {
        element.hidden = false;
        key = k;
        void load();
      }
    },
  };
}
