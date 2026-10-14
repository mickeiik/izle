import type { Command } from "./store.ts";

export type ServerEvent =
  | { type: "state"; data: { version: number } }
  | { type: "command"; data: { id: number; type: string; payload: Record<string, unknown> } };

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
    let set = this.subscribers.get(deviceId);
    if (!set) {
      set = new Set();
      this.subscribers.set(deviceId, set);
    }
    set.add(subscriber);
    return () => {
      set.delete(subscriber);
      if (set.size === 0 && this.subscribers.get(deviceId) === set) this.subscribers.delete(deviceId);
    };
  }

  publish(deviceId: string, event: ServerEvent): void {
    for (const s of this.subscribers.get(deviceId) ?? []) s.send(event);
  }

  connections(deviceId: string): number {
    return this.subscribers.get(deviceId)?.size ?? 0;
  }

  isOnline(deviceId: string): boolean {
    return this.connections(deviceId) > 0;
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
