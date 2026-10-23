// @ts-check
// Pure helpers of the admin UI (no DOM): formatting, the texts views show, small list operations and the Listen
// along maths. Unit-tested from node (server/test/admin-ui.test.ts).

/** The server's limits (it enforces them): Home's items, and the grid's cards per row and rows per screen. */
export const HOME_MAX = 200;
export const HOME_COLUMNS = [3, 4, 5, 6];
export const HOME_ROWS = [1, 2, 3, 4];
/** The TV resumes a saved position only from 30 s on (PlaybackPlan); earlier positions start over. */
const RESUME_MIN_MS = 30_000;

/** `1:02:03` or `12:34`; `–` when unknown. @param {number | null | undefined} ms */
export function formatClock(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "–";
  const total = Math.floor(ms / 1000);
  const pad = (/** @type {number} */ n) => String(n).padStart(2, "0");
  const [h, m, s] = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60];
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * "just now", "5 min ago", "3 h ago", "2 days ago", or a date.
 * @param {string | null | undefined} iso @param {number} [now]
 */
export function formatRelative(iso, now = Date.now()) {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "–";
  const sec = Math.round((now - t) / 1000);
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 14) return d === 1 ? "yesterday" : `${d} days ago`;
  return new Date(t).toISOString().slice(0, 10);
}

/** The time left until `iso`, as `m:ss` (never negative). @param {string} iso @param {number} [now] */
export const formatCountdown = (iso, now = Date.now()) => formatClock(Math.max(0, Date.parse(iso) - now));

/** `123 456`: pairing codes read like they look on the TV. @param {string} code */
export const formatCode = (code) => (code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code);

/** The admin token of a sign-in link (`…/admin/#token=<token>`), else null. @param {string | null | undefined} hash */
export function tokenFromHash(hash) {
  const m = /^#token=(.+)$/.exec(hash ?? "");
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]).trim() || null;
  } catch {
    return null;
  }
}

/** What to type on a TV: the origin and a reverse proxy's prefix. @param {string} origin @param {string} pathname */
export const serverAddress = (origin, pathname) => `${origin}${pathname.replace(/\/admin(\/.*)?$/, "")}`;

/**
 * @typedef {{ season?: number | null, number?: number | null, title?: string | null, label?: string | null }}
 *   EpisodeLike
 */

/**
 * The catalog label, else "S2 · E5", else "Episode 5", plus the title. A film: its title, else "Film"; a channel:
 * "Live".
 * @param {EpisodeLike} e @param {string | null} [kind]
 */
export function episodeName(e, kind) {
  if (kind === "live") return "Live";
  let head = e.label ?? null;
  if (!head && e.number !== null && e.number !== undefined) {
    head = e.season !== null && e.season !== undefined ? `S${e.season} · E${e.number}` : `Episode ${e.number}`;
  }
  if (!head) return e.title ?? (kind === "movie" ? "Film" : "Episode");
  return e.title ? `${head} — ${e.title}` : head;
}

/**
 * What OK plays for a home entry (`continue` of `GET /admin/devices/<id>`).
 * @typedef {EpisodeLike & { episodeId: string, status: "new" | "watching" | "finished", positionMs: number,
 *   durationMs: number | null }} ContinueInfo
 */

/** Whether OK on the TV continues where it was, not from the start. @param {ContinueInfo | null | undefined} c */
export const resumes = (c) => c?.status === "watching" && c.positionMs >= RESUME_MIN_MS;

/** What OK does on the TV for a home entry. @param {ContinueInfo | null | undefined} c @param {string | null} kind */
export function continueText(c, kind) {
  if (kind === "live") return "Live";
  if (!c) return "Nothing playable";
  const which = kind === "series" ? `${episodeName(c, kind)} · ` : "";
  if (resumes(c)) {
    return `${which}continues at ${formatClock(c.positionMs)}${c.durationMs ? ` of ${formatClock(c.durationMs)}` : ""}`;
  }
  if (c.status === "watching") return `${which}starts from the beginning`;
  return c.status === "finished" ? `${which}watched — starts over` : `${which}new`;
}

/** 0–100, or null when unknown. @param {number | null | undefined} position @param {number | null | undefined} duration
 */
export function percent(position, duration) {
  if (!duration || duration <= 0 || position === null || position === undefined) return null;
  return Math.min(100, Math.max(0, Math.round((position / duration) * 100)));
}

/**
 * The muted line under a show's title: Film or Series (with its episode count) and the year; with `playable`, how many
 * episodes may be played when not all, or a channel the catalog does not allow.
 * @param {{ kind: string, year?: number | null, episodeCount?: number | null, playableCount?: number | null,
 *   playable?: boolean }} item
 * @param {{ playable?: boolean }} [o]
 */
export function showMeta(item, o = {}) {
  if (item.kind === "live") return o.playable && item.playable === false ? "Channel · not playable" : "Channel";
  const episodes = typeof item.episodeCount === "number" ? ` · ${plural(item.episodeCount, "episode")}` : "";
  const parts = [item.kind === "series" ? `Series${episodes}` : "Film"];
  if (item.year) parts.push(String(item.year));
  if (o.playable && typeof item.playableCount === "number" && typeof item.episodeCount === "number" && item.playableCount < item.episodeCount) {
    parts.push(item.playableCount === 0 ? "not playable" : `${item.playableCount} of ${item.episodeCount} playable`);
  }
  return parts.join(" · ");
}

// --- The catalog browser -----------------------------------------------------------------------------------------

export const BROWSE_PAGE = 50;
export const BROWSE_SORTS = /** @type {const} */ ([
  ["title", "By title"], ["year", "Newest year first"], ["newest", "Newest in the catalog first"],
]);
const BROWSE_KINDS = ["movie", "series", "live"];

/** The filters as typed (years too); `since` is a build id ("": any time). */
export const DEFAULT_FILTERS = { q: "", kind: "", genre: "", yearFrom: "", yearTo: "", playable: false, notOnHome: false, since: "", sort: "title" };
/** @typedef {typeof DEFAULT_FILTERS} BrowseFilters */
/** @typedef {{ buildId: string, loadedAt: string, baseline: boolean }} BrowseBuild */

/** Case-, accent- and dotless-ı-insensitive, as the server matches genres and titles. @param {string} text */
export const foldText = (text) => text.normalize("NFD").replace(/\p{M}/gu, "").replace(/ı/g, "i").toLowerCase();

/** A year box's value as a year within the bundle schema's bounds, or null. @param {string} text */
export function yearValue(text) {
  const t = text.trim();
  const n = Number(t);
  return /^\d+$/.test(t) && n >= 1870 && n <= 2200 ? n : null;
}

/** Whether any filter but the order narrows the list. @param {BrowseFilters} f */
export function isFiltered(f) {
  return f.q.trim() !== "" || f.kind !== "" || f.genre !== "" || yearValue(f.yearFrom) !== null || yearValue(f.yearTo) !== null || f.playable || f.notOnHome || f.since !== "";
}

/**
 * The `loadedAt` of a "new since" build; null for any time, the baseline (nothing in it is new) or a build gone.
 * @param {string} buildId @param {BrowseBuild[]} builds
 */
export function sinceAt(buildId, builds) {
  const b = builds.find((x) => x.buildId === buildId);
  return b && !b.baseline ? b.loadedAt : null;
}

/** "New" options: any time, then the builds after the baseline. @param {BrowseBuild[]} builds @param {number} [now] */
export function newSinceOptions(builds, now = Date.now()) {
  /** @type {Array<[string, string]>} */
  const options = [["", "Any time"]];
  for (const b of builds.filter((x) => !x.baseline)) {
    const when = formatRelative(b.loadedAt, now);
    options.push([b.buildId, options.length === 1 ? `Since the latest build (${when})` : `Since build ${shortId(b.buildId)} (${when})`]);
  }
  return options;
}

/**
 * The search request for one page, with only the parameters that are set.
 * @param {BrowseFilters} f
 * @param {{ offset: number, limit: number, sinceAt?: string | null, notOnDevice?: string | null }} o
 */
export function browsePath(f, o) {
  const p = new URLSearchParams();
  const from = yearValue(f.yearFrom);
  const to = yearValue(f.yearTo);
  for (const [key, value] of /** @type {const} */ ([
    ["q", f.q.trim()], ["kind", f.kind], ["genre", f.genre], ["yearFrom", from === null ? "" : String(from)],
    ["yearTo", to === null ? "" : String(to)], ["playable", f.playable ? "true" : ""], ["since", o.sinceAt ?? ""],
    ["notOnDevice", o.notOnDevice ?? ""], ["sort", f.sort === "title" ? "" : f.sort],
    ["offset", o.offset > 0 ? String(o.offset) : ""],
  ])) {
    if (value) p.set(key, value);
  }
  p.set("limit", String(o.limit));
  return `/catalog/search?${p}`;
}

/**
 * The line above the results: `All 7 shows.`, `Showing 50 of 1,234 shows that match “pro” (filtered).`
 * @param {number} shown @param {number} total @param {BrowseFilters} f
 */
export function browseSummary(shown, total, f) {
  const filtered = isFiltered(f);
  if (total === 0) return filtered ? "No show matches." : "The catalog has no shows.";
  const q = f.q.trim();
  const others = isFiltered({ ...f, q: "" }) ? " (filtered)" : "";
  const n = (/** @type {number} */ x) => x.toLocaleString("en-US");
  if (shown >= total && total === 1) {
    return filtered ? `1 show${q ? ` that matches “${q}”` : ""}${others}.` : "The catalog's only show.";
  }
  const suffix = `${q ? ` that match “${q}”` : ""}${others}`;
  return shown >= total ? `All ${n(total)} shows${suffix}.` : `Showing ${n(shown)} of ${n(total)} shows${suffix}.`;
}

/**
 * The filters in a hash's query (`#/catalog?q=pro&kind=series`), defaults for the rest and for what cannot be shown.
 * @param {URLSearchParams | string} query the query, with or without its `?`, or the whole `#/catalog?…` hash
 * @returns {BrowseFilters}
 */
export function parseBrowseHash(query) {
  let p = query;
  if (typeof p === "string") {
    const text = p.startsWith("#") ? (p.includes("?") ? p.slice(p.indexOf("?") + 1) : "") : p;
    p = new URLSearchParams(text);
  }
  const text = (/** @type {string} */ k) => p.get(k) ?? "";
  const year = (/** @type {string} */ k) => String(yearValue(text(k)) ?? "");
  const kind = text("kind");
  const sort = text("sort");
  return {
    q: text("q"), kind: BROWSE_KINDS.includes(kind) ? kind : "", genre: text("genre"), yearFrom: year("yearFrom"),
    yearTo: year("yearTo"), playable: text("playable") === "1", notOnHome: text("notOnHome") === "1",
    since: text("since"), sort: BROWSE_SORTS.some(([s]) => s === sort) ? sort : "title",
  };
}

/** The hash of the filters that are not the defaults (ticked boxes as `1`, only years). @param {BrowseFilters} f */
export function browseHash(f) {
  const p = new URLSearchParams();
  for (const key of /** @type {Array<keyof BrowseFilters>} */ (Object.keys(DEFAULT_FILTERS))) {
    const v = f[key];
    if (v === DEFAULT_FILTERS[key]) continue;
    if (typeof v === "boolean") p.set(key, "1");
    else if (key !== "yearFrom" && key !== "yearTo") p.set(key, v);
    else if (yearValue(v) !== null) p.set(key, String(yearValue(v)));
  }
  const query = p.toString();
  return query ? `#/catalog?${query}` : "#/catalog";
}

/**
 * `9 shows (7 films, 1 series, 1 channel) · 11 episodes, 11 playable · 13 sources` ("show" is any catalog item).
 * @param {{ items: number, movies: number, series: number, live?: number, episodes: number, playableEpisodes: number,
 *   sources: number }} s the catalog's `stats`
 */
export function catalogContents(s) {
  const kinds = `${plural(s.movies, "film")}, ${s.series} series, ${plural(s.live ?? 0, "channel")}`;
  return `${plural(s.items, "show")} (${kinds}) · ${plural(s.episodes, "episode")}, ${s.playableEpisodes} playable · ${plural(s.sources, "source")}`;
}

/** `HLS`, `DASH`, `MP4`, `MPEG-TS` (`ts`). @param {string} kind */
export const mediaKindLabel = (kind) => (kind === "ts" ? "MPEG-TS" : kind.toUpperCase());

/** @typedef {{ state: string, updatedAt: string }} NowPlaying */

/**
 * Whether playback is going on: a TV that stopped reporting for two minutes is not playing, whatever its last state.
 * @param {NowPlaying | null | undefined} n @param {boolean} online @param {number} [now]
 */
export function isActive(n, online, now = Date.now()) {
  if (!n || !online || !["starting", "playing", "paused"].includes(n.state)) return false;
  return now - Date.parse(n.updatedAt) < 2 * 60_000;
}

/**
 * @param {NowPlaying} n @param {boolean} online @param {number} [now]
 * @returns {{ label: string, tone: "ok" | "", active: boolean }}
 */
export function playbackState(n, online, now = Date.now()) {
  if (!isActive(n, online, now)) return { label: "Last played", tone: "", active: false };
  if (n.state === "playing") return { label: "Playing", tone: "ok", active: true };
  return { label: n.state === "paused" ? "Paused" : "Starting", tone: "", active: true };
}

/** `14:05` in the browser's time zone. @param {string} iso */
const clockTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * `1:02 / 10:00 · source tr-dub`; a channel: when its viewing started (if known) and the source, `since 14:05 · source
 * main`.
 * @param {{ itemKind?: string | null, positionMs: number | null, durationMs: number | null, sourceId: string | null }} n
 * @param {string | null} [startedAt] @param {(iso: string) => string} [formatTime]
 */
export function nowPlayingLine(n, startedAt = null, formatTime = clockTime) {
  const source = n.sourceId ? `source ${n.sourceId}` : null;
  if (n.itemKind === "live") return [startedAt ? `since ${formatTime(startedAt)}` : null, source].filter(Boolean).join(" · ");
  return [`${formatClock(n.positionMs)} / ${formatClock(n.durationMs)}`, source].filter(Boolean).join(" · ");
}

/**
 * Where and when a problem happened: show · episode · source · position · HTTP status · app.
 * @param {{ itemId: string | null, itemTitle: string | null, itemKind?: string | null, episodeId: string | null,
 *   episodeTitle: string | null, season: number | null, number: number | null, sourceId: string | null,
 *   positionMs: number | null, httpStatus: number | null, appVersion: string | null, missing: boolean }} p
 */
export function problemContext(p) {
  const parts = [];
  if (p.missing) parts.push(`${p.itemId ?? p.episodeId} (no longer in the catalog)`);
  else if (p.itemTitle) {
    parts.push(p.itemTitle);
    if (p.itemKind !== "movie" && p.itemKind !== "live") parts.push(episodeName({ season: p.season, number: p.number, title: p.episodeTitle }, p.itemKind));
  }
  if (p.sourceId) parts.push(`source ${p.sourceId}`);
  if (p.positionMs !== null && p.positionMs !== undefined) parts.push(`at ${formatClock(p.positionMs)}`);
  if (p.httpStatus !== null && p.httpStatus !== undefined) parts.push(`HTTP ${p.httpStatus}`);
  if (p.appVersion) parts.push(`app ${p.appVersion}`);
  return parts.join(" · ");
}

/**
 * `+2 shows · +14 episodes · −1 episode`; `first load` for the baseline (nothing in it counts as new).
 * @param {{ baseline: boolean, added: { items: number, episodes: number },
 *   removed: { items: number, episodes: number } }} b
 */
export function buildSummary(b) {
  if (b.baseline) return "first load";
  const parts = [];
  for (const [sign, counts] of /** @type {const} */ ([["+", b.added], ["−", b.removed]])) {
    if (counts.items > 0) parts.push(`${sign}${plural(counts.items, "show")}`);
    if (counts.episodes > 0) parts.push(`${sign}${plural(counts.episodes, "episode")}`);
  }
  return parts.length ? parts.join(" · ") : "nothing added or removed";
}

/**
 * A build's episodes by show, in order of appearance: `S1 E7`, else the label, else `E7`, else the id; one the catalog
 * does not allow to play is marked; a show without a title is named by its id.
 * @param {Array<{ id: string, itemId: string, itemTitle: string | null, season?: number | null, number?: number | null,
 *   label?: string | null, playbackAllowed?: boolean }>} list
 */
export function groupEpisodeChanges(list) {
  /** @type {Map<string, { itemId: string, title: string, episodes: string[] }>} */
  const groups = new Map();
  for (const e of list) {
    let group = groups.get(e.itemId);
    if (!group) groups.set(e.itemId, (group = { itemId: e.itemId, title: e.itemTitle ?? e.itemId, episodes: [] }));
    const { season = null, number = null } = e;
    const name = season !== null && number !== null ? `S${season} E${number}` : (e.label ?? (number !== null ? `E${number}` : e.id));
    group.episodes.push(e.playbackAllowed === false ? `${name} (not allowed)` : name);
  }
  return [...groups.values()];
}

/** A build id short enough for a list row: `20261014-1a2b3c4d5e6f…`. @param {string} id */
export const shortId = (id) => (id.length > 24 ? `${id.slice(0, 20)}…` : id);

/** `items.json /items/3/poster: file not found` @param {{ file: string, path?: string | null, message: string }} i */
export const issueLine = (i) => `${i.file}${i.path ? ` ${i.path}` : ""}: ${i.message}`;

/** Owner-facing text for API (and companion player) error codes. */
const ERRORS = /** @type {Record<string, string>} */ ({
  unauthorized: "The admin token is not valid.",
  too_many_attempts: "Too many wrong admin tokens were tried from this address. Try again in 10 minutes.",
  unknown_code: "That code is not waiting for approval any more. It may have expired: the TV shows a new one.",
  already_approved: "That code is already approved; the TV will pick it up in a moment.",
  too_many_items: `A home screen holds at most ${HOME_MAX} shows.`,
  duplicate_item: "That show is already on the home screen.",
  unknown_item: "That show is not in the catalog (any more).",
  not_playable: "That show has no episode that may be played, or that channel may not be played.",
  has_episodes: "That show is played through its episodes; only a channel is played by itself.",
  not_allowed: "Playback of that episode is not allowed by the catalog.",
  unknown_episode: "That episode is not in the catalog (any more).",
  unknown_device: "That TV does not exist any more.",
  unknown_build: "That build is not in the catalog's history.",
  invalid_catalog: "The catalog on disk is invalid; the previous one stays active.",
  invalid_request: "The server did not accept the request.",
  body_too_large: "The request was too large.",
  network: "The server cannot be reached.",
  internal: "The server ran into an error. Its log has details.",
  unknown_source: "That source is not in the catalog (any more).",
  unsupported_media: "That source is DASH or MPEG-TS, which a phone cannot play through the server.",
  no_playable_source: "The source could not be resolved right now.",
  no_link: "Save the timing for this episode first.",
  insufficient_scope: "This token may not do that; the admin page needs the owner token.",
  duplicate_name: "A token with that name exists already.",
  unknown_token: "That token does not exist (any more).",
  unknown_viewing: "That viewing does not exist (any more).",
  unknown_command: "That command is not stored (any more).",
  home_changed: "The home screen changed meanwhile; it was reloaded. Try again.",
  not_on_home: "That show is not on the home screen.",
  too_many_sections: "A Home holds at most 20 sections.",
  unknown_section: "That section is not on this Home (any more).",
  untitled_section: "The section without a title cannot be renamed or deleted.",
  duplicate_section: "That section is listed twice.",
  device_exists: "That TV still exists; forget it first.",
  hls_unsupported: "This browser cannot play HLS.",
  hls_unavailable: "The HLS player did not load. Reload the page and try again.",
  no_apk: "No TV app is stored on the server yet: fetch or upload one on the TV app page.",
  invalid_filename: "Name the file izle-tv-X.Y.Z.apk, as on the releases page.",
  not_an_apk: "That file is not an Android app (APK).",
  unsupported_media_type: "The server did not accept that kind of file; choose the APK.",
  apk_too_large: "That APK is larger than 64 MiB, the server's limit.",
  github_disabled: "Checks are off: this server is set to uploaded APKs only.",
  check_running: "A check is already running; its result shows here in a moment.",
  nothing_to_check: "Nothing to check: no episode or channel there may be played.",
  unknown_check: "That check is not kept any more: the server restarted, or another check followed it.",
});

/** Owner-facing text for anything that went wrong: an error with a string `code` is looked up. @param {unknown} err */
export function errorText(err) {
  const code = /** @type {{ code?: unknown } | null | undefined} */ (err)?.code;
  return typeof code === "string" ? ERRORS[code] ?? `The server answered: ${code}.` : "Something went wrong.";
}

/** `1 variant`, `2 variants`. @param {number} n @param {string} word */
export const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * "8 shows per screen", and the rows of Home below the first screen.
 * @param {number} columns @param {number} rows @param {number} homeCount
 */
export function gridSummary(columns, rows, homeCount) {
  const below = Math.ceil(homeCount / columns) - rows;
  return `${plural(columns * rows, "show")} per screen${below > 0 ? ` · ${plural(below, "more row")} below` : ""}`;
}

/**
 * The TV's Home grid in dp, as HomeGrid.compute of the TV app (keep the two in step) on its safe area: `columns` ×
 * `rows` portrait 2:3 cards (clamped to 3–6 × 1–4) as large as fit with one card of a row open (16:9 at the card's
 * height, `openWidth`), and no names under them. `rowWidth`: a row with one card open, from its first card's left edge
 * to its last card's right edge; the viewport is that and PADDING around it, exactly `rows` rows tall. `faceLines`: the
 * lines of a name that fit in a card without a picture. `height`: the area, less `SECTION_HEADER` when Home shows a
 * titled section.
 * @param {number} columns @param {number} rows @param {number} [height]
 */
export function tvGrid(columns, rows, height = TV_H - 2 * TV_SAFE_Y) {
  const width = TV_W - 2 * TV_SAFE_X;
  const gap = 20;
  const padding = 14;
  const cols = Math.min(HOME_COLUMNS[HOME_COLUMNS.length - 1], Math.max(HOME_COLUMNS[0], columns));
  const rowsShown = Math.min(HOME_ROWS[HOME_ROWS.length - 1], Math.max(HOME_ROWS[0], rows));
  // N − 1 cards and one open card (8/3 of a card) fit a row; R cards (3/2 of a card tall) fit the height.
  const widthBound = (3 * (width - 2 * padding - (cols - 1) * gap)) / (3 * cols + 5);
  const heightBound = (2 * (height - 2 * padding - (rowsShown - 1) * gap)) / (3 * rowsShown);
  const cardWidth = Math.max(1, Math.floor(Math.min(widthBound, heightBound)));
  const cardHeight = cardWidth * 1.5;
  const openWidth = Math.floor((8 * cardWidth) / 3);
  const rowWidth = (cols - 1) * (cardWidth + gap) + openWidth;
  return {
    columns: cols, rows: rowsShown, cardWidth, cardHeight, openWidth, gap, padding, rowWidth,
    viewportWidth: rowWidth + 2 * padding,
    viewportHeight: rowsShown * cardHeight + (rowsShown - 1) * gap + 2 * padding,
    faceLines: Math.max(1, Math.floor((cardHeight - 2 * CARD_INSET) / FACE_LINE)),
  };
}

// --- Home sections on the TV: the TV app's Home geometry (docs/ux/senior-tv.md#sections), keep the two in step ------

/** The TV's screen and safe margins, in dp. */
export const TV_W = 960;
const TV_H = 540;
const TV_SAFE_X = 48;
const TV_SAFE_Y = 27;
/** A section title's block: one 30 sp line (38 dp) and 6 dp under it, set aside once when Home has a titled section. */
export const SECTION_HEADER = 44;
export const UNTITLED = "untitled";
/** The scroll indicator in the right margin (HomeScreen.kt). */
const SCROLL_BAR_W = 6;
const SCROLL_BAR_END = 22;

/** @param {{ title: string | null }} s */
export const sectionName = (s) => s.title ?? "No title";

/** "6 shows", "1 show", "Empty". @param {number} n */
export const sectionCount = (n) => (n === 0 ? "Empty" : plural(n, "show"));

/** @param {string} title @param {number} n how many shows the section holds */
export function deleteSectionText(title, n) {
  if (n === 0) return `Delete ${title}?`;
  return n === 1 ? `Delete ${title}? Its show moves to No title.` : `Delete ${title}? Its ${n} shows move to No title.`;
}

/**
 * `count`: the cards the TV shows in the section (none: it leaves the section out).
 * @typedef {{ id: string, title: string | null, layout: string, count: number }} SectionInput
 */
/**
 * A section as drawn, y = 0 at the viewport's top. `row`: one scrolling line; `empty`: a titled section the TV does
 * not show (one dashed band); `top`: where its view starts (its title, else its cards less PADDING); `rowTops`: each
 * line's card top; `cellBottom`: the bottom of its last line's cards; `lineY`: the centre of the line above it.
 * @typedef {{ id: string, title: string | null, row: boolean, empty: boolean, count: number, top: number,
 *   titleTop: number | null, rowTops: number[], cellBottom: number, lineY: number | null }} SectionBox
 */
/**
 * `pitch`: from a closed card's left edge to the next; `viewport`: where the cards scroll, on the screen; `x0`: the
 * first column's left edge on the screen; `contentWidth`: a row with one card open; `lines`: the rows and scrolling
 * lines of all sections.
 * @typedef {{ grid: ReturnType<typeof tvGrid>, titled: boolean, pitch: number, viewport: { x: number, y: number,
 *   width: number, height: number }, x0: number, contentWidth: number, contentHeight: number, lines: number,
 *   sections: SectionBox[] }} HomeLayout
 */

/**
 * Home with sections as the TV app draws it: one card size for all of Home; each section starts where a next row of
 * the previous one would, a titled one with its title; a 2 dp line between two sections, in the middle of the gap
 * above the next. A row with one card open is centred in the safe area. Sections without a card on the TV are left
 * out, except a titled one: the admin page draws it as one row, its dashed band.
 * @param {number} columns @param {number} rows @param {SectionInput[]} sections in Home order
 * @returns {HomeLayout}
 */
export function tvHomeLayout(columns, rows, sections) {
  const titled = sections.some((s) => s.title !== null && s.count > 0);
  const reserve = titled ? SECTION_HEADER : 0;
  const grid = tvGrid(columns, rows, TV_H - 2 * TV_SAFE_Y - reserve);
  const { cardWidth, cardHeight, gap, padding, rowWidth } = grid;
  const x0 = TV_SAFE_X + (TV_W - 2 * TV_SAFE_X - rowWidth) / 2;
  const height = grid.viewportHeight + reserve;
  const viewport = { x: x0 - padding, y: (TV_H - height) / 2, width: grid.viewportWidth, height };
  /** @type {SectionBox[]} */
  const out = [];
  let cellBottom = 0;
  let lines = 0;
  for (const s of sections) {
    const count = s.count;
    const empty = count === 0;
    if (empty && s.title === null) continue;
    const row = !empty && s.layout === "row";
    const nRows = row || empty ? 1 : Math.ceil(count / grid.columns);
    const first = out.length === 0;
    const nextTop = first ? 0 : cellBottom + gap;
    const lineY = first ? null : Math.round((cellBottom + nextTop) / 2);
    const titleTop = s.title !== null ? nextTop : null;
    // The cards: under the title block and PADDING; untitled, PADDING under Home's top, or right where a row would be.
    const cardsTop = titleTop !== null ? nextTop + SECTION_HEADER + padding : first ? padding : nextTop;
    const rowTops = Array.from({ length: nRows }, (_, r) => cardsTop + r * (cardHeight + gap));
    cellBottom = cardsTop + (nRows - 1) * (cardHeight + gap) + cardHeight;
    lines += nRows;
    out.push({ id: s.id, title: s.title, row, empty, count, top: titleTop ?? cardsTop - padding, titleTop, rowTops, cellBottom, lineY });
  }
  return {
    grid, titled, pitch: cardWidth + gap, viewport, x0, contentWidth: rowWidth,
    contentHeight: out.length ? cellBottom + padding : 0, lines, sections: out,
  };
}

/**
 * A scrolling line's first card in view once the focus is on its card `focus` of `n`: it moves only when the focus
 * reaches the edge of what is in view, and never past its ends.
 * @param {number} first @param {number} focus @param {number} columns @param {number} n
 */
export const tvRowFirst = (first, focus, columns, n) => Math.max(0, Math.min(Math.max(first, focus - columns + 1), focus, Math.max(0, n - columns)));

/**
 * The left edge of card `i` of section `s` on the screen; `first`: a scrolling line's first card in view; `open`: the
 * section's open card (-1: none), which pushes the cards after it in its line right by what it grew.
 * @param {HomeLayout} L @param {number} s @param {number} i @param {number} first @param {number} [open]
 */
export function tvCardX(L, s, i, first, open = -1) {
  const box = /** @type {SectionBox} */ (L.sections[s]);
  const cols = L.grid.columns;
  const pushed = open >= 0 && open < i && (box.row || Math.floor(open / cols) === Math.floor(i / cols));
  return L.x0 + (box.row ? i - first : i % cols) * L.pitch + (pushed ? L.grid.openWidth - L.grid.cardWidth : 0);
}

/** The line (0-based) of card `i` in section `s`. @param {HomeLayout} L @param {number} s @param {number} i */
export const tvLineOf = (L, s, i) => (L.sections[s]?.row ? 0 : Math.floor(i / L.grid.columns));

/**
 * The scroll that shows line `r` of section `s` whole, moving as little as possible from `offset`: with the section's
 * title on its first line, and at the top on Home's first line.
 * @param {HomeLayout} L @param {number} s @param {number} r @param {number} offset
 */
export function tvScroll(L, s, r, offset) {
  const box = L.sections[s];
  const rowTop = box?.rowTops[r];
  if (!box || rowTop === undefined || (s === 0 && r === 0)) return 0;
  const p = L.grid.padding;
  const top = r === 0 ? box.top : rowTop - p;
  const to = Math.min(Math.max(offset, rowTop + L.grid.cardHeight + p - L.viewport.height), top);
  return Math.max(0, Math.min(to, L.contentHeight - L.viewport.height));
}

/**
 * What the screen shows after any redraw: every scrolling line within its ends; the selected card (`at`) in view, its
 * line moved as a focus move would and the screen scrolled to it; or, with `chosen` (a section's index, -1: none),
 * the screen scrolled to that section's first line.
 * @param {HomeLayout} L @param {Record<string, number>} firsts @param {{ s: number, i: number } | null} at
 * @param {number} chosen @param {number} offset
 */
export function tvView(L, firsts, at, chosen, offset) {
  const cols = L.grid.columns;
  /** @type {Record<string, number>} */
  const next = {};
  for (const box of L.sections) if (box.row) next[box.id] = Math.min(firsts[box.id] ?? 0, Math.max(0, box.count - cols));
  const box = at ? L.sections[at.s] : undefined;
  if (at && box?.row) next[box.id] = tvRowFirst(next[box.id] ?? 0, at.i, cols, box.count);
  if (chosen >= 0 && chosen < L.sections.length) return { firsts: next, offset: tvScroll(L, chosen, 0, offset) };
  if (at && box) return { firsts: next, offset: tvScroll(L, at.s, tvLineOf(L, at.s, at.i), offset) };
  return { firsts: next, offset: Math.max(0, Math.min(offset, L.contentHeight - L.viewport.height)) };
}

/**
 * Where the focus goes from card `i` of section `s` with an arrow key, as on the TV: ← → along the line, stopping at
 * its ends; ↑ ↓ to the previous or next line, across sections (an empty one has no card), onto the card in the
 * nearest column (a grid's column, or the place among the cards in view of a scrolling line). Null: it stays.
 * @param {HomeLayout} L @param {Record<string, number>} firsts @param {number} s @param {number} i @param {string} key
 * @returns {{ s: number, i: number } | null}
 */
export function tvMove(L, firsts, s, i, key) {
  const box = L.sections[s];
  if (!box || box.empty) return null;
  const cols = L.grid.columns;
  if (key === "ArrowLeft") return (box.row ? i > 0 : i % cols > 0) ? { s, i: i - 1 } : null;
  if (key === "ArrowRight") return i + 1 < box.count && (box.row || i % cols < cols - 1) ? { s, i: i + 1 } : null;
  if (key !== "ArrowUp" && key !== "ArrowDown") return null;
  const dir = key === "ArrowDown" ? 1 : -1;
  const firstOf = (/** @type {number} */ k) => firsts[L.sections[k]?.id ?? ""] ?? 0;
  const column = (/** @type {number} */ k, /** @type {number} */ j) => (L.sections[k]?.row ? j - firstOf(k) : j % cols);
  let ts = s;
  let tr = tvLineOf(L, s, i) + dir;
  if (tr < 0 || tr >= box.rowTops.length) {
    do ts += dir;
    while (L.sections[ts]?.empty);
    const t = L.sections[ts];
    if (!t) return null;
    tr = dir > 0 ? 0 : t.rowTops.length - 1;
  }
  const t = /** @type {SectionBox} */ (L.sections[ts]);
  const from = t.row ? Math.min(firstOf(ts), Math.max(0, t.count - 1)) : tr * cols;
  const col = column(s, i);
  const distance = (/** @type {number} */ j) => Math.abs(column(ts, j) - col);
  let best = from;
  for (let j = from + 1; j < Math.min(t.count, from + cols); j++) if (distance(j) < distance(best)) best = j;
  return { s: ts, i: best };
}

/** The scroll indicator while Home is taller than its viewport. @param {HomeLayout} L @param {number} offset */
export function tvScrollBar(L, offset) {
  const vh = L.viewport.height;
  if (L.contentHeight <= vh) return null;
  const track = vh - 2 * L.grid.padding;
  return {
    x: TV_W - SCROLL_BAR_END - SCROLL_BAR_W, y: L.viewport.y + L.grid.padding, width: SCROLL_BAR_W, height: track,
    thumbTop: (offset / L.contentHeight) * track, thumbHeight: (vh / L.contentHeight) * track,
  };
}

// --- A card's face and its open panel (docs/ux/senior-tv.md#home): what fits, measured in the page's own font -------

/** Around what is drawn on a card (IzleSpacing.Small), and the panel's inset (IzleSpacing.Medium), in dp. */
const CARD_INSET = 8;
const PANEL_INSET = 12;
/** Line heights, in dp: a name in a card without a picture (24 sp bold), the panel's name (26 sp bold) and text (24 sp). */
const FACE_LINE = 32;
const NAME_LINE = 34;
const TEXT_LINE = 32;
/** A chip's horizontal padding and border, both sides; its height at 16 sp and at 24 sp; the "2 new" chip's height. */
const CHIP_X = 18;
const CHIP_16 = 26;
const CHIP_24 = 38;
const NEW_CHIP = 24;
/** The progress bar's height. */
const BAR = 6;

/** A resuming chip's first part ("Continue · Episode 2"), alone when the whole chip does not fit. */
const CONTINUE = "Continue";

/**
 * The width of `text` on one line at `size` px (16, 24 or 26), in bold unless `weight` says otherwise.
 * @typedef {(text: string, size: number, weight?: number) => number} MeasureText
 */

/**
 * The lines `text` wraps to at `width` (word by word; a word wider than the line takes a line of its own).
 * @param {string} text @param {number} width @param {number} size @param {MeasureText} measure
 */
export function wrapLines(text, width, size, measure) {
  const words = text.split(/\s+/).filter(Boolean);
  let lines = 0;
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (line && measure(next, size) > width) {
      lines++;
      line = w;
    } else line = next;
  }
  return lines + (line ? 1 : 0);
}

/**
 * What a card that is not open shows over its picture: the 16 sp chip ("Continue · Episode 2" as "Continue" when it
 * does not fit; null when nothing fits), and whether the "2 new" chip fits at the top right.
 * @param {ReturnType<typeof tvCard>} c @param {ReturnType<typeof tvGrid>} grid @param {MeasureText} measure
 */
export function tvFace(c, grid, measure) {
  const room = grid.cardWidth - 2 * CARD_INSET;
  const bar = c.progress !== null ? BAR + CARD_INSET : 0;
  const fits = (/** @type {string} */ text) => measure(text, 16) + CHIP_X <= room && CARD_INSET + CHIP_16 + bar + CARD_INSET <= grid.cardHeight;
  const chip = fits(c.chip) ? c.chip : c.episode !== null && fits(CONTINUE) ? CONTINUE : null;
  const bottom = chip !== null ? CARD_INSET + CHIP_16 + bar + CARD_INSET : bar ? bar + CARD_INSET : 0;
  // The "2 new" chip is not bold (labelSmall).
  const fresh = c.newEpisodes > 0 && measure(`${c.newEpisodes} new`, 16, 400) + CHIP_X <= room && CARD_INSET + NEW_CHIP + bottom <= grid.cardHeight;
  return { chip, newEpisodes: fresh };
}

/**
 * The open card's panel (`openWidth` less the card's width, 12 dp inside): the name's lines (1–3), "2 new episodes"
 * (null: left out), the chip saying what OK does and its size (24, else 16 when too wide, or too tall under one line
 * of name), the episode line under a "Continue" chip too wide with its episode (null: none), and the progress bar.
 * Whatever else does not fit the height is left out in this order: "2 new episodes", the episode line, name lines
 * down to one, then the progress bar (null: none, or left out). A channel: its name and Live.
 * @param {ReturnType<typeof tvCard>} c @param {string} name @param {ReturnType<typeof tvGrid>} grid
 * @param {MeasureText} measure
 */
export function tvPanel(c, name, grid, measure) {
  const width = grid.openWidth - grid.cardWidth - 2 * PANEL_INSET;
  const height = grid.cardHeight - 2 * PANEL_INSET;
  const chipFits = (/** @type {string} */ text) => measure(text, 24) + CHIP_X <= width;
  let chip = c.chip;
  /** @type {string | null} */
  let episode = null;
  if (c.episode !== null && !chipFits(c.chip)) [chip, episode] = [CONTINUE, c.episode];
  // At 24 sp when it fits the width, and the height under one line of name with the bar.
  const bar = c.progress !== null ? CARD_INSET + BAR : 0;
  const chipSize = chipFits(chip) && NAME_LINE + CARD_INSET + CHIP_24 + bar <= height ? 24 : 16;
  /** @type {string | null} */
  let news = c.newEpisodes > 0 ? plural(c.newEpisodes, "new episode") : null;
  let nameLines = Math.max(1, Math.min(3, wrapLines(name, width, 26, measure)));
  let progress = c.progress;
  const used = () => {
    const bottom = [news ? TEXT_LINE : 0, chipSize === 24 ? CHIP_24 : CHIP_16, episode ? TEXT_LINE : 0, progress !== null ? BAR : 0].filter((x) => x > 0);
    return nameLines * NAME_LINE + CARD_INSET + bottom.reduce((a, b) => a + b, 0) + (bottom.length - 1) * CARD_INSET;
  };
  while (used() > height) {
    if (news) news = null;
    else if (episode) episode = null;
    else if (nameLines > 1) nameLines--;
    else if (progress !== null) progress = null;
    else break;
  }
  return { nameLines, news, chip, chipSize, episode, progress };
}

/**
 * "Films · card 3 of 6 · row 1, column 3"; "Channels · card 5 of 6" in a scrolling line.
 * @param {{ title: string | null, row: boolean }} section @param {number} i @param {number} count @param {number} columns
 */
export function cardPlace(section, i, count, columns) {
  const where = `${sectionName(section)} · card ${i + 1} of ${count}`;
  return section.row ? where : `${where} · row ${Math.floor(i / columns) + 1}, column ${(i % columns) + 1}`;
}

/** Whether the TV shows an entry (in the catalog, playable). @param {{ missing?: boolean, playable?: boolean }} e */
export const onTv = (e) => !e.missing && e.playable !== false;

/**
 * Whether the TV resumes `c` (PlaybackPlan.resumePositionMs): watching, from 30 s on, and not within the credits
 * allowance of the end (5 % of the duration, at least 2 min, at most 10 %). @param {ContinueInfo} c
 */
function tvResumes(c) {
  if (c.status !== "watching" || c.positionMs < RESUME_MIN_MS) return false;
  const d = c.durationMs;
  return !d || d <= 0 || d - c.positionMs > Math.min(Math.max(120_000, d * 0.05), d * 0.1);
}

/**
 * What a card on the TV's Home shows over its picture (EpisodeNames.badge, tileBadgeText and ActionChip): the chip
 * (`tone` "live", "new", "resume" or ""), the progress bar's percent (null: none), the "2 new" count (0: none) and,
 * when the chip is "Continue · Episode 2", the episode it resumes (`episode`; null otherwise).
 * @param {{ kind: string, continue: (ContinueInfo & { index?: number }) | null, newEpisodes?: number }} e
 */
export function tvCard(e) {
  if (e.kind === "live") return { chip: "Live", tone: "live", progress: null, newEpisodes: 0, episode: null };
  const c = e.continue;
  const newEpisodes = Math.max(0, e.newEpisodes ?? 0);
  if (!c) return { chip: "New", tone: "new", progress: null, newEpisodes, episode: null };
  const resume = tvResumes(c);
  const progress = resume && c.durationMs ? percent(c.positionMs, c.durationMs) : null;
  if (e.kind === "series") {
    const number = c.number ?? (c.index ?? 0) + 1;
    const label = c.label?.trim();
    const name = label || (c.season !== null && c.season !== undefined && c.season > 1 ? `Season ${c.season}, Episode ${number}` : `Episode ${number}`);
    return { chip: resume ? `${CONTINUE} · ${name}` : name, tone: resume ? "resume" : "", progress, newEpisodes, episode: resume ? name : null };
  }
  if (resume) return { chip: CONTINUE, tone: "resume", progress, newEpisodes, episode: null };
  if (c.status === "finished") return { chip: "Watch again", tone: "", progress, newEpisodes, episode: null };
  return { chip: "New", tone: "new", progress, newEpisodes, episode: null };
}

// --- checks: one source's report, a playable's stored summary, a Home entry's results, a batch run ----------------

/** What a failed source attempt means. */
const TRIED = /** @type {Record<string, string>} */ ({
  empty: "the adapter found nothing to play",
  timeout: "timed out",
  abort: "cancelled",
  error: "the adapter failed",
  adapter_unavailable: "no resolver module provides this adapter",
  unsupported: "cannot be served (DASH that needs upstream headers)",
});

/** What each step of a source's check fetched, as the TV would. */
const STEPS = /** @type {Record<string, string>} */ ({
  playlist: "playlist", variant: "variant playlist", rendition: "rendition playlist", segment: "segment", init: "init segment",
  key: "key", subtitle: "subtitles", file: "file", manifest: "DASH manifest",
});

/** Why a step failed (`http`: its status says it). */
const STEP_ERRORS = /** @type {Record<string, string>} */ ({
  timeout: "timed out",
  network: "could not connect",
  http: "HTTP error",
  not_a_playlist: "not a playlist",
  too_large: "too large",
  not_media: "not media",
  bad_key: "not a 16-byte key",
  egress_denied: "refused by the server's egress policy",
  not_subtitles: "not subtitles",
  not_mpd: "not a DASH manifest",
  aborted: "cancelled",
  budget: "the source's time ran out",
});

/** What a step found. */
const CONTAINERS = /** @type {Record<string, string>} */ ({
  ts: "MPEG-TS", mp4: "MP4", fmp4: "fMP4", aac: "AAC", id3: "ID3 audio", webvtt: "WebVTT", srt: "SRT", ttml: "TTML", mpd: "MPD", m3u8: "M3U8",
});

/** What a warning means: the source works, but something may still go wrong on the TV. */
const WARNINGS = /** @type {Record<string, string>} */ ({
  risky_codec: "a codec that may not decode on every TV",
  high_resolution: "above 1080p: may not decode on every TV",
  sample_aes: "encrypted with SAMPLE-AES: may not play",
  no_range: "no range support: resume and seeking break",
  subtitle_failed: "a subtitle track could not be loaded",
  manifest_only: "DASH: only the manifest was checked",
  playlists_unchecked: "more than 16 playlists: the rest were not checked",
});

/** `2.5 Mbit/s`, `800 kbit/s`. @param {number} bps */
const bitrate = (bps) => (bps >= 1_000_000 ? `${(bps / 1_000_000).toFixed(1)} Mbit/s` : `${Math.round(bps / 1000)} kbit/s`);

/**
 * One step of a source's check: "variant playlist 2: ok (HTTP 200, M3U8, 12 ms)", "segment: failed, not media (HTTP
 * 200, 3 ms) · cdn.example.org"; the host only when it is not the stream's.
 * @param {any} step @param {string | null} [streamHost]
 */
export function stepText(step, streamHost = null) {
  const n = typeof step.index === "number" ? ` ${step.index + 1}` : "";
  // A segment, init segment or key names the playlist it came from: "segment of variant 1", "key of rendition 2".
  const what = `${STEPS[step.what] ?? step.what}${step.of ? ` of ${step.of}` : ""}${n}`;
  const httpError = !step.ok && step.error === "http" && step.status;
  const result = step.ok ? "ok" : `failed, ${httpError ? `HTTP ${step.status}` : STEP_ERRORS[step.error] ?? step.error ?? "unknown error"}`;
  const details = [
    step.status && !httpError ? `HTTP ${step.status}` : null,
    step.container ? CONTAINERS[step.container] ?? step.container : null,
    typeof step.bytes === "number" ? formatBytes(step.bytes) : null,
    `${step.ms} ms`,
  ].filter(Boolean).join(", ");
  return `${what}: ${result} (${details})${step.host && step.host !== streamHost ? ` · ${step.host}` : ""}`;
}

/**
 * One source of a check (`POST /admin/diagnostics/resolve`, or stored): its verdict, how it was tried, what came back
 * a line each (with the HLS variants' codecs), every step the check fetched, and its warnings.
 * @param {any} s an entry of the answer's `sources` @param {(iso: string) => string} [formatTime] for an expiry
 * @returns {{ verdict: "ok" | "warn" | "fail", sourceId: string, how: string, lines: string[],
 *   steps: Array<{ ok: boolean, text: string }>, warnings: string[] }}
 */
export function sourceReport(s, formatTime = (iso) => new Date(iso).toLocaleString()) {
  const st = s.stream;
  /** @type {string[]} */
  const lines = [];
  if (!s.ok && s.name === "BudgetExhausted") lines.push("skipped: the time budget of the request ran out");
  else if (!s.ok) lines.push(`${TRIED[s.code] ?? s.code}${s.name && s.code !== "timeout" ? ` (${s.name})` : ""}`);
  if (st) {
    const delivery = st.delivery === "proxy" ? "through the proxy" : st.delivery === "direct" ? "direct to the TV" : "cannot be served";
    lines.push(`${mediaKindLabel(st.kind)}${st.inline ? " (inline playlist)" : ""} from ${st.host ?? "?"} · ${delivery}`);
    if (st.headerNames?.length) lines.push(`upstream headers: ${st.headerNames.join(", ")}`);
    if (st.languages) lines.push(`audio ${st.languages.audio?.join(", ") || "unknown"} · subtitles ${st.languages.subtitles?.join(", ") || "unknown"}`);
    if (st.expiresAt) lines.push(`expires ${formatTime(st.expiresAt)}`);
  }
  for (const [i, v] of (s.codecs ?? []).entries()) {
    const facts = [v.codecs ?? "codecs not listed", v.resolution, v.bandwidth ? bitrate(v.bandwidth) : null].filter(Boolean).join(" · ");
    lines.push(`variant ${i + 1}: ${facts}`);
  }
  const steps = (s.steps ?? []).map((/** @type {any} */ step) => ({ ok: Boolean(step.ok), text: stepText(step, st?.host ?? null) }));
  const warnings = (s.warnings ?? []).map((/** @type {string} */ w) => WARNINGS[w] ?? w);
  const how = `${s.type === "adapter" ? `adapter ${s.adapterId}` : "direct"} · ${s.ms} ms${s.checkMs ? ` · checked in ${s.checkMs} ms` : ""}`;
  return { verdict: s.verdict ?? (s.ok ? "ok" : "fail"), sourceId: s.sourceId, how, lines, steps, warnings };
}

/** Each verdict's mark (shown next to its words, never alone) and words. */
const VERDICTS = /** @type {const} */ ({ ok: ["✔", "Works"], warn: ["⚠", "Works, with warnings"], fail: ["✖", "Fails"] });
const RANK = { ok: 0, warn: 1, fail: 2 };

/** The worse of two verdicts (null: unknown). @param {"ok" | "warn" | "fail" | null} a @param {"ok" | "warn" | "fail" | null} b */
const worse = (a, b) => (a === null ? b : b === null ? a : RANK[a] >= RANK[b] ? a : b);

/**
 * A verdict's chip: `mark` (✔ ⚠ ✖, beside the text, which says it all) and `tone`.
 * @param {"ok" | "warn" | "fail"} verdict
 * @returns {{ mark: string, text: string, tone: "ok" | "warn" | "bad" }}
 */
export const verdictChip = (verdict) => ({ mark: VERDICTS[verdict][0], text: VERDICTS[verdict][1], tone: verdict === "ok" ? "ok" : verdict === "warn" ? "warn" : "bad" });

/**
 * The chip of a playable's stored check (`check` of an episode, a channel or a Home entry): "Works · checked 2 h ago",
 * "Works, with warnings · …", "Fails · …"; "Source changed · …" when a source is new or changed since (its verdict is
 * then not known); "Not checked".
 * @param {{ verdict: "ok" | "warn" | "fail", checkedAt: string, working: number, total: number, stale: boolean } | null | undefined} check
 * @param {number} [now]
 * @returns {{ mark: string, text: string, tone: "ok" | "warn" | "bad" | "info" | "" }}
 */
export function checkSummaryText(check, now = Date.now()) {
  if (!check) return { mark: "", text: "Not checked", tone: "" };
  const when = `checked ${formatRelative(check.checkedAt, now)}`;
  if (check.stale) return { mark: "", text: `Source changed · ${when}`, tone: "info" };
  const c = verdictChip(check.verdict);
  // It plays, but on fewer sources than it has: that is the warning, said as such.
  const text = check.verdict === "warn" && check.working < check.total ? `Works, ${check.total - check.working} of ${plural(check.total, "source")} failing` : c.text;
  return { ...c, text: `${text} · ${when}` };
}

/**
 * A Home entry's verdict, for the Check results list: the worse of what OK plays (unless a source changed since) and
 * of its episodes; null when nothing was checked.
 * @param {{ check?: { verdict: "ok" | "warn" | "fail", stale: boolean } | null, checkAll?: { verdict: "ok" | "warn" | "fail" | null } | null }} e
 */
export const verdictOf = (e) => worse(e.check && !e.check.stale ? e.check.verdict : null, e.checkAll?.verdict ?? null);

/**
 * What a Home entry's checks found, a line each: what OK plays ("What OK plays: Fails · checked 2 h ago") and a
 * series' episodes ("Episodes: 38 of 40 checked · 1 failing · 2 with warnings"; "not checked" when none was); a film
 * of one episode has no episode line (it is what OK plays).
 * @param {{ kind?: string, check?: any, checkAll?: { checked: number, total: number, failed: number, warned: number } | null }} e
 * @param {number} [now]
 */
export function homeCheckLines(e, now = Date.now()) {
  const lines = [`What OK plays: ${checkSummaryText(e.check, now).text}`];
  const a = e.checkAll;
  if (a && (e.kind === "series" || a.total > 1)) {
    const found = [a.failed ? `${a.failed} failing` : null, a.warned ? `${a.warned} with warnings` : null].filter(Boolean);
    lines.push(a.checked === 0 ? "Episodes: not checked" : [`Episodes: ${a.checked} of ${a.total} checked`, ...found].join(" · "));
  }
  return lines;
}

/**
 * What a batch check is about: the show's title, or "Home of Living room, quick" (what OK plays) or ", full" (every
 * episode). @param {{ title: string, target: { itemId?: string, deviceId?: string, mode?: string } }} run
 */
export const runTitle = (run) => (run.target.deviceId ? `Home of ${run.title}, ${run.target.mode === "quick" ? "quick" : "full"}` : run.title);

/**
 * A batch check's progress: "12 of 40 checked · 1 failing · 2 with warnings"; "Stopped: 12 of 40 checked …" once
 * stopped; "Done: 40 checked · all work" (or what failed) once done. Skipped shows are counted last.
 * @param {{ state: string, total: number, done: number, failed: number, warned: number, skipped?: any[] }} run
 */
export function runProgressText(run) {
  const found = [run.failed ? `${run.failed} failing` : null, run.warned ? `${run.warned} with warnings` : null].filter(Boolean);
  const skipped = run.skipped?.length ? [`${run.skipped.length} skipped`] : [];
  if (run.state === "done") return [`Done: ${run.done} checked`, ...(found.length ? found : ["all work"]), ...skipped].join(" · ");
  return [`${run.state === "cancelled" ? "Stopped: " : ""}${run.done} of ${run.total} checked`, ...found, ...skipped].join(" · ");
}

/**
 * The shows a batch check left out, and why: "Skipped: Sintel (missing from the catalog), Tears (not playable)."; ""
 * when none. @param {{ skipped?: Array<{ itemId: string, title: string | null, reason: string }> }} run
 */
export function skippedText(run) {
  const list = run.skipped ?? [];
  if (list.length === 0) return "";
  const why = (/** @type {string} */ r) => (r === "missing" ? "missing from the catalog" : "not playable");
  return `Skipped: ${list.map((s) => `${s.title ?? s.itemId} (${why(s.reason)})`).join(", ")}.`;
}

/** Languages offered in the settings selects; any other BCP 47 tag the API accepts is shown as it is. */
export const LANGUAGES = /** @type {const} */ ([
  ["en", "English"], ["tr", "Türkçe"], ["de", "Deutsch"], ["fr", "Français"], ["es", "Español"], ["it", "Italiano"],
  ["nl", "Nederlands"], ["pt", "Português"], ["ru", "Русский"], ["ar", "العربية"], ["ku", "Kurdî"],
]);

/** "Türkçe (tr)" for known tags, else the tag; `none` without a tag. @param {string | null | undefined} tag */
export function languageLabel(tag, none = "–") {
  if (!tag) return none;
  const known = LANGUAGES.find(([t]) => t === primarySubtag(tag));
  return known ? `${known[1]} (${tag})` : tag;
}

/** `pt` for `pt-BR`. @param {string} tag */
const primarySubtag = (tag) => (tag.split("-")[0] ?? "").toLowerCase();

/**
 * Whether a track's language is the one wanted (`en` matches `en-GB`).
 * @param {string | null | undefined} wanted @param {string | null | undefined} actual
 */
export const sameLanguage = (wanted, actual) =>
  Boolean(wanted && actual && primarySubtag(wanted) === primarySubtag(actual));

/**
 * The episodes (a channel has none) with what the device did with each: watched, current (where OK continues),
 * progress.
 * @template {{ id: string }} E
 * @param {E[] | null | undefined} episodes @param {string | null} cursorEpisodeId
 * @param {Array<{ episodeId: string, status: string, positionMs: number, durationMs: number | null }>} progress
 */
export function episodeStates(episodes, cursorEpisodeId, progress) {
  const byId = new Map(progress.map((p) => [p.episodeId, p]));
  return (episodes ?? []).map((e) => {
    const p = byId.get(e.id);
    const watched = p?.status === "finished";
    const pct = p && !watched ? percent(p.positionMs, p.durationMs) : null;
    return { episode: e, current: e.id === cursorEpisodeId, watched, percent: pct };
  });
}

/** @param {{ episode: { playbackAllowed?: boolean }, current: boolean, watched: boolean, percent: number | null }} s */
export function episodeStateLabel(s) {
  if (!s.episode.playbackAllowed) return "not allowed";
  if (s.current) return "next";
  if (s.watched) return "watched";
  return s.percent !== null ? `${s.percent}%` : "new";
}

// --- events, history and access tokens ----------------------------------------------------------------------------

/**
 * The complete server-sent events in `text` and the unfinished rest; comments, `retry:` and messages without data are
 * skipped. @param {string} text
 */
export function parseSse(text) {
  const blocks = text.split(/\r?\n\r?\n/);
  const rest = blocks.pop() ?? "";
  const events = [];
  for (const block of blocks) {
    let id = /** @type {string | null} */ (null);
    let event = "message";
    const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (line === "" || line.startsWith(":")) continue;
      const i = line.indexOf(":");
      const field = i < 0 ? line : line.slice(0, i);
      const value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
      if (field === "id") id = value;
      else if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (data.length > 0) events.push({ id, event, data: data.join("\n") });
  }
  return { events, rest };
}

/** `2 h 05 min`, `45 min`, `under a minute`; `–` when unknown. @param {number | null | undefined} ms */
export function formatDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "–";
  const min = Math.round(ms / 60_000);
  if (min < 1) return "under a minute";
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min`;
}

/** Who an actor is, for a line of text. @param {{ type: string, name?: string } | null | undefined} actor */
export function actorLabel(actor) {
  if (!actor) return "";
  if (actor.type === "token") return `token “${actor.name}”`;
  return new Map([["owner", "the owner"], ["tv", "the TV"], ["server", "the server"]]).get(actor.type) ?? actor.type;
}

/**
 * Who started a viewing: the viewer, autoplay, auto-next (a channel: CH+/CH−), or whoever sent the command.
 * @param {{ trigger: string, itemKind?: string | null, actor?: { type: string, name?: string } | null }} v
 */
export function triggerLabel(v) {
  if (v.trigger === "next") return v.itemKind === "live" ? "CH+/CH−" : "auto-next";
  if (v.trigger === "command") return actorLabel(v.actor) || "a command";
  return new Map([["viewer", "the viewer"], ["autoplay", "autoplay"]]).get(v.trigger) ?? "";
}

/**
 * How a viewing ended: `watched to the end`, `stopped at 12:34`, `switched away at 1:02`, `lost at 0:40` (a power cut,
 * a dead app), without the position for a channel; `· seen` when it counts as seen without a finished report.
 * @param {{ endedAt: string | null, endReason: string | null, endPositionMs: number | null, seen: boolean }} v
 */
export function viewingEnd(v) {
  if (v.endedAt === null) return "playing now";
  if (v.endReason === "finished") return "watched to the end";
  const at = v.endPositionMs === null || v.endPositionMs === undefined ? "" : ` at ${formatClock(v.endPositionMs)}`;
  const how = v.endReason === "replaced" ? "switched away" : (v.endReason ?? "ended");
  return `${how}${at}${v.seen ? " · seen" : ""}`;
}

/**
 * `14:05–14:52`, `since 14:05` while it runs.
 * @param {{ startedAt: string, endedAt: string | null }} v @param {(iso: string) => string} [formatTime]
 */
export function viewingSpan(v, formatTime = clockTime) {
  return v.endedAt === null ? `since ${formatTime(v.startedAt)}` : `${formatTime(v.startedAt)}–${formatTime(v.endedAt)}`;
}

/**
 * A channel's viewing: `14:05–14:52 · 45 min · stopped` (how long the picture actually ran, `watchedMs`).
 * @param {{ startedAt: string, endedAt: string | null, endReason: string | null, endPositionMs: number | null,
 *   seen: boolean, watchedMs: number | null }} v
 * @param {(iso: string) => string} [formatTime]
 */
export function liveViewingLine(v, formatTime = clockTime) {
  return [viewingSpan(v, formatTime), formatDuration(v.watchedMs), viewingEnd(v)].join(" · ");
}

/** A title's history status. @param {string} status @returns {{ label: string, tone: "ok" | "info" | "" }} */
export function titleStatusLabel(status) {
  if (status === "finished") return { label: "Finished", tone: "ok" };
  if (status === "new_episodes") return { label: "New episodes", tone: "info" };
  return { label: new Map([["watching", "Watching"], ["idle", "Idle"]]).get(status) ?? status, tone: "" };
}

/**
 * `Series · 5 of 12 episodes seen · last watched 2 days ago · 3 h 20 min`; a channel: `Channel · 3 viewings · …`.
 * @param {{ kind: string | null, inCatalog: boolean, episodes: { total: number, seen: number } | null, viewings?: number,
 *   lastWatchedAt: string | null, watchedMs: number }} t
 * @param {number} [now]
 */
export function titleLine(t, now = Date.now()) {
  const e = t.episodes ?? { total: 0, seen: 0 };
  const parts = [
    t.kind === "live" ? (t.viewings ? `Channel · ${plural(t.viewings, "viewing")}` : "Channel")
    : t.kind === "movie" ? (e.seen > 0 ? "Film · seen" : "Film")
    : `Series · ${e.seen} of ${plural(e.total, "episode")} seen`,
  ];
  if (!t.inCatalog) parts.push("no longer in the catalog");
  if (t.lastWatchedAt) parts.push(`last watched ${formatRelative(t.lastWatchedAt, now)}`);
  if (t.watchedMs > 0) parts.push(formatDuration(t.watchedMs));
  return parts.join(" · ");
}

/**
 * `seen 2026-10-10 · 85% played · 3 viewings · 1 h 10 min`, or `not seen · last at 12:34`.
 * @param {{ seen: boolean, seenAt: string | null, coveredFraction: number | null, viewings: number, watchedMs: number,
 *   lastPositionMs: number | null, mark: boolean | null }} e
 */
export function episodeHistoryLine(e) {
  const parts = [];
  if (e.seen) parts.push(e.seenAt ? `seen ${e.seenAt.slice(0, 10)}` : "seen");
  else parts.push(e.viewings > 0 ? "not seen" : "never played");
  if (e.mark !== null) parts.push(e.mark ? "marked seen" : "marked not seen");
  if (e.coveredFraction !== null) parts.push(`${Math.round(e.coveredFraction * 100)}% played`);
  if (e.viewings > 0) parts.push(plural(e.viewings, "viewing"));
  if (e.watchedMs > 0) parts.push(formatDuration(e.watchedMs));
  if (!e.seen && e.lastPositionMs !== null && e.lastPositionMs > 0) parts.push(`last at ${formatClock(e.lastPositionMs)}`);
  return parts.join(" · ");
}

/** The words of a command result reason, by `type:reason` or by `reason`. */
const REASONS = /** @type {Record<string, string>} */ ({
  not_in_player: "nothing is playing", not_ready: "the TV is not set up", no_episode: "no episode that way", unknown_type: "the TV does not know this command",
  no_playable_source: "no source could be played", playback_error: "the player failed", superseded: "something else started first",
  stopped: "the player was left first", busy: "the TV was busy", episodes_unavailable: "the episode list could not be fetched",
  live: "a channel cannot be paused or seeked", no_channel: "no channel that way on Home",
  "next:no_channel": "no channel after this one on Home", "previous:no_channel": "no channel before this one on Home",
});

/** What became of an `update` command, by `result:reason` (or by `reason` for any result). */
const UPDATE_RESULTS = /** @type {Record<string, string>} */ ({
  "done:installing": "Update: the TV is installing",
  "done:prompted": "Update: the TV shows the install screen; someone has to press OK",
  up_to_date: "Update: ignored, the TV is up to date",
  not_newer: "Update: ignored, the TV has this version or a newer one",
  busy: "Update: ignored, the TV is playing",
  not_ready: "Update: ignored, the TV is not set up",
  declined: "Update: declined on the TV (Back was pressed)",
  timeout: "Update: nobody pressed OK on the TV within 60 s",
  download: "Update failed: the TV could not download the APK",
  too_large: "Update failed: the APK is too large for the TV",
  verify: "Update failed: the download did not match its checksum",
  wrong_package: "Update failed: the APK is not the izle TV app",
  bad_archive: "Update failed: the APK is damaged",
  install_failure_incompatible: "Update failed: different signing key (only a release APK installs over a release install)",
});

/** @param {string} reason */
const words = (reason) => reason.replace(/_/g, " ");

/** @param {{ result: string, reason: string | null }} d */
function updateResultText(d) {
  const known = UPDATE_RESULTS[`${d.result}:${d.reason}`] ?? (d.reason ? UPDATE_RESULTS[d.reason] : undefined);
  if (known) return known;
  if (d.reason?.startsWith("install_")) return `Update failed: the TV's installer refused (${words(d.reason.slice("install_".length))})`;
  if (d.result === "done") return "Update: done";
  const why = d.reason ? ` (${words(d.reason)})` : "";
  return d.result === "failed" ? `Update failed${why}` : `Update: ${d.result}${why}`;
}

/**
 * A command's result, for a toast: `Play: done`, `Pause: ignored (nothing is playing)`; an `update` in its own words.
 * @param {{ type: string, result: string, reason: string | null }} d a `command.result` event's data
 */
export function commandResultText(d) {
  if (d.type === "update") return updateResultText(d);
  const why = d.reason ? ` (${REASONS[`${d.type}:${d.reason}`] ?? REASONS[d.reason] ?? words(d.reason)})` : "";
  return `${d.type.charAt(0).toUpperCase()}${d.type.slice(1)}: ${d.result}${why}`;
}

/** What a token scope allows, for the scope picker and the token list. */
export const SCOPES = /** @type {const} */ ([
  ["read", "Read", "sees the TVs, the catalog, the history and the events"],
  ["control", "Control", "read, and sends commands to the TVs (play, pause, a message)"],
  ["manage", "Manage", "control, and changes home screens, settings and the history's marks"],
]);

/** `Read`, `Control`, `Manage`; the scope itself when unknown. @param {string} scope */
export const scopeLabel = (scope) => SCOPES.find(([s]) => s === scope)?.[1] ?? scope;

// --- TV app updates ----------------------------------------------------------------------------------------------

/** The server's upload cap for an APK. */
export const APK_MAX_BYTES = 64 * 1024 * 1024;

/** `512 B`, `12.3 MB`, `164 MB` (powers of 1000); `–` when unknown. @param {number | null | undefined} n */
export function formatBytes(n) {
  if (n === null || n === undefined || !Number.isFinite(n) || n < 0) return "–";
  if (n < 1000) return `${Math.round(n)} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let v = n / 1000;
  let i = 0;
  for (; v >= 999.5 && i < units.length - 1; i++) v /= 1000;
  return `${v >= 99.95 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** The version in a release APK's name, as the server requires it (`izle-tv-0.3.0.apk`). @param {string} name */
export function apkVersion(name) {
  const m = /^izle-tv-(0|[1-9]\d*)\.([1-9]?\d)\.([1-9]?\d)(-[0-9A-Za-z.-]+)?\.apk$/.exec(name);
  return m ? `${m[1]}.${m[2]}.${m[3]}${m[4] ?? ""}` : null;
}

/**
 * What a TV reports about its app (`app` of a device row); absent or all nulls on older servers and apps.
 * @typedef {{ version?: string | null, versionCode?: number | null, androidSdk?: number | null,
 *   capability?: string | null, reportedAt?: string | null, update?: string | null }} DeviceApp
 */

/** @param {DeviceApp | null | undefined} app @returns {{ text: string, tone: "ok" | "warn" | "info" | "" }} */
export function appUpdateChip(app) {
  switch (app?.update) {
    case "up_to_date": return { text: "Up to date", tone: "ok" };
    case "pending": return { text: "Update available", tone: "info" };
    case "needs_install_now": return { text: "Needs Install now", tone: "warn" };
    default: return { text: "Unknown", tone: "" };
  }
}

/** Android versions by API level; a level not listed is shown as it is. */
const ANDROID = /** @type {Record<number, string>} */ ({
  21: "5.0", 22: "5.1", 23: "6", 24: "7.0", 25: "7.1", 26: "8.0", 27: "8.1", 28: "9", 29: "10", 30: "11", 31: "12",
  32: "12L", 33: "13", 34: "14", 35: "15", 36: "16",
});

/** `Android 9 (API 28)`; `unknown` when the TV did not say. @param {number | null | undefined} sdk */
export function androidText(sdk) {
  if (sdk === null || sdk === undefined || !Number.isInteger(sdk)) return "unknown";
  return ANDROID[sdk] ? `Android ${ANDROID[sdk]} (API ${sdk})` : `API ${sdk}`;
}

/** How a TV takes an update. @param {DeviceApp | null | undefined} app @param {boolean} [auto] on while unknown */
export function capabilityText(app, auto = true) {
  if (app?.capability === "silent") {
    return auto
      ? "Installs updates by itself while nobody is watching."
      : "Can install updates by itself, but automatic installs are off on this server: an update needs Install now here.";
  }
  if (app?.capability !== "guided") return "Unknown: the TV has not said how it installs updates (an older app).";
  const why = (app.androidSdk ?? 0) >= 31 ? "The TV lacks the one-time permission to install apps, so" : "On Android 11 or older,";
  return `${why} an update needs Install now here, and someone at the TV pressing OK when the screen appears.`;
}

/** The words of a failed check's reason. */
const CHECK_REASONS = /** @type {Record<string, string>} */ ({
  network: "GitHub could not be reached",
  rate_limited: "GitHub's rate limit was reached; a later check tries again",
  no_release: "the repository has no release yet",
  prerelease: "the latest release is a pre-release, which is not offered to TVs",
  bad_tag: "the latest release's tag is not a version (vX.Y.Z)",
  no_apk_asset: "the latest release has no izle-tv APK",
  no_checksums: "the latest release has no checksum file",
  checksums_too_large: "the release's checksum file is too large",
  checksum_missing: "the checksum file does not list the APK",
  checksum_mismatch: "the downloaded APK does not match its checksum",
  too_large: "the APK is larger than 64 MiB",
  not_an_apk: "the download is not an APK",
});

/** @param {string | null | undefined} reason */
export function appCheckReasonText(reason) {
  if (!reason) return "for an unknown reason";
  const http = /^http_(\d{3})$/.exec(reason);
  return http ? `GitHub answered HTTP ${http[1]}` : CHECK_REASONS[reason] ?? words(reason);
}

/** `5 min`, `3 h`, `2 days`: how long until `iso`. @param {string} iso @param {number} now */
function formatUntil(iso, now) {
  const min = Math.round((Date.parse(iso) - now) / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? "1 day" : `${d} days`;
}

/**
 * The server's checks for a new release in one line: `Last check 2 h ago: up to date · next check in 4 h`.
 * @param {{ lastAt: string | null, nextAt: string | null, result: string | null, reason: string | null, running: boolean }
 *   | null | undefined} check
 * @param {string} source `github` or `manual` @param {number} [now]
 */
export function appCheckText(check, source, now = Date.now()) {
  if (source === "manual") return "Checks disabled (manual source): the server offers the APK uploaded here.";
  if (!check) return "";
  const when = formatRelative(check.lastAt, now);
  const results = /** @type {Record<string, string>} */ ({
    failed: `last check failed ${when}: ${appCheckReasonText(check.reason)}`,
    fetched: `last check ${when}: fetched a new version`,
    up_to_date: `last check ${when}: up to date`,
  });
  const last = results[check.result ?? ""] ?? `last check ${when}`;
  const parts = [check.running ? "checking now…" : !check.lastAt ? "not checked yet" : last];
  if (check.nextAt && !check.running) {
    const ms = Date.parse(check.nextAt) - now;
    if (!Number.isNaN(ms)) parts.push(ms < 60_000 ? "next check soon" : `next check in ${formatUntil(check.nextAt, now)}`);
  }
  const text = parts.join(" · ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Who installs a new APK by themselves: with `appUpdates.auto`, the TVs that can (when idle). @param {boolean} auto */
export function newApkText(auto) {
  return auto
    ? "TVs that install by themselves update when idle; the others need Install now."
    : "Automatic installs are off: every TV needs Install now.";
}

/**
 * The toast after "Check now".
 * @param {{ result: string, reason: string | null, apk: { versionName: string } | null }} r @param {boolean} auto
 * @returns {{ text: string, kind: "ok" | "info" | "error" }}
 */
export function checkResultText(r, auto) {
  if (r.result === "fetched") return { text: `Fetched ${r.apk?.versionName ?? "a new version"} from GitHub. ${newApkText(auto)}`, kind: "ok" };
  if (r.result === "up_to_date") return { text: `Up to date: ${r.apk ? `${r.apk.versionName} is the latest release` : "nothing new on GitHub"}.`, kind: "info" };
  return { text: `The check failed: ${appCheckReasonText(r.reason)}.`, kind: "error" };
}

/**
 * Why "Install now" is unavailable for a TV, or null.
 * @param {{ status?: string, online?: boolean, app?: DeviceApp | null }} device @param {boolean} hasApk
 */
export function installNowBlocked(device, hasApk) {
  if (!hasApk) return "No TV app is stored on the server.";
  if (device.status !== undefined && device.status !== "active") return "The TV is not set up yet.";
  if (!device.online) return "The TV is offline.";
  return device.app?.update === "up_to_date" ? "The TV is up to date." : null;
}

// --- Listen along (companion audio on the owner's phone) ----------------------------------------------------------

/** Sync loop tuning: when to seek, how hard to nudge the playback rate, which clock samples to trust. */
export const SYNC = { seekMs: 1500, coarseMs: 300, fineMs: 40, coarseAdj: 0.05, fineAdj: 0.02, minRate: 0.9, maxRate: 1.1, sampleMaxRttMs: 1000 };

/**
 * @typedef {{ positionMs: number, atMs: number, playing: boolean, rate?: number }} Anchor
 * @typedef {{ offsetMs: number, rate: number }} LinkTiming
 * @typedef {{ sentAt: number, receivedAt: number, serverNowMs: number }} ClockSample
 */

/** Where the TV is at `serverNowMs`. @param {Anchor | null | undefined} anchor @param {number} serverNowMs */
export function tvPositionAt(anchor, serverNowMs) {
  if (!anchor) return null;
  return anchor.positionMs + (anchor.playing ? Math.max(0, serverNowMs - anchor.atMs) * (anchor.rate ?? 1) : 0);
}

/**
 * `rate · tv + offset`, plus this phone's nudge for its output latency.
 * @param {number} tvPositionMs @param {LinkTiming} link @param {number} [nudgeMs]
 */
export const companionTarget = (tvPositionMs, link, nudgeMs = 0) => link.rate * tvPositionMs + link.offsetMs + nudgeMs;

/**
 * What the phone's player should do: pause with the TV, seek when far off, else play a little faster or slower than
 * the nominal rate until the error is within `SYNC.fineMs`.
 * @param {{ targetMs: number, actualMs: number, tvPlaying: boolean, nominalRate: number }} p
 * @returns {{ action: "pause" | "seek" | "play", rate: number, state: string, errorMs: number, toMs?: number }}
 */
export function syncDecision({ targetMs, actualMs, tvPlaying, nominalRate }) {
  const errorMs = targetMs - actualMs;
  if (!tvPlaying) return { action: "pause", rate: nominalRate, state: "paused", errorMs };
  if (targetMs < 0) return { action: "pause", rate: nominalRate, state: "waiting", errorMs };
  if (Math.abs(errorMs) > SYNC.seekMs) return { action: "seek", toMs: targetMs, rate: nominalRate, state: "seeking", errorMs };
  const adj = Math.abs(errorMs) > SYNC.coarseMs ? SYNC.coarseAdj : Math.abs(errorMs) > SYNC.fineMs ? SYNC.fineAdj : 0;
  const rate = Math.min(SYNC.maxRate, Math.max(SYNC.minRate, nominalRate * (1 + Math.sign(errorMs) * adj)));
  return { action: "play", rate, state: adj === 0 ? "synced" : errorMs > 0 ? "catching up" : "holding back", errorMs };
}

/**
 * Server clock minus phone clock: the sample with the shortest round trip wins; long ones (a long-poll that waited)
 * are ignored. Null without a usable sample. @param {ClockSample[]} samples
 */
export function clockOffset(samples) {
  /** @type {ClockSample | null} */
  let best = null;
  for (const s of samples) {
    const rtt = s.receivedAt - s.sentAt;
    if (rtt >= 0 && rtt <= SYNC.sampleMaxRttMs && (!best || rtt < best.receivedAt - best.sentAt)) best = s;
  }
  return best ? best.serverNowMs - (best.sentAt + best.receivedAt) / 2 : null;
}

/**
 * Options for the companion candidates: one per source, or one per audio language when a source has several.
 * `value` is `<sourceId>\u0000<language>` (see `parseCandidate`).
 * @param {Array<{ sourceId: string, label: string | null, current: boolean, supported: boolean, reason: string | null,
 *   languages: { audio: string[] | null, subtitles: string[] | null } }>} candidates
 */
export function candidateOptions(candidates) {
  const out = [];
  for (const c of candidates) {
    const langs = c.languages?.audio ?? null;
    for (const lang of langs && langs.length >= 2 ? langs : [null]) {
      const parts = [c.label ? `${c.sourceId} — ${c.label}` : c.sourceId];
      if (lang) parts.push(languageLabel(lang));
      else if (langs && langs.length === 1) parts.push(languageLabel(langs[0]));
      else if (langs && langs.length === 0) parts.push("no dialogue");
      if (c.current) parts.push("the TV's source");
      if (!c.supported) parts.push(c.reason === "dash" || c.reason === "ts" ? `${mediaKindLabel(c.reason)}, cannot play on a phone` : "cannot play");
      out.push({ value: `${c.sourceId}\u0000${lang ?? ""}`, label: parts.join(" · "), sourceId: c.sourceId, language: lang, disabled: !c.supported });
    }
  }
  return out;
}

/** @param {string} value */
export function parseCandidate(value) {
  const [sourceId, language] = value.split("\u0000");
  return { sourceId: sourceId ?? "", language: language || null };
}

/** `+0.6 s`, `−12 ms`; `–` when unknown. @param {number | null | undefined} ms */
export function formatDrift(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "–";
  const sign = ms < 0 ? "−" : "+";
  const abs = Math.abs(ms);
  return abs >= 1000 ? `${sign}${(abs / 1000).toFixed(1)} s` : `${sign}${Math.round(abs)} ms`;
}

/** `1:02:03.4`, for the sync status line. @param {number | null | undefined} ms */
export function formatPosition(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "–";
  return `${formatClock(ms)}.${Math.floor((ms % 1000) / 100)}`;
}
