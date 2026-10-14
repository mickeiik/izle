// What the TV calls: pairing (unauthenticated; the owner's approval is an admin route), then with its device token
// the home state, item details, resolve, playback progress, command acknowledgements, problem reports and the event
// stream (SSE: the state version on connect, then state changes and commands; unacknowledged recent commands are
// replayed on every (re)connect).

import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { bearerToken } from "../../auth.ts";
import type { AppContext } from "../../context.ts";
import { HttpError, unauthorized } from "../../errors.ts";
import { commandEvent, eventId, type ServerEvent } from "../../events.ts";
import { MAX_PAIR_WAIT_MS, PAIR_CODE } from "../../pairing.ts";
import { iso } from "../../presenters.ts";
import { isId, parseBody, problemBody, progressBody, resolveBody } from "../../validation.ts";
import type { Env } from "../middleware.ts";
import { parseWait } from "../params.ts";

export function registerTv(app: Hono<Env>, ctx: AppContext, clientKey: (c: Context) => string): void {
  const { tv, pairing, events, notifier } = ctx;

  app.post("/api/v1/pair/start", (c) => {
    const r = pairing.start(clientKey(c));
    return c.json({ code: r.code, pairToken: r.pairToken, expiresAt: iso(r.expiresAt) });
  });

  app.get("/api/v1/pair/wait", async (c) => {
    const code = c.req.query("code") ?? "";
    if (!PAIR_CODE.test(code)) throw new HttpError(400, "invalid_request", "code must be 6 digits");
    const pairToken = bearerToken(c.req.header("Authorization"));
    if (!pairToken) throw unauthorized("izle-pair", "the pair token is required");
    const waitSec = parseWait(c.req.query("wait"), MAX_PAIR_WAIT_MS / 1000, MAX_PAIR_WAIT_MS / 1000);
    return c.json(await pairing.wait(code, pairToken, waitSec * 1000, c.req.raw.signal));
  });

  app.get("/api/v1/tv/state", (c) => c.json(tv.state(c.get("device"))));

  app.get("/api/v1/tv/items/:itemId", (c) => {
    const itemId = c.req.param("itemId");
    if (!isId(itemId)) throw new HttpError(404, "unknown_item");
    return c.json(tv.item(c.get("device"), itemId));
  });

  app.post("/api/v1/tv/resolve", async (c) => {
    const body = await parseBody(c, resolveBody);
    return c.json(await tv.resolve(c.get("device"), body, c.req.raw.signal));
  });

  app.post("/api/v1/tv/progress", async (c) => {
    const body = await parseBody(c, progressBody);
    return c.json({ ok: true, version: tv.recordProgress(c.get("device"), body).version });
  });

  app.post("/api/v1/tv/commands/:id/ack", (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isSafeInteger(id) || id <= 0 || !ctx.commands.ack(c.get("device").id, id)) {
      throw new HttpError(404, "unknown_command");
    }
    return c.json({ ok: true });
  });

  // Something went wrong on the TV ("Can't play right now", a player error): kept for the owner's admin page.
  app.post("/api/v1/tv/problems", async (c) => {
    const body = await parseBody(c, problemBody);
    ctx.problems.report(c.get("device"), body);
    return c.json({ ok: true }, 202);
  });

  app.get("/api/v1/tv/events", (c) => {
    const device = c.get("device");
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      let ping: ReturnType<typeof setInterval> | undefined;
      const closed = new Promise<void>((resolve) => stream.onAbort(resolve));
      const message = (ev: ServerEvent) => ({ event: ev.type, data: JSON.stringify(ev.data), id: eventId(ev) });
      const write = (ev: ServerEvent) => stream.writeSSE(message(ev)).catch(() => stream.abort());
      const unsubscribe = events.subscribe(device.id, { send: (ev) => void write(ev), close: () => stream.abort() });
      try {
        await stream.writeSSE({ ...message({ type: "state", data: { version: notifier.version(device) } }), retry: 5000 });
        for (const cmd of ctx.commands.replayable(device.id)) await write(commandEvent(cmd));
        ping = setInterval(() => void stream.write(": ping\n\n").catch(() => stream.abort()), ctx.pingMs);
        await closed;
      } finally {
        clearInterval(ping);
        unsubscribe();
      }
    });
  });
}
