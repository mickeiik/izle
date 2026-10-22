// A TV's Home list: the whole list (`PUT …/home`, its items or its sections), single changes (add, move, remove one
// item), so that two editors (the owner, an agent) do not overwrite each other's lists, and its sections (create,
// change, delete). Every one answers the version, the list in Home order and the sections.

import type { Context, Hono } from "hono";
import type { AppContext } from "../../context.ts";
import { HttpError } from "../../errors.ts";
import type { Device } from "../../store.ts";
import { homeBody, homeItemBody, homeMoveBody, isId, parseBody, sectionCreateBody, sectionPatchBody } from "../../validation.ts";
import type { Env } from "../middleware.ts";
import { requireDevice } from "./admin.ts";

export function registerAdminHome(app: Hono<Env>, ctx: AppContext): void {
  const { store, home, devices } = ctx;

  /** The answer of every home change. */
  const answer = (c: Context<Env>, d: Device, version: number, extra: Record<string, unknown> = {}) =>
    c.json({ version, home: devices.home(d), sections: home.sections(d.id), ...extra });

  /** The device and the item a `…/home/items/:itemId` route names; an id that cannot be on a list is not on it. */
  const item = (c: Context<Env>) => {
    const d = requireDevice(store, c.req.param("id") ?? "");
    const itemId = c.req.param("itemId") ?? "";
    if (!isId(itemId)) throw new HttpError(404, "not_on_home");
    return { d, itemId };
  };

  /** The device and the section a `…/home/sections/:sectionId` route names; an id that cannot be a section is none. */
  const section = (c: Context<Env>) => {
    const d = requireDevice(store, c.req.param("id") ?? "");
    const sectionId = c.req.param("sectionId") ?? "";
    if (!isId(sectionId)) throw new HttpError(404, "unknown_section");
    return { d, sectionId };
  };

  app.put("/api/v1/admin/devices/:id/home", async (c) => {
    const d = requireDevice(store, c.req.param("id"));
    const body = await parseBody(c, homeBody);
    const version = "itemIds" in body
      ? home.set(d.id, body.itemIds, c.get("actor"), body.expected)
      : home.setSections(d.id, body.sections, c.get("actor"), body.expected);
    return answer(c, d, version);
  });

  app.post("/api/v1/admin/devices/:id/home/items", async (c) => {
    const d = requireDevice(store, c.req.param("id"));
    const { itemId, sectionId, position } = await parseBody(c, homeItemBody);
    return answer(c, d, home.add(d.id, itemId, { sectionId, position }, c.get("actor")));
  });

  app.patch("/api/v1/admin/devices/:id/home/items/:itemId", async (c) => {
    const { d, itemId } = item(c);
    const body = await parseBody(c, homeMoveBody);
    return answer(c, d, home.move(d.id, itemId, body, c.get("actor")));
  });

  app.delete("/api/v1/admin/devices/:id/home/items/:itemId", (c) => {
    const { d, itemId } = item(c);
    return answer(c, d, home.remove(d.id, itemId, c.get("actor")));
  });

  app.post("/api/v1/admin/devices/:id/home/sections", async (c) => {
    const d = requireDevice(store, c.req.param("id"));
    const body = await parseBody(c, sectionCreateBody);
    const { version, sectionId } = home.createSection(d.id, body.title, body.layout, body.position, c.get("actor"));
    return answer(c, d, version, { sectionId });
  });

  app.patch("/api/v1/admin/devices/:id/home/sections/:sectionId", async (c) => {
    const { d, sectionId } = section(c);
    const body = await parseBody(c, sectionPatchBody);
    return answer(c, d, home.updateSection(d.id, sectionId, body, c.get("actor")));
  });

  app.delete("/api/v1/admin/devices/:id/home/sections/:sectionId", (c) => {
    const { d, sectionId } = section(c);
    return answer(c, d, home.deleteSection(d.id, sectionId, c.get("actor")));
  });
}
