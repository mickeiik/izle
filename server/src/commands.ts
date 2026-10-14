// Remote control from the admin page: a command is stored, published to the TV's open event streams, and replayed
// when the TV (re)connects until the TV acknowledges it or it is too old to act on.

import type { Services } from "./context.ts";
import { requireEpisode, requirePlayable } from "./lookup.ts";
import type { Command } from "./store.ts";

/** Commands that carry no payload (the SSE payload is `{}`). */
export const PLAIN_COMMANDS = ["stop", "pause", "resume", "next", "previous"] as const;
/** The longest relative seek, either way. */
export const MAX_SEEK_DELTA_MS = 3_600_000;
export const MESSAGE_MAX_CHARS = 200;
export const MESSAGE_DURATION_SEC = { min: 3, max: 120, default: 15 };

export type CommandType = "play" | "seek" | "message" | (typeof PLAIN_COMMANDS)[number];

/** A command as the admin API takes it (`POST /admin/devices/:id/commands`, validated in validation.ts). */
export type CommandBody =
  | { type: "play"; episodeId: string }
  | { type: (typeof PLAIN_COMMANDS)[number] }
  | { type: "seek"; deltaMs: number; positionMs?: undefined }
  | { type: "seek"; positionMs: number; deltaMs?: undefined }
  | { type: "message"; text: string; durationSec?: number };

/** Unacknowledged commands younger than this are replayed when a TV (re)connects to the event stream. */
export const COMMAND_REPLAY_MS = 2 * 60_000;

export class CommandService {
  private readonly s: Services;

  constructor(services: Services) {
    this.s = services;
  }

  /** What the TV gets with a command (the SSE `payload`); a message's display time defaults here. */
  private payload(body: CommandBody): Record<string, unknown> {
    switch (body.type) {
      case "play": {
        const ref = requireEpisode(this.s.catalog, body.episodeId, 400, "unknown_episode");
        requirePlayable(ref.episode, 400, "not_allowed");
        return { itemId: ref.item.id, episodeId: ref.episode.id };
      }
      case "seek":
        return body.deltaMs !== undefined ? { deltaMs: body.deltaMs } : { positionMs: body.positionMs };
      case "message":
        return { text: body.text.trim(), durationSec: body.durationSec ?? MESSAGE_DURATION_SEC.default };
      default:
        return {}; // stop, pause, resume, next, previous
    }
  }

  /** Stores a command for the device and publishes it to the device's open event streams. */
  send(deviceId: string, body: CommandBody): Command {
    const cmd = this.s.store.insertCommand(deviceId, body.type, this.payload(body), this.s.now());
    this.s.notifier.command(cmd);
    // Type and ids only: never a message's text.
    this.s.log.info("command queued", { deviceId, type: cmd.type, commandId: cmd.id });
    return cmd;
  }

  /** The commands a (re)connecting TV gets again: unacknowledged and younger than COMMAND_REPLAY_MS, oldest first. */
  replayable(deviceId: string): Command[] {
    return this.s.store.pendingCommands(deviceId, this.s.now() - COMMAND_REPLAY_MS);
  }

  /** The TV acknowledges a command; false when the device has no command with this id. */
  ack(deviceId: string, id: number): boolean {
    return this.s.store.ackCommand(deviceId, id, this.s.now());
  }
}
