// @ts-check
// A show of the catalog: what it is, its episodes (a film: its sources) and "Test sources", which runs every
// source of an episode through the server's resolve path and shows what came back (no URLs: hosts and header
// names only).

import { ApiError, api, attempt } from "./api.js";
import { actionButton, card, h, page, poster, setTitle, slot, srOnly } from "./dom.js";
import { episodeName, errorText, formatClock, plural, showMeta, sourceReport } from "./lib.js";

/** @param {any} report the answer of POST /admin/diagnostics/resolve */
function reportView(report) {
  /** @type {Array<ReturnType<typeof sourceReport>>} */
  const sources = report.sources.map((/** @type {any} */ s) => sourceReport(s));
  const working = sources.filter((r) => r.ok).length;
  return h(
    "div",
    null,
    h("p", { class: "summary" }, `Working: ${working} of ${plural(sources.length, "source")}.`),
    h(
      "ul",
      { class: "diag" },
      sources.map((r) =>
        h(
          "li",
          { class: r.ok ? "ok" : "bad" },
          h("strong", null, h("span", { "aria-hidden": "true" }, r.ok ? "✔ " : "✖ "), srOnly(r.ok ? "Works: " : "Fails: "), r.sourceId),
          h("span", { class: "muted" }, ` ${r.how}`),
          h("div", null, r.lines.map((l) => h("div", null, l))),
        ),
      ),
    ),
  );
}

/**
 * One episode (or a film's only entry): what it is, its sources, and "Test sources".
 * @param {any} e
 * @param {any} item
 */
function episodeEntry(e, item) {
  const film = item.kind === "movie";
  const label = film ? item.title : episodeName(e, item.kind);
  const out = h("div", { "aria-live": "polite" });
  const test = actionButton("Test sources", { "aria-label": `Test sources of ${label}` }, async () => {
    out.replaceChildren(h("p", { class: "muted" }, "Testing every source… (adapters may take a few seconds)"));
    const r = await attempt(() => api("POST", "/diagnostics/resolve", { episodeId: e.id }));
    out.replaceChildren(r.ok ? reportView(r.value) : h("p", { class: "error" }, "The test could not run."));
  });
  const facts = [
    e.durationMs ? formatClock(e.durationMs) : null,
    e.playbackAllowed ? null : "playback not allowed",
    e.autoAdvance === false ? "no auto-advance after this one" : null,
  ].filter(Boolean);
  return h(
    film ? "div" : "li",
    null,
    h(
      "div",
      { class: "row top-align" },
      h(
        "div",
        { class: "grow" },
        film ? null : h("strong", null, label),
        facts.length ? h("div", { class: "muted" }, film ? `Duration ${facts.join(" · ")}` : facts.join(" · ")) : null,
        h(
          "ul",
          { class: "sources" },
          e.sources.map((/** @type {any} */ s) =>
            h(
              "li",
              null,
              h("code", null, s.id),
              ` ${s.type === "adapter" ? `adapter ${s.adapter}` : s.kind.toUpperCase()}${s.needsProxy ? " · proxied" : ""}${s.label ? ` · ${s.label}` : ""} · audio ${s.languages.audio === null ? "unknown" : s.languages.audio.join(", ") || "none"}`,
            ),
          ),
        ),
      ),
      e.sources.length ? test : null,
    ),
    out,
  );
}

/**
 * @param {import("./router.js").Scope} scope
 * @param {string} itemId
 */
export function itemView(scope, itemId) {
  const title = h("h1", null, "Show");
  const body = slot();

  scope.load(
    async () => {
      const { item } = await scope.read(`/catalog/items/${encodeURIComponent(itemId)}`);
      setTitle(title, item.title);
      const head = h(
        "section",
        { class: "card show-head" },
        h(
          "div",
          { class: "row top-align" },
          poster(item.posterUrl, item.title),
          h(
            "div",
            { class: "grow" },
            h(
              "p",
              { class: "muted" },
              [showMeta({ kind: item.kind, year: item.year, episodeCount: item.kind === "series" ? item.episodes.length : undefined }), item.originalTitle && item.originalTitle !== item.title ? item.originalTitle : null, item.genres.join(", ")]
                .filter(Boolean)
                .join(" · "),
            ),
            item.synopsis ? h("p", null, item.synopsis) : null,
            item.kind === "series" ? h("p", { class: "muted" }, item.autoAdvance ? "Episodes advance on their own." : "Episodes do not advance on their own.") : null,
          ),
        ),
      );
      const entries =
        item.kind === "movie" && item.episodes.length === 1
          ? card({ title: "Sources", intro: "Where the film is played from, in the order the TV tries them." }, episodeEntry(item.episodes[0], item))
          : card({ title: "Episodes", intro: "In play order, with their sources in the order the TV tries them." }, h("ol", { class: "list" }, item.episodes.map((/** @type {any} */ e) => episodeEntry(e, item))));
      body.show(head, entries);
    },
    (err, retry) => {
      if (err instanceof ApiError && err.code === "unknown_item") body.show(h("p", { class: "error" }, errorText(err)));
      else body.fail(err, retry, "Could not load this show.");
    },
  );

  return page({ back: ["#/catalog", "← Catalog"], title }, scope.note, body.element);
}
