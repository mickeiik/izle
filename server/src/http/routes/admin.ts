// The admin API: pairing approval, the TVs (list, page, settings, deletion, adopting a deleted TV's history, home
// list, "continue from", what each has watched and is playing, remote commands and their results, problem reports),
// the catalog (what is loaded and its builds, search, an item's details, the "test this episode" diagnostics, the
// reload), and "Listen along" (companion audio on the owner's phone: the candidate sources of what a TV plays,
// resolving one for the phone, the timing links).
import type { Context, Hono } from "hono";
import { buildJson, catalogInfo, catalogItemJson, reloadCatalog, searchHitJson } from "../../catalog-admin.ts";
import type { AppContext } from "../../context.ts";
import { diagnosePlayable } from "../../diagnostics.ts";
import { HttpError } from "../../errors.ts";
import { requireItem } from "../../lookup.ts";
import { PAIR_CODE } from "../../pairing.ts";
import { PROBLEM_LIST_DEFAULT, PROBLEM_LIST_MAX } from "../../problems.ts";
import { iso } from "../../presenters.ts";
import type { Device, Store } from "../../store.ts";
import { HOME_MAX_ITEMS, MAX_NOW_WAIT_MS } from "../../tv.ts";
import { adoptBody, approveBody, commandBody, companionLinkBody, companionResolveBody, cursorBody, devicePatchBody, diagnosticsBody, homeBody, intParam, intQuery, isId, limitQuery, parseBody, parseWait } from "../../validation.ts";
import type { Env } from "../middleware.ts";

/** The device a `/admin/devices/:id` route names; 404 `unknown_device` otherwise. */
export function requireDevice(store: Store, id: string): Device {
  const d = isId(id) ? store.getDevice(id) : null;
  if (!d) throw new HttpError(404, "unknown_device");
  return d;
}

export function registerAdmin(app: Hono<Env>, ctx: AppContext): void {
  const { store, tv, pairing, devices, catalog, companion } = ctx;

  app.post("/api/v1/admin/pair/approve", async (c) => {
    const body = await parseBody(c, approveBody);
    return c.json(pairing.approve(body.code, body.name, body.replaces));
  });

  app.get("/api/v1/admin/pair/pending", (c) =>
    c.json({ codes: pairing.listOpen().map((p) => ({ code: p.code, createdAt: iso(p.createdAt), expiresAt: iso(p.expiresAt), approved: p.approved })) }),
  );

  // Clears a code the owner's TV does not show; owner only (not in ROUTE_SCOPES: every non-GET route defaults to owner).
  app.delete("/api/v1/admin/pair/pending/:code", (c) => {
    const code = c.req.param("code");
    if (!PAIR_CODE.test(code) || !pairing.cancel(code, c.get("actor"))) throw new HttpError(404, "unknown_code", "no open pairing code with this value");
    return c.body(null, 204);
  });

  app.get("/api/v1/admin/devices", (c) => c.json({ devices: devices.list() }));

  app.get("/api/v1/admin/devices/:id", (c) => {
    const d = requireDevice(store, c.req.param("id"));
    return c.json({ device: devices.view(d), home: devices.home(d), homeMax: HOME_MAX_ITEMS });
  });

  app.patch("/api/v1/admin/devices/:id", async (c) => {
    const d = requireDevice(store, c.req.param("id"));
    const body = await parseBody(c, devicePatchBody);
    return c.json({ device: devices.view(devices.update(d, body, c.get("actor"))) });
  });

  app.delete("/api/v1/admin/devices/:id", (c) => {
    devices.remove(requireDevice(store, c.req.param("id")), c.get("actor"));
    return c.body(null, 204);
  });

  app.post("/api/v1/admin/devices/:id/history/adopt", async (c) => {
    const d = requireDevice(store, c.req.param("id"));
    const body = await parseBody(c, adoptBody);
    return c.json({ moved: devices.adoptHistory(d, body.fromDeviceId, c.get("actor")) });
  });

  app.put("/api/v1/admin/devices/:id/home", async (c) => {
    const d = requireDevice(store, c.req.param("id"));
    const body = await parseBody(c, homeBody);
    const version = tv.setHome(d.id, body.itemIds, c.get("actor"), body.expected);
    return c.json({ version, home: devices.home(d) });
  });

  app.put("/api/v1/admin/devices/:id/cursor", async (c) => {
    const d = requireDevice(store, c.req.param("id"));
    const body = await parseBody(c, cursorBody);
    return c.json({ version: tv.setCursor(d.id, body.itemId, body.episodeId, c.get("actor")) });
  });

  app.get("/api/v1/admin/devices/:id/progress", (c) => c.json(devices.progress(requireDevice(store, c.req.param("id")))));

  // `?seq=<n>&wait=<s>` long-polls until the row changes (the phone's "Listen along" follows the TV with it).
  app.get("/api/v1/admin/devices/:id/now", async (c) => {
    const d = requireDevice(store, c.req.param("id"));
    const seq = intQuery(c.req.query("seq"), "seq", 0) ?? null;
    const waitSec = parseWait(c.req.query("wait"), 0, MAX_NOW_WAIT_MS / 1000);
    const n = await tv.waitNow(d.id, seq, waitSec * 1000, c.req.raw.signal);
    return c.json(devices.now(d, n));
  });

  app.post("/api/v1/admin/devices/:id/commands", async (c) => {
    const d = requireDevice(store, c.req.param("id"));
    const body = await parseBody(c, commandBody);
    const { command, online } = ctx.commands.send(d.id, body, c.get("actor"));
    return c.json({ id: command.id, online }, 202);
  });

  // A command while it is stored (7 days): when the TV acknowledged it, and what it made of it.
  app.get("/api/v1/admin/devices/:id/commands/:commandId", (c) => {
    const d = requireDevice(store, c.req.param("id"));
    const id = intParam(c.req.param("commandId"), "unknown_command");
    const cmd = store.getCommand(d.id, id);
    if (!cmd) throw new HttpError(404, "unknown_command");
    const { type, payload, actor, result, reason } = cmd;
    return c.json({ command: { id, type, payload, actor, createdAt: iso(cmd.createdAt), deliveredAt: iso(cmd.ackedAt), result, reason, resultAt: iso(cmd.resultAt) } });
  });

  app.get("/api/v1/admin/devices/:id/problems", (c) => {
    const d = requireDevice(store, c.req.param("id"));
    return c.json({ problems: ctx.problems.list(d.id, limitQuery(c.req.query("limit"), PROBLEM_LIST_DEFAULT, PROBLEM_LIST_MAX)) });
  });

  app.delete("/api/v1/admin/devices/:id/problems", (c) => {
    ctx.problems.clear(requireDevice(store, c.req.param("id")).id);
    return c.body(null, 204);
  });

  app.get("/api/v1/admin/catalog", (c) => c.json(catalogInfo(ctx)));

  app.get("/api/v1/admin/catalog/search", (c) => {
    const q = (c.req.query("q") ?? "").slice(0, 200);
    return c.json({ items: catalog.search(q, limitQuery(c.req.query("limit"), 50, 200)).map((item) => searchHitJson(catalog, item)) });
  });

  app.get("/api/v1/admin/catalog/builds/:buildId", (c) => {
    const found = store.getCatalogBuild(catalog.catalogId, c.req.param("buildId"));
    if (!found) throw new HttpError(404, "unknown_build");
    return c.json({ build: buildJson(found.build), changes: found.changes });
  });

  app.get("/api/v1/admin/catalog/items/:id", (c) => {
    const id = c.req.param("id");
    if (!isId(id)) throw new HttpError(404, "unknown_item");
    return c.json({ item: catalogItemJson(catalog, requireItem(catalog, id, 404, "unknown_item")) });
  });

  app.post("/api/v1/admin/diagnostics/resolve", async (c) => {
    const body = await parseBody(c, diagnosticsBody);
    return c.json(await diagnosePlayable(ctx, body, c.req.raw.signal));
  });

  app.post("/api/v1/admin/catalog/reload", async (c) => {
    const r = await reloadCatalog(ctx, c.get("actor"));
    if (!r.ok) {
      return c.json({ error: "invalid_catalog", issues: r.issues.map((i) => ({ severity: i.severity, file: i.file, path: i.path, message: i.message })) }, 422);
    }
    return c.json({ catalog: catalogInfo(ctx) });
  });

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
