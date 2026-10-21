// Pure play-order rules: which episode OK plays, what auto-next does, and in which order sources are tried.
// No I/O here so the rules are easy to test.

import type { EpisodicItem, LanguageFacts, Source } from "@izle/contract";
import type { Progress } from "./store.ts";


/** Index of the first episode after `from` (exclusive) with playbackAllowed, or -1 (`from` -1: the first one). */
function nextAllowedIndex(item: EpisodicItem, from: number): number {
  for (let i = from + 1; i < item.episodes.length; i++) if (item.episodes[i]!.playbackAllowed) return i;
  return -1;
}

export function isPlayable(item: EpisodicItem): boolean {
  return nextAllowedIndex(item, -1) >= 0;
}

/** An item's cursor as the play-order rules see it; a bare episode id is an ordinary (not wrapped) cursor. */
interface CursorLike {
  episodeId: string;
  /** Placed by the wrap to the first episode after the last one was finished. */
  wrapped: boolean;
}

/**
 * The episode OK plays (index into item.episodes), or -1 when nothing is playable.
 * - A wrapped cursor (the item was watched to the end) with `appended` episodes (added to the catalog after the
 *   wrap) plays the first of them in play order with playbackAllowed; when none is allowed, the rules below apply.
 * - A cursor on an allowed episode wins.
 * - A cursor on a no-longer-allowed episode moves to the next allowed one (wrapping to the first).
 * - Without a usable cursor: the first allowed episode not yet finished, else the first allowed one (rewatch).
 */
export function cursorIndex(
  item: EpisodicItem,
  cursor: string | CursorLike | null,
  progress: ReadonlyMap<string, Pick<Progress, "status">>,
  appended: ReadonlySet<string> = new Set(),
): number {
  const first = nextAllowedIndex(item, -1);
  if (first < 0) return -1;
  const c: CursorLike | null = typeof cursor === "string" ? { episodeId: cursor, wrapped: false } : cursor;
  if (c?.wrapped && appended.size > 0) {
    const added = item.episodes.findIndex((e) => e.playbackAllowed && appended.has(e.id));
    if (added >= 0) return added;
  }
  if (c !== null) {
    const at = item.episodes.findIndex((e) => e.id === c.episodeId);
    if (at >= 0) {
      if (item.episodes[at]!.playbackAllowed) return at;
      const next = nextAllowedIndex(item, at);
      return next >= 0 ? next : first;
    }
  }
  for (let i = first; i >= 0; i = nextAllowedIndex(item, i)) {
    if (progress.get(item.episodes[i]!.id)?.status !== "finished") return i;
  }
  return first;
}

/** What a progress report says the player is doing. */
export const PROGRESS_REPORT_STATUSES = ["playing", "paused", "stopped", "finished"] as const;

export type ProgressReportStatus = (typeof PROGRESS_REPORT_STATUSES)[number];

/**
 * The cursor after a progress report on the episode at `index`. `finished` moves it to the next allowed episode,
 * wrapping to the first after the last (so OK on a fully watched item starts it again; `autoAdvance` does not matter
 * here); only that wrap gives a wrapped cursor. Every other report keeps it on the reported episode as an ordinary
 * cursor. `changed` (the state version must be bumped) is always true for `stopped` and `finished` (the TV left the
 * player); any other report is a change when the cursor moves, or stops being wrapped (OK may then play another
 * episode).
 */
export function cursorAfterReport(
  item: EpisodicItem,
  index: number,
  status: ProgressReportStatus,
  before: CursorLike | null,
): CursorLike & { changed: boolean } {
  const finished = status === "finished";
  const next = nextAllowedIndex(item, index);
  const wrapped = finished && next < 0;
  const episodeId = (finished ? item.episodes[wrapped ? nextAllowedIndex(item, -1) : next] : undefined)?.id ?? item.episodes[index]!.id;
  const changed = finished || status === "stopped" || before?.episodeId !== episodeId || (before?.wrapped ?? false) !== wrapped;
  return { episodeId, wrapped, changed };
}

/**
 * The episode auto-next would start after `index`, or -1: the end of the item, or an autoAdvance boundary (the
 * episode's setting, else the item's, else true).
 */
export function autoNextIndex(item: EpisodicItem, index: number): number {
  const episode = item.episodes[index];
  if (!episode || !(episode.autoAdvance ?? item.autoAdvance ?? true)) return -1;
  return nextAllowedIndex(item, index);
}

/**
 * 0 = matches the preferred audio language (or has no dialogue, or no preference is set), 1 = unknown,
 * 2 = known not to match. Languages match on their primary subtag.
 */
function audioRank(languages: LanguageFacts, preferred: string | null): 0 | 1 | 2 {
  if (!preferred) return 0;
  if (languages.audio === null) return 1;
  if (languages.audio.length === 0) return 0;
  const primary = (tag: string) => tag.split("-")[0]!.toLowerCase();
  return languages.audio.some((t) => primary(t) === primary(preferred)) ? 0 : 2;
}

/**
 * Candidate sources in the order they are tried: bundle order, stable-sorted by audio match > unknown > mismatch,
 * with the `exclude`d ones (the TV already tried them) left out and the recently `failed` ones moved to the end.
 */
export function orderSources(
  sources: readonly Source[],
  opts: { preferredAudioLanguage: string | null; exclude?: ReadonlySet<string>; failed?: ReadonlySet<string> },
): Source[] {
  const preferred = opts.preferredAudioLanguage;
  return sources
    .filter((s) => !opts.exclude?.has(s.id))
    .map((s, i) => ({ s, i, f: opts.failed?.has(s.id) ? 1 : 0, r: audioRank(s.languages, preferred) }))
    .sort((a, b) => a.f - b.f || a.r - b.r || a.i - b.i)
    .map((x) => x.s);
}
