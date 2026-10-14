// @ts-check
// Pure helpers of the admin UI (no DOM): formatting, the texts views show, and small list operations. Unit-tested
// from node (server/test/admin-ui.test.ts).

/** Shows the server's home list cap; the server enforces it. */
export const HOME_MAX = 12;

/** The TV resumes a saved position only from 30 s on (PlaybackPlan); earlier positions start over. */
export const RESUME_MIN_MS = 30_000;

/** The most results the catalog search returns (the server's cap). */
export const SEARCH_MAX = 200;

/**
 * `1:02:03` or `12:34` for a duration in milliseconds; `–` when unknown.
 * @param {number | null | undefined} ms
 */
export function formatClock(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "–";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (/** @type {number} */ n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * "just now", "5 min ago", "3 h ago", "2 days ago", or a date.
 * @param {string | null | undefined} iso
 * @param {number} [now]
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

/**
 * Seconds until `iso`, as `m:ss` (never negative).
 * @param {string} iso
 * @param {number} [now]
 */
export function formatCountdown(iso, now = Date.now()) {
  const left = Math.max(0, Date.parse(iso) - now);
  return formatClock(left);
}

/**
 * `123 456` — pairing codes read like they look on the TV.
 * @param {string} code
 */
export function formatCode(code) {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

/**
 * The admin token carried by a sign-in link (`…/admin/#token=<token>`, printed by `izle-server admin-token --link`),
 * or null when the fragment is something else (a route, nothing).
 * @param {string | null | undefined} hash `location.hash`
 */
export function tokenFromHash(hash) {
  const m = /^#token=(.+)$/.exec(hash ?? "");
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]).trim() || null;
  } catch {
    return null;
  }
}

/**
 * The address to type on a TV for this server: the page's origin plus whatever path precedes `/admin/`, so a
 * server behind a reverse proxy under a prefix is right too.
 * @param {string} origin `location.origin` @param {string} pathname `location.pathname`
 */
export function serverAddress(origin, pathname) {
  return `${origin}${pathname.replace(/\/admin(\/.*)?$/, "")}`;
}

/**
 * @typedef {object} EpisodeLike
 * @property {number | null} [season]
 * @property {number | null} [number]
 * @property {string | null} [title]
 * @property {string | null} [label]
 */

/**
 * How an episode is named for the owner: the catalog label, else "S2 · E5", else "Episode 5", plus its title.
 * Movies have no number: their (optional) title only, else "Film".
 * @param {EpisodeLike} e
 * @param {"movie" | "series" | string | null} [kind]
 */
export function episodeName(e, kind) {
  let head = e.label ?? null;
  if (!head && e.number !== null && e.number !== undefined) {
    head = e.season !== null && e.season !== undefined ? `S${e.season} · E${e.number}` : `Episode ${e.number}`;
  }
  if (!head) return e.title ?? (kind === "movie" ? "Film" : "Episode");
  return e.title ? `${head} — ${e.title}` : head;
}

/**
 * @typedef {EpisodeLike & { status: "new" | "watching" | "finished", positionMs: number, durationMs: number | null, index: number, count: number }} ContinueInfo
 */

/**
 * What OK does on the TV for a home entry, in a few words.
 * @param {ContinueInfo | null | undefined} c
 * @param {string | null} kind
 */
export function continueText(c, kind) {
  if (!c) return "Nothing playable";
  const which = kind === "series" ? `${episodeName(c, kind)} · ` : "";
  if (c.status === "watching" && c.positionMs >= RESUME_MIN_MS) {
    return `${which}continues at ${formatClock(c.positionMs)}${c.durationMs ? ` of ${formatClock(c.durationMs)}` : ""}`;
  }
  if (c.status === "watching") return `${which}starts from the beginning`;
  if (c.status === "finished") return `${which}watched — starts over`;
  return `${which}new`;
}

/**
 * 0–100, or null when unknown.
 * @param {number | null | undefined} position
 * @param {number | null | undefined} duration
 */
export function percent(position, duration) {
  if (!duration || duration <= 0 || position === null || position === undefined) return null;
  return Math.min(100, Math.max(0, Math.round((position / duration) * 100)));
}

/**
 * A copy of `list` with the element at `index` moved by `delta` (clamped).
 * @template T
 * @param {readonly T[]} list
 * @param {number} index
 * @param {number} delta
 * @returns {T[]}
 */
export function moveItem(list, index, delta) {
  const out = [...list];
  const to = Math.min(out.length - 1, Math.max(0, index + delta));
  if (index < 0 || index >= out.length || to === index) return out;
  const [item] = out.splice(index, 1);
  out.splice(to, 0, /** @type {T} */ (item));
  return out;
}

/**
 * @typedef {object} ShowLike
 * @property {string} kind
 * @property {number | null} [year]
 * @property {number} [episodeCount]
 * @property {number} [playableCount]
 */

/**
 * The muted line under a show's title: Film or Series (with its episode count), the year, and with `playable` how
 * many of its episodes may be played when that is not all of them.
 * @param {ShowLike} item
 * @param {{ playable?: boolean }} [o]
 */
export function showMeta(item, o = {}) {
  const parts = [item.kind === "series" ? (item.episodeCount !== undefined ? `Series · ${plural(item.episodeCount, "episode")}` : "Series") : "Film"];
  if (item.year) parts.push(String(item.year));
  if (o.playable && item.playableCount !== undefined && item.episodeCount !== undefined && item.playableCount < item.episodeCount) {
    parts.push(item.playableCount === 0 ? "not playable" : `${item.playableCount} of ${item.episodeCount} playable`);
  }
  return parts.join(" · ");
}

/**
 * What a catalog search found, for the line above the results (screen readers hear it too): `3 shows match
 * “pro”.`, `All 7 shows.`; at the server's cap, a hint to type more.
 * @param {number} count
 * @param {string} query
 */
export function searchSummary(count, query) {
  const q = query.trim();
  if (count === 0) return q ? `No show matches “${q}”.` : "The catalog has no shows.";
  if (count >= SEARCH_MAX) return q ? `The first ${count} shows that match “${q}”; type more to narrow the list.` : `The first ${count} shows; type a title to narrow the list.`;
  if (!q) return count === 1 ? "The catalog's only show." : `All ${count} shows.`;
  return `${plural(count, "show")} ${count === 1 ? "matches" : "match"} “${q}”.`;
}

/**
 * @typedef {object} NowPlaying
 * @property {string} state
 * @property {string} updatedAt
 * @property {string | null} itemTitle
 * @property {string | null} episodeTitle
 * @property {number} positionMs
 * @property {number | null} durationMs
 */

/**
 * Whether a now-playing record describes playback that is going on (a TV that stopped reporting for two minutes
 * is not playing any more, whatever its last state was).
 * @param {NowPlaying | null | undefined} n
 * @param {boolean} online
 * @param {number} [now]
 */
export function isActive(n, online, now = Date.now()) {
  if (!n || !online) return false;
  if (!["starting", "playing", "paused"].includes(n.state)) return false;
  return now - Date.parse(n.updatedAt) < 2 * 60_000;
}

/**
 * Whether the remote-control buttons (pause, resume, seek, previous/next episode) make sense: the TV's last report
 * says it is in the player, playing or paused. An offline TV gets the command queued.
 * @param {{ state: string } | null | undefined} n
 */
export function canControlPlayback(n) {
  return n?.state === "playing" || n?.state === "paused";
}

/**
 * The now-playing chip: Playing, Paused or Starting while the TV's reports are recent (`isActive`), else Last
 * played. `tone` is the chip's colour: `ok` only while the picture runs.
 * @param {NowPlaying} n
 * @param {boolean} online
 * @param {number} [now]
 * @returns {{ label: string, tone: "ok" | "", active: boolean }}
 */
export function playbackState(n, online, now = Date.now()) {
  if (!isActive(n, online, now)) return { label: "Last played", tone: "", active: false };
  if (n.state === "paused") return { label: "Paused", tone: "", active: true };
  if (n.state === "starting") return { label: "Starting", tone: "", active: true };
  return { label: "Playing", tone: "ok", active: true };
}

/**
 * @typedef {object} ProblemLike
 * @property {"tv" | "server" | string} origin
 * @property {string} kind
 * @property {string} code
 * @property {string | null} itemId
 * @property {string | null} itemTitle
 * @property {string | null} [itemKind]
 * @property {string | null} episodeId
 * @property {string | null} episodeTitle
 * @property {number | null} season
 * @property {number | null} number
 * @property {string | null} sourceId
 * @property {number | null} positionMs
 * @property {number | null} httpStatus
 * @property {string | null} appVersion
 * @property {boolean} missing
 */

/** @param {string} origin */
export function originLabel(origin) {
  return origin === "tv" ? "TV" : origin;
}

/**
 * Where and when a problem happened, in a few words: show · episode · source · position · HTTP status · app version.
 * @param {ProblemLike} p
 */
export function problemContext(p) {
  const parts = [];
  if (p.missing) parts.push(`${p.itemId ?? p.episodeId} (no longer in the catalog)`);
  else if (p.itemTitle) {
    parts.push(p.itemTitle);
    if (p.itemKind !== "movie") parts.push(episodeName({ season: p.season, number: p.number, title: p.episodeTitle }, p.itemKind));
  }
  if (p.sourceId) parts.push(`source ${p.sourceId}`);
  if (p.positionMs !== null && p.positionMs !== undefined) parts.push(`at ${formatClock(p.positionMs)}`);
  if (p.httpStatus !== null && p.httpStatus !== undefined) parts.push(`HTTP ${p.httpStatus}`);
  if (p.appVersion) parts.push(`app ${p.appVersion}`);
  return parts.join(" · ");
}

// --- Catalog builds -------------------------------------------------------------------------------------------

/**
 * @typedef {object} BuildLike
 * @property {boolean} baseline
 * @property {{ items: number, episodes: number }} added
 * @property {{ items: number, episodes: number }} removed
 */

/**
 * What a catalog build changed, in a few words: `+2 shows · +14 episodes · −1 episode`; `first load` for the
 * baseline (the first build the server loaded: nothing in it counts as new).
 * @param {BuildLike} b
 */
export function buildSummary(b) {
  if (b.baseline) return "first load";
  const parts = [];
  if (b.added.items > 0) parts.push(`+${plural(b.added.items, "show")}`);
  if (b.added.episodes > 0) parts.push(`+${plural(b.added.episodes, "episode")}`);
  if (b.removed.items > 0) parts.push(`−${plural(b.removed.items, "show")}`);
  if (b.removed.episodes > 0) parts.push(`−${plural(b.removed.episodes, "episode")}`);
  return parts.length ? parts.join(" · ") : "nothing added or removed";
}

/**
 * @typedef {object} EpisodeChange
 * @property {string} id
 * @property {string} itemId
 * @property {string | null} itemTitle
 * @property {number | null} [season]
 * @property {number | null} [number]
 * @property {string | null} [label]
 * @property {boolean} [playbackAllowed]
 */

/**
 * A build's added or removed episodes grouped by show, shows in the order they first appear: `Title — S1 E7, S1 E8`
 * once joined. An episode is `S1 E7`, else its label, else `E7`, else its id (removed episodes carry nothing
 * more); one the catalog does not allow to play is marked. A show without a title is named by its id.
 * @param {EpisodeChange[]} list
 * @returns {Array<{ itemId: string, title: string, episodes: string[] }>}
 */
export function groupEpisodeChanges(list) {
  /** @type {Map<string, { itemId: string, title: string, episodes: string[] }>} */
  const groups = new Map();
  for (const e of list) {
    let group = groups.get(e.itemId);
    if (!group) groups.set(e.itemId, (group = { itemId: e.itemId, title: e.itemTitle ?? e.itemId, episodes: [] }));
    const season = e.season ?? null;
    const number = e.number ?? null;
    const name = season !== null && number !== null ? `S${season} E${number}` : (e.label ?? (number !== null ? `E${number}` : e.id));
    group.episodes.push(e.playbackAllowed === false ? `${name} (not allowed)` : name);
  }
  return [...groups.values()];
}

/**
 * A build id short enough for a list row: `20261014-1a2b3c4d5e6f…`.
 * @param {string} id
 */
export function shortId(id) {
  return id.length > 24 ? `${id.slice(0, 20)}…` : id;
}

/**
 * One line of a catalog validation issue or warning: `items.json /items/3/poster: file not found`.
 * @param {{ file: string, path?: string | null, message: string }} issue
 */
export function issueLine(issue) {
  return `${issue.file}${issue.path ? ` ${issue.path}` : ""}: ${issue.message}`;
}

/** Owner-facing text for API error codes. */
const ERRORS = /** @type {Record<string, string>} */ ({
  unauthorized: "The admin token is not valid.",
  too_many_attempts: "Too many wrong admin tokens were tried from this address. Try again in 10 minutes.",
  unknown_code: "That code is not waiting for approval any more. It may have expired: the TV shows a new one.",
  already_approved: "That code is already approved; the TV will pick it up in a moment.",
  too_many_items: `A home screen holds at most ${HOME_MAX} shows.`,
  duplicate_item: "That show is already on the home screen.",
  unknown_item: "That show is not in the catalog (any more).",
  not_playable: "That show has no episode that may be played.",
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
  unsupported_media: "That source is DASH, which a phone cannot play through the server.",
  no_playable_source: "The source could not be resolved right now.",
  no_link: "Save the timing for this episode first.",
  hls_unsupported: "This browser cannot play HLS.",
  hls_unavailable: "The HLS player did not load. Reload the page and try again.",
});

/**
 * @param {string} code
 */
export function errorMessage(code) {
  return ERRORS[code] ?? `The server answered: ${code}.`;
}

/**
 * Owner-facing text for anything that went wrong: an error that carries a code (the API's, or the companion
 * player's) is looked up in the table above; anything else is a generic sentence.
 * @param {unknown} err
 */
export function errorText(err) {
  const code = /** @type {{ code?: unknown } | null | undefined} */ (err)?.code;
  return typeof code === "string" ? errorMessage(code) : "Something went wrong.";
}

/**
 * `1 variant`, `2 variants`.
 * @param {number} n @param {string} word
 */
export function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** What a failed source attempt means, for the diagnostics view. */
const TRIED = /** @type {Record<string, string>} */ ({
  empty: "the adapter found nothing to play",
  timeout: "timed out",
  abort: "cancelled",
  error: "the adapter failed",
  adapter_unavailable: "no resolver module provides this adapter",
  unsupported: "cannot be served (DASH that needs upstream headers)",
});

/**
 * @param {string} code
 * @param {string | null | undefined} name
 */
export function triedText(code, name) {
  const text = TRIED[code] ?? code;
  if (name === "BudgetExhausted") return "skipped: the time budget of the request ran out";
  return name && code !== "timeout" ? `${text} (${name})` : text;
}

/**
 * One source of a diagnostics run (`POST /admin/diagnostics/resolve`) for the item page: whether it worked
 * (resolved, and its probe passed when there was one), how it was tried, and what came back, a line each.
 * @param {any} s an entry of the answer's `sources`
 * @param {(iso: string) => string} [formatTime] how an expiry time is shown
 * @returns {{ ok: boolean, sourceId: string, how: string, lines: string[] }}
 */
export function sourceReport(s, formatTime = (iso) => new Date(iso).toLocaleString()) {
  const st = s.stream;
  const p = s.probe;
  /** @type {string[]} */
  const lines = [];
  if (!s.ok) lines.push(triedText(s.code, s.name));
  if (st) {
    const delivery = st.delivery === "proxy" ? "through the proxy" : st.delivery === "direct" ? "direct to the TV" : "cannot be served";
    lines.push(`${st.kind.toUpperCase()}${st.inline ? " (inline playlist)" : ""} from ${st.host ?? "?"} · ${delivery}`);
    if (st.headerNames?.length) lines.push(`upstream headers: ${st.headerNames.join(", ")}`);
    if (st.languages) lines.push(`audio ${st.languages.audio?.join(", ") || "unknown"} · subtitles ${st.languages.subtitles?.join(", ") || "unknown"}`);
    if (st.expiresAt) lines.push(`expires ${formatTime(st.expiresAt)}`);
  }
  if (p) {
    const pl = p.playlist;
    const found = pl ? (pl.master ? `${plural(pl.variants, "variant")}, ${plural(pl.renditions, "rendition")}` : plural(pl.segments, "segment")) : null;
    lines.push(
      p.ok
        ? `probe ok (${[p.status ? `HTTP ${p.status}` : null, found, `${p.ms} ms`].filter(Boolean).join(", ")})`
        : `probe failed: ${p.error ?? `HTTP ${p.status}`}${p.name ? ` (${p.name})` : ""}`,
    );
  }
  return {
    ok: Boolean(s.ok && (!p || p.ok)),
    sourceId: s.sourceId,
    how: `${s.type === "adapter" ? `adapter ${s.adapterId}` : "direct"} · ${s.ms} ms`,
    lines,
  };
}

/** Languages offered in the settings selects; any other BCP 47 tag the API accepts is shown as it is. */
export const LANGUAGES = /** @type {const} */ ([
  ["en", "English"],
  ["tr", "Türkçe"],
  ["de", "Deutsch"],
  ["fr", "Français"],
  ["es", "Español"],
  ["it", "Italiano"],
  ["nl", "Nederlands"],
  ["pt", "Português"],
  ["ru", "Русский"],
  ["ar", "العربية"],
  ["ku", "Kurdî"],
]);

/**
 * "Türkçe (tr)" for known tags, the tag itself otherwise; "Off"/"Default" for null as `none` says.
 * @param {string | null | undefined} tag
 * @param {string} [none]
 */
export function languageLabel(tag, none = "–") {
  if (!tag) return none;
  const primary = primarySubtag(tag);
  const known = LANGUAGES.find(([t]) => t === primary);
  return known ? `${known[1]} (${tag})` : tag;
}

/**
 * The language of a BCP 47 tag without region or script, lower case: `pt` for `pt-BR`.
 * @param {string} tag
 */
export function primarySubtag(tag) {
  return (tag.split("-")[0] ?? "").toLowerCase();
}

/**
 * Whether a stream's track language is the one wanted (`en` matches `en-GB`); never for an unknown side.
 * @param {string | null | undefined} wanted
 * @param {string | null | undefined} actual
 */
export function sameLanguage(wanted, actual) {
  return Boolean(wanted && actual && primarySubtag(wanted) === primarySubtag(actual));
}

/**
 * The episode list with what the device did with each: watched, current (where OK continues), progress.
 * @template {{ id: string }} E
 * @param {E[]} episodes
 * @param {string | null} cursorEpisodeId
 * @param {Array<{ episodeId: string, status: string, positionMs: number, durationMs: number | null }>} progress
 */
export function episodeStates(episodes, cursorEpisodeId, progress) {
  const byId = new Map(progress.map((p) => [p.episodeId, p]));
  return episodes.map((e) => {
    const p = byId.get(e.id);
    return {
      episode: e,
      current: e.id === cursorEpisodeId,
      watched: p?.status === "finished",
      percent: p && p.status !== "finished" ? percent(p.positionMs, p.durationMs) : null,
    };
  });
}

/**
 * The chip of an episode in the "continue from" picker: not allowed (by the catalog), next (where OK continues),
 * watched, how far it got, else new.
 * @param {{ episode: { playbackAllowed?: boolean }, current: boolean, watched: boolean, percent: number | null }} s
 */
export function episodeStateLabel(s) {
  if (!s.episode.playbackAllowed) return "not allowed";
  if (s.current) return "next";
  if (s.watched) return "watched";
  return s.percent !== null ? `${s.percent}%` : "new";
}

// --- Listen along (companion audio on the owner's phone) ----------------------------------------------------------

/** Sync loop tuning: when to seek, how hard to nudge the playback rate, which clock samples to trust. */
export const SYNC = { seekMs: 1500, coarseMs: 300, fineMs: 40, coarseAdj: 0.05, fineAdj: 0.02, minRate: 0.9, maxRate: 1.1, sampleMaxRttMs: 1000 };

/**
 * @typedef {{ positionMs: number, atMs: number, playing: boolean, rate?: number }} Anchor
 * @typedef {{ offsetMs: number, rate: number }} LinkTiming
 * @typedef {{ sentAt: number, receivedAt: number, serverNowMs: number }} ClockSample
 */

/**
 * Where the TV is at `serverNowMs` (server clock): the anchor's position, advanced while it was playing.
 * @param {Anchor | null | undefined} anchor
 * @param {number} serverNowMs
 */
export function tvPositionAt(anchor, serverNowMs) {
  if (!anchor) return null;
  const run = anchor.playing ? Math.max(0, serverNowMs - anchor.atMs) * (anchor.rate ?? 1) : 0;
  return anchor.positionMs + run;
}

/**
 * The companion position matching a TV position: `rate · tv + offset`, plus this phone's nudge for its own
 * output latency.
 * @param {number} tvPositionMs
 * @param {LinkTiming} link
 * @param {number} [nudgeMs]
 */
export function companionTarget(tvPositionMs, link, nudgeMs = 0) {
  return link.rate * tvPositionMs + link.offsetMs + nudgeMs;
}

/**
 * What the phone's player should do to stay on target: pause with the TV, seek when far off, otherwise play a
 * little faster or slower than the nominal rate until the error is within `SYNC.fineMs`.
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
 * Server clock minus phone clock, from round trips measured on the phone: the sample with the shortest round
 * trip wins; long ones (a long-poll that waited) are ignored. Null without a usable sample.
 * @param {ClockSample[]} samples
 */
export function clockOffset(samples) {
  /** @type {ClockSample | null} */
  let best = null;
  for (const s of samples) {
    const rtt = s.receivedAt - s.sentAt;
    if (rtt < 0 || rtt > SYNC.sampleMaxRttMs) continue;
    if (!best || rtt < best.receivedAt - best.sentAt) best = s;
  }
  return best ? best.serverNowMs - (best.sentAt + best.receivedAt) / 2 : null;
}

/**
 * @param {ClockSample[]} samples @param {ClockSample} sample @param {number} [keep]
 */
export function pushSample(samples, sample, keep = 8) {
  return [...samples, sample].slice(-keep);
}

/**
 * @typedef {object} Candidate
 * @property {string} sourceId
 * @property {string | null} label
 * @property {{ audio: string[] | null, subtitles: string[] | null }} languages
 * @property {boolean} current
 * @property {boolean} supported
 * @property {string | null} reason
 */

/**
 * Select options for the companion candidates: one per source, or one per audio language when a source has
 * several. `value` is `<sourceId>\u0000<language>` (see `parseCandidate`).
 * @param {Candidate[]} candidates
 */
export function candidateOptions(candidates) {
  const out = [];
  for (const c of candidates) {
    const langs = c.languages?.audio ?? null;
    const perLanguage = langs && langs.length >= 2 ? langs : [null];
    for (const lang of perLanguage) {
      const parts = [c.label ? `${c.sourceId} — ${c.label}` : c.sourceId];
      if (lang) parts.push(languageLabel(lang));
      else if (langs && langs.length === 1) parts.push(languageLabel(langs[0]));
      else if (langs && langs.length === 0) parts.push("no dialogue");
      if (c.current) parts.push("the TV's source");
      if (!c.supported) parts.push(c.reason === "dash" ? "DASH, cannot play on a phone" : "cannot play");
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

/**
 * `+0.6 s`, `−12 ms`; `–` when unknown.
 * @param {number | null | undefined} ms
 */
export function formatDrift(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "–";
  const sign = ms < 0 ? "−" : "+";
  const abs = Math.abs(ms);
  return abs >= 1000 ? `${sign}${(abs / 1000).toFixed(1)} s` : `${sign}${Math.round(abs)} ms`;
}

/**
 * `1:02:03.4` — a position with tenths of a second, for the sync status line.
 * @param {number | null | undefined} ms
 */
export function formatPosition(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "–";
  return `${formatClock(ms)}.${Math.floor((ms % 1000) / 100)}`;
}
