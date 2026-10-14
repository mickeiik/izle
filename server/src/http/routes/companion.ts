// "Listen along" (companion audio on the owner's phone): the candidate sources of what a TV plays, resolving one
// for the phone, and the owner's timing links.

import type { Context, Hono } from "hono";
import type { AppContext } from "../../context.ts";
import { HttpError } from "../../errors.ts";
import { companionLinkBody, companionResolveBody, isId, parseBody } from "../../validation.ts";
import type { Env } from "../middleware.ts";
import { requireDevice } from "../params.ts";

export function registerCompanion(app: Hono<Env>, ctx: AppContext): void {
  const { store, companion } = ctx;

  app.get("/api/v1/admin/devices/:id/companion", (c) => c.json(companion.candidates(requireDevice(store, c.req.param("id")))));

  app.post("/api/v1/admin/devices/:id/companion/resolve", async (c) => {
    const d = requireDevice(store, c.req.param("id"));
    const body = await parseBody(c, companionResolveBody);
    return c.json(await companion.resolve(d, body, c.req.raw.signal));
  });

  const linkParams = (c: Context) => {
    const episodeId = c.req.param("episodeId") ?? "";
    const sourceId = c.req.param("sourceId") ?? "";
    if (!isId(episodeId)) throw new HttpError(404, "unknown_episode");
    if (!isId(sourceId)) throw new HttpError(404, "unknown_source");
    return { episodeId, sourceId };
  };

  app.put("/api/v1/admin/companion/links/:episodeId/:sourceId", async (c) => {
    const { episodeId, sourceId } = linkParams(c);
    const body = await parseBody(c, companionLinkBody);
    return c.json({ link: companion.putLink(episodeId, sourceId, body) });
  });

  app.post("/api/v1/admin/companion/links/:episodeId/:sourceId/copy-to-item", (c) => {
    const { episodeId, sourceId } = linkParams(c);
    return c.json(companion.copyToItem(episodeId, sourceId));
  });
}
