import { isLiveItem, type EpisodicItem } from "@izle/contract";
import type { Actor } from "./actor.ts";
import { playingKey } from "./catalog.ts";
import type { Services } from "./context.ts";
import { HttpError } from "./errors.ts";
import { requireEpisode, requireEpisodicItem, requireItem, requirePlayable, requirePlayableRef } from "./lookup.ts";
import { autoNextIndex, cursorAfterReport, cursorIndex, isPlayable } from "./playback.ts";
import type { EpisodeProgressInput, LiveReportInput, PlayingService, ProgressInput } from "./playing.ts";
import { episodeDetails, episodeSummary, iso, itemCard, itemDetails, tvSource } from "./presenters.ts";
import { noPlayableDetail, triedDetail } from "./problems.ts";
import type { ResolvedStream, ResolveInput, Tried } from "./resolve.ts";
import type { Cursor, Device, Progress } from "./store.ts";

/** A technical safety limit on every device's home list, not a product rule: Home scrolls past one screen. */
export const HOME_MAX_ITEMS = 200;

/** What the device saved about one item: positions by episode, the play cursor, and the episodes new since a time. */
export interface ItemFacts {
  progress: Map<string, Progress>;
  cursor: Cursor | null;
  /** The item's present episodes that first appeared after `sinceMs`, oldest first. */
  seenAfter: (sinceMs: number) => string[];
}

/** Per-TV home grid: cards per row and rows per screen (the owner's setting; the defaults are migration 8's). */
export const HOME_COLUMNS = { min: 3, max: 6, default: 4 } as const;
export const HOME_ROWS = { min: 1, max: 4, default: 2 } as const;

type TvDeps = Pick<Services, "config" | "store" | "catalog" | "notifier" | "eventLog" | "resolver" | "problems" | "now"> & {
  /** What each TV is playing: a resolve starts a playback, a report goes on to it. */
  playing: PlayingService;
};

/**
 * What the TV sees and reports: home state, item details, resolve and progress. Also the owner's side of the same
 * state (the admin API): the home list and the "continue from" override. What a TV is playing is playing.ts's.
 */
export class TvService {
  private readonly s: TvDeps;

  constructor(deps: TvDeps) {
    this.s = deps;
  }

  /** The device's settings, falling back to the server's defaults, then to the catalog's hints. */
  settings(device: Device) {
    const hints = this.s.catalog.current.manifest.defaults ?? {};
    const ui = device.uiLanguage ?? this.s.config.defaults.uiLanguage ?? hints.uiLanguage ?? "en";
    return {
      uiLanguage: ui === "tr" ? ("tr" as const) : ("en" as const),
      preferredAudioLanguage: device.preferredAudioLanguage ?? this.s.config.defaults.preferredAudioLanguage ?? hints.preferredAudioLanguage ?? null,
      subtitlesLanguage: device.subtitlesLanguage,
      autoplayOnStart: device.autoplayOnStart,
      homeColumns: device.homeColumns,
      homeRows: device.homeRows,
    };
  }

  private progressMap(deviceId: string, itemId: string): Map<string, Progress> {
    return new Map(this.s.store.listProgress(deviceId, this.s.catalog.catalogId, itemId).map((p) => [p.episodeId, p]));
  }

  /** What continueFor and newEpisodesFor read about one item on one device, a few queries. */
  private itemFacts(deviceId: string, itemId: string): ItemFacts {
    const catalogId = this.s.catalog.catalogId;
    return {
      progress: this.progressMap(deviceId, itemId),
      cursor: this.s.store.getCursor(deviceId, catalogId, itemId),
      seenAfter: (sinceMs) => this.s.store.episodesSeenAfter(catalogId, itemId, sinceMs),
    };
  }

  /**
   * The same facts for every item of a device's home list (up to HOME_MAX_ITEMS), read in three queries rather than
   * a few per item.
   */
  homeFacts(deviceId: string): (itemId: string) => ItemFacts {
    const catalogId = this.s.catalog.catalogId;
    const progress = new Map<string, Map<string, Progress>>();
    for (const p of this.s.store.listProgress(deviceId, catalogId)) {
      const byEpisode = progress.get(p.itemId) ?? new Map<string, Progress>();
      progress.set(p.itemId, byEpisode.set(p.episodeId, p));
    }
    const cursors = new Map(this.s.store.listCursors(deviceId, catalogId).map((c) => [c.itemId, c]));
    const seen = this.s.store.listSeen(catalogId);
    return (itemId) => ({
      progress: progress.get(itemId) ?? new Map(),
      cursor: cursors.get(itemId) ?? null,
      seenAfter: (sinceMs) => (seen.get(itemId) ?? []).filter((e) => e.firstSeenAt > sinceMs).map((e) => e.episodeId),
    });
  }

  /**
   * The episode OK would play for this item and where it would start. Null when nothing is playable. After the
   * item was watched to the end (a wrapped cursor), episodes the catalog gained since then come first. `facts` is
   * what the device saved about the item, when the caller already has it (see homeFacts).
   */
  continueFor(deviceId: string, item: EpisodicItem, facts = this.itemFacts(deviceId, item.id)) {
    const { progress, cursor } = facts;
    const appended = cursor?.wrapped ? new Set(facts.seenAfter(cursor.updatedAt)) : undefined;
    const index = cursorIndex(item, cursor, progress, appended);
    if (index < 0) return null;
    const episode = item.episodes[index]!;
    const p = progress.get(episode.id);
    const status = p?.status ?? "new";
    const positionMs = status === "watching" ? p!.positionMs : 0;
    const durationMs = p?.durationMs ?? episode.durationMs ?? null;
    return { episodeId: episode.id, ...episodeSummary(episode), index, count: item.episodes.length, positionMs, durationMs, status };
  }

  /**
   * How many episodes of the item with playbackAllowed entered the catalog after both the device's last progress
   * report on the item and the moment the item went on its home list (`addedAt`). Episodes of the first load of
   * the catalog (the history's baseline) never count.
   */
  newEpisodesFor(deviceId: string, item: EpisodicItem, addedAt: number | null, facts = this.itemFacts(deviceId, item.id)): number {
    const lastProgressAt = Math.max(0, ...[...facts.progress.values()].map((p) => p.updatedAt));
    const added = facts.seenAfter(Math.max(lastProgressAt, addedAt ?? 0));
    const allowed = new Set(item.episodes.filter((e) => e.playbackAllowed).map((e) => e.id));
    return added.filter((id) => allowed.has(id)).length;
  }

  state(device: Device) {
    const { manifest } = this.s.catalog.current;
    const home = [];
    const factsFor = this.homeFacts(device.id);
    for (const { itemId, addedAt } of this.s.store.getHomeEntries(device.id, manifest.catalogId)) {
      // Items gone after a catalog reload are flagged on the admin page; unplayable ones are left out.
      const item = this.s.catalog.item(itemId);
      if (!item) continue;
      if (isLiveItem(item)) {
        // A channel has no cursor, position or new episodes: OK plays it at its live edge.
        if (item.playbackAllowed) home.push({ item: itemCard(this.s.catalog, item), continue: null, newEpisodes: 0 });
        continue;
      }
      const facts = factsFor(item.id);
      const cont = this.continueFor(device.id, item, facts);
      if (!cont) continue;
      home.push({ item: itemCard(this.s.catalog, item), continue: cont, newEpisodes: this.newEpisodesFor(device.id, item, addedAt, facts) });
    }
    return {
      version: device.stateVersion, device: { id: device.id, name: device.name, ...this.settings(device) },
      catalog: { id: manifest.catalogId, buildId: manifest.buildId, name: manifest.name }, home,
    };
  }

  /** The hidden menu's view of an item: its episodes with the cursor, or a channel's approval and sources. */
  item(device: Device, itemId: string) {
    const item = requireItem(this.s.catalog, itemId, 404, "unknown_item");
    if (isLiveItem(item)) {
      return { item: itemDetails(this.s.catalog, item), channel: { playbackAllowed: item.playbackAllowed, sources: item.sources.map(tvSource) } };
    }
    const facts = this.itemFacts(device.id, item.id);
    const { progress } = facts;
    const cont = this.continueFor(device.id, item, facts);
    return {
      item: itemDetails(this.s.catalog, item),
      cursorEpisodeId: cont?.episodeId ?? null,
      episodes: item.episodes.map((episode, index) => {
        const p = progress.get(episode.id);
        return {
          ...episodeDetails(episode, index),
          progress: p ? { positionMs: p.positionMs, durationMs: p.durationMs, status: p.status, updatedAt: iso(p.updatedAt) } : null,
          sources: episode.sources.map(tvSource),
        };
      }),
    };
  }

  /** The TV's resolve, recording for the owner what went wrong on the way (problem reports). */
  private async resolveRecordingProblems(device: Device, input: ResolveInput, signal: AbortSignal | undefined): Promise<ResolvedStream> {
    let r: ResolvedStream;
    try {
      r = await this.s.resolver.resolve(device.id, this.settings(device).preferredAudioLanguage, input, signal);
    } catch (err) {
      // "Can't play right now" on the TV: the owner learns which sources were tried and why each failed.
      if (err instanceof HttpError && err.code === "no_playable_source") {
        const tried = (err.extra.tried ?? []) as Tried[];
        const playing = input.episodeId !== undefined ? { episodeId: input.episodeId } : { itemId: input.itemId };
        this.s.problems.record(device.id, { kind: "resolve", code: "no_playable_source", ...playing, detail: noPlayableDetail(tried, input.exclude) });
      }
      throw err;
    }
    // Sources the server fell back past. A missing adapter is a configuration warning on the catalog page instead.
    const playing = playingKey(r.ref);
    for (const t of r.failed) {
      if (t.code === "adapter_unavailable") continue;
      this.s.problems.record(device.id, { kind: "resolve", code: "source_failed", ...playing, sourceId: t.sourceId, detail: triedDetail(t) });
    }
    return r;
  }

  /**
   * The TV's resolve: what to play and how, with the episode's resume position and auto-next, or for a channel
   * (`episode`, `next` and `resume` null) the stream at its live edge. The playback starts (or goes on) in playing.ts.
   */
  async resolve(device: Device, input: ResolveInput, signal?: AbortSignal) {
    const r = await this.resolveRecordingProblems(device, input, signal);
    const { ref } = r;
    const answer = {
      sessionId: r.session.id, sourceId: r.source.id, media: r.media,
      subtitleTracks: r.subtitleTracks.map((s) => ({ url: s.url, language: s.language, format: s.format, label: s.label ?? null })),
      languages: r.languages, alternatives: r.alternatives, item: itemCard(this.s.catalog, ref.item), expiresAt: r.expiresAt,
    };
    const played = { ref, sourceId: r.source.id };
    if (ref.kind === "live") {
      this.s.playing.started(device, played, null, input);
      return { ...answer, next: null, episode: null, resume: null };
    }
    const { item, episode, index } = ref;
    const nextIndex = autoNextIndex(item, index);
    const next = nextIndex >= 0 ? item.episodes[nextIndex]! : null;
    const progress = this.s.store.getProgress(device.id, this.s.catalog.catalogId, episode.id);
    const resume = progress?.status === "watching" ? { positionMs: progress.positionMs, durationMs: progress.durationMs } : null;
    // Playback starts where the resume offered says, with the duration the TV last reported, else the catalog's.
    this.s.playing.started(device, played, { positionMs: resume?.positionMs ?? 0, durationMs: progress?.durationMs ?? episode.durationMs ?? null }, input);
    return {
      ...answer, next: next ? { episodeId: next.id, ...episodeSummary(next) } : null,
      episode: { id: episode.id, index, count: item.episodes.length, ...episodeSummary(episode), durationMs: episode.durationMs ?? null }, resume,
    };
  }

  /**
   * Heartbeat from the player: an episode's report (recordEpisodeProgress) or a channel's (recordLiveReport);
   * `version` is the device's state version after it.
   */
  recordProgress(device: Device, input: ProgressInput): { version: number } {
    return input.itemId !== undefined ? this.recordLiveReport(device, input) : this.recordEpisodeProgress(device, input);
  }

  /**
   * A channel's report. A channel has no position, cursor or end, so nothing the TV shows changes: no progress row
   * is written and the state version is not bumped; playing.ts hears it.
   */
  private recordLiveReport(device: Device, input: LiveReportInput): { version: number } {
    this.s.playing.reported(device, requirePlayableRef(this.s.catalog, { itemId: input.itemId }, 404), input);
    return { version: this.s.notifier.version(device) };
  }

  /**
   * An episode's report. Saves the position, keeps the item's cursor on the episode being watched, and on
   * `finished` moves the cursor to the next allowed episode (wrapping to the first after the last). Only that wrap
   * stores a wrapped cursor; every other report makes it an ordinary one. playing.ts hears it in the same
   * transaction.
   */
  private recordEpisodeProgress(device: Device, input: EpisodeProgressInput): { version: number } {
    const ref = requireEpisode(this.s.catalog, input.episodeId, 404, "unknown_episode");
    const { item, episode, index } = ref;
    const catalogId = this.s.catalog.catalogId;
    const t = this.s.now();
    const durationMs = input.durationMs ?? null;
    const finished = input.status === "finished";
    const changed = this.s.store.transaction(() => {
      const cursor = cursorAfterReport(item, index, input.status, this.s.store.getCursor(device.id, catalogId, item.id));
      const positionMs = finished ? (durationMs ?? input.positionMs) : input.positionMs;
      this.s.store.upsertProgress(device.id, { catalogId, itemId: item.id, episodeId: episode.id, positionMs, durationMs, status: finished ? "finished" : "watching", updatedAt: t });
      this.s.store.setCursor(device.id, { catalogId, itemId: item.id, episodeId: cursor.episodeId, updatedAt: t, wrapped: cursor.wrapped });
      this.s.playing.reported(device, ref, input);
      return cursor.changed;
    });
    return { version: changed ? this.s.notifier.bump(device.id) : this.s.notifier.version(device) };
  }

  /**
   * Owner override "continue from episode X": moves the cursor (an ordinary one, so it wins over episodes added
   * after a wrap) and forgets X's saved position so it starts over. A channel has no cursor (400 `unknown_episode`).
   */
  setCursor(deviceId: string, itemId: string, episodeId: string, actor: Actor): number {
    const item = requireEpisodicItem(this.s.catalog, itemId, 404, "unknown_item");
    const episode = item.episodes.find((e) => e.id === episodeId);
    if (!episode) throw new HttpError(400, "unknown_episode", "the episode does not belong to this item");
    requirePlayable(episode, 400, "not_allowed");
    const catalogId = this.s.catalog.catalogId;
    this.s.store.transaction(() => {
      this.s.store.setCursor(deviceId, { catalogId, itemId, episodeId, updatedAt: this.s.now() });
      this.s.store.deleteProgress(deviceId, catalogId, episodeId);
      this.s.eventLog.append("cursor.changed", deviceId, actor, { itemId, episodeId });
    });
    return this.s.notifier.bump(deviceId);
  }

  /**
   * Replaces the home list. With `expected` (the list the caller saw), answers 409 `home_changed` when the list is
   * no longer that, so two editors do not overwrite each other.
   */
  setHome(deviceId: string, itemIds: string[], actor: Actor, expected?: string[]): number {
    if (itemIds.length > HOME_MAX_ITEMS) {
      throw new HttpError(400, "too_many_items", `a home list holds at most ${HOME_MAX_ITEMS} items`, { max: HOME_MAX_ITEMS });
    }
    const seen = new Set<string>();
    for (const id of itemIds) {
      if (seen.has(id)) throw new HttpError(400, "duplicate_item", "an item appears twice", { itemId: id });
      seen.add(id);
      const item = this.s.catalog.item(id);
      if (!item) throw new HttpError(400, "unknown_item", "no such item in the catalog", { itemId: id });
      if (!isPlayable(item)) throw new HttpError(400, "not_playable", "the item has no episode with playback allowed, or is a channel whose playback is not allowed", { itemId: id });
    }
    this.s.store.transaction(() => {
      const before = this.homeIds(deviceId);
      if (expected && (before.length !== expected.length || before.some((id, i) => id !== expected[i]))) {
        throw new HttpError(409, "home_changed", "the home list changed in the meantime", { itemIds: before });
      }
      this.s.store.setHome(deviceId, this.s.catalog.catalogId, itemIds, this.s.now());
      const was = new Set(before);
      const is = new Set(itemIds);
      this.s.eventLog.append("home.changed", deviceId, actor, { itemIds, added: itemIds.filter((id) => !was.has(id)), removed: before.filter((id) => !is.has(id)) });
    });
    return this.s.notifier.bump(deviceId);
  }

  // --- single home changes: each builds the new list and goes through setHome ----------------------------------

  /** The device's home list as item ids, in display order (items gone from the catalog included). */
  homeIds(deviceId: string): string[] {
    return this.s.store.getHomeEntries(deviceId, this.s.catalog.catalogId).map((e) => e.itemId);
  }

  /** Puts the item at `position` (0-based; default and upper bound: the end). */
  addHomeItem(deviceId: string, itemId: string, position: number | undefined, actor: Actor): number {
    const ids = this.homeIds(deviceId);
    ids.splice(Math.min(position ?? ids.length, ids.length), 0, itemId);
    return this.setHome(deviceId, ids, actor);
  }

  /** Moves an item of the list to `position` (clamped to the end). */
  moveHomeItem(deviceId: string, itemId: string, position: number, actor: Actor): number {
    const ids = this.withoutHomeItem(deviceId, itemId);
    ids.splice(Math.min(position, ids.length), 0, itemId);
    return this.setHome(deviceId, ids, actor);
  }

  removeHomeItem(deviceId: string, itemId: string, actor: Actor): number {
    return this.setHome(deviceId, this.withoutHomeItem(deviceId, itemId), actor);
  }

  /** The list without the item; 404 `not_on_home` when it is not on it. */
  private withoutHomeItem(deviceId: string, itemId: string): string[] {
    const ids = this.homeIds(deviceId);
    if (!ids.includes(itemId)) throw new HttpError(404, "not_on_home", "the item is not on this TV's home list");
    return ids.filter((id) => id !== itemId);
  }
}
