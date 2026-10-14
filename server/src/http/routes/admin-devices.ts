// The admin API for TVs: pairing approval, the device list and a TV's page (settings, home list, "continue from",
// what it has watched and is playing), remote commands and its problem reports.

import type { Hono } from "hono";
import type { AppContext } from "../../context.ts";
import { HttpError } from "../../errors.ts";
import { PROBLEM_LIST_DEFAULT, PROBLEM_LIST_MAX } from "../../problems.ts";
import { iso } from "../../presenters.ts";
import { HOME_MAX_ITEMS, MAX_NOW_WAIT_MS } from "../../tv.ts";
import { approveBody, commandBody, cursorBody, devicePatchBody, homeBody, parseBody } from "../../validation.ts";
import type { Env } from "../middleware.ts";
import { parseWait, requireDevice } from "../params.ts";

/** Pairing approval and the devices: list, page, settings, deletion, home list, cursor, progress, now playing. */
export function registerAdminDevices(app: Hono<Env>, ctx: AppContext): void {
  const { store, tv, pairing, devices } = ctx;

  app.post("/api/v1/admin/pair/approve", async (c) => {
    const body = await parseBody(c, approveBody);
    return c.json(pairing.approve(body.code, body.name));
  });

  app.get("/api/v1/admin/pair/pending", (c) =>
    c.json({ codes: pairing.listOpen().map((p) => ({ code: p.code, createdAt: iso(p.createdAt), expiresAt: iso(p.expiresAt), approved: p.approved })) }),
  );

  app.get("/api/v1/admin/devices", (c) => c.json({ devices: devices.list() }));

  app.get("/api/v1/admin/devices/:id", (c) => {
    const d = requireDevice(store, c.req.param("id"));
    return c.json({ device: devices.view(d), home: devices.home(d), homeMax: HOME_MAX_ITEMS });
  });

  app.patch("/api/v1/admin/devices/:id", async (c) => {
    const d = requireDevice(store, c.req.param("id"));
    const body = await parseBody(c, devicePatchBody);
    return c.json({ device: devices.view(devices.update(d, body)) });
  });

  app.delete("/api/v1/admin/devices/:id", (c) => {
    devices.remove(requireDevice(store, c.req.param("id")));
    return c.body(null, 204);
  });

  app.put("/api/v1/admin/devices/:id/home", async (c) => {
    const d = requireDevice(store, c.req.param("id"));
    const body = await parseBody(c, homeBody);
    const version = tv.setHome(d.id, body.itemIds);
    return c.json({ version, home: devices.home(d) });
  });

  app.put("/api/v1/admin/devices/:id/cursor", async (c) => {
    const d = requireDevice(store, c.req.param("id"));
    const body = await parseBody(c, cursorBody);
    return c.json({ version: tv.setCursor(d.id, body.itemId, body.episodeId) });
  });

  app.get("/api/v1/admin/devices/:id/progress", (c) => c.json(devices.progress(requireDevice(store, c.req.param("id")))));

  // `?seq=<n>&wait=<s>` long-polls until the row changes (the phone's "Listen along" follows the TV with it).
  app.get("/api/v1/admin/devices/:id/now", async (c) => {
    const d = requireDevice(store, c.req.param("id"));
    const seqParam = c.req.query("seq");
    const seq = seqParam === undefined ? null : Number(seqParam);
    if (seq !== null && (!Number.isSafeInteger(seq) || seq < 0)) throw new HttpError(400, "invalid_request", "seq must be a non-negative integer");
    const waitSec = parseWait(c.req.query("wait"), 0, MAX_NOW_WAIT_MS / 1000);
    const n = await tv.waitNow(d.id, seq, waitSec * 1000, c.req.raw.signal);
    return c.json(devices.now(d, n));
  });
}

/** Remote commands to a TV and the TV's problem reports. */
export function registerAdminCommands(app: Hono<Env>, ctx: AppContext): void {
  const { store, events } = ctx;

  app.post("/api/v1/admin/devices/:id/commands", async (c) => {
    const d = requireDevice(store, c.req.param("id"));
    const body = await parseBody(c, commandBody);
    const cmd = ctx.commands.send(d.id, body);
    return c.json({ id: cmd.id, online: events.isOnline(d.id) }, 202);
  });

  app.get("/api/v1/admin/devices/:id/problems", (c) => {
    const d = requireDevice(store, c.req.param("id"));
    const asked = Math.trunc(Number(c.req.query("limit") ?? PROBLEM_LIST_DEFAULT)) || PROBLEM_LIST_DEFAULT;
    return c.json({ problems: ctx.problems.list(d.id, Math.min(Math.max(asked, 1), PROBLEM_LIST_MAX)) });
  });

  app.delete("/api/v1/admin/devices/:id/problems", (c) => {
    const d = requireDevice(store, c.req.param("id"));
    ctx.problems.clear(d.id);
    ctx.log.info("problems cleared", { deviceId: d.id });
    return c.body(null, 204);
  });
}
