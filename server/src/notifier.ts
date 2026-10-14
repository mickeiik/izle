import { commandEvent, type EventHub } from "./events.ts";
import type { Command, Store } from "./store.ts";

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

  /** Publishes a stored command to its device's streams. */
  command(cmd: Command): void {
    this.events.publish(cmd.deviceId, commandEvent(cmd));
  }
}
