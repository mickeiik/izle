// Remote control from the admin page: a command is stored, published to the TV's open event streams, and replayed
// when the TV (re)connects until the TV acknowledges it or it is too old to act on.

import { isLiveItem } from "@izle/contract";
import { tvActor, type Actor } from "./actor.ts";
import type { AppUpdateService } from "./app-updates.ts";
import type { CatalogService } from "./catalog.ts";
import { HttpError } from "./errors.ts";
import type { EventLog } from "./eventlog.ts";
import type { EventHub, Notifier } from "./events.ts";
import type { HomeService } from "./home.ts";
import type { Logger } from "./log.ts";
import { requireEpisode, requireItem, requirePlayable } from "./lookup.ts";
import type { Command, Store } from "./store.ts";

/** Commands that carry no payload (the SSE payload is `{}`). */
export const PLAIN_COMMANDS = ["stop", "pause", "resume", "next", "previous"] as const;
export const MAX_SEEK_DELTA_MS = 3_600_000;
export const MESSAGE_MAX_CHARS = 200;
export const MESSAGE_DURATION_SEC = { min: 3, max: 120, default: 15 };

export type CommandType = "play" | "seek" | "message" | "update" | (typeof PLAIN_COMMANDS)[number];

export const COMMAND_RESULTS = ["done", "ignored", "failed"] as const;
export type CommandResult = (typeof COMMAND_RESULTS)[number];

/** A command as the admin API takes it (validated in validation.ts). */
export type CommandBody =
  | { type: "play"; itemId?: string; episodeId?: string; positionMs?: number }
  | { type: (typeof PLAIN_COMMANDS)[number] }
  | { type: "seek"; deltaMs: number; positionMs?: undefined }
  | { type: "seek"; positionMs: number; deltaMs?: undefined }
  | { type: "message"; text: string; durationSec?: number }
  | { type: "update" };

/** Unacknowledged commands younger than this are replayed when a TV (re)connects to the event stream. */
const COMMAND_REPLAY_MS = 2 * 60_000;
/** Commands older than this are deleted by the housekeeping timer, acknowledged or not. */
const COMMAND_RETENTION_MS = 7 * 24 * 60 * 60_000;

interface CommandDeps {
  store: Store;
  catalog: CatalogService;
  events: EventHub;
  notifier: Notifier;
  eventLog: EventLog;
  appUpdates: AppUpdateService;
  home: HomeService;
  log: Logger;
  now: () => number;
}

export class CommandService {
  private readonly s: CommandDeps;

  constructor(deps: CommandDeps) {
    this.s = deps;
  }

  /**
   * The episode a `play` names: the one given, or what OK would play for the item on this TV right now (the TV gets
   * ids only, so it plays what the owner saw when sending); a channel plays at its live edge, with no position.
   */
  private playPayload(deviceId: string, body: Extract<CommandBody, { type: "play" }>): Record<string, unknown> {
    const item = body.itemId === undefined ? null : requireItem(this.s.catalog, body.itemId, 404, "unknown_item");
    const position = body.positionMs === undefined ? {} : { positionMs: body.positionMs };
    if (body.episodeId !== undefined) {
      const ref = requireEpisode(this.s.catalog, body.episodeId, 400, "unknown_episode");
      if (item && ref.item.id !== item.id) throw new HttpError(400, "unknown_episode", "the episode does not belong to this item");
      requirePlayable(ref.episode, 400, "not_allowed");
      return { itemId: ref.item.id, episodeId: ref.episode.id, ...position };
    }
    // Without an episode the body names an item (validation.ts).
    const target = item!;
    if (isLiveItem(target)) {
      // A channel has no position: one sent with it is left out, not refused.
      if (!target.playbackAllowed) throw new HttpError(400, "not_playable", "playback of this channel is not allowed", { itemId: target.id });
      return { itemId: target.id, episodeId: null };
    }
    const cont = this.s.home.continueFor(deviceId, target);
    if (!cont) throw new HttpError(400, "not_playable", "the item has no episode with playback allowed", { itemId: target.id });
    return { itemId: target.id, episodeId: cont.episodeId, ...position };
  }

  /** What the TV gets with a command (the SSE `payload`). */
  private payload(deviceId: string, body: CommandBody): Record<string, unknown> {
    switch (body.type) {
      case "play":
        return this.playPayload(deviceId, body);
      case "seek":
        return body.deltaMs !== undefined ? { deltaMs: body.deltaMs } : { positionMs: body.positionMs };
      case "message":
        return { text: body.text.trim(), durationSec: body.durationSec ?? MESSAGE_DURATION_SEC.default };
      case "update": {
        // The TV fetches /tv/app before installing.
        const apk = this.s.appUpdates.current();
        if (!apk) throw new HttpError(409, "no_apk", "no TV app APK is stored");
        return { versionCode: apk.versionCode };
      }
      default:
        return {}; // stop, pause, resume, next, previous
    }
  }

  send(deviceId: string, body: CommandBody, actor: Actor): { command: Command; online: boolean } {
    const payload = this.payload(deviceId, body);
    const online = this.s.events.isOnline(deviceId);
    const cmd = this.s.store.transaction(() => {
      const c = this.s.store.insertCommand(deviceId, body.type, payload, actor, this.s.now());
      this.s.eventLog.append("command.sent", deviceId, actor, { commandId: c.id, type: c.type, online });
      return c;
    });
    this.s.notifier.command(cmd);
    // Type and ids only: never a message's text.
    this.s.log.info("command queued", { deviceId, type: cmd.type, commandId: cmd.id });
    return { command: cmd, online };
  }

  /** The commands a (re)connecting TV gets again, oldest first. */
  replayable(deviceId: string): Command[] {
    return this.s.store.pendingCommands(deviceId, this.s.now() - COMMAND_REPLAY_MS);
  }

  /** False when the device has no command with this id. */
  ack(deviceId: string, id: number): boolean {
    return this.s.store.transaction(() => {
      if (!this.s.store.ackCommand(deviceId, id, this.s.now())) return false;
      this.s.eventLog.append("command.delivered", deviceId, tvActor(deviceId), { commandId: id });
      return true;
    });
  }

  /** The TV reports what it made of a command, once. */
  report(deviceId: string, id: number, result: CommandResult, reason: string | null): "ok" | "unknown" | "already_reported" {
    const outcome = this.s.store.transaction(() => {
      const cmd = this.s.store.getCommand(deviceId, id);
      if (!cmd) return "unknown";
      if (cmd.result !== null) return "already_reported";
      this.s.store.setCommandResult(id, result, reason, this.s.now());
      this.s.eventLog.append("command.result", deviceId, tvActor(deviceId), { commandId: id, type: cmd.type, result, reason });
      return "ok";
    });
    // The reason is one of a few codes ([A-Za-z0-9_.:-]), never free text.
    if (outcome === "ok") this.s.log.info("command result", { deviceId, commandId: id, result, reason });
    return outcome;
  }

  purge(): void {
    this.s.store.purgeCommands(this.s.now() - COMMAND_RETENTION_MS);
  }
}
