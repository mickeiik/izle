// What each TV is playing: its now-playing row (what GET …/now, Listen along and the status list read), the running
// viewing of the history (one playback of one episode, or of one channel: its start, its heartbeats, its end and the
// lost sweep) and the long-poll on the row. A successful resolve starts or continues a playback; a progress report
// is applied to the row and the viewing at once. Whether it is an episode or a channel is decided here, once, from
// the ref: a channel has no position, so its row has none, its viewing has no ranges or seeks and is never seen.
// Every change appends its events in its own transaction; nothing here is logged beyond ids and small facts.

import { isLiveItem } from "@izle/contract";
import { SERVER, tvActor, type Actor } from "./actor.ts";
import { describePlayable, playingKey, samePlaying, type CatalogService, type EpisodeRef, type LiveRef, type PlayableRef } from "./catalog.ts";
import type { EventLog } from "./eventlog.ts";
import type { EventHub } from "./events.ts";
import type { Logger } from "./log.ts";
import type { LiveReportStatus, ProgressReportStatus } from "./playback.ts";
import { matchesSaid, type PartialPlayingKey, type PlaybackSessions, type ResolveInput } from "./resolve.ts";
import type { Device, NowPlaying, Store, Viewing, ViewingEndReason, ViewingTrigger } from "./store.ts";
import { Waiters } from "./waiters.ts";

/** Longest an admin "now" long-poll waits for the next playback report. */
export const MAX_NOW_WAIT_MS = 25_000;
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

interface ReportFields {
  sessionId?: string | null;
  /** Whether the player was actually advancing (false during a rebuffer stall); defaults to `status === "playing"`. */
  playing?: boolean;
  /** How long before sending the position was sampled, so a delayed report still anchors correctly. */
  ageMs?: number;
}

/** An episode's progress report: where the player is. */
export interface EpisodeProgressInput extends ReportFields {
  episodeId: string;
  itemId?: undefined;
  positionMs: number;
  durationMs?: number | null;
  status: ProgressReportStatus;
}

/** A channel's report: only that it plays (or stalls) or stopped; a channel has no position. */
export interface LiveReportInput extends ReportFields {
  itemId: string;
  episodeId?: undefined;
  status: LiveReportStatus;
}

/** `POST /tv/progress`: an episode's report or a channel's (validation.ts tells them apart). */
export type ProgressInput = EpisodeProgressInput | LiveReportInput;

/** Where an episode is and how long it is (as far as known); a channel has neither. */
export interface Position {
  positionMs: number;
  durationMs: number | null;
}

/** The row and, while the running viewing is the one the row reports on, its id (null once it ended). */
export type Current = NowPlaying & { viewingId: number | null };

interface PlayingDeps {
  store: Store;
  catalog: CatalogService;
  sessions: PlaybackSessions;
  eventLog: EventLog;
  events: EventHub;
  log: Logger;
  now: () => number;
}

/** A report as the row and the viewing hear it, the episode-or-channel decision already taken (`position`). */
interface Report {
  /**
   * What the report names, which its session and its viewing must play: an episode's report names the episode
   * alone (its item is the catalog's of today, maybe not the resolve's), a channel's names the item.
   */
  said: PartialPlayingKey;
  status: ProgressReportStatus;
  /** Where the player is; null for a channel. */
  position: Position | null;
  playing: boolean;
  /** When the position was sampled (the receipt time minus the report's age). */
  anchorAt: number;
}

type ViewingPatch = Partial<Omit<Viewing, "id" | "actor">>;

/** What a report does to the running viewing it names. */
interface Heard {
  patch: ViewingPatch;
  /** The events it appends, in order: the stall transitions, a seek, the pause transitions. */
  events: Array<{ type: string; data: Record<string, unknown> }>;
  /** What was played since the report before, when the player advanced there without a seek (an episode only). */
  range: { fromMs: number; toMs: number } | null;
  /** How the report ends the viewing and where (null for a channel); null while it goes on. */
  end: { reason: "stopped" | "finished"; positionMs: number | null } | null;
}

/** What the player was doing according to a report: `playing` with `playing: false` is a stall. */
type PlayerState = "starting" | "playing" | "paused" | "stalled";

function playerState(status: ProgressReportStatus | null, playing: boolean): PlayerState {
  if (status === null) return "starting";
  if (status === "paused") return "paused";
  return playing ? "playing" : "stalled";
}

/** Where a viewing was last (its last report, else where it started); null for a channel, which has no position. */
function lastPosition(v: Viewing): number | null {
  return v.episodeId === null ? null : (v.lastPositionMs ?? v.startPositionMs ?? 0);
}

/**
 * A report's effect on the running viewing `v`: the time since the report before counts as watched (capped at
 * MAX_REPORT_GAP_MS) while the player was advancing, the pause and stall transitions are events, and for an episode
 * a jump away from where playback should be is a seek, an advance within the tolerance a played range.
 */
function hear(v: Viewing, r: Report, t: number): Heard {
  const before = playerState(v.lastState, v.lastPlaying);
  // A final report (stopped, finished) is an end, not a transition.
  const after = r.status === "playing" || r.status === "paused" ? playerState(r.status, r.playing) : null;
  const advancing = before === "playing";
  const elapsed = Math.max(0, r.anchorAt - (v.lastAnchorAt ?? v.lastReportAt ?? t));
  const watchedMs = (v.watchedMs ?? 0) + (v.lastReportAt !== null && advancing ? Math.min(elapsed, MAX_REPORT_GAP_MS) : 0);
  const patch: ViewingPatch = { lastReportAt: t, lastPlaying: r.playing, lastAnchorAt: r.anchorAt, lastState: r.status, watchedMs };
  const at = r.position;
  const data = { viewingId: v.id, positionMs: at?.positionMs ?? null };
  const events: Heard["events"] = [];
  let range: Heard["range"] = null;
  if (after === "playing" && before === "stalled") events.push({ type: "playback.recovered", data });
  if (after === "stalled" && before !== "stalled") events.push({ type: "playback.stalled", data });
  if (at) {
    patch.lastPositionMs = at.positionMs;
    if (at.durationMs !== null) patch.durationMs = at.durationMs;
    if (v.lastReportAt === null) patch.startPositionMs = at.positionMs;
    if (v.lastPositionMs !== null) {
      // Where playback should be: the previous position, advanced by the time since its anchor while it was playing.
      const expected = v.lastPositionMs + (advancing ? elapsed : 0);
      if (Math.abs(at.positionMs - expected) > SEEK_TOLERANCE_MS) {
        events.push({ type: "playback.seeked", data: { viewingId: v.id, fromMs: expected, toMs: at.positionMs } });
      } else if (advancing && at.positionMs > v.lastPositionMs) {
        range = { fromMs: v.lastPositionMs, toMs: at.positionMs };
      }
    }
  }
  // A channel is never paused (its reports know only playing and stopped).
  if (after === "paused" && before !== "paused") events.push({ type: "playback.paused", data });
  if (after === "playing" && before === "paused") events.push({ type: "playback.resumed", data });
  let end: Heard["end"] = null;
  if (r.status === "stopped") end = { reason: "stopped", positionMs: at?.positionMs ?? null };
  if (r.status === "finished") end = { reason: "finished", positionMs: (patch.durationMs ?? v.durationMs) ?? at?.positionMs ?? null };
  return { patch, events, range, end };
}

/**
 * What each TV is playing: the now-playing row, the running viewing and the waiters on the row. A resolve and a
 * report change both in one transaction (the caller's, when it has one); the waiters wake once it committed.
 */
export class PlayingService {
  private readonly s: PlayingDeps;
  private readonly waiters = new Waiters<string>();
  /** When each TV went offline (its last stream's grace period ended); a TV absent here has been offline since the start. */
  private readonly offlineAt = new Map<string, number>();
  private readonly startedAt: number;

  constructor(deps: PlayingDeps) {
    this.s = deps;
    this.startedAt = deps.now();
  }

  /** What the device plays (null: it never played). One read for the device page, Listen along and the status list. */
  current(deviceId: string): Current | null {
    const n = this.s.store.getNowPlaying(deviceId);
    if (!n) return null;
    const v = this.s.store.runningViewing(deviceId);
    return { ...n, viewingId: v && samePlaying(v, n) ? v.id : null };
  }

  /**
   * `current`, long-polled: with `seq` equal to the row's current sequence number, waits up to `waitMs` (at most
   * MAX_NOW_WAIT_MS) for the next write (a resolve or a progress report); any other `seq`, or `null`, answers at once.
   */
  async waitCurrent(deviceId: string, seq: number | null, waitMs: number, signal?: AbortSignal): Promise<Current | null> {
    const current = this.current(deviceId);
    if (seq === null || waitMs <= 0 || (current?.seq ?? 0) !== seq) return current;
    await this.waiters.wait(deviceId, Math.min(waitMs, MAX_NOW_WAIT_MS), signal);
    return this.current(deviceId);
  }

  /** The device's running viewing, or null. */
  running(deviceId: string): Viewing | null {
    return this.s.store.runningViewing(deviceId);
  }

  /**
   * A successful TV resolve: the row goes to `starting`; the running viewing of the same episode or channel goes on
   * (the source may change; no event), any other is ended as `replaced` and a new one started. `start` is where an
   * episode starts (the resume position offered, else 0) and its duration as last known; without one it starts at 0
   * with the catalog's duration. A channel plays at its live edge: `start` is ignored.
   */
  started(device: Device, played: { ref: PlayableRef; sourceId: string }, start: Position | null, input: Pick<ResolveInput, "trigger" | "commandId">): void {
    const { ref, sourceId } = played;
    const t = this.s.now();
    const position = ref.kind === "live" ? null : (start ?? { positionMs: 0, durationMs: ref.episode.durationMs ?? null });
    this.s.store.transaction(() => {
      this.write(device.id, ref, sourceId, { state: "starting", position, playing: false, anchorAt: t }, t);
      this.startViewing(device, ref, sourceId, position, input, t);
      this.s.store.afterCommit(() => this.waiters.wake(device.id));
    });
  }

  /**
   * A progress report, an episode's on its episode or a channel's on its channel: the row becomes the report's
   * projection, and the running viewing of what the report names hears it (`hear`), ended on `stopped` or
   * `finished`. The session the report names gives the row its source.
   */
  reported(device: Device, ref: EpisodeRef, input: EpisodeProgressInput): void;
  reported(device: Device, ref: LiveRef, input: LiveReportInput): void;
  reported(device: Device, ref: PlayableRef, input: ProgressInput): void {
    const t = this.s.now();
    let said: PartialPlayingKey;
    let position: Position | null = null;
    if (ref.kind === "episode") {
      // The overloads pair an episode's ref with an episode's report.
      const { positionMs, durationMs = null } = input as EpisodeProgressInput;
      said = { episodeId: ref.episode.id };
      position = { positionMs, durationMs };
    } else {
      said = playingKey(ref);
    }
    const r: Report = { said, status: input.status, position, playing: input.playing ?? input.status === "playing", anchorAt: t - (input.ageMs ?? 0) };
    const sourceId = this.s.sessions.owned(input.sessionId, device.id, said)?.sourceId ?? null;
    this.s.store.transaction(() => {
      this.write(device.id, ref, sourceId, { state: r.status, position, playing: r.playing, anchorAt: r.anchorAt }, t);
      this.hearViewing(device, r, t);
      this.s.store.afterCommit(() => this.waiters.wake(device.id));
    });
  }

  /** Writes the row: what plays, from which source, where (null for a channel) and in which state since when. */
  private write(
    deviceId: string,
    ref: PlayableRef,
    sourceId: string | null,
    w: { state: NowPlaying["state"]; position: Position | null; playing: boolean; anchorAt: number },
    t: number,
  ): void {
    const { position, ...rest } = w;
    this.s.store.setNowPlaying(deviceId, {
      catalogId: this.s.catalog.catalogId, ...playingKey(ref), sourceId, positionMs: position?.positionMs ?? null, durationMs: position?.durationMs ?? null,
      ...rest, updatedAt: t,
    });
  }

  private startViewing(device: Device, ref: PlayableRef, sourceId: string, position: Position | null, input: Pick<ResolveInput, "trigger" | "commandId">, t: number): void {
    const { store, eventLog } = this.s;
    const running = store.runningViewing(device.id);
    const playing = playingKey(ref);
    if (running && samePlaying(running, playing)) {
      if (running.sourceId !== sourceId) store.updateViewing(running.id, { sourceId });
      return;
    }
    const { trigger, actor, commandId } = this.origin(device.id, input);
    if (running) this.end(running, "replaced", t, lastPosition(running), actor);
    // The ref's own titles: the catalog may have been reloaded while the adapter was awaited.
    const { itemKind, itemTitle, episodeTitle, season, number } = describePlayable(ref);
    const positionMs = position?.positionMs ?? null;
    const v = store.insertViewing({
      deviceId: device.id, deviceName: device.name, catalogId: this.s.catalog.catalogId, ...playing, itemKind, itemTitle, episodeTitle, season, number, sourceId,
      startedAt: t, endedAt: null, startPositionMs: positionMs, endPositionMs: null, durationMs: position?.durationMs ?? null, watchedMs: 0, endReason: null,
      seen: false, trigger, actor, commandId, imported: false, lastReportAt: null, lastPositionMs: null, lastPlaying: false, lastAnchorAt: null, lastState: null,
    });
    const viewingId = v.id;
    const { itemId, episodeId } = playing;
    eventLog.append("playback.started", device.id, actor, {
      viewingId, itemId, itemKind, itemTitle, episodeId, episodeTitle, season, number, sourceId, positionMs, trigger,
    });
    this.s.log.debug("viewing started", { deviceId: device.id, viewingId, itemId, episodeId, trigger });
  }

  /** The trigger, actor and command behind a resolve: a command's actor when the TV names one of its play/next/previous commands. */
  private origin(deviceId: string, input: Pick<ResolveInput, "trigger" | "commandId">): { trigger: ViewingTrigger; actor: Actor; commandId: number | null } {
    const tv = tvActor(deviceId);
    if (input.trigger === undefined) return { trigger: "unknown", actor: tv, commandId: null };
    if (input.trigger !== "command") return { trigger: input.trigger, actor: tv, commandId: null };
    const cmd = input.commandId === undefined ? null : this.s.store.viewingCommand(deviceId, input.commandId);
    return { trigger: "command", actor: cmd?.actor ?? tv, commandId: cmd?.id ?? null };
  }

  /** Applies a report to the TV's running viewing when it plays what the report names (ignored otherwise). */
  private hearViewing(device: Device, r: Report, t: number): void {
    const { store, eventLog } = this.s;
    const v = store.runningViewing(device.id);
    if (!v || !matchesSaid(r.said, v)) return;
    const actor = tvActor(device.id);
    const { patch, events, range, end } = hear(v, r, t);
    for (const e of events) eventLog.append(e.type, device.id, actor, e.data);
    if (range) store.addViewingRange(v.id, range.fromMs, range.toMs);
    store.updateViewing(v.id, patch);
    if (end) this.end({ ...v, ...patch }, end.reason, t, end.positionMs, actor);
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

  /** Hears the online rule's changes (from the event hub), so the lost sweep knows how long a TV has been offline. */
  onOnline(deviceId: string, online: boolean): void {
    if (online) this.offlineAt.delete(deviceId);
    else this.offlineAt.set(deviceId, this.s.now());
  }
}
