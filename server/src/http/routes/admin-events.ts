// The event log for live consumers: a server-sent event stream (the admin page, with the token in a header, so it
// reads it with fetch), and a long-poll for clients that cannot keep a stream open (MCP tools, scripts).

import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppContext } from "../../context.ts";
import { HttpError } from "../../errors.ts";
import { EVENT_LIST_DEFAULT, EVENT_LIST_MAX, EVENT_TYPE, MAX_EVENT_WAIT_MS, type Event } from "../../eventlog.ts";
import type { EventFilter } from "../../store.ts";
import { isId, parseWait } from "../../validation.ts";
import type { Env } from "../middleware.ts";

/** `?after=`: an event id, or absent (null). */
function parseAfter(param: string | undefined): number | null {
  if (param === undefined || param === "") return null;
  const n = Number(param);
  if (!Number.isSafeInteger(n) || n < 0) throw new HttpError(400, "invalid_request", "after must be a non-negative integer");
  return n;
}

/** A comma-separated list parameter, each entry checked by `ok`; absent = no filter. */
function parseList(param: string | undefined, what: string, ok: (v: string) => boolean): string[] | undefined {
  if (param === undefined) return undefined;
  const list = param.split(",").map((v) => v.trim()).filter((v) => v !== "");
  if (list.length > 100 || list.some((v) => !ok(v))) throw new HttpError(400, "invalid_request", `${what} must be a comma-separated list of ${what}`);
  return list;
}

/** The `devices` and `types` filters of both routes. */
function filters(c: Context): Pick<EventFilter, "devices" | "types"> {
  return {
    devices: parseList(c.req.query("devices"), "device ids", isId),
    types: parseList(c.req.query("types"), "event types", (t) => EVENT_TYPE.test(t) && t.length <= 60),
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
    const after = parseAfter(c.req.query("after"));
    const waitSec = parseWait(c.req.query("wait"), 0, MAX_EVENT_WAIT_MS / 1000);
    const asked = Math.trunc(Number(c.req.query("limit") ?? EVENT_LIST_DEFAULT)) || EVENT_LIST_DEFAULT;
    const limit = Math.min(Math.max(asked, 1), EVENT_LIST_MAX);
    const f = filters(c);
    // Without `after` the caller is finding out where to start following from.
    if (after === null) return c.json({ events: [], last: eventLog.lastId(), gap: false });
    return c.json(await eventLog.wait({ after, limit, ...f }, waitSec * 1000, c.req.raw.signal));
  });

  // Replays the stored events after `after` / `Last-Event-ID`, then the live ones; without either, live ones only.
  app.get("/api/v1/admin/events/stream", (c) => {
    const after = parseAfter(c.req.query("after") ?? c.req.header("Last-Event-ID"));
    const f = filters(c);
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      let ping: ReturnType<typeof setInterval> | undefined;
      const closed = new Promise<void>((resolve) => stream.onAbort(resolve));
      // One writer at a time keeps the replay and the live events in id order.
      let queue = Promise.resolve();
      let lastSent = after ?? Number.MAX_SAFE_INTEGER;
      const send = (e: Event) => {
        if (e.id <= lastSent) return;
        lastSent = e.id;
        queue = queue.then(() => stream.writeSSE({ id: String(e.id), event: e.type, data: JSON.stringify(e) })).catch(() => stream.abort());
      };
      // Subscribed before the stored events are read: nothing committed in between can be missed (the store is
      // synchronous, so no event lands between the two statements).
      const unsubscribe = eventLog.subscribe((e) => void (passes(e, f) && send(e)));
      try {
        await stream.write("retry: 5000\n\n");
        if (after !== null) {
          let from = after;
          for (;;) {
            const page = eventLog.list({ after: from, limit: EVENT_LIST_MAX, ...f });
            if (from === after && page.gap) await stream.writeSSE({ event: "gap", data: JSON.stringify({ oldest: eventLog.oldestId() }) });
            for (const e of page.events) send(e);
            if (page.events.length < EVENT_LIST_MAX) break;
            from = page.last;
          }
        } else {
          lastSent = eventLog.lastId();
        }
        ping = setInterval(() => void stream.write(": ping\n\n").catch(() => stream.abort()), ctx.pingMs);
        await closed;
      } finally {
        clearInterval(ping);
        unsubscribe();
      }
    });
  });
}
