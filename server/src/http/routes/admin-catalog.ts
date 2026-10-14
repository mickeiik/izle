// The admin API for the catalog: what is loaded and its builds, search, an item's details, the "test this
// episode" diagnostics, and the reload.

import type { Hono } from "hono";
import { buildJson, catalogInfo, catalogItemJson, reloadCatalog, searchHitJson } from "../../catalog-admin.ts";
import type { AppContext } from "../../context.ts";
import { diagnoseEpisode } from "../../diagnostics.ts";
import { HttpError } from "../../errors.ts";
import { diagnosticsBody, isId, parseBody } from "../../validation.ts";
import type { Env } from "../middleware.ts";

export function registerAdminCatalog(app: Hono<Env>, ctx: AppContext): void {
  const { store, catalog } = ctx;

  app.get("/api/v1/admin/catalog", (c) => c.json(catalogInfo(ctx)));

  app.get("/api/v1/admin/catalog/search", (c) => {
    const q = (c.req.query("q") ?? "").slice(0, 200);
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200);
    return c.json({ items: catalog.search(q, limit).map((item) => searchHitJson(catalog, item)) });
  });

  app.get("/api/v1/admin/catalog/builds/:buildId", (c) => {
    const found = store.getCatalogBuild(catalog.catalogId, c.req.param("buildId"));
    if (!found) throw new HttpError(404, "unknown_build");
    return c.json({ build: buildJson(found.build), changes: found.changes });
  });

  app.get("/api/v1/admin/catalog/items/:id", (c) => {
    const id = c.req.param("id");
    const item = isId(id) ? catalog.item(id) : undefined;
    if (!item) throw new HttpError(404, "unknown_item");
    return c.json({ item: catalogItemJson(catalog, item) });
  });

  app.post("/api/v1/admin/diagnostics/resolve", async (c) => {
    const body = await parseBody(c, diagnosticsBody);
    return c.json(await diagnoseEpisode({ catalog, resolver: ctx.resolver }, body, c.req.raw.signal));
  });

  app.post("/api/v1/admin/catalog/reload", async (c) => {
    const r = await reloadCatalog(ctx);
    if (!r.ok) {
      return c.json({ error: "invalid_catalog", issues: r.issues.map((i) => ({ severity: i.severity, file: i.file, path: i.path, message: i.message })) }, 422);
    }
    return c.json({ catalog: catalogInfo(ctx) });
  });
}
