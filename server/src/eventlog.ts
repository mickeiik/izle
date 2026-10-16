// The stored event log: everything worth reacting to, appended in the transaction of the change it reports, kept
// for a few days for live consumers (the admin page, agents). Events carry ids, titles and counts only: never URLs,
// headers, refs, tokens, message texts or problem details.

import type { Actor } from "./actor.ts";
import type { Logger } from "./log.ts";
import { iso } from "./presenters.ts";
import type { EventFilter, Store, StoredEvent } from "./store.ts";
import { Waiters } from "./waiters.ts";

/** An event as the admin API shows it. */
export interface Event {
  id: number;
  at: string;
  type: string;
  deviceId: string | null;
  actor: Actor;
  data: Record<string, unknown>;
}

/** What `GET /admin/events` answers: events oldest first, where to continue, and whether some were lost. */
export interface EventPage {
  events: Event[];
  /** The id of the last event returned, else `after`. */
  last: number;
  /** `after` was older than the oldest kept event: the events in between are gone. */
  gap: boolean;
}

/** Longest a long-poll waits for an event. */
export const MAX_EVENT_WAIT_MS = 25_000;
export const EVENT_LIST_DEFAULT = 100;
export const EVENT_LIST_MAX = 500;
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

  /** Live events, as they are committed, unfiltered; the stream route filters. */
  subscribe(fn: (e: Event) => void): () => void {
    this.subscribers.add(fn);
    return () => void this.subscribers.delete(fn);
  }

  lastId(): number {
    return this.store.lastEventId();
  }

  /** The oldest kept event's id, or null when none is kept. */
  oldestId(): number | null {
    return this.store.oldestEventId();
  }

  /**
   * The events after `f.after` (at most `f.limit`), with `gap: true` when some between `after` and the oldest kept
   * one are gone: the kept events then start from the oldest.
   */
  list(f: EventFilter): EventPage {
    const oldest = this.store.oldestEventId();
    const gap = oldest === null ? f.after < this.store.lastEventId() : f.after < oldest - 1;
    const events = this.store.listEvents(f).map(eventJson);
    return { events, last: events.at(-1)?.id ?? f.after, gap };
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

  /** Housekeeping: drops events older than the retention period. */
  purge(): void {
    const deleted = this.store.purgeEvents(this.now() - this.retentionMs);
    if (deleted > 0) this.log.debug("events purged", { deleted });
  }
}
