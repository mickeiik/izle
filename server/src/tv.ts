import type { CatalogItem, Episode } from "@izle/contract";
import type { CatalogService } from "./catalog.ts";
import type { ServerConfig } from "./config.ts";
import { HttpError } from "./errors.ts";
import type { EventHub } from "./events.ts";
import type { Logger } from "./log.ts";
import { autoNextIndex, cursorAfterFinished, cursorIndex, isPlayable, type ProgressLike } from "./playback.ts";
import type { ResolveInput, ResolveService } from "./resolve.ts";
import type { Device, Progress, Store } from "./store.ts";

/** The server caps every device's home list (the TV shows a 4-column grid; ≤ 8 fits without scrolling). */
export const HOME_MAX_ITEMS = 12;

export type ProgressReportStatus = "playing" | "paused" | "stopped" | "finished";

export interface ProgressInput {
  sessionId?: string | null;
  episodeId: string;
  positionMs: number;
  durationMs: number | null;
  status: ProgressReportStatus;
}

export interface EffectiveSettings {
  uiLanguage: "tr" | "en";
  preferredAudioLanguage: string | null;
  subtitlesLanguage: string | null;
}

export interface Services {
  config: ServerConfig;
  store: Store;
  catalog: CatalogService;
  events: EventHub;
  resolver: ResolveService;
  log: Logger;
  now: () => number;
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

function episodeSummary(episode: Episode) {
  return { season: episode.season ?? null, number: episode.number ?? null, title: episode.title ?? null, label: episode.label ?? null };
}

/** What the TV sees: home state, item details, resolve and progress. Also used by the admin API. */
export class TvService {
  private readonly s: Services;

  constructor(services: Services) {
    this.s = services;
  }

  settings(device: Device): EffectiveSettings {
    const hints = this.s.catalog.current.manifest.defaults ?? {};
    const ui = device.uiLanguage ?? this.s.config.defaults.uiLanguage ?? hints.uiLanguage ?? "en";
    return {
      uiLanguage: ui === "tr" ? "tr" : "en",
      preferredAudioLanguage: device.preferredAudioLanguage ?? this.s.config.defaults.preferredAudioLanguage ?? hints.preferredAudioLanguage ?? null,
      subtitlesLanguage: device.subtitlesLanguage,
    };
  }

  /** Bumps the device's state version and tells its open SSE connections. */
  bump(deviceId: string): number {
    const version = this.s.store.bumpStateVersion(deviceId);
    this.notify(deviceId, version);
    return version;
  }

  notify(deviceId: string, version: number): void {
    this.s.events.publish(deviceId, { type: "state", data: { version } });
  }

  private progressMap(deviceId: string, itemId: string): Map<string, Progress> {
    return new Map(this.s.store.listProgress(deviceId, this.s.catalog.catalogId, itemId).map((p) => [p.episodeId, p]));
  }

  /** The episode OK would play for this item and where it would start. Null when nothing is playable. */
  continueFor(deviceId: string, item: CatalogItem) {
    const progress = this.progressMap(deviceId, item.id);
    const cursor = this.s.store.getCursor(deviceId, this.s.catalog.catalogId, item.id);
    const index = cursorIndex(item, cursor?.episodeId ?? null, progress as ReadonlyMap<string, ProgressLike>);
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

  itemCard(item: CatalogItem) {
    return { id: item.id, kind: item.kind, title: item.title, year: item.year ?? null, posterUrl: this.s.catalog.posterUrl(item) };
  }

  state(device: Device) {
    const { manifest } = this.s.catalog.current;
    const home = [];
    for (const itemId of this.s.store.getHome(device.id, manifest.catalogId)) {
      const item = this.s.catalog.item(itemId);
      if (!item) continue; // gone after a catalog reload; the admin API flags it
      const cont = this.continueFor(device.id, item);
      if (!cont) continue; // nothing playable
      home.push({ item: this.itemCard(item), continue: cont });
    }
    return {
      version: device.stateVersion,
      device: { id: device.id, name: device.name, ...this.settings(device) },
      catalog: { id: manifest.catalogId, buildId: manifest.buildId, name: manifest.name },
      home,
    };
  }

  item(device: Device, itemId: string) {
    const item = this.s.catalog.item(itemId);
    if (!item) throw new HttpError(404, "unknown_item");
    const progress = this.progressMap(device.id, item.id);
    const cont = this.continueFor(device.id, item);
    return {
      item: {
        ...this.itemCard(item),
        originalTitle: item.originalTitle ?? null,
        synopsis: item.synopsis ?? null,
        genres: item.genres ?? [],
      },
      cursorEpisodeId: cont?.episodeId ?? null,
      episodes: item.episodes.map((episode, index) => {
        const p = progress.get(episode.id);
        return {
          id: episode.id,
          index,
          ...episodeSummary(episode),
          durationMs: episode.durationMs ?? null,
          playbackAllowed: episode.playbackAllowed,
          progress: p ? { positionMs: p.positionMs, durationMs: p.durationMs, status: p.status, updatedAt: iso(p.updatedAt) } : null,
          sources: episode.sources.map((s) => ({ id: s.id, label: s.label ?? null, languages: s.languages })),
        };
      }),
    };
  }

  async resolve(device: Device, input: ResolveInput, signal?: AbortSignal) {
    const r = await this.s.resolver.resolve(device.id, this.settings(device).preferredAudioLanguage, input, signal);
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
    });
    return {
      sessionId: r.session.id,
      sourceId: r.source.id,
      media: r.media,
      subtitleTracks: r.subtitleTracks.map((t) => ({ url: t.url, language: t.language, format: t.format, label: t.label ?? null })),
      languages: r.languages,
      alternatives: r.alternatives,
      next: next ? { episodeId: next.id, ...episodeSummary(next) } : null,
      item: this.itemCard(item),
      episode: { id: episode.id, index, count: item.episodes.length, ...episodeSummary(episode), durationMs: episode.durationMs ?? null },
      resume: progress?.status === "watching" ? { positionMs: progress.positionMs, durationMs: progress.durationMs } : null,
      expiresAt: r.expiresAt,
    };
  }

  /**
   * Heartbeat from the player. Saves the position, keeps the item's cursor on the episode being watched, and on
   * `finished` moves the cursor to the next allowed episode (wrapping to the first after the last).
   */
  recordProgress(device: Device, input: ProgressInput): { version: number } {
    const ref = this.s.catalog.episode(input.episodeId);
    if (!ref) throw new HttpError(404, "unknown_episode");
    const { item, episode, index } = ref;
    const catalogId = this.s.catalog.catalogId;
    const session = input.sessionId ? this.s.resolver.session(input.sessionId) : undefined;
    const sourceId = session && session.deviceId === device.id && session.episodeId === episode.id ? session.sourceId : null;
    const t = this.s.now();
    const durationMs = input.durationMs ?? null;
    let changed = false;

    this.s.store.transaction(() => {
      const before = this.s.store.getCursor(device.id, catalogId, item.id);
      let cursorEpisode = episode;
      if (input.status === "finished") {
        this.s.store.upsertProgress(device.id, {
          catalogId,
          itemId: item.id,
          episodeId: episode.id,
          positionMs: durationMs ?? input.positionMs,
          durationMs,
          status: "finished",
          updatedAt: t,
        });
        cursorEpisode = item.episodes[cursorAfterFinished(item, index)] ?? episode;
        changed = true;
      } else {
        this.s.store.upsertProgress(device.id, {
          catalogId,
          itemId: item.id,
          episodeId: episode.id,
          positionMs: input.positionMs,
          durationMs,
          status: "watching",
          updatedAt: t,
        });
        if (input.status === "stopped") changed = true;
      }
      if (before?.episodeId !== cursorEpisode.id) changed = true;
      this.s.store.setCursor(device.id, { catalogId, itemId: item.id, episodeId: cursorEpisode.id, updatedAt: t });
      this.s.store.setNowPlaying(device.id, {
        catalogId,
        itemId: item.id,
        episodeId: episode.id,
        sourceId,
        positionMs: input.positionMs,
        durationMs,
        state: input.status,
        updatedAt: t,
      });
    });

    return { version: changed ? this.bump(device.id) : (this.s.store.getDevice(device.id)?.stateVersion ?? device.stateVersion) };
  }

  /** Owner override "continue from episode X": moves the cursor and forgets X's saved position so it starts over. */
  setCursor(deviceId: string, itemId: string, episodeId: string): number {
    const item = this.s.catalog.item(itemId);
    if (!item) throw new HttpError(404, "unknown_item");
    const episode = item.episodes.find((e) => e.id === episodeId);
    if (!episode) throw new HttpError(400, "unknown_episode", "the episode does not belong to this item");
    if (!episode.playbackAllowed) throw new HttpError(400, "not_allowed", "playback of this episode is not allowed");
    const catalogId = this.s.catalog.catalogId;
    this.s.store.transaction(() => {
      this.s.store.setCursor(deviceId, { catalogId, itemId, episodeId, updatedAt: this.s.now() });
      this.s.store.deleteProgress(deviceId, catalogId, episodeId);
    });
    return this.bump(deviceId);
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
    this.s.store.setHome(deviceId, this.s.catalog.catalogId, itemIds);
    return this.bump(deviceId);
  }
}
