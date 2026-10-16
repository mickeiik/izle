// The event log for live consumers: a server-sent event stream (the admin page, with the token in a header, so it
// reads it with fetch), and a long-poll for clients that cannot keep a stream open (MCP tools, scripts).

import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppContext } from "../../context.ts";
import { EVENT_LIST_DEFAULT, EVENT_LIST_MAX, EVENT_TYPE, MAX_EVENT_WAIT_MS, type Event } from "../../eventlog.ts";
import type { EventFilter } from "../../store.ts";
import { intQuery, isId, limitQuery, listQuery, parseWait } from "../../validation.ts";
import type { Env } from "../middleware.ts";

/** The `devices` and `types` filters of both routes. */
function filters(c: Context): Pick<EventFilter, "devices" | "types"> {
  return {
    devices: listQuery(c.req.query("devices"), "device ids", isId),
    types: listQuery(c.req.query("types"), "event types", (t) => EVENT_TYPE.test(t) && t.length <= 60),
  };
}

/** Whether a live event passes the request's filters. */
function passes(e: Event, f: Pick<EventFilter, "devices" | "types">): boolean {
  if (f.devices && e.deviceId !== null && !f.devices.includes(e.deviceId)) return false;
  if (f.types && !f.types.some((t) => (t.endsWith(".") ? e.type.startsWith(t) : e.type === t))) return false;
  return true;
}

export function registerAdminEvents(app: Hono<Env>, ctx: AppContext): void {
  const { eventLog } = ctx;

  app.get("/api/v1/admin/events", async (c) => {
    const after = intQuery(c.req.query("after"), "after", 0);
    const waitSec = parseWait(c.req.query("wait"), 0, MAX_EVENT_WAIT_MS / 1000);
    const limit = limitQuery(c.req.query("limit"), EVENT_LIST_DEFAULT, EVENT_LIST_MAX);
    const f = filters(c);
    // Without `after` the caller is finding out where to start following from.
    if (after === undefined) return c.json({ events: [], last: eventLog.lastId(), gap: false });
    return c.json(await eventLog.wait({ after, limit, ...f }, waitSec * 1000, c.req.raw.signal));
  });

  // Replays the stored events after `after` / `Last-Event-ID`, then the live ones; without either, live ones only.
  app.get("/api/v1/admin/events/stream", (c) => {
    const after = intQuery(c.req.query("after") ?? c.req.header("Last-Event-ID"), "after", 0);
    const f = filters(c);
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      let ping: ReturnType<typeof setInterval> | undefined;
      const closed = new Promise<void>((resolve) => stream.onAbort(resolve));
      // Every frame goes through one writer, in the order it was queued.
      let queue: Promise<unknown> = Promise.resolve();
      const write = (frame: () => Promise<unknown>) => void (queue = queue.then(frame).catch(() => stream.abort()));
      const send = (e: Event) => write(() => stream.writeSSE({ id: String(e.id), event: e.type, data: JSON.stringify(e) }));
      // The stored events are read and the live subscription made in one synchronous run (the store is synchronous,
      // so nothing is committed in between): no event is missed, none is sent twice.
      const replay: Event[] = [];
      let gap = false;
      for (let from = after; from !== undefined; ) {
        const page = eventLog.list({ after: from, limit: EVENT_LIST_MAX, ...f });
        if (from === after) gap = page.gap;
        replay.push(...page.events);
        from = page.events.length < EVENT_LIST_MAX ? undefined : page.last;
      }
      const unsubscribe = eventLog.subscribe((e) => void (passes(e, f) && send(e)));
      try {
        write(() => stream.write("retry: 5000\n\n"));
        if (gap) write(() => stream.writeSSE({ event: "gap", data: JSON.stringify({ oldest: eventLog.oldestId() }) }));
        for (const e of replay) send(e);
        ping = setInterval(() => void stream.write(": ping\n\n").catch(() => stream.abort()), ctx.pingMs);
        await closed;
      } finally {
        clearInterval(ping);
        unsubscribe();
      }
    });
  });
}
