// Pure play-order rules: which episode OK plays, what auto-next does, and in which order sources are tried.
// No I/O here so the rules are easy to test.

import type { CatalogItem, Episode, LanguageFacts, Source } from "@izle/contract";

export interface ProgressLike {
  episodeId: string;
  positionMs: number;
  durationMs: number | null;
  status: "watching" | "finished";
}

/** Whether playback should auto-start the next episode after `episode` (episode setting, else item, else true). */
export function autoAdvanceAfter(item: CatalogItem, episode: Episode): boolean {
  return episode.autoAdvance ?? item.autoAdvance ?? true;
}

/** Index of the first episode after `from` (exclusive) with playbackAllowed, or -1. */
export function nextAllowedIndex(item: CatalogItem, from: number): number {
  for (let i = from + 1; i < item.episodes.length; i++) if (item.episodes[i]!.playbackAllowed) return i;
  return -1;
}

export function firstAllowedIndex(item: CatalogItem): number {
  return nextAllowedIndex(item, -1);
}

export function isPlayable(item: CatalogItem): boolean {
  return firstAllowedIndex(item) >= 0;
}

/** An item's cursor as the play-order rules see it; a bare episode id is an ordinary (not wrapped) cursor. */
export interface CursorLike {
  episodeId: string;
  /** Placed by the wrap to the first episode after the last one was finished. */
  wrapped: boolean;
}

const EMPTY: ReadonlySet<string> = new Set();

/**
 * The episode OK plays (index into item.episodes), or -1 when nothing is playable.
 * - A wrapped cursor (the item was watched to the end) with `appended` episodes (added to the catalog after the
 *   wrap) plays the first of them in play order with playbackAllowed; when none is allowed, the rules below apply.
 * - A cursor on an allowed episode wins.
 * - A cursor on a no-longer-allowed episode moves to the next allowed one (wrapping to the first).
 * - Without a usable cursor: the first allowed episode not yet finished, else the first allowed one (rewatch).
 */
export function cursorIndex(
  item: CatalogItem,
  cursor: string | CursorLike | null,
  progress: ReadonlyMap<string, ProgressLike>,
  appended: ReadonlySet<string> = EMPTY,
): number {
  const first = firstAllowedIndex(item);
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

/**
 * Where the cursor goes after an episode finished: the next allowed episode in play order, wrapping to the first
 * allowed one after the last (so OK on a fully watched item starts it again). `autoAdvance` does not matter here;
 * it only controls whether playback continues by itself.
 */
export function cursorAfterFinished(item: CatalogItem, finishedIndex: number): number {
  const next = nextAllowedIndex(item, finishedIndex);
  return next >= 0 ? next : firstAllowedIndex(item);
}

/** The episode auto-next would start after `index`, or -1 (end of the item, or an autoAdvance boundary). */
export function autoNextIndex(item: CatalogItem, index: number): number {
  const episode = item.episodes[index];
  if (!episode || !autoAdvanceAfter(item, episode)) return -1;
  return nextAllowedIndex(item, index);
}

export function primarySubtag(tag: string): string {
  return tag.split("-")[0]!.toLowerCase();
}

/**
 * 0 = matches the preferred audio language (or has no dialogue, or no preference is set), 1 = unknown,
 * 2 = known not to match.
 */
export function audioRank(languages: LanguageFacts, preferred: string | null): 0 | 1 | 2 {
  if (!preferred) return 0;
  if (languages.audio === null) return 1;
  if (languages.audio.length === 0) return 0;
  const want = primarySubtag(preferred);
  return languages.audio.some((t) => primarySubtag(t) === want) ? 0 : 2;
}

export interface OrderOptions {
  preferredAudioLanguage: string | null;
  /** Source ids to leave out (the TV already tried them). */
  exclude?: ReadonlySet<string>;
  /** Source ids that failed recently; they go last. */
  failed?: ReadonlySet<string>;
}

/**
 * Candidate sources in the order they are tried: bundle order, stable-sorted by audio match > unknown > mismatch,
 * with recently failed sources moved to the end.
 */
export function orderSources(sources: readonly Source[], opts: OrderOptions): Source[] {
  const exclude = opts.exclude ?? new Set<string>();
  const failed = opts.failed ?? new Set<string>();
  return sources
    .filter((s) => !exclude.has(s.id))
    .map((s, i) => ({ s, i, f: failed.has(s.id) ? 1 : 0, r: audioRank(s.languages, opts.preferredAudioLanguage) }))
    .sort((a, b) => a.f - b.f || a.r - b.r || a.i - b.i)
    .map((x) => x.s);
}
