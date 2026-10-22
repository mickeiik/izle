// A TV's Home: the whole list (`PUT …/home`, its items or its sections), single changes to one item (so that two
// editors do not overwrite each other's lists), and its sections. Each answers the version, the list and the sections.

import type { Context, Hono } from "hono";
import type { AppContext } from "../../context.ts";
import { HttpError } from "../../errors.ts";
import type { Device } from "../../store.ts";
import { homeBody, homeItemBody, homeMoveBody, isId, parseBody, sectionCreateBody, sectionPatchBody } from "../../validation.ts";
import type { Env } from "../middleware.ts";
import { requireDevice } from "./admin.ts";

export function registerAdminHome(app: Hono<Env>, ctx: AppContext): void {
  const { store, home, devices } = ctx;

  const answer = (c: Context<Env>, d: Device, version: number, extra: Record<string, unknown> = {}) =>
    c.json({ version, home: devices.home(d), sections: home.sections(d.id), ...extra });

  /** The device and the item or section the route names: an id that cannot be on a list is not on it (404 `code`). */
  const named = (c: Context<Env>, param: "itemId" | "sectionId", code: string) => {
    const d = requireDevice(store, c.req.param("id"));
    const id = c.req.param(param) ?? "";
    if (!isId(id)) throw new HttpError(404, code);
    return { d, id };
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
    const { d, id } = named(c, "itemId", "not_on_home");
    return answer(c, d, home.move(d.id, id, await parseBody(c, homeMoveBody), c.get("actor")));
  });

  app.delete("/api/v1/admin/devices/:id/home/items/:itemId", (c) => {
    const { d, id } = named(c, "itemId", "not_on_home");
    return answer(c, d, home.remove(d.id, id, c.get("actor")));
  });

  app.post("/api/v1/admin/devices/:id/home/sections", async (c) => {
    const d = requireDevice(store, c.req.param("id"));
    const body = await parseBody(c, sectionCreateBody);
    const { version, sectionId } = home.createSection(d.id, body.title, body.layout, body.position, c.get("actor"));
    return answer(c, d, version, { sectionId });
  });

  app.patch("/api/v1/admin/devices/:id/home/sections/:sectionId", async (c) => {
    const { d, id } = named(c, "sectionId", "unknown_section");
    return answer(c, d, home.updateSection(d.id, id, await parseBody(c, sectionPatchBody), c.get("actor")));
  });

  app.delete("/api/v1/admin/devices/:id/home/sections/:sectionId", (c) => {
    const { d, id } = named(c, "sectionId", "unknown_section");
    return answer(c, d, home.deleteSection(d.id, id, c.get("actor")));
  });
}
