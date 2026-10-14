// The TV's API (device token): home state, item details, resolve, playback progress, command acknowledgements and
// problem reports. The event stream is in events.ts.

import type { Hono } from "hono";
import type { AppContext } from "../../context.ts";
import { HttpError } from "../../errors.ts";
import { isId, parseBody, problemBody, progressBody, resolveBody } from "../../validation.ts";
import type { Env } from "../middleware.ts";

export function registerTv(app: Hono<Env>, ctx: AppContext): void {
  const { tv } = ctx;

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
    const r = tv.recordProgress(c.get("device"), { ...body, durationMs: body.durationMs ?? null });
    return c.json({ ok: true, version: r.version });
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
}
