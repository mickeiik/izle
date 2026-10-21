// The viewing history's writing side: a viewing (one playback of one episode, or of one channel, on one TV) starts
// with a successful resolve, follows the TV's reports (watched time; for an episode also played ranges, pauses and
// seeks; stalls), and ends with a stopped or finished report, with the TV resolving something else, or with silence
// (the lost sweep). A channel's viewing has no positions and is never seen. Also the owner's marks and deletions.
// Every change appends its events in its own transaction; nothing here is logged beyond ids and small facts.

import { isLiveItem } from "@izle/contract";
import { SERVER, tvActor, type Actor } from "./actor.ts";
import { playingKey, samePlaying, type CatalogService, type PlayableRef } from "./catalog.ts";
import type { EventLog } from "./eventlog.ts";
import type { EventHub } from "./events.ts";
import { HttpError } from "./errors.ts";
import type { Logger } from "./log.ts";
import type { LiveReportStatus, ProgressReportStatus } from "./playback.ts";
import type { ResolveInput } from "./resolve.ts";
import type { Device, Store, Viewing, ViewingEndReason, ViewingTrigger } from "./store.ts";

/** What a TV may say started a playback (`POST /tv/resolve`); without it the viewing's trigger is `unknown`. */
export const VIEWING_TRIGGERS = ["viewer", "autoplay", "next", "command"] as const;
export type ResolveTrigger = (typeof VIEWING_TRIGGERS)[number];

/** How often the lost sweep runs. */
export const VIEWING_SWEEP_MS = 30_000;
/** Silence (while playing, or before the first report) or an offline TV for this long ends the viewing as lost. */
const LOST_AFTER_MS = 2 * 60_000;
/** The most watched time two consecutive reports can account for (the TV reports every 15 s while playing). */
const MAX_REPORT_GAP_MS = 60_000;
/** A report further than this from where playback should be is a seek. */
const SEEK_TOLERANCE_MS = 10_000;
/** A viewing that ends not seen with less watched time than this was a mis-press: it is dropped. */
const DROP_UNDER_MS = 10_000;
/** A viewing that ends at this share of the duration or later is seen, whatever the report said. */
const SEEN_FRACTION = 0.9;

interface ViewingDeps {
  store: Store;
  catalog: CatalogService;
  eventLog: EventLog;
  events: EventHub;
  log: Logger;
  now: () => number;
}

/** A progress report as the history sees it: the status, whether the player advanced, and where it was sampled. */
export interface ViewingReport {
  episodeId: string;
  positionMs: number;
  durationMs: number | null;
  status: ProgressReportStatus;
  playing: boolean;
  anchorAt: number;
}

/** A channel's report as the history sees it: no position, only whether the player advanced and when it said so. */
export interface LiveViewingReport {
  itemId: string;
  status: LiveReportStatus;
  playing: boolean;
  anchorAt: number;
}

/** Where a viewing was last (its last report, else where it started); null for a channel, which has no position. */
function lastPosition(v: Viewing): number | null {
  return v.episodeId === null ? null : (v.lastPositionMs ?? v.startPositionMs ?? 0);
}

/** What the player was doing according to a report: `playing` with `playing: false` is a stall. */
type PlayerState = "starting" | "playing" | "paused" | "stalled";

function playerState(status: ProgressReportStatus | null, playing: boolean): PlayerState {
  if (status === null) return "starting";
  if (status === "paused") return "paused";
  return playing ? "playing" : "stalled";
}

export class ViewingService {
  private readonly s: ViewingDeps;
  /** When each TV went offline (its last stream's grace period ended); a TV absent here has been offline since the start. */
  private readonly offlineAt = new Map<string, number>();
  private readonly startedAt: number;

  constructor(deps: ViewingDeps) {
    this.s = deps;
    this.startedAt = deps.now();
  }

  /** The device's running viewing, or null. */
  running(deviceId: string): Viewing | null {
    return this.s.store.runningViewing(deviceId);
  }

  /** Hears the online rule's changes (from the event hub), so the lost sweep knows how long a TV has been offline. */
  onOnline(deviceId: string, online: boolean): void {
    if (online) this.offlineAt.delete(deviceId);
    else this.offlineAt.set(deviceId, this.s.now());
  }

  /**
   * A successful TV resolve, inside its transaction: continues the running viewing of the same episode or channel
   * (the source may change; no event), or ends the running one as `replaced` and starts a new one. `positionMs` is
   * where playback will start (the resume position offered), `durationMs` the catalog's; both null for a channel,
   * which plays at its live edge.
   */
  onResolve(device: Device, ref: PlayableRef, sourceId: string, positionMs: number | null, durationMs: number | null, input: ResolveInput): void {
    const { store, eventLog } = this.s;
    const running = store.runningViewing(device.id);
    const t = this.s.now();
    const playing = playingKey(ref);
    if (running && samePlaying(running, playing)) {
      if (running.sourceId !== sourceId) store.updateViewing(running.id, { sourceId });
      return;
    }
    const { trigger, actor, commandId } = this.origin(device.id, input);
    if (running) this.end(running, "replaced", t, lastPosition(running), actor);
    const { itemKind, itemTitle, episodeTitle, season, number } = this.s.catalog.describe(playing);
    const v = store.insertViewing({
      deviceId: device.id, deviceName: device.name, catalogId: this.s.catalog.catalogId, ...playing, itemKind, itemTitle, episodeTitle, season, number, sourceId,
      startedAt: t, endedAt: null, startPositionMs: positionMs, endPositionMs: null, durationMs, watchedMs: 0, endReason: null, seen: false,
      trigger, actor, commandId, imported: false, lastReportAt: null, lastPositionMs: null, lastPlaying: false, lastAnchorAt: null, lastState: null,
    });
    const viewingId = v.id;
    const { itemId, episodeId } = playing;
    eventLog.append("playback.started", device.id, actor, {
      viewingId, itemId, itemKind, itemTitle, episodeId, episodeTitle, season, number, sourceId, positionMs, trigger,
    });
    this.s.log.debug("viewing started", { deviceId: device.id, viewingId, itemId, episodeId, trigger });
  }

  /** The trigger, actor and command behind a resolve: a command's actor when the TV names one of its play/next/previous commands. */
  private origin(deviceId: string, input: ResolveInput): { trigger: ViewingTrigger; actor: Actor; commandId: number | null } {
    const tv = tvActor(deviceId);
    if (input.trigger === undefined) return { trigger: "unknown", actor: tv, commandId: null };
    if (input.trigger !== "command") return { trigger: input.trigger, actor: tv, commandId: null };
    const cmd = input.commandId === undefined ? null : this.s.store.viewingCommand(deviceId, input.commandId);
    return { trigger: "command", actor: cmd?.actor ?? tv, commandId: cmd?.id ?? null };
  }

  /**
   * A progress report, inside its transaction. Applied only to the TV's running viewing of the reported episode:
   * watched time and played ranges between consecutive reports while the player advanced, seeks, the pause and
   * stall transitions, and the end on `stopped` or `finished`.
   */
  onReport(device: Device, r: ViewingReport): void {
    const { store, eventLog } = this.s;
    const v = store.runningViewing(device.id);
    if (!v || v.episodeId === null || v.episodeId !== r.episodeId) return;
    const t = this.s.now();
    const actor = tvActor(device.id);
    const patch: Partial<Omit<Viewing, "id" | "actor">> = {
      lastReportAt: t, lastPositionMs: r.positionMs, lastPlaying: r.playing, lastAnchorAt: r.anchorAt, lastState: r.status, watchedMs: v.watchedMs ?? 0,
    };
    if (r.durationMs !== null) patch.durationMs = r.durationMs;
    if (v.lastReportAt === null) patch.startPositionMs = r.positionMs;
    // A final report (stopped, finished) is an end, not a transition.
    const after = r.status === "playing" || r.status === "paused" ? playerState(r.status, r.playing) : null;
    const data = { viewingId: v.id, positionMs: r.positionMs };
    const { before, elapsed, advancing } = this.heartbeat(v, r, after, patch, data, actor, t);
    if (v.lastPositionMs !== null) {
      // Where playback should be: the previous position, advanced by the time since its anchor while it was playing.
      const expected = v.lastPositionMs + (advancing ? elapsed : 0);
      if (Math.abs(r.positionMs - expected) > SEEK_TOLERANCE_MS) {
        eventLog.append("playback.seeked", device.id, actor, { viewingId: v.id, fromMs: expected, toMs: r.positionMs });
      } else if (advancing && r.positionMs > v.lastPositionMs) {
        store.addViewingRange(v.id, v.lastPositionMs, r.positionMs);
      }
    }
    // The pause transitions (the stall ones are every report's, in heartbeat).
    if (after === "paused" && before !== "paused") eventLog.append("playback.paused", device.id, actor, data);
    if (after === "playing" && before === "paused") eventLog.append("playback.resumed", device.id, actor, data);
    store.updateViewing(v.id, patch);
    const updated = { ...v, ...patch };
    if (r.status === "stopped") this.end(updated, "stopped", t, r.positionMs, actor);
    if (r.status === "finished") this.end(updated, "finished", t, updated.durationMs ?? r.positionMs, actor);
  }

  /**
   * A channel's report, inside its transaction. Applied only to the TV's running viewing of that channel: watched
   * time between consecutive reports while the player advanced (there is no position, so no ranges or seeks), the
   * stall transitions, and the end on `stopped`.
   */
  onLiveReport(device: Device, r: LiveViewingReport): void {
    const { store } = this.s;
    const v = store.runningViewing(device.id);
    if (!v || !samePlaying(v, { itemId: r.itemId, episodeId: null })) return;
    const t = this.s.now();
    const actor = tvActor(device.id);
    const patch: Partial<Omit<Viewing, "id" | "actor">> = { lastReportAt: t, lastPlaying: r.playing, lastAnchorAt: r.anchorAt, lastState: r.status, watchedMs: v.watchedMs ?? 0 };
    const after = r.status === "playing" ? playerState(r.status, r.playing) : null;
    this.heartbeat(v, r, after, patch, { viewingId: v.id, positionMs: null }, actor, t);
    store.updateViewing(v.id, patch);
    if (r.status === "stopped") this.end({ ...v, ...patch }, "stopped", t, null, actor);
  }

  /**
   * What every report (an episode's or a channel's) does to the running viewing `v`: the time since the report before,
   * counted as watched (capped at MAX_REPORT_GAP_MS) while the player was advancing, and the stall transitions
   * (`after`: the player's state the report says, null for a final one). Returns the state before, the time since the
   * last anchor and whether the player was advancing, for the position-dependent parts an episode's report adds.
   */
  private heartbeat(
    v: Viewing,
    r: { anchorAt: number },
    after: PlayerState | null,
    patch: Partial<Pick<Viewing, "watchedMs">>,
    data: { viewingId: number; positionMs: number | null },
    actor: Actor,
    t: number,
  ): { before: PlayerState; elapsed: number; advancing: boolean } {
    const { eventLog } = this.s;
    const before = playerState(v.lastState, v.lastPlaying);
    const elapsed = Math.max(0, r.anchorAt - (v.lastAnchorAt ?? v.lastReportAt ?? t));
    const advancing = before === "playing";
    if (v.lastReportAt !== null && advancing) patch.watchedMs = (patch.watchedMs ?? 0) + Math.min(elapsed, MAX_REPORT_GAP_MS);
    if (after === "playing" && before === "stalled") eventLog.append("playback.recovered", v.deviceId, actor, data);
    if (after === "stalled" && before !== "stalled") eventLog.append("playback.stalled", v.deviceId, actor, data);
    return { before, elapsed, advancing };
  }

  /**
   * Ends `v` (already updated with its last report), or drops it when it was too short to keep; the events follow.
   * `positionMs` is where it ended (null for a channel, which is never seen).
   */
  private end(v: Viewing, reason: ViewingEndReason, at: number, positionMs: number | null, actor: Actor): void {
    const { store, eventLog } = this.s;
    const watchedMs = v.watchedMs ?? 0;
    const seen = reason === "finished" || (positionMs !== null && v.durationMs !== null && v.durationMs > 0 && positionMs >= SEEN_FRACTION * v.durationMs);
    const dropped = !seen && watchedMs < DROP_UNDER_MS;
    if (dropped) store.deleteViewing(v.id);
    else store.updateViewing(v.id, { endedAt: at, endReason: reason, endPositionMs: positionMs, seen, watchedMs });
    eventLog.append("playback.ended", v.deviceId, actor, { viewingId: v.id, endReason: reason, seen, positionMs, watchedMs, dropped });
    if (seen) this.seenEvent(v, actor);
    this.s.log.debug("viewing ended", { deviceId: v.deviceId, viewingId: v.id, endReason: reason, seen, watchedMs, dropped });
  }

  /** `episode.seen`: whether this is the episode's first time, and whether the item is now finished. */
  private seenEvent(v: Viewing, actor: Actor): void {
    const { store, catalog } = this.s;
    if (v.episodeId === null) return; // a channel is never seen
    const catalogId = catalog.catalogId;
    const mark = store.getMark(catalogId, v.episodeId);
    const firstTime = !(mark ? mark.seen : store.episodeSeenByOther(catalogId, v.episodeId, v.id));
    const item = catalog.item(v.itemId);
    let itemFinished = false;
    if (item && !isLiveItem(item)) {
      const marks = store.listMarks(catalogId, item.id);
      const seenByViewing = new Set(store.episodeSeenAt(catalogId, item.id).map((e) => e.episodeId));
      const playable = item.episodes.filter((e) => e.playbackAllowed);
      itemFinished = playable.length > 0 && playable.every((e) => marks.get(e.id)?.seen ?? seenByViewing.has(e.id));
    }
    this.s.eventLog.append("episode.seen", v.deviceId, actor, { viewingId: v.id, itemId: v.itemId, episodeId: v.episodeId, firstTime, itemFinished });
  }

  /**
   * The lost sweep: ends, at its last report (or its resolve), every running viewing whose TV has been silent for
   * 2 minutes while playing (or before any report came), or offline for 2 minutes whatever it last said. A paused
   * TV that stays online keeps its viewing.
   */
  sweep(): void {
    const t = this.s.now();
    for (const v of this.s.store.listRunningViewings()) {
      const lastAt = v.lastReportAt ?? v.startedAt;
      const silent = (v.lastState === null || v.lastState === "playing") && t - lastAt >= LOST_AFTER_MS;
      const offlineSince = this.s.events.isOnline(v.deviceId) ? null : (this.offlineAt.get(v.deviceId) ?? this.startedAt);
      const offline = offlineSince !== null && t - offlineSince >= LOST_AFTER_MS;
      if (!silent && !offline) continue;
      this.s.store.transaction(() => this.end(v, "lost", lastAt, lastPosition(v), SERVER));
    }
  }

  /**
   * The owner's word on episodes (`seen: null` removes it); each must be in the catalog or the history. Returns how
   * many. A channel's item id is no episode id: channels are never marked.
   */
  setMarks(episodeIds: readonly string[], seen: boolean | null, actor: Actor): number {
    const { store, catalog } = this.s;
    const catalogId = catalog.catalogId;
    const entries = new Map<string, { episodeId: string; itemId: string }>();
    for (const episodeId of episodeIds) {
      const itemId = catalog.episode(episodeId)?.item.id ?? store.historyEpisodeItem(catalogId, episodeId) ?? store.getMark(catalogId, episodeId)?.itemId;
      if (itemId === undefined || itemId === null) throw new HttpError(400, "unknown_episode", "the episode is neither in the catalog nor in the history", { episodeId });
      entries.set(episodeId, { episodeId, itemId });
    }
    store.transaction(() => {
      store.setMarks(catalogId, [...entries.values()], seen, this.s.now());
      this.s.eventLog.append("history.changed", null, actor, { episodeIds: [...entries.keys()], seen });
    });
    return entries.size;
  }

  /** Deletes the viewings of a TV (when given) started before `olderThan` (when given), running ones too. */
  deleteViewings(deviceId: string | null, olderThan: number | null, actor: Actor): number {
    return this.s.store.transaction(() => {
      const deleted = this.s.store.deleteViewings(this.s.catalog.catalogId, deviceId, olderThan);
      this.s.eventLog.append("history.changed", deviceId, actor, { deleted });
      return deleted;
    });
  }

  /** Deletes one viewing; false when there is none with this id. */
  deleteViewing(id: number, actor: Actor): boolean {
    return this.s.store.transaction(() => {
      const v = this.s.store.getViewing(id);
      if (!v) return false;
      this.s.store.deleteViewing(id);
      this.s.eventLog.append("history.changed", v.deviceId, actor, { deleted: 1 });
      return true;
    });
  }
}
