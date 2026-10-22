// The stored event log: everything worth reacting to, appended in the transaction of the change it reports, kept
// for a few days for live consumers (the admin page, agents). Events carry ids, titles and counts only: never URLs,
// headers, refs, tokens, message texts or problem details.

import type { Actor } from "./actor.ts";
import type { Logger } from "./log.ts";
import { iso } from "./presenters.ts";
import type { EventFilter, Store, StoredEvent } from "./store.ts";
import { Waiters } from "./waiters.ts";

export interface Event {
  id: number;
  at: string;
  type: string;
  deviceId: string | null;
  actor: Actor;
  data: Record<string, unknown>;
}

/** `last`: the id of the last event returned, else `after`; `gap`: events after `after` were purged. */
export interface EventPage {
  events: Event[];
  last: number;
  gap: boolean;
}

export const MAX_EVENT_WAIT_MS = 25_000;
export const EVENT_LIST_DEFAULT = 100;
export const EVENT_LIST_MAX = 500;
/** Most stored events a stream replays when it opens; it starts with a gap when there were more. */
export const EVENT_REPLAY_MAX = EVENT_LIST_MAX;
/** Event types are lower-case words joined by dots and underscores (`playback.started`). */
export const EVENT_TYPE = /^[a-z][a-z_]*(\.[a-z_]*)*$/;

const DAY_MS = 24 * 60 * 60_000;
const WAKE_KEY = "events";

export function eventJson(e: StoredEvent): Event {
  return { id: e.id, at: iso(e.at)!, type: e.type, deviceId: e.deviceId, actor: e.actor, data: e.data };
}

export class EventLog {
  private readonly store: Store;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly retentionMs: number;
  private readonly subscribers = new Set<(e: Event) => void>();
  private readonly waiters = new Waiters<string>();

  constructor(store: Store, log: Logger, now: () => number, retentionDays: number) {
    this.store = store;
    this.log = log;
    this.now = now;
    this.retentionMs = retentionDays * DAY_MS;
  }

  /**
   * Appends an event. Call it inside the store transaction of the change it reports: the id then follows the
   * order the changes were stored in, and subscribers hear of it only once the transaction committed.
   */
  append(type: string, deviceId: string | null, actor: Actor, data: Record<string, unknown>): number {
    const e: StoredEvent = { id: 0, at: this.now(), type, deviceId, actor, data };
    e.id = this.store.insertEvent(e);
    this.store.afterCommit(() => {
      const json = eventJson(e);
      for (const s of this.subscribers) s(json);
      this.waiters.wake(WAKE_KEY);
    });
    return e.id;
  }

  /** Live events, as they are committed, unfiltered. */
  subscribe(fn: (e: Event) => void): () => void {
    this.subscribers.add(fn);
    return () => void this.subscribers.delete(fn);
  }

  lastId(): number {
    return this.store.lastEventId();
  }

  list(f: EventFilter): EventPage {
    const events = this.store.listEvents(f).map(eventJson);
    return { events, last: events.at(-1)?.id ?? f.after, gap: this.lost(f.after) };
  }

  /**
   * What a stream replays: the newest `f.limit` events after `f.after`, oldest first. `gap` when some were lost
   * (as for `list`) or skipped for the limit; `oldest`: the id the replay starts from, else the oldest kept one.
   */
  replay(f: EventFilter): { events: Event[]; gap: boolean; oldest: number | null } {
    const rows = this.store.listEvents({ ...f, limit: f.limit + 1, newest: true });
    const skipped = rows.length > f.limit;
    const events = (skipped ? rows.slice(1) : rows).map(eventJson);
    return { events, gap: skipped || this.lost(f.after), oldest: skipped ? events[0]!.id : this.store.oldestEventId() };
  }

  private lost(after: number): boolean {
    const oldest = this.store.oldestEventId();
    return oldest === null ? after < this.store.lastEventId() : after < oldest - 1;
  }

  /** `list`, waiting up to `waitMs` for the first matching event when there is none yet. */
  async wait(f: EventFilter, waitMs: number, signal?: AbortSignal): Promise<EventPage> {
    const deadline = this.now() + Math.min(waitMs, MAX_EVENT_WAIT_MS);
    for (;;) {
      const page = this.list(f);
      const left = deadline - this.now();
      if (page.events.length > 0 || left <= 0 || signal?.aborted) return page;
      await this.waiters.wait(WAKE_KEY, left, signal);
    }
  }

  purge(): void {
    const deleted = this.store.purgeEvents(this.now() - this.retentionMs);
    if (deleted > 0) this.log.debug("events purged", { deleted });
  }
}
