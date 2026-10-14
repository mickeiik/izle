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

/** Fan-out of live events to the SSE connections of each device. */
export class EventHub {
  private readonly subscribers = new Map<string, Set<Subscriber>>();

  subscribe(deviceId: string, subscriber: Subscriber): () => void {
    const set = this.subscribers.get(deviceId) ?? new Set<Subscriber>();
    this.subscribers.set(deviceId, set);
    set.add(subscriber);
    return () => {
      set.delete(subscriber);
      if (set.size === 0 && this.subscribers.get(deviceId) === set) this.subscribers.delete(deviceId);
    };
  }

  publish(deviceId: string, event: ServerEvent): void {
    for (const s of this.subscribers.get(deviceId) ?? []) s.send(event);
  }

  isOnline(deviceId: string): boolean {
    return (this.subscribers.get(deviceId)?.size ?? 0) > 0;
  }

  /** Ends the open streams of one device (e.g. after it was deleted). */
  closeDevice(deviceId: string): void {
    for (const s of [...(this.subscribers.get(deviceId) ?? [])]) s.close();
  }

  /** Ends every open stream (server shutdown). */
  closeAll(): void {
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
