// Single home list changes (add, move, remove one item), so that two editors (the owner, an agent) do not overwrite
// each other's lists. Each answers like `PUT …/home`, which takes the whole list (admin.ts).

import type { Context, Hono } from "hono";
import type { AppContext } from "../../context.ts";
import { HttpError } from "../../errors.ts";
import { homeItemBody, homeMoveBody, isId, parseBody } from "../../validation.ts";
import type { Env } from "../middleware.ts";
import { requireDevice } from "./admin.ts";

export function registerAdminHome(app: Hono<Env>, ctx: AppContext): void {
  const { store, tv, devices } = ctx;

  /** The device and the item a `…/home/items/:itemId` route names; an id that cannot be on a list is not on it. */
  const target = (c: Context<Env>) => {
    const d = requireDevice(store, c.req.param("id") ?? "");
    const itemId = c.req.param("itemId") ?? "";
    if (!isId(itemId)) throw new HttpError(404, "not_on_home");
    return { d, itemId };
  };

  app.post("/api/v1/admin/devices/:id/home/items", async (c) => {
    const d = requireDevice(store, c.req.param("id"));
    const body = await parseBody(c, homeItemBody);
    const version = tv.addHomeItem(d.id, body.itemId, body.position, c.get("actor"));
    return c.json({ version, home: devices.home(d) });
  });

  app.patch("/api/v1/admin/devices/:id/home/items/:itemId", async (c) => {
    const { d, itemId } = target(c);
    const body = await parseBody(c, homeMoveBody);
    const version = tv.moveHomeItem(d.id, itemId, body.position, c.get("actor"));
    return c.json({ version, home: devices.home(d) });
  });

  app.delete("/api/v1/admin/devices/:id/home/items/:itemId", (c) => {
    const { d, itemId } = target(c);
    const version = tv.removeHomeItem(d.id, itemId, c.get("actor"));
    return c.json({ version, home: devices.home(d) });
  });
}
