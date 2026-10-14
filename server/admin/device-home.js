// @ts-check
// The "Home screen" card of a TV's page: the shows on the TV's home screen, in order (▲ ▼ Play Episodes… ✕), the
// "continue from" picker of a series, and "Add shows", which searches the catalog as the owner types. Every edit
// saves the whole list at once (`PUT …/home`). Rows are kept per show, so moving one keeps the focus on its button.

import { api, attempt } from "./api.js";
import { actionButton, card, chip, h, keepFocus, keyedRows, liveSearch, loadError, loading, poster, progressBar, setOff, showRow, uid } from "./dom.js";
import {
  HOME_MAX,
  RESUME_MIN_MS,
  SEARCH_MAX,
  continueText,
  episodeName,
  episodeStateLabel,
  episodeStates,
  formatClock,
  moveItem,
  percent,
  plural,
  searchSummary,
  showMeta,
} from "./lib.js";

/**
 * @param {import("./view-device.js").DeviceContext} ctx
 * @returns {{ element: HTMLElement, update(home: any[]): void }}
 */
export function homeCard(ctx) {
  /** @type {any[]} */
  let entries = [];
  let saving = false;
  /** Item id whose "continue from" picker is open. */
  let openPicker = /** @type {string | null} */ (null);

  const counter = h("span", { class: "muted count" });
  const list = h("ol", { class: "list home" });
  const empty = h("p", { class: "muted" }, "The TV shows “Nothing here yet”. Add shows below.");
  const searchId = uid("add-shows");
  const hintId = uid("add-hint");
  const search = h("input", { type: "search", id: searchId, placeholder: "Search the catalog", autocomplete: "off", spellcheck: "false", "aria-describedby": hintId });

  /** Saves the list; while a save runs, other edits wait for it (each is computed from the list it saw). */
  const save = async (/** @type {string[]} */ itemIds, /** @type {string} */ message) => {
    if (saving) return;
    saving = true;
    list.setAttribute("aria-busy", "true");
    try {
      const r = await attempt(() => api("PUT", `${ctx.path}/home`, { itemIds }), message);
      if (r.ok) update(r.value.home);
    } finally {
      saving = false;
      list.removeAttribute("aria-busy");
    }
  };
  const ids = () => entries.map((e) => e.itemId);

  // Rows --------------------------------------------------------------------------------------------------------
  /** @param {any} first */
  const homeRow = (first) => {
    const itemId = first.itemId;
    /** @type {any} */
    let entry = first;
    const name = () => entry.title ?? itemId;
    const art = h("div", { class: "art" });
    let posterUrl = /** @type {string | null | undefined} */ (undefined);
    const title = h("strong");
    const line = h("div", { class: "muted" });
    const barBox = h("div");
    const up = actionButton("▲", { class: "icon", "data-control": "up" }, () => {
      const all = ids();
      return save(moveItem(all, all.indexOf(itemId), -1), "Order saved.");
    });
    const down = actionButton("▼", { class: "icon", "data-control": "down" }, () => {
      const all = ids();
      return save(moveItem(all, all.indexOf(itemId), 1), "Order saved.");
    });
    const play = actionButton("Play", { "data-control": "play" }, () => (entry.continue ? ctx.send({ type: "play", episodeId: entry.continue.episodeId }, "Play") : Promise.resolve()));
    const picker = h("div", { class: "picker", id: uid("episodes"), hidden: true });
    const toggle = h("button", { type: "button", "data-control": "episodes", "aria-controls": picker.id, "aria-expanded": "false" }, "Episodes…");
    toggle.addEventListener("click", () => {
      openPicker = openPicker === itemId ? null : itemId;
      syncPickers();
    });
    const remove = actionButton("✕", { class: "danger icon", "data-control": "remove" }, () => save(ids().filter((x) => x !== itemId), `${name()} removed.`));
    const element = h(
      "li",
      null,
      h("div", { class: "row" }, art, h("div", { class: "grow" }, title, line, barBox), h("div", { class: "buttons" }, up, down, play, toggle, remove)),
      picker,
    );

    let pickerKey = "";
    let pickerSeq = 0;
    const loadPicker = async () => {
      const mine = ++pickerSeq;
      if (!picker.firstChild) picker.replaceChildren(loading());
      let states;
      let kind;
      try {
        const [item, prog] = await Promise.all([ctx.read(`/catalog/items/${encodeURIComponent(itemId)}`), ctx.read(`${ctx.path}/progress`)]);
        kind = item.item.kind;
        const episodes = /** @type {Array<{ id: string, playbackAllowed: boolean }>} */ (item.item.episodes);
        states = episodeStates(episodes, entry.continue?.episodeId ?? null, prog.progress.filter((/** @type {any} */ p) => p.itemId === itemId));
      } catch (err) {
        if (mine === pickerSeq && ctx.scope.alive()) picker.replaceChildren(loadError(err, loadPicker, "Could not load the episodes."));
        return;
      }
      if (mine !== pickerSeq || picker.hidden) return;
      const rows = states.map((s) => {
        const e = /** @type {any} */ (s.episode);
        const label = episodeName(e, kind);
        return h(
          "li",
          { class: s.current ? "current" : "" },
          h("span", { class: "grow" }, label),
          chip(episodeStateLabel(s), s.current ? "ok" : ""),
          e.playbackAllowed && !s.current
            ? actionButton("Continue from here", { "data-focus": `continue:${e.id}`, "aria-label": `Continue from here: ${label}` }, async () => {
                const r = await attempt(() => api("PUT", `${ctx.path}/cursor`, { itemId, episodeId: e.id }), `${name()} continues from ${label}.`);
                if (!r.ok) return;
                openPicker = null;
                await keepFocus(async () => {
                  syncPickers();
                  await ctx.reload();
                }, toggle);
              })
            : null,
          e.playbackAllowed ? actionButton("Play now", { "data-focus": `now:${e.id}`, "aria-label": `Play now: ${label}` }, () => ctx.send({ type: "play", episodeId: e.id }, "Play")) : null,
        );
      });
      await keepFocus(() =>
        picker.replaceChildren(
          h("p", { class: "muted" }, "OK on the TV plays the episode marked “next”. Choose where it continues; that episode starts from its beginning."),
          h("ul", { class: "episodes" }, rows),
        ),
      );
    };

    /** Opens or closes the picker as `openPicker` says; an open one reloads when what OK plays changed. */
    const syncPicker = () => {
      const open = openPicker === itemId;
      toggle.setAttribute("aria-expanded", String(open));
      const key = JSON.stringify([entry.continue?.episodeId, entry.continue?.status, entry.continue?.positionMs]);
      if (!open) {
        picker.hidden = true;
        picker.replaceChildren();
        pickerKey = "";
        pickerSeq++;
      } else if (picker.hidden || key !== pickerKey) {
        picker.hidden = false;
        pickerKey = key;
        void loadPicker();
      }
    };

    return {
      element,
      syncPicker,
      /** @param {any} e @param {number} i @param {any[]} all */
      update(e, i, all) {
        entry = e;
        const n = name();
        title.textContent = n;
        if (posterUrl !== e.posterUrl) {
          posterUrl = e.posterUrl;
          art.replaceChildren(poster(e.posterUrl));
        }
        const c = e.continue;
        line.replaceChildren(
          ...(e.missing
            ? [chip("Missing from the catalog — hidden on the TV", "warn")]
            : [continueText(c, e.kind), e.newEpisodes > 0 ? " " : "", e.newEpisodes > 0 ? chip(plural(e.newEpisodes, "new episode"), "info") : ""]),
        );
        const watching = c && c.status === "watching" && c.positionMs >= RESUME_MIN_MS;
        const bar = watching ? progressBar(percent(c.positionMs, c.durationMs), `${n}: how far`, `${formatClock(c.positionMs)} of ${formatClock(c.durationMs)}`) : null;
        barBox.replaceChildren(...(bar ? [bar] : []));
        up.setAttribute("aria-label", `Move ${n} up`);
        down.setAttribute("aria-label", `Move ${n} down`);
        setOff(up, i === 0);
        setOff(down, i === all.length - 1);
        play.hidden = !c;
        play.setAttribute("aria-label", `Play ${n}`);
        toggle.hidden = e.kind !== "series";
        toggle.setAttribute("aria-label", `Episodes of ${n}`);
        remove.setAttribute("aria-label", `Remove ${n}`);
        syncPicker();
      },
    };
  };
  const rows = keyedRows(list, (/** @type {any} */ e) => e.itemId, homeRow, () => search);
  const syncPickers = () => {
    for (const r of rows.rows.values()) r.syncPicker();
  };

  // Add shows ---------------------------------------------------------------------------------------------------
  let showAll = false;
  /** @type {any[] | null} the last results shown, null while the hint shows */
  let results = null;
  const showAllButton = h("button", { type: "button" }, "Show all");
  const hint = h("div", { class: "search-hint", id: hintId }, h("span", { class: "muted" }, "Type a title to search the catalog."), showAllButton);
  const summary = h("p", { class: "summary muted", "aria-live": "polite" });
  const resultsList = h("div", { class: "list results" });
  const resultsArea = h("div", null, resultsList);

  /** @param {any} item */
  const resultRow = (item) => {
    const add = actionButton("Add", { "data-control": "add", "data-focus": `add:${item.id}`, "aria-label": `Add ${item.title}` }, async () => {
      const after = (results ?? []).map((/** @type {any} */ r) => `add:${r.id}`);
      const at = after.indexOf(`add:${item.id}`);
      // The row's Add turns into "On Home": the focus goes to the next show's Add, else the search box.
      await keepFocus(() => save([...ids(), item.id], `${item.title} added to Home.`), ...after.slice(at + 1), ...after.slice(0, at).reverse(), search);
    });
    const reason = chip("");
    const element = showRow(item, { meta: showMeta(item), end: h("div", { class: "end" }, add, reason) });
    return {
      element,
      /** @param {any} next */
      update(next) {
        const onHome = entries.some((e) => e.itemId === next.id);
        const why = onHome ? "On Home" : next.playableCount === 0 ? "Not playable" : entries.length >= HOME_MAX ? "Home is full" : null;
        add.hidden = why !== null;
        reason.hidden = why === null;
        reason.textContent = why ?? "";
      },
    };
  };
  const resultRows = keyedRows(resultsList, (/** @type {any} */ i) => i.id, resultRow, () => search);

  const finder = liveSearch(
    ctx.scope,
    search,
    async (query) => {
      if (!query.trim()) {
        if (!showAll) return null;
      } else showAll = false;
      return (await ctx.read(`/catalog/search?limit=${SEARCH_MAX}&q=${encodeURIComponent(query.trim())}`)).items;
    },
    (items, query) => {
      results = items;
      hint.hidden = items !== null;
      if (items === null) {
        summary.textContent = "";
        resultRows.set([]);
      } else {
        summary.textContent = searchSummary(items.length, query);
        resultRows.set(items);
      }
      resultsArea.replaceChildren(resultsList);
    },
    (err) => {
      summary.textContent = "";
      resultsArea.replaceChildren(loadError(err, finder.run, "Could not search the catalog."));
    },
  );
  search.addEventListener("input", () => {
    if (!search.value.trim()) showAll = false;
  });
  showAllButton.addEventListener("click", () => {
    showAll = true;
    void keepFocus(() => finder.run(), search);
  });

  /** @param {any[]} home */
  const update = (home) => {
    entries = home;
    counter.textContent = `${entries.length} / ${HOME_MAX}`;
    empty.hidden = entries.length > 0;
    rows.set(entries);
    if (results) resultRows.set(results);
  };

  const element = card(
    { title: "Home screen", aside: counter, intro: "What the TV shows, in this order. The first four fit on the screen without scrolling." },
    empty,
    list,
    h("h3", null, h("label", { for: searchId }, "Add shows")),
    search,
    hint,
    summary,
    resultsArea,
  );
  return { element, update };
}
