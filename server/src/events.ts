import type { CommandType } from "./commands.ts";
import type { Command, Device, Store } from "./store.ts";

export type ServerEvent =
  | { type: "state"; data: { version: number } }
  | { type: "command"; data: { id: number; type: CommandType; payload: Record<string, unknown> } };

interface Subscriber {
  send(event: ServerEvent): void;
  close(): void;
}

/** The event a stored command reaches the TV as, live or replayed on connect. */
export function commandEvent(cmd: Pick<Command, "id" | "type" | "payload">): ServerEvent {
  return { type: "command", data: { id: cmd.id, type: cmd.type, payload: cmd.payload } };
}

/** The SSE `id` of an event: `s<version>` for state, `c<commandId>` for commands. */
export function eventId(ev: ServerEvent): string {
  return ev.type === "state" ? `s${ev.data.version}` : `c${ev.data.id}`;
}

/** A TV stays online this long after its last event stream closed, so a reconnect does not flap. */
export const OFFLINE_GRACE_MS = 60_000;

/**
 * Fan-out of live events to the SSE connections of each device, and the one rule for `online`: a TV is online
 * while it has a stream open, and for `offlineGraceMs` after its last one closed. `onOnline` hears each change.
 */
export class EventHub {
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  /** Devices whose last stream closed less than the grace period ago: still online until the timer fires. */
  private readonly closing = new Map<string, ReturnType<typeof setTimeout>>();
  /** Devices removed while a stream was open: their last unsubscribe is not a disconnect to announce. */
  private readonly dropped = new Set<string>();
  private readonly offlineGraceMs: number;
  /** Told when a device goes online (its first stream opens) or offline (the grace period after its last ended). */
  onOnline: (deviceId: string, online: boolean) => void = () => {};

  constructor(offlineGraceMs = OFFLINE_GRACE_MS) {
    this.offlineGraceMs = offlineGraceMs;
  }

  subscribe(deviceId: string, subscriber: Subscriber): () => void {
    const set = this.subscribers.get(deviceId) ?? new Set<Subscriber>();
    this.subscribers.set(deviceId, set);
    set.add(subscriber);
    this.dropped.delete(deviceId);
    if (set.size === 1) {
      const timer = this.closing.get(deviceId);
      if (timer !== undefined) {
        // A reconnect within the grace period: the TV never went offline.
        clearTimeout(timer);
        this.closing.delete(deviceId);
      } else {
        this.onOnline(deviceId, true);
      }
    }
    return () => {
      if (!set.delete(subscriber)) return;
      if (set.size > 0 || this.subscribers.get(deviceId) !== set) return;
      this.subscribers.delete(deviceId);
      if (this.dropped.delete(deviceId)) return;
      const timer = setTimeout(() => {
        this.closing.delete(deviceId);
        this.onOnline(deviceId, false);
      }, this.offlineGraceMs);
      timer.unref();
      this.closing.set(deviceId, timer);
    };
  }

  publish(deviceId: string, event: ServerEvent): void {
    for (const s of this.subscribers.get(deviceId) ?? []) s.send(event);
  }

  isOnline(deviceId: string): boolean {
    return (this.subscribers.get(deviceId)?.size ?? 0) > 0 || this.closing.has(deviceId);
  }

  /** Ends the open streams of a device that is gone (deleted): no offline event follows. */
  closeDevice(deviceId: string): void {
    const timer = this.closing.get(deviceId);
    if (timer !== undefined) clearTimeout(timer);
    this.closing.delete(deviceId);
    const open = [...(this.subscribers.get(deviceId) ?? [])];
    if (open.length > 0) this.dropped.add(deviceId);
    for (const s of open) s.close();
  }

  /** Ends every open stream (server shutdown); nothing is announced, the next start says every TV is offline. */
  closeAll(): void {
    for (const timer of this.closing.values()) clearTimeout(timer);
    this.closing.clear();
    this.onOnline = () => {};
    for (const set of this.subscribers.values()) for (const s of [...set]) s.close();
    this.subscribers.clear();
  }
}

/**
 * Tells TVs what changed, on their open event streams: a new state version (the TV re-reads its state) or a
 * command. Every state-version change goes through here, so the version a TV hears is the one stored.
 */
export class Notifier {
  private readonly store: Store;
  private readonly events: EventHub;

  constructor(store: Store, events: EventHub) {
    this.store = store;
    this.events = events;
  }

  /** The device's state version as stored now; the one `device` was read with when the device is gone. */
  version(device: Device): number {
    return this.store.getDevice(device.id)?.stateVersion ?? device.stateVersion;
  }

  /** Bumps the device's state version and tells its streams; returns the new version. */
  bump(deviceId: string): number {
    const version = this.store.bumpStateVersion(deviceId);
    this.state(deviceId, version);
    return version;
  }

  /** Tells the device's streams about a version the store already bumped (as `Store.updateDevice` does). */
  state(deviceId: string, version: number): void {
    this.events.publish(deviceId, { type: "state", data: { version } });
  }

  /** Bumps every device's state version (after a catalog reload) and tells each one. */
  bumpAll(): void {
    for (const { id, stateVersion } of this.store.bumpAllStateVersions()) this.state(id, stateVersion);
  }

  command(cmd: Command): void {
    this.events.publish(cmd.deviceId, commandEvent(cmd));
  }
}
