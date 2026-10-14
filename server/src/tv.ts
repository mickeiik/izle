import type { CatalogItem } from "@izle/contract";
import type { Services } from "./context.ts";
import { HttpError } from "./errors.ts";
import { requireEpisode, requireItem, requirePlayable } from "./lookup.ts";
import { autoNextIndex, cursorAfterReport, cursorIndex, isPlayable, type ProgressLike, type ProgressReportStatus } from "./playback.ts";
import { episodeDetails, episodeSummary, iso, itemCard, itemDetails } from "./presenters.ts";
import { noPlayableDetail, triedDetail } from "./problems.ts";
import type { ResolvedStream, ResolveInput, Tried } from "./resolve.ts";
import type { Device, NowPlaying, Progress } from "./store.ts";
import { Waiters } from "./waiters.ts";

export type { Services } from "./context.ts";
export type { ProgressReportStatus } from "./playback.ts";

/** The server caps every device's home list (the TV shows a 4-column grid; ≤ 8 fits without scrolling). */
export const HOME_MAX_ITEMS = 12;

/** Longest an admin "now" long-poll waits for the next playback report. */
export const MAX_NOW_WAIT_MS = 25_000;

export interface ProgressInput {
  sessionId?: string | null;
  episodeId: string;
  positionMs: number;
  durationMs: number | null;
  status: ProgressReportStatus;
  /** Whether the player was actually advancing (false during a rebuffer stall); defaults to `status === "playing"`. */
  playing?: boolean;
  /** How long before sending the position was sampled, so a delayed report still anchors correctly. */
  ageMs?: number;
}

export interface EffectiveSettings {
  uiLanguage: "tr" | "en";
  preferredAudioLanguage: string | null;
  subtitlesLanguage: string | null;
  autoplayOnStart: boolean;
}

/** What the TV sees: home state, item details, resolve and progress. Also used by the admin API. */
export class TvService {
  private readonly s: Services;
  /** Admin long-polls waiting for a device's next now-playing write. */
  private readonly nowWaiters = new Waiters<string>();

  constructor(services: Services) {
    this.s = services;
  }

  /**
   * The device's now-playing row. With `seq` equal to the row's current sequence number, waits up to `waitMs`
   * for the next write (a resolve or a progress report); any other `seq`, or `null`, answers at once.
   */
  async waitNow(deviceId: string, seq: number | null, waitMs: number, signal?: AbortSignal): Promise<NowPlaying | null> {
    const current = this.s.store.getNowPlaying(deviceId);
    if (seq === null || waitMs <= 0 || (current?.seq ?? 0) !== seq) return current;
    await this.nowWaiters.wait(deviceId, Math.min(waitMs, MAX_NOW_WAIT_MS), signal);
    return this.s.store.getNowPlaying(deviceId);
  }

  settings(device: Device): EffectiveSettings {
    const hints = this.s.catalog.current.manifest.defaults ?? {};
    const ui = device.uiLanguage ?? this.s.config.defaults.uiLanguage ?? hints.uiLanguage ?? "en";
    return {
      uiLanguage: ui === "tr" ? "tr" : "en",
      preferredAudioLanguage: device.preferredAudioLanguage ?? this.s.config.defaults.preferredAudioLanguage ?? hints.preferredAudioLanguage ?? null,
      subtitlesLanguage: device.subtitlesLanguage,
      autoplayOnStart: device.autoplayOnStart,
    };
  }

  private progressMap(deviceId: string, itemId: string): Map<string, Progress> {
    return new Map(this.s.store.listProgress(deviceId, this.s.catalog.catalogId, itemId).map((p) => [p.episodeId, p]));
  }

  /**
   * The episode OK would play for this item and where it would start. Null when nothing is playable. After the
   * item was watched to the end (a wrapped cursor), episodes the catalog gained since then come first.
   */
  continueFor(deviceId: string, item: CatalogItem) {
    const catalogId = this.s.catalog.catalogId;
    const progress = this.progressMap(deviceId, item.id);
    const cursor = this.s.store.getCursor(deviceId, catalogId, item.id);
    const appended = cursor?.wrapped ? new Set(this.s.store.episodesSeenAfter(catalogId, item.id, cursor.updatedAt)) : undefined;
    const index = cursorIndex(item, cursor, progress as ReadonlyMap<string, ProgressLike>, appended);
    if (index < 0) return null;
    const episode = item.episodes[index]!;
    const p = progress.get(episode.id);
    const status = !p ? "new" : p.status === "finished" ? "finished" : "watching";
    return {
      episodeId: episode.id,
      ...episodeSummary(episode),
      index,
      count: item.episodes.length,
      positionMs: status === "watching" ? p!.positionMs : 0,
      durationMs: p?.durationMs ?? episode.durationMs ?? null,
      status,
    };
  }

  /**
   * How many episodes of the item with playbackAllowed entered the catalog after both the device's last progress
   * report on the item and the moment the item went on its home list (`addedAt`). Episodes of the first load of
   * the catalog (the history's baseline) never count.
   */
  newEpisodesFor(deviceId: string, item: CatalogItem, addedAt: number | null): number {
    const catalogId = this.s.catalog.catalogId;
    const since = Math.max(this.s.store.lastProgressAt(deviceId, catalogId, item.id) ?? 0, addedAt ?? 0);
    const added = this.s.store.episodesSeenAfter(catalogId, item.id, since);
    if (added.length === 0) return 0;
    const allowed = new Set(item.episodes.filter((e) => e.playbackAllowed).map((e) => e.id));
    return added.filter((id) => allowed.has(id)).length;
  }

  state(device: Device) {
    const { manifest } = this.s.catalog.current;
    const home = [];
    for (const { itemId, addedAt } of this.s.store.getHomeEntries(device.id, manifest.catalogId)) {
      const item = this.s.catalog.item(itemId);
      if (!item) continue; // gone after a catalog reload; the admin API flags it
      const cont = this.continueFor(device.id, item);
      if (!cont) continue; // nothing playable
      home.push({ item: itemCard(this.s.catalog, item), continue: cont, newEpisodes: this.newEpisodesFor(device.id, item, addedAt) });
    }
    return {
      version: device.stateVersion,
      device: { id: device.id, name: device.name, ...this.settings(device) },
      catalog: { id: manifest.catalogId, buildId: manifest.buildId, name: manifest.name },
      home,
    };
  }

  item(device: Device, itemId: string) {
    const item = requireItem(this.s.catalog, itemId, 404, "unknown_item");
    const progress = this.progressMap(device.id, item.id);
    const cont = this.continueFor(device.id, item);
    return {
      item: itemDetails(this.s.catalog, item),
      cursorEpisodeId: cont?.episodeId ?? null,
      episodes: item.episodes.map((episode, index) => {
        const p = progress.get(episode.id);
        return {
          ...episodeDetails(episode, index),
          progress: p ? { positionMs: p.positionMs, durationMs: p.durationMs, status: p.status, updatedAt: iso(p.updatedAt) } : null,
          sources: episode.sources.map((s) => ({ id: s.id, label: s.label ?? null, languages: s.languages })),
        };
      }),
    };
  }

  async resolve(device: Device, input: ResolveInput, signal?: AbortSignal) {
    let r: ResolvedStream;
    try {
      r = await this.s.resolver.resolve(device.id, this.settings(device).preferredAudioLanguage, input, signal);
    } catch (err) {
      // "Can't play right now" on the TV: the owner learns which sources were tried and why each failed.
      if (err instanceof HttpError && err.code === "no_playable_source") {
        const tried = (err.extra.tried ?? []) as Tried[];
        this.s.problems.record(device.id, { kind: "resolve", code: "no_playable_source", episodeId: input.episodeId, detail: noPlayableDetail(tried, input.exclude) });
      }
      throw err;
    }
    // Sources the server fell back past. A missing adapter is a configuration warning on the catalog page instead.
    for (const t of r.failed) {
      if (t.code === "adapter_unavailable") continue;
      this.s.problems.record(device.id, { kind: "resolve", code: "source_failed", episodeId: r.ref.episode.id, sourceId: t.sourceId, detail: triedDetail(t) });
    }
    const { item, episode, index } = r.ref;
    const nextIndex = autoNextIndex(item, index);
    const next = nextIndex >= 0 ? item.episodes[nextIndex]! : null;
    const progress = this.s.store.getProgress(device.id, this.s.catalog.catalogId, episode.id);
    this.s.store.setNowPlaying(device.id, {
      catalogId: this.s.catalog.catalogId,
      itemId: item.id,
      episodeId: episode.id,
      sourceId: r.source.id,
      positionMs: progress?.status === "watching" ? progress.positionMs : 0,
      durationMs: progress?.durationMs ?? episode.durationMs ?? null,
      state: "starting",
      updatedAt: this.s.now(),
      playing: false,
      anchorAt: this.s.now(),
    });
    this.nowWaiters.wake(device.id);
    return {
      sessionId: r.session.id,
      sourceId: r.source.id,
      media: r.media,
      subtitleTracks: r.subtitleTracks.map((t) => ({ url: t.url, language: t.language, format: t.format, label: t.label ?? null })),
      languages: r.languages,
      alternatives: r.alternatives,
      next: next ? { episodeId: next.id, ...episodeSummary(next) } : null,
      item: itemCard(this.s.catalog, item),
      episode: { id: episode.id, index, count: item.episodes.length, ...episodeSummary(episode), durationMs: episode.durationMs ?? null },
      resume: progress?.status === "watching" ? { positionMs: progress.positionMs, durationMs: progress.durationMs } : null,
      expiresAt: r.expiresAt,
    };
  }

  /**
   * Heartbeat from the player. Saves the position, keeps the item's cursor on the episode being watched, and on
   * `finished` moves the cursor to the next allowed episode (wrapping to the first after the last). Only that wrap
   * stores a wrapped cursor; every other report makes it an ordinary one.
   */
  recordProgress(device: Device, input: ProgressInput): { version: number } {
    const { item, episode, index } = requireEpisode(this.s.catalog, input.episodeId, 404, "unknown_episode");
    const catalogId = this.s.catalog.catalogId;
    const session = input.sessionId ? this.s.resolver.session(input.sessionId) : undefined;
    const sourceId = session && session.deviceId === device.id && session.episodeId === episode.id ? session.sourceId : null;
    const t = this.s.now();
    const durationMs = input.durationMs ?? null;
    const playing = input.playing ?? input.status === "playing";
    const anchorAt = t - (input.ageMs ?? 0);
    const finished = input.status === "finished";

    const changed = this.s.store.transaction(() => {
      const cursor = cursorAfterReport(item, index, input.status, this.s.store.getCursor(device.id, catalogId, item.id));
      this.s.store.upsertProgress(device.id, {
        catalogId,
        itemId: item.id,
        episodeId: episode.id,
        positionMs: finished ? (durationMs ?? input.positionMs) : input.positionMs,
        durationMs,
        status: finished ? "finished" : "watching",
        updatedAt: t,
      });
      this.s.store.setCursor(device.id, { catalogId, itemId: item.id, episodeId: cursor.episodeId, updatedAt: t, wrapped: cursor.wrapped });
      this.s.store.setNowPlaying(device.id, {
        catalogId,
        itemId: item.id,
        episodeId: episode.id,
        sourceId,
        positionMs: input.positionMs,
        durationMs,
        state: input.status,
        updatedAt: t,
        playing,
        anchorAt,
      });
      return cursor.changed;
    });
    this.nowWaiters.wake(device.id);

    return { version: changed ? this.s.notifier.bump(device.id) : (this.s.store.getDevice(device.id)?.stateVersion ?? device.stateVersion) };
  }

  /**
   * Owner override "continue from episode X": moves the cursor (an ordinary one, so it wins over episodes added
   * after a wrap) and forgets X's saved position so it starts over.
   */
  setCursor(deviceId: string, itemId: string, episodeId: string): number {
    const item = requireItem(this.s.catalog, itemId, 404, "unknown_item");
    const episode = item.episodes.find((e) => e.id === episodeId);
    if (!episode) throw new HttpError(400, "unknown_episode", "the episode does not belong to this item");
    requirePlayable(episode, 400, "not_allowed");
    const catalogId = this.s.catalog.catalogId;
    this.s.store.transaction(() => {
      this.s.store.setCursor(deviceId, { catalogId, itemId, episodeId, updatedAt: this.s.now() });
      this.s.store.deleteProgress(deviceId, catalogId, episodeId);
    });
    return this.s.notifier.bump(deviceId);
  }

  /** Validates and stores a device's home list. */
  setHome(deviceId: string, itemIds: string[]): number {
    if (itemIds.length > HOME_MAX_ITEMS) {
      throw new HttpError(400, "too_many_items", `a home list holds at most ${HOME_MAX_ITEMS} items`, { max: HOME_MAX_ITEMS });
    }
    const seen = new Set<string>();
    for (const id of itemIds) {
      if (seen.has(id)) throw new HttpError(400, "duplicate_item", "an item appears twice", { itemId: id });
      seen.add(id);
      const item = this.s.catalog.item(id);
      if (!item) throw new HttpError(400, "unknown_item", "no such item in the catalog", { itemId: id });
      if (!isPlayable(item)) throw new HttpError(400, "not_playable", "the item has no episode with playback allowed", { itemId: id });
    }
    this.s.store.setHome(deviceId, this.s.catalog.catalogId, itemIds, this.s.now());
    return this.s.notifier.bump(deviceId);
  }
}
