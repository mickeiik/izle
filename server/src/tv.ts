import { isLiveItem } from "@izle/contract";
import { playingKey, type CatalogService } from "./catalog.ts";
import type { ServerConfig } from "./config.ts";
import { effectiveSettings } from "./devices.ts";
import { HttpError } from "./errors.ts";
import type { Notifier } from "./events.ts";
import type { HomeService } from "./home.ts";
import { requireEpisode, requireItem, requirePlayableRef } from "./lookup.ts";
import { autoNextIndex, cursorAfterReport } from "./playback.ts";
import type { EpisodeProgressInput, LiveReportInput, PlayingService, ProgressInput } from "./playing.ts";
import { episodeDetails, episodeSummary, iso, itemCard, itemDetails, tvSource } from "./presenters.ts";
import { noPlayableDetail, triedDetail, type ProblemService } from "./problems.ts";
import type { ResolvedStream, ResolveInput, ResolveService, Tried } from "./resolve.ts";
import type { Device, Store } from "./store.ts";

interface TvDeps {
  config: ServerConfig;
  store: Store;
  catalog: CatalogService;
  notifier: Notifier;
  resolver: ResolveService;
  problems: ProblemService;
  /** The home list the state shows, and what OK plays on each item. */
  home: HomeService;
  /** What each TV is playing: a resolve starts a playback, a report goes on to it. */
  playing: PlayingService;
  now: () => number;
}

/**
 * What the TV sees and reports: home state, item details, resolve and progress. The home list and the owner's
 * operations on it are home.ts's; what a TV is playing is playing.ts's.
 */
export class TvService {
  private readonly s: TvDeps;

  constructor(deps: TvDeps) {
    this.s = deps;
  }

  private settings(device: Device) {
    return effectiveSettings(device, this.s.config, this.s.catalog);
  }

  /** The TV's Home: the entries it can play (items gone after a catalog reload, or not playable, are left out). */
  state(device: Device) {
    const { catalog } = this.s;
    const { manifest } = catalog.current;
    const home = this.s.home.list(device.id).flatMap(({ item, playable, continue: cont, newEpisodes }) =>
      item && playable ? [{ item: itemCard(catalog, item), continue: cont, newEpisodes }] : [],
    );
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
    const { progress, continue: cont } = this.s.home.itemProgress(device.id, item);
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
    if (ref.kind === "live") {
      this.s.playing.started(device, { ref, sourceId: r.source.id }, null, input);
      return { ...answer, next: null, episode: null, resume: null };
    }
    const { item, episode, index } = ref;
    const nextIndex = autoNextIndex(item, index);
    const next = nextIndex >= 0 ? item.episodes[nextIndex]! : null;
    const progress = this.s.store.getProgress(device.id, this.s.catalog.catalogId, episode.id);
    const resume = progress?.status === "watching" ? { positionMs: progress.positionMs, durationMs: progress.durationMs } : null;
    // Playback starts where the resume offered says, with the duration the TV last reported, else the catalog's.
    this.s.playing.started(device, { ref, sourceId: r.source.id }, { positionMs: resume?.positionMs ?? 0, durationMs: progress?.durationMs ?? episode.durationMs ?? null }, input);
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
}
