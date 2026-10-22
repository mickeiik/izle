// The event log for live consumers: a server-sent event stream (the admin page reads it with fetch, the token in a
// header), and a long-poll for clients that cannot keep a stream open (MCP tools, scripts).

import type { Context, Hono } from "hono";
import type { StreamingApi } from "hono/utils/stream";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import { limiterKey } from "../../clientip.ts";
import type { AppContext } from "../../context.ts";
import { tooManyRequests, unauthorized } from "../../errors.ts";
import { EVENT_LIST_DEFAULT, EVENT_LIST_MAX, EVENT_REPLAY_MAX, EVENT_TYPE, MAX_EVENT_WAIT_MS, type Event } from "../../eventlog.ts";
import { intQuery, isId, limitQuery, listQuery, parseWait } from "../../validation.ts";
import type { Env } from "../middleware.ts";

const filters = (c: Context) => ({
  devices: listQuery(c.req.query("devices"), "device ids", isId),
  types: listQuery(c.req.query("types"), "event types", (t) => EVENT_TYPE.test(t) && t.length <= 60),
});

/** Whether a live event passes the request's filters (a type ending in "." is a prefix). */
function passes(e: Event, f: ReturnType<typeof filters>): boolean {
  if (f.devices && e.deviceId !== null && !f.devices.includes(e.deviceId)) return false;
  return !f.types || f.types.some((t) => (t.endsWith(".") ? e.type.startsWith(t) : e.type === t));
}

/** Frames a stream may have waiting for a reader that fell behind before it is closed (it reconnects and replays). */
export const MAX_QUEUED_FRAMES = 2 * EVENT_REPLAY_MAX;
/** Event streams open at once per access token, and for the owner token per client address. */
export const MAX_ADMIN_STREAMS = 10;

/** One writer for a stream's frames, in order; aborts the stream once more than `max` wait instead of queuing on. */
export function frameWriter(stream: Pick<StreamingApi, "abort" | "aborted">, max: number): (frame: () => Promise<unknown>) => void {
  let queue: Promise<unknown> = Promise.resolve();
  let waiting = 0;
  return (frame) => {
    if (stream.aborted) return;
    if (++waiting > max) return stream.abort();
    queue = queue
      .then(frame)
      .catch(() => stream.abort())
      .finally(() => waiting--);
  };
}

export function registerAdminEvents(app: Hono<Env>, ctx: AppContext, clientKey: (c: Context) => string): void {
  const { eventLog } = ctx;
  const open = new Map<string, number>();

  app.get("/api/v1/admin/events", async (c) => {
    const after = intQuery(c.req.query("after"), "after", 0);
    const waitSec = parseWait(c.req.query("wait"), 0, MAX_EVENT_WAIT_MS / 1000);
    const limit = limitQuery(c.req.query("limit"), EVENT_LIST_DEFAULT, EVENT_LIST_MAX);
    const f = filters(c);
    // Without `after` the caller is finding out where to start following from.
    if (after === undefined) return c.json({ events: [], last: eventLog.lastId(), gap: false });
    // A token revoked while its long-poll waits gets the 401 any later request would.
    const actor = c.get("actor");
    const revoked = new AbortController();
    const unregister = actor.type === "token" ? ctx.tokens.onRevoke(actor.tokenId, () => revoked.abort()) : () => {};
    try {
      const page = await eventLog.wait({ after, limit, ...f }, waitSec * 1000, AbortSignal.any([c.req.raw.signal, revoked.signal]));
      if (revoked.signal.aborted) throw unauthorized("izle-admin", "missing or invalid admin token");
      return c.json(page);
    } finally {
      unregister();
    }
  });

  // Replays the stored events after `after` / `Last-Event-ID`, then the live ones; without either, live ones only.
  app.get("/api/v1/admin/events/stream", (c) => {
    const after = intQuery(c.req.query("after") ?? c.req.header("Last-Event-ID"), "after", 0);
    const f = filters(c);
    const actor = c.get("actor");
    const tokenId = actor.type === "token" ? actor.tokenId : null;
    const key = tokenId === null ? `owner ${limiterKey(clientKey(c))}` : `token ${tokenId}`;
    const count = open.get(key) ?? 0;
    if (count >= MAX_ADMIN_STREAMS) throw tooManyRequests("too_many_streams", "too many event streams are open with this token", 5);
    open.set(key, count + 1);
    const release = () => {
      const left = (open.get(key) ?? 1) - 1;
      if (left > 0) open.set(key, left);
      else open.delete(key);
    };
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, (stream) => follow(stream).finally(release));

    async function follow(stream: SSEStreamingApi): Promise<void> {
      let ping: ReturnType<typeof setInterval> | undefined;
      const closed = new Promise<void>((resolve) => stream.onAbort(resolve));
      const write = frameWriter(stream, MAX_QUEUED_FRAMES);
      const send = (e: Event) => write(() => stream.writeSSE({ id: String(e.id), event: e.type, data: JSON.stringify(e) }));
      // Replay and subscription in one synchronous run (the store is synchronous): no event missed or sent twice.
      const replay = after === undefined ? null : eventLog.replay({ after, limit: EVENT_REPLAY_MAX, ...f });
      const unsubscribe = eventLog.subscribe((e) => void (passes(e, f) && send(e)));
      // Revoking the stream's access token ends it at once; each ping checks again.
      const unregister = tokenId === null ? () => {} : ctx.tokens.onRevoke(tokenId, () => stream.abort());
      try {
        write(() => stream.write("retry: 5000\n\n"));
        if (replay?.gap) write(() => stream.writeSSE({ event: "gap", data: JSON.stringify({ oldest: replay.oldest }) }));
        for (const e of replay?.events ?? []) send(e);
        ping = setInterval(() => {
          if (tokenId !== null && !ctx.tokens.exists(tokenId)) stream.abort();
          else write(() => stream.write(": ping\n\n"));
        }, ctx.pingMs);
        await closed;
      } finally {
        clearInterval(ping);
        unsubscribe();
        unregister();
      }
    }
  });
}
