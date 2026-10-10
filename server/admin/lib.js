// @ts-check
// Pure helpers of the admin UI (no DOM): formatting and small list operations. Unit-tested from node.

/** Shows the server's home list cap; the server enforces it. */
export const HOME_MAX = 12;

/** The TV resumes a saved position only from 30 s on (PlaybackPlan); earlier positions start over. */
export const RESUME_MIN_MS = 30_000;

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

/** Owner-facing text for API error codes. */
const ERRORS = /** @type {Record<string, string>} */ ({
  unauthorized: "The admin token is not valid.",
  unknown_code: "That code is not waiting for approval any more. It may have expired: the TV shows a new one.",
  already_approved: "That code is already approved; the TV will pick it up in a moment.",
  too_many_items: `A home screen holds at most ${HOME_MAX} shows.`,
  duplicate_item: "That show is already on the home screen.",
  unknown_item: "That show is not in the catalog (any more).",
  not_playable: "That show has no episode that may be played.",
  not_allowed: "Playback of that episode is not allowed by the catalog.",
  unknown_episode: "That episode is not in the catalog (any more).",
  unknown_device: "That TV does not exist any more.",
  invalid_catalog: "The catalog on disk is invalid; the previous one stays active.",
  invalid_request: "The server did not accept the request.",
  body_too_large: "The request was too large.",
  network: "The server cannot be reached.",
  internal: "The server ran into an error. Its log has details.",
});

/**
 * @param {string} code
 */
export function errorMessage(code) {
  return ERRORS[code] ?? `The server answered: ${code}.`;
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
  const primary = tag.split("-")[0]?.toLowerCase();
  const known = LANGUAGES.find(([t]) => t === primary);
  return known ? `${known[1]} (${tag})` : tag;
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
