// @ts-check
// The "Home screen" tab of a TV's page: the TV's Home drawn to scale, its grid, sections, hidden shows, the selected
// show's controls and "Add shows". Every edit is one single change on the server (never the whole list), and the screen
// redraws from the answer. Everything is built once and updated in place, so a refresh never takes the focus away.

import { api, attempt } from "./api.js";
import { catalogBrowser } from "./catalog-browser.js";
import { actionButton, card, chip, h, keepFocus, keyedRows, loadError, loading, onSubmit, options, progressBar, setOff, setProgress, showRow, toast, uid } from "./dom.js";
import {
  HOME_COLUMNS, HOME_MAX, HOME_ROWS, TV_W, UNTITLED, cardPlace, continueText, deleteSectionText, episodeName, episodeStateLabel, episodeStates,
  formatClock, gridSummary, onTv, percent, plural, resumes, sectionCount, sectionName, showMeta, tvCard, tvCardX, tvFace, tvHomeLayout, tvLineOf,
  tvMove, tvPanel, tvScrollBar, tvView,
} from "./lib.js";

/** @typedef {{ id: string, title: string | null, layout: string, itemIds: string[] }} Section */
/** @typedef {{ home: any[], sections: Section[], sectionsMax?: number }} HomeAnswer the TV's GET and every home change answer this */

/** @param {HTMLElement} el @param {number} x @param {number} y @param {number | null} [width] @param {number | null} [height] */
function setBox(el, x, y, width = null, height = null) {
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  if (width !== null) el.style.width = `${width}px`;
  if (height !== null) el.style.height = `${height}px`;
}

/** @param {any} e a home entry */
const nameOf = (e) => e.title ?? e.itemId;

/** @param {import("./view-device.js").DeviceContext} ctx */
export function homeCard(ctx) {
  /** Every entry of the Home list, in Home order (what the TV hides included). @type {any[]} */
  let entries = [];
  let sections = /** @type {Section[]} */ ([]);
  let sectionsMax = 20;
  /** Each section's cards on the TV, by section id. @type {Map<string, any[]>} */
  let shownIn = new Map();
  /** Each item's section, by item id. @type {Map<string, Section>} */
  let sectionOf = new Map();
  let selected = /** @type {string | null} */ (null);
  /** Each scrolling line's first card in view, by section id: it keeps its place when the selection leaves it. */
  /** @type {Record<string, number>} */
  let firsts = {};
  /** The screen's vertical scroll, in dp. */
  let offset = 0;
  /** The section chosen in the Sections list, which the screen scrolls to; null: the screen follows the selected card. */
  let anchor = /** @type {string | null} */ (null);

  const counter = h("span", { class: "muted count" });
  const itemPath = (/** @type {string} */ itemId) => `/home/items/${encodeURIComponent(itemId)}`;
  const sectionPath = (/** @type {string} */ sectionId) => `/home/sections/${encodeURIComponent(sectionId)}`;
  const shownAll = () => sections.flatMap((s) => shownIn.get(s.id) ?? []);

  let running = /** @type {Promise<unknown> | null} */ (null);
  /**
   * Saves one change (`method` on `path` below the TV's) and redraws from the answer, which it resolves with (null on
   * a failure, which toasts and reads the TV again). While a change is saved, a move or an add is ignored (each was
   * computed from what the owner saw); with `wait` (a title or a layout) the change waits for it.
   * @param {string} method @param {string} path @param {unknown} body @param {string} message @param {boolean} [wait]
   * @returns {Promise<any>}
   */
  const save = async (method, path, body, message, wait = false) => {
    if (running && !wait) return null;
    while (running) await running;
    const work = attempt(() => api(method, `${ctx.path}${path}`, body), message);
    running = work;
    view.setAttribute("aria-busy", "true");
    const r = await work;
    if (running === work) {
      running = null;
      view.removeAttribute("aria-busy");
    }
    if (r.ok) update(r.value);
    else void ctx.reload().catch(() => {});
    return r.ok ? r.value : null;
  };

  // --- the grid's size: previewed on the mirror as soon as it is chosen, saved with "Save grid" ---------------------
  let savedGrid = /** @type {{ columns: number, rows: number } | null} */ (null);
  const gridHint = h("p", { class: "hint", id: uid("grid-hint"), role: "status" });
  const sizeSelect = (/** @type {string} */ id, /** @type {number[]} */ sizes) =>
    h("select", { id: uid(id), "aria-describedby": gridHint.id }, options(sizes.map((n) => [String(n), String(n)])));
  const columns = sizeSelect("columns", HOME_COLUMNS);
  const rows = sizeSelect("rows", HOME_ROWS);
  const chosenGrid = () => ({ columns: Number(columns.value), rows: Number(rows.value) });
  const gridChanged = () => savedGrid !== null && (chosenGrid().columns !== savedGrid.columns || chosenGrid().rows !== savedGrid.rows);
  const showGrid = (/** @type {{ columns: number, rows: number }} */ g) => {
    columns.value = String(g.columns);
    rows.value = String(g.rows);
  };
  const saveGrid = actionButton("Save grid", null, async () => {
    if (!gridChanged()) return;
    const r = await attempt(() => api("PATCH", ctx.path, { homeColumns: chosenGrid().columns, homeRows: chosenGrid().rows }), "Grid saved. The TV applies it right away.");
    if (r.ok) await ctx.reload().catch(() => {});
  });
  // Undo hides itself: the focus goes back to the columns.
  const undoGrid = actionButton("Undo", null, async () => {
    if (!savedGrid) return;
    showGrid(savedGrid);
    draw();
    columns.focus();
  });
  for (const select of [columns, rows]) select.addEventListener("change", () => draw());
  const gridControls = h("div", { class: "grid-size" },
    h("label", { for: columns.id }, "Columns"), columns, h("label", { for: rows.id }, "Rows"), rows, saveGrid, undoGrid);

  // --- the mirror: the TV's screen, 960 × 540 dp scaled to the card's width ------------------------------------------
  const tvEmpty = h("div", { class: "tv-empty" }, h("strong", null, "Nothing here yet"), h("span", null, "The owner adds shows from the izle admin page."));
  const content = h("div", { class: "tv-content" });
  const view = h("div", { class: "tv-view", role: "listbox", "aria-label": "Home on the TV", "aria-describedby": gridHint.id }, content);
  // `overflow: clip` keeps the browser from scrolling it to a focused card; this catches a browser without it.
  view.addEventListener("scroll", () => view.scrollTo(0, 0));
  const thumb = h("span");
  const scrollBar = h("div", { class: "tv-scroll", "aria-hidden": "true", hidden: true }, thumb);
  const canvas = h("div", { class: "tv-canvas" }, tvEmpty, view, scrollBar);
  const screen = h("div", { class: "tv-screen" }, canvas);
  const scale = new ResizeObserver(() => (canvas.style.transform = `scale(${screen.clientWidth / TV_W})`));
  scale.observe(screen);
  ctx.scope.onCleanup(() => scale.disconnect());
  let L = tvHomeLayout(4, 2, []);

  // What fits on a card and in its panel is measured in the mirror's own font, as the TV measures in its own.
  const measure = document.createElement("canvas").getContext("2d");
  /** @type {Map<string, number>} */
  const widths = new Map();
  /** @type {import("./lib.js").MeasureText} */
  const measureText = (text, size) => {
    if (!measure) return 0;
    const font = `700 ${size}px ${getComputedStyle(canvas).fontFamily || "sans-serif"}`;
    const key = `${font}\n${text}`;
    if (!widths.has(key)) {
      measure.font = font;
      widths.set(key, measure.measureText(text).width);
    }
    return /** @type {number} */ (widths.get(key));
  };
  /** @param {HTMLElement} bar @param {number | null} pct */
  const setBar = (bar, pct) => {
    bar.hidden = pct === null;
    /** @type {HTMLElement} */ (bar.firstElementChild).style.width = `${pct ?? 0}%`;
  };

  /** @param {string} itemId */
  const tile = (itemId) => {
    // The card as it is closed: the poster (a channel's logo, whole), else the name; its chip, bar and "2 new".
    const picture = h("div", { class: "tv-picture" });
    let pictureKey = "";
    const badge = h("span", { class: "tv-chip" });
    const bar = h("div", { class: "tv-bar" }, h("span"));
    const shade = h("div", { class: "tv-shade" }, badge, bar);
    const fresh = h("span", { class: "tv-new" });
    // The open card's panel at its right, over the backdrop, else the poster blurred; plain for a channel or a show
    // without a picture. It is filled while the card is open and stays as it was while the card closes.
    const backdrop = h("div", { class: "tv-backdrop" });
    let backdropKey = "";
    const panelName = h("strong", { class: "tv-name" });
    const news = h("span", { class: "tv-text" });
    const action = h("span", { class: "tv-chip" });
    const episode = h("span", { class: "tv-text" });
    const panelBar = h("div", { class: "tv-bar" }, h("span"));
    const panel = h("div", { class: "tv-panel" }, backdrop,
      h("div", { class: "tv-panel-text" }, panelName, h("div", { class: "tv-panel-end" }, news, action, episode, panelBar)));
    const element = h("div", { class: "tv-tile", role: "option", id: uid("tile"), tabindex: "-1", "aria-selected": "false" },
      h("div", { class: "tv-card" }, h("div", { class: "tv-face" }, picture, shade, fresh), panel));
    element.addEventListener("click", () => select(itemId, true));
    return {
      element,
      /** @param {any} e @param {boolean} open */
      update(e, open) {
        const name = nameOf(e);
        const live = e.kind === "live";
        const poster = e.posterUrl ?? null;
        const key = JSON.stringify([poster, live, poster ? "" : name]);
        if (key !== pictureKey) {
          pictureKey = key;
          picture.className = live && poster ? "tv-picture logo" : "tv-picture";
          picture.replaceChildren(poster ? h("img", { src: poster, alt: "", loading: "lazy" }) : h("span", null, h("span", null, name)));
        }
        const c = tvCard(e);
        const f = tvFace(c, L.grid, measureText);
        badge.hidden = f.chip === null;
        badge.textContent = f.chip ?? "";
        badge.className = c.tone ? `tv-chip ${c.tone}` : "tv-chip";
        setBar(bar, c.progress);
        shade.hidden = f.chip === null && c.progress === null;
        fresh.hidden = !f.newEpisodes;
        fresh.textContent = `${c.newEpisodes} new`;
        element.setAttribute("aria-label", `${name}: ${c.chip}${c.progress !== null ? `, ${c.progress}% watched` : ""}${c.newEpisodes > 0 ? `, ${c.newEpisodes} new` : ""}`);
        if (!open) return;
        const behind = live ? null : e.backdropUrl ? { src: e.backdropUrl, blur: false } : poster ? { src: poster, blur: true } : null;
        const bKey = JSON.stringify(behind);
        if (bKey !== backdropKey) {
          backdropKey = bKey;
          backdrop.hidden = behind === null;
          backdrop.replaceChildren(...(behind ? [h("img", { src: behind.src, alt: "", class: behind.blur ? "blur" : null })] : []));
        }
        const p = tvPanel(c, name, L.grid, measureText);
        panelName.textContent = name;
        panelName.style.setProperty("--name-lines", String(p.nameLines));
        news.hidden = p.news === null;
        news.textContent = p.news ?? "";
        action.textContent = p.chip;
        action.className = `tv-chip${c.tone ? ` ${c.tone}` : ""}${p.chipSize === 24 ? " big" : ""}`;
        episode.hidden = p.episode === null;
        episode.textContent = p.episode ?? "";
        setBar(panelBar, p.progress);
      },
    };
  };
  /** @type {Map<string, ReturnType<typeof tile>>} */
  const tiles = new Map();

  /** @type {Map<string, { group: HTMLElement, line: HTMLElement, heading: HTMLElement, band: HTMLElement, cells: HTMLElement }>} */
  const sectionViews = new Map();
  const sectionView = (/** @type {string} */ id) => {
    let v = sectionViews.get(id);
    if (!v) {
      const line = h("div", { class: "tv-line", "aria-hidden": "true" });
      const heading = h("div", { class: "tv-heading", "aria-hidden": "true" });
      const band = h("div", { class: "tv-band", "aria-hidden": "true" }, "Empty: not shown on the TV");
      const cells = h("div", { class: "tv-cells" });
      v = { group: h("div", { class: "tv-section", role: "group" }, line, heading, band, cells), line, heading, band, cells };
      sectionViews.set(id, v);
    }
    return v;
  };

  /** A card's section index in the layout drawn last and its place among the section's cards. */
  const locate = (/** @type {string | null} */ itemId) => {
    const sec = itemId ? sectionOf.get(itemId) : undefined;
    if (!sec) return null;
    const s = L.sections.findIndex((b) => b.id === sec.id);
    const i = (shownIn.get(sec.id) ?? []).findIndex((e) => e.itemId === itemId);
    return s < 0 || i < 0 ? null : { s, i, sec };
  };

  const select = (/** @type {string} */ itemId, /** @type {boolean} */ focus) => {
    selected = itemId;
    anchor = null;
    draw();
    if (focus) tiles.get(itemId)?.element.focus({ preventScroll: true });
  };

  // ← → ↑ ↓ move the selection as the remote moves the focus on the TV; Home and End go to the first and last card.
  view.addEventListener("keydown", (ev) => {
    const at = locate(selected);
    if (!at) return;
    let to = /** @type {string | undefined} */ (undefined);
    if (ev.key === "Home" || ev.key === "End") to = shownAll().at(ev.key === "Home" ? 0 : -1)?.itemId;
    else if (ev.key.startsWith("Arrow")) {
      const m = tvMove(L, firsts, at.s, at.i, ev.key);
      to = m ? shownIn.get(L.sections[m.s].id)?.[m.i]?.itemId : undefined;
    } else return;
    ev.preventDefault();
    if (to) select(to, true);
  });

  const draw = () => {
    const hadFocus = view.contains(document.activeElement);
    const g = chosenGrid();
    L = tvHomeLayout(g.columns, g.rows, sections.map((s) => ({ id: s.id, title: s.title, layout: s.layout, count: (shownIn.get(s.id) ?? []).length })));
    const { grid, viewport } = L;
    const cols = grid.columns;
    view.style.top = `${viewport.y}px`;
    view.style.height = `${viewport.height}px`;
    view.style.setProperty("--card-w", `${grid.cardWidth}px`);
    view.style.setProperty("--card-h", `${grid.cardHeight}px`);
    view.style.setProperty("--open-w", `${grid.openWidth}px`);
    view.style.setProperty("--face-lines", String(grid.faceLines));
    content.style.height = `${L.contentHeight}px`;
    // The selected card is drawn open: the cards after it in its line move right by what it grew.
    const at = locate(selected);
    ({ firsts, offset } = tvView(L, firsts, at, anchor === null ? -1 : L.sections.findIndex((b) => b.id === anchor), offset));
    content.style.transform = `translateY(${-offset}px)`;
    const drawn = new Set(L.sections.map((b) => b.id));
    L.sections.forEach((box, k) => {
      const open = at?.s === k ? at.i : -1;
      const v = sectionView(box.id);
      if (content.children[k] !== v.group) content.insertBefore(v.group, content.children[k] ?? null);
      v.group.setAttribute("aria-label", box.empty ? `${sectionName(box)}, empty: not shown on the TV` : sectionName(box));
      v.line.hidden = box.lineY === null;
      if (box.lineY !== null) setBox(v.line, L.x0, box.lineY - 1, L.contentWidth);
      v.heading.hidden = box.titleTop === null;
      if (box.titleTop !== null) {
        v.heading.textContent = box.title;
        setBox(v.heading, L.x0, box.titleTop, L.contentWidth);
      }
      v.band.hidden = !box.empty;
      if (box.empty) setBox(v.band, L.x0, box.rowTops[0], L.contentWidth, grid.cardHeight);
      v.heading.classList.toggle("on", at?.s === k);
      // A scrolling line's cards are placed from its start; the line itself slides to its first card in view.
      v.cells.style.transform = box.row ? `translate(${L.x0 - (firsts[box.id] ?? 0) * L.pitch}px, ${box.rowTops[0]}px)` : "";
      (shownIn.get(box.id) ?? []).forEach((e, j) => {
        let t = tiles.get(e.itemId);
        if (!t) tiles.set(e.itemId, (t = tile(e.itemId)));
        t.update(e, j === open);
        const width = j === open ? grid.openWidth : grid.cardWidth;
        if (box.row) setBox(t.element, tvCardX(L, k, j, 0, open) - L.x0, 0, width);
        else setBox(t.element, tvCardX(L, k, j, 0, open), box.rowTops[Math.floor(j / cols)], width);
        if (v.cells.children[j] !== t.element) v.cells.insertBefore(t.element, v.cells.children[j] ?? null);
      });
    });
    const shownIds = new Set(shownAll().map((e) => e.itemId));
    for (const [map, keep] of /** @type {const} */ ([[sectionViews, drawn], [tiles, shownIds]])) {
      for (const [id, v] of map) {
        if (keep.has(id)) continue;
        ("group" in v ? v.group : v.element).remove();
        map.delete(id);
      }
    }

    const sb = tvScrollBar(L, offset);
    scrollBar.hidden = sb === null || shownIds.size === 0;
    if (sb) {
      setBox(scrollBar, sb.x, sb.y, sb.width, sb.height);
      setBox(thumb, 0, sb.thumbTop, null, sb.thumbHeight);
    }
    for (const [id, t] of tiles) {
      t.element.setAttribute("aria-selected", String(id === selected));
      t.element.tabIndex = id === selected ? 0 : -1;
    }
    // A card moved to another section, or removed, lost the focus: it goes to the selected card, else to "Add shows".
    if (hadFocus && !view.contains(document.activeElement)) (tiles.get(selected ?? "")?.element ?? browser.search).focus({ preventScroll: true });

    const summary = gridSummary(cols, grid.rows, L.lines * cols);
    gridHint.textContent = gridChanged() ? `${summary}. Preview: not saved yet.` : summary;
    setOff(saveGrid, !gridChanged());
    undoGrid.hidden = !gridChanged();
    showInspector();
  };

  // --- what the TV hides ------------------------------------------------------------------------------------------
  const hiddenList = h("ul", { class: "list" });
  const hiddenRow = (/** @type {any} */ first) => {
    const itemId = first.itemId;
    let entry = first;
    const name = h("strong");
    const why = chip("", "warn");
    const where = h("span", { class: "muted" });
    const remove = actionButton("Remove", { class: "danger", "data-control": "remove" }, () => save("DELETE", itemPath(itemId), undefined, `${nameOf(entry)} removed.`));
    return {
      element: h("li", { class: "row" }, h("div", { class: "grow" }, name, why, where), remove),
      /** @param {any} e */
      update(e) {
        entry = e;
        name.textContent = nameOf(e);
        why.textContent = e.missing ? "Missing from the catalog" : "Not playable";
        const sec = sectionOf.get(itemId);
        where.textContent = sec ? ` in ${sectionName(sec)}` : "";
        remove.setAttribute("aria-label", `Remove ${nameOf(e)}`);
      },
    };
  };
  const hiddenRows = keyedRows(hiddenList, (/** @type {any} */ e) => e.itemId, hiddenRow, () => browser.search);
  const hiddenBox = h("div", { class: "callout warn hidden-on-tv", hidden: true },
    h("p", null, h("strong", null, "Hidden on the TV"), " — a catalog reload took these away. They come back if the catalog has them again."), hiddenList);

  // --- the sections, in their order on the TV ------------------------------------------------------------------------
  const sectionList = h("ol", { class: "list sections", "aria-label": "Sections, in their order on the TV" });
  const sectionRow = (/** @type {Section} */ first) => {
    const id = first.id;
    let s = first;
    let index = 0;
    const label = () => sectionName(s);
    const up = actionButton("↑", { class: "icon", "data-control": "up" }, () => save("PATCH", sectionPath(id), { position: index - 1 }, "Order saved."));
    const down = actionButton("↓", { class: "icon", "data-control": "down" }, () => save("PATCH", sectionPath(id), { position: index + 1 }, "Order saved."));
    // The title: saved with Enter or on leaving the field; a blank one is put back (Escape too).
    const title = id === UNTITLED ? null : h("input", { type: "text", maxlength: "40", autocomplete: "off", spellcheck: "false", "aria-label": "Section title", "data-focus": `title:${id}`, "data-control": "title" });
    let sending = /** @type {string | null} */ (null);
    const commit = async () => {
      if (!title) return;
      const v = title.value.trim();
      title.value = v || (s.title ?? "");
      if (!v || v === s.title || v === sending) return;
      sending = v;
      await save("PATCH", sectionPath(id), { title: v }, `Section renamed to ${v}.`, true);
      sending = null;
    };
    title?.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        void commit();
      } else if (ev.key === "Escape") title.value = s.title ?? "";
    });
    title?.addEventListener("blur", () => void commit());
    const name = title ?? h("div", { class: "untitled-name" }, h("strong", null, "No title"), h("span", { class: "muted" }, " · shows in no section"));
    const scroll = h("input", { type: "checkbox", "data-control": "scroll" });
    scroll.addEventListener("change", () => {
      const row = scroll.checked;
      void save("PATCH", sectionPath(id), { layout: row ? "row" : "grid" }, row ? `${label()} is one scrolling line.` : `${label()} wraps in rows.`, true);
    });
    const count = h("span", { class: "muted" });
    // Delete asks in place; Keep (where the focus goes) leaves it.
    const del = h("button", { type: "button", class: "danger", "data-control": "delete" }, "Delete");
    const question = h("p", { id: uid("delete-q") });
    const confirm = actionButton("Delete", { class: "danger", "data-control": "confirm" }, () =>
      save("DELETE", sectionPath(id), undefined, s.itemIds.length > 0 ? `${label()} deleted. Its shows are in No title.` : `${label()} deleted.`));
    const keep = h("button", { type: "button" }, "Keep");
    const asking = h("div", { class: "confirm", role: "group", "aria-labelledby": question.id, hidden: true }, question, h("div", { class: "buttons" }, confirm, keep));
    const ask = (/** @type {boolean} */ on) => {
      asking.hidden = !on;
      del.hidden = on;
      (on ? keep : del).focus();
    };
    del.addEventListener("click", () => {
      question.textContent = deleteSectionText(label(), s.itemIds.length);
      ask(true);
    });
    keep.addEventListener("click", () => ask(false));
    const element = h("li", { class: id === UNTITLED ? "untitled" : "" },
      h("div", { class: "order", role: "group", "aria-label": "Move the section" }, up, down),
      h("div", { class: "grow" }, name,
        h("div", { class: "meta" }, h("label", { class: "check" }, scroll, "One scrolling line"), count, id === UNTITLED ? null : del)),
      id === UNTITLED ? null : asking);
    // Choosing a section scrolls the screen to it, as little as shows its first line with its title.
    const choose = () => {
      if (anchor === id) return;
      anchor = id;
      draw();
    };
    element.addEventListener("focusin", choose);
    element.addEventListener("click", choose);
    return {
      element,
      /** @param {Section} next @param {number} i @param {Section[]} all */
      update(next, i, all) {
        s = next;
        index = i;
        setOff(up, i === 0);
        setOff(down, i === all.length - 1);
        up.setAttribute("aria-label", `Move ${label()} up`);
        down.setAttribute("aria-label", `Move ${label()} down`);
        if (title && document.activeElement !== title) title.value = next.title ?? "";
        scroll.checked = next.layout === "row";
        scroll.setAttribute("aria-label", `${label()}: one scrolling line`);
        count.textContent = sectionCount(next.itemIds.length);
        del.setAttribute("aria-label", `Delete ${label()}`);
      },
    };
  };
  const sectionRows = keyedRows(sectionList, (/** @type {Section} */ s) => s.id, sectionRow, () => newTitle);

  // A new section goes at the end of Home, and its title field takes the focus.
  const newTitle = h("input", { type: "text", id: uid("new-section"), maxlength: "40", autocomplete: "off", spellcheck: "false", placeholder: "Title" });
  const addSection = h("button", { type: "submit" }, "Add");
  const addForm = h("form", { class: "add-section" }, h("label", { for: newTitle.id }, "Add section"), h("div", { class: "row" }, newTitle, addSection));
  const full = h("p", { class: "muted add-section", hidden: true });
  onSubmit(addForm, addSection, () => {
    const t = newTitle.value.trim();
    if (!t) {
      toast("Type the new section's title first.", "error");
      return newTitle.focus();
    }
    return async () => {
      const r = await save("POST", "/home/sections", { title: t }, `${t} added at the end of Home.`);
      if (!r) return;
      newTitle.value = "";
      const field = sectionList.querySelector(`[data-focus="${CSS.escape(`title:${r.sectionId}`)}"]`);
      if (field instanceof HTMLElement) field.focus();
    };
  });
  const sectionsHeading = h("h3", { id: uid("sections") }, "Sections");
  const sectionsPanel = h("section", { class: "sections-panel", "aria-labelledby": sectionsHeading.id },
    sectionsHeading, h("p", { class: "muted hint" }, "Top to bottom is their order on the TV."), sectionList, addForm, full);

  // --- the selected card: where it is, what OK plays, Play, Episodes…, moves, its section and Remove ------------------
  const where = h("p", { class: "muted where" });
  const name = h("h3", { tabindex: "-1" });
  const line = h("div", { class: "muted" });
  const progress = /** @type {HTMLElement} */ (progressBar(0, "How far"));
  const entryNow = () => (selected ? shownAll().find((e) => e.itemId === selected) : undefined);
  const play = actionButton("Play", { class: "primary" }, async () => {
    const e = entryNow();
    if (e?.kind === "live") await ctx.send({ type: "play", itemId: e.itemId }, "Play");
    else if (e?.continue) await ctx.send({ type: "play", episodeId: e.continue.episodeId }, "Play");
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
  /** Moves the selected card to where card `j` of its section (of those the TV shows) is. @param {(i: number, n: number) => number} target */
  const moveTo = (target) => {
    const at = locate(selected);
    const cards = at ? (shownIn.get(at.sec.id) ?? []) : [];
    const j = at ? target(at.i, cards.length) : -1;
    if (!at || j < 0 || j >= cards.length || j === at.i) return Promise.resolve();
    return save("PATCH", itemPath(cards[at.i].itemId), { position: at.sec.itemIds.indexOf(cards[j].itemId) }, "Order saved.");
  };
  const cols = () => L.grid.columns;
  const left = actionButton("◀", { class: "icon", "aria-label": "Move left" }, () => moveTo((i) => i - 1));
  const right = actionButton("▶", { class: "icon", "aria-label": "Move right" }, () => moveTo((i) => i + 1));
  const up = actionButton("▲", { class: "icon", "aria-label": "Move up a row" }, () => moveTo((i) => i - cols()));
  const down = actionButton("▼", { class: "icon", "aria-label": "Move down a row" }, () => moveTo((i, n) => Math.min(i + cols(), n - 1)));
  const first = actionButton("Move to first", null, async () => {
    const e = entryNow();
    if (e) await save("PATCH", itemPath(e.itemId), { position: 0 }, "Order saved.");
  });
  // The card goes to the end of the chosen section and stays selected there.
  const sectionChoice = h("select", { id: uid("section") });
  sectionChoice.addEventListener("change", async () => {
    const e = entryNow();
    const to = sections.find((s) => s.id === sectionChoice.value);
    if (!e || !to || sectionOf.get(e.itemId)?.id === to.id) return;
    const r = await save("PATCH", itemPath(e.itemId), { sectionId: to.id }, `${nameOf(e)} moved to ${sectionName(to)}.`);
    if (!r) showInspector();
  });
  // The card that takes its place is selected next (see `update`); with none left, the focus goes to "Add shows".
  const remove = actionButton("Remove from Home", { class: "danger" }, async () => {
    const e = entryNow();
    if (e) await keepFocus(() => save("DELETE", itemPath(e.itemId), undefined, `${nameOf(e)} removed.`), browser.search);
  });
  const inspector = h("section", { class: "inspector", "aria-label": "Selected show", hidden: true },
    where, h("div", { class: "row top-align" }, h("div", { class: "grow" }, name, line, progress), h("div", { class: "buttons" }, play, episodes)),
    h("div", { class: "buttons moves", role: "group", "aria-label": "Move the card" }, h("span", { class: "muted" }, "Move"), left, right, up, down, first,
      h("label", { for: sectionChoice.id }, "Section"), sectionChoice, h("span", { class: "grow" }), remove),
    pickerBox);

  /** @param {any} e */
  const setPicker = (e) => {
    picker?.sync(null, false);
    pickerOpen = false;
    pickerFor = e?.itemId ?? null;
    // "Continue from here" closes the picker: the focus goes to its toggle.
    picker = e?.kind === "series" ? episodePicker(ctx, e.itemId, async () => {
      pickerOpen = false;
      await keepFocus(async () => {
        showInspector();
        await ctx.reload();
      }, episodes);
    }) : null;
    pickerBox.replaceChildren(...(picker ? [picker.element] : []));
    if (picker) episodes.setAttribute("aria-controls", picker.element.id);
  };

  const showInspector = () => {
    const e = entryNow();
    const at = locate(selected);
    inspector.hidden = !e || !at;
    if (!e || !at) return setPicker(null);
    const box = L.sections[at.s];
    const n = box.count;
    where.textContent = cardPlace(box, at.i, n, cols());
    const title = nameOf(e);
    name.textContent = title;
    const c = e.continue;
    const live = e.kind === "live";
    line.replaceChildren(live ? chip("Live", "live") : continueText(c, e.kind), ...(!live && e.newEpisodes > 0 ? [" ", chip(plural(e.newEpisodes, "new episode"), "info")] : []));
    const pct = !live && resumes(c) ? percent(c.positionMs, c.durationMs) : null;
    progress.hidden = pct === null;
    if (pct !== null) setProgress(progress, pct, `${formatClock(c.positionMs)} of ${formatClock(c.durationMs)}`);
    play.setAttribute("aria-label", `Play ${title}`);
    setOff(play, live ? !e.playable : !c);
    const row = tvLineOf(L, at.s, at.i);
    setOff(left, at.i === 0);
    setOff(right, at.i === n - 1);
    setOff(up, box.row || row === 0);
    setOff(down, box.row || row === box.rowTops.length - 1);
    setOff(first, at.i === 0);
    sectionChoice.value = at.sec.id;
    sectionChoice.setAttribute("aria-label", `Section of ${title}`);
    remove.setAttribute("aria-label", `Remove ${title} from Home`);
    episodes.hidden = e.kind !== "series";
    if (pickerFor !== e.itemId) setPicker(e);
    episodes.setAttribute("aria-expanded", String(pickerOpen));
    episodes.textContent = pickerOpen ? "Hide episodes" : "Episodes…";
    picker?.sync(e, pickerOpen);
  };

  // --- Add shows: the catalog browser, with an Add on each show (or why it cannot be added) --------------------------
  // "Add to": the section a show is added to, the untitled one unless the owner picks another, kept while the tab is open.
  const addTo = h("select", { id: uid("add-to") });
  let addToId = UNTITLED;
  /** The sections the two section selects were last filled with. */
  let sectionsKey = "";
  addTo.addEventListener("change", () => (addToId = addTo.value));
  const addToBox = h("div", { class: "add-to" }, h("label", { for: addTo.id }, "Add to"), addTo);
  const resultRow = (/** @type {any} */ item) => {
    const add = actionButton("Add", { "data-control": "add", "data-focus": `add:${item.id}`, "aria-label": `Add ${item.title}` }, async () => {
      const after = browser.items().map((/** @type {any} */ r) => `add:${r.id}`);
      const at = after.indexOf(`add:${item.id}`);
      const to = sections.find((s) => s.id === addToId);
      const body = { itemId: item.id, sectionId: to?.id ?? UNTITLED };
      // The row's Add turns into "On Home": the focus goes to the next show's Add, else to the nearest one above, else
      // to the search box.
      await keepFocus(() => save("POST", "/home/items", body, `${item.title} added to ${to?.title ?? "Home"}.`), ...after.slice(at + 1), ...after.slice(0, at).reverse(), browser.search);
    });
    const reason = chip("");
    return {
      element: showRow(item, { meta: showMeta(item), end: h("div", { class: "end" }, add, reason) }),
      /** @param {any} next */
      update(next) {
        const onHome = sectionOf.has(next.id);
        const why = onHome ? "On Home" : next.playable === false ? "Not playable" : entries.length >= HOME_MAX ? "Home is full" : null;
        add.hidden = why !== null;
        reason.hidden = why === null;
        reason.textContent = why ?? "";
      },
    };
  };
  const browser = catalogBrowser(ctx.scope, { row: resultRow, label: "Add shows", heading: true, notOnDevice: ctx.id, above: addToBox });

  /** With `device`, also its saved grid (a grid being previewed stays). @param {HomeAnswer} d @param {any} [device] */
  const update = (d, device) => {
    // A selected card that went away (removed here or elsewhere, or hidden by a catalog reload) hands the selection
    // to the card that takes its place in Home order, else the one before it.
    const was = shownAll().findIndex((e) => e.itemId === selected);
    entries = d.home;
    sections = d.sections;
    if (typeof d.sectionsMax === "number") sectionsMax = d.sectionsMax;
    const byId = new Map(entries.map((e) => [e.itemId, e]));
    sectionOf = new Map(sections.flatMap((s) => s.itemIds.map((id) => [id, s])));
    shownIn = new Map(sections.map((s) => [s.id, s.itemIds.map((id) => byId.get(id)).filter((e) => e && onTv(e))]));
    if (device) {
      const before = savedGrid;
      savedGrid = { columns: device.settings.homeColumns, rows: device.settings.homeRows };
      const previewing = before && (chosenGrid().columns !== before.columns || chosenGrid().rows !== before.rows);
      if (!previewing) showGrid(savedGrid);
    }
    const shown = shownAll();
    counter.textContent = plural(entries.length, "show");
    // With nothing to show the TV says so; a section with nothing in it is in the Sections list.
    tvEmpty.hidden = shown.length > 0;
    view.hidden = shown.length === 0;
    hiddenRows.set(entries.filter((e) => !onTv(e)));
    hiddenBox.hidden = shown.length === entries.length;
    sectionRows.set(sections);
    addForm.hidden = sections.filter((s) => s.id !== UNTITLED).length >= sectionsMax;
    full.hidden = !addForm.hidden;
    full.textContent = `A Home holds at most ${sectionsMax} sections.`;
    if (!sections.some((s) => s.id === addToId)) addToId = UNTITLED;
    const key = JSON.stringify(sections.map((s) => [s.id, s.title]));
    if (key !== sectionsKey) {
      sectionsKey = key;
      for (const select of [addTo, sectionChoice]) select.replaceChildren(...options(sections.map((s) => [s.id, sectionName(s)])));
    }
    addTo.value = addToId;
    if (anchor !== null && !sections.some((s) => s.id === anchor)) anchor = null;
    if (!shown.some((e) => e.itemId === selected)) selected = shown[Math.min(Math.max(was, 0), shown.length - 1)]?.itemId ?? null;
    draw();
    browser.refresh();
  };

  const element = card(
    {
      title: "Home screen", aside: counter,
      intro: "The TV's Home, to scale: its sections one under the other, the cards left to right and row by row; further lines scroll into view. Select a card to play it, move it, choose its episode or remove it.",
    },
    gridControls, gridHint, h("div", { class: "home-bench" }, h("div", { class: "tv" }, screen), sectionsPanel), hiddenBox, inspector, browser.element,
  );
  return { element, update };
}

/**
 * The "continue from" picker of a series: its episodes with what the TV did with each, "Continue from here" and
 * "Play now". `sync(entry, open)` shows or hides it; an open picker reloads when what OK plays changed.
 * @param {import("./view-device.js").DeviceContext} ctx @param {string} itemId
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
    await keepFocus(() => element.replaceChildren(
      h("p", { class: "muted" }, "OK on the TV plays the episode marked “next”. Choose where it continues; that episode starts from its beginning."),
      h("ul", { class: "episodes" }, rows),
    ));
  };

  return {
    element,
    /** @param {any} next the row's home entry @param {boolean} open */
    sync(next, open) {
      entry = next;
      if (!open) {
        element.hidden = true;
        element.replaceChildren();
        key = "";
        seq++;
        return;
      }
      const k = JSON.stringify([entry.continue?.episodeId, entry.continue?.status, entry.continue?.positionMs]);
      if (element.hidden || k !== key) {
        element.hidden = false;
        key = k;
        void load();
      }
    },
  };
}
