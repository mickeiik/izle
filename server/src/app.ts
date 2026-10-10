import { readFile } from "node:fs/promises";
import path from "node:path";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { routePath } from "hono/route";
import { streamSSE } from "hono/streaming";
import { bearerToken, secretsEqual, sha256 } from "./auth.ts";
import { HttpError } from "./errors.ts";
import { MAX_PAIR_WAIT_MS, type PairingService } from "./pairing.ts";
import type { Device } from "./store.ts";
import { HOME_MAX_ITEMS, type Services, type TvService } from "./tv.ts";
import { approveBody, commandBody, cursorBody, devicePatchBody, homeBody, isId, parseBody, progressBody, resolveBody } from "./validation.ts";

export interface AppContext extends Services {
  tv: TvService;
  pairing: PairingService;
  adminToken: string;
  /** SSE keep-alive comment interval. */
  pingMs: number;
  /** Directory of the static admin UI. */
  adminUiDir: string;
}

/** Unacknowledged commands younger than this are replayed when a TV (re)connects to the event stream. */
export const COMMAND_REPLAY_MS = 2 * 60_000;
const API_BODY_LIMIT = 64 * 1024;

type Env = { Variables: { device: Device } };

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

const CONTENT_TYPES: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

export function createApp(ctx: AppContext): Hono<Env> {
  const app = new Hono<Env>();
  const { store, catalog, tv, pairing, events, log } = ctx;

  // --- cross-cutting -------------------------------------------------------------------------------------------

  app.use("*", async (c, next) => {
    const started = performance.now();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
    await next();
    // Route templates only: raw paths can carry tokens.
    const route = c.res.status === 404 && routePath(c, -1) === "*" ? "<unmatched>" : routePath(c, -1);
    const fields = {
      method: c.req.method,
      route,
      status: c.res.status,
      ms: Math.round(performance.now() - started),
      deviceId: c.get("device")?.id,
    };
    if (route === "/healthz") log.debug("request", fields);
    else log.info("request", fields);
  });

  app.use("/api/*", async (c, next) => {
    await next();
    if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
  });
  app.use(
    "/api/*",
    bodyLimit({ maxSize: API_BODY_LIMIT, onError: (c) => c.json({ error: "body_too_large" }, 413) }),
  );

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      for (const [k, v] of Object.entries(err.headers)) c.header(k, v);
      const body: Record<string, unknown> = { error: err.code, ...err.extra };
      if (err.message !== err.code) body.message = err.message;
      return c.json(body, err.status);
    }
    if (err instanceof HTTPException) return err.getResponse();
    log.error("unhandled error", { route: routePath(c, -1), error: err });
    return c.json({ error: "internal" }, 500);
  });
  app.notFound((c) => c.json({ error: "not_found" }, 404));

  const tvAuth = createMiddleware<Env>(async (c, next) => {
    const token = bearerToken(c.req.header("Authorization"));
    const device = token ? store.getDeviceByTokenHash(sha256(token)) : null;
    if (!device) throw new HttpError(401, "unauthorized", "missing or invalid device token", {}, { "WWW-Authenticate": 'Bearer realm="izle"' });
    const t = ctx.now();
    if (device.lastSeenAt === null || t - device.lastSeenAt > 60_000) store.touchDevice(device.id, t);
    c.set("device", device);
    await next();
  });

  const adminAuth = createMiddleware<Env>(async (c, next) => {
    const token = bearerToken(c.req.header("Authorization"));
    if (!token || !secretsEqual(token, ctx.adminToken)) {
      throw new HttpError(401, "unauthorized", "missing or invalid admin token", {}, { "WWW-Authenticate": 'Bearer realm="izle-admin"' });
    }
    await next();
  });

  app.use("/api/v1/tv/*", tvAuth);
  app.use("/api/v1/admin/*", adminAuth);

  // --- health, static ------------------------------------------------------------------------------------------

  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/", (c) => c.redirect("/admin/"));

  app.get("/assets/:file", async (c) => {
    const file = c.req.param("file");
    const abs = catalog.assetPath(file);
    if (!abs) throw new HttpError(404, "not_found");
    let bytes: Buffer;
    try {
      bytes = await readFile(abs);
    } catch {
      throw new HttpError(404, "not_found");
    }
    const ext = file.slice(file.lastIndexOf(".") + 1);
    return c.body(new Uint8Array(bytes), 200, {
      "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
      ETag: `"${file.slice(0, 64)}"`,
    });
  });

  const adminIndex = async (c: Context) => {
    const html = await readFile(path.join(ctx.adminUiDir, "index.html"), "utf8");
    c.header("Cache-Control", "no-cache");
    return c.html(html);
  };
  app.get("/admin", (c) => c.redirect("/admin/"));
  app.get("/admin/", adminIndex);

  // --- pairing (unauthenticated TV side) -----------------------------------------------------------------------

  const clientKey = (c: Context): string => {
    try {
      return getConnInfo(c).remote.address ?? "unknown";
    } catch {
      return "unknown";
    }
  };

  app.post("/api/v1/pair/start", (c) => {
    const r = pairing.start(clientKey(c));
    return c.json({ code: r.code, pairToken: r.pairToken, expiresAt: iso(r.expiresAt) });
  });

  app.get("/api/v1/pair/wait", async (c) => {
    const code = c.req.query("code") ?? "";
    if (!/^[0-9]{6}$/.test(code)) throw new HttpError(400, "invalid_request", "code must be 6 digits");
    const pairToken = bearerToken(c.req.header("Authorization"));
    if (!pairToken) throw new HttpError(401, "unauthorized", "the pair token is required", {}, { "WWW-Authenticate": 'Bearer realm="izle-pair"' });
    const waitParam = c.req.query("wait");
    const waitSec = waitParam === undefined ? MAX_PAIR_WAIT_MS / 1000 : Number(waitParam);
    if (!Number.isInteger(waitSec) || waitSec < 0 || waitSec > MAX_PAIR_WAIT_MS / 1000) {
      throw new HttpError(400, "invalid_request", `wait must be an integer between 0 and ${MAX_PAIR_WAIT_MS / 1000}`);
    }
    const r = await pairing.wait(code, pairToken, waitSec * 1000, c.req.raw.signal);
    return c.json(r);
  });

  // --- TV ------------------------------------------------------------------------------------------------------

  app.get("/api/v1/tv/state", (c) => c.json(tv.state(c.get("device"))));

  app.get("/api/v1/tv/items/:itemId", (c) => {
    const itemId = c.req.param("itemId");
    if (!isId(itemId)) throw new HttpError(404, "unknown_item");
    return c.json(tv.item(c.get("device"), itemId));
  });

  app.post("/api/v1/tv/resolve", async (c) => {
    const body = await parseBody(c, resolveBody);
    return c.json(await tv.resolve(c.get("device"), body));
  });

  app.post("/api/v1/tv/progress", async (c) => {
    const body = await parseBody(c, progressBody);
    const r = tv.recordProgress(c.get("device"), { ...body, durationMs: body.durationMs ?? null });
    return c.json({ ok: true, version: r.version });
  });

  app.post("/api/v1/tv/commands/:id/ack", (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isSafeInteger(id) || id <= 0 || !store.ackCommand(c.get("device").id, id, ctx.now())) {
      throw new HttpError(404, "unknown_command");
    }
    return c.json({ ok: true });
  });

  app.get("/api/v1/tv/events", (c) => {
    const device = c.get("device");
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      let ping: ReturnType<typeof setInterval> | undefined;
      const closed = new Promise<void>((resolve) => stream.onAbort(resolve));
      const write = (event: string, data: unknown, id?: string) =>
        stream.writeSSE({ event, data: JSON.stringify(data), ...(id ? { id } : {}) }).catch(() => stream.abort());
      const unsubscribe = events.subscribe(device.id, {
        send: (ev) => void write(ev.type, ev.data, ev.type === "state" ? `s${ev.data.version}` : `c${ev.data.id}`),
        close: () => stream.abort(),
      });
      try {
        const current = store.getDevice(device.id);
        const version = current?.stateVersion ?? device.stateVersion;
        await stream.writeSSE({ event: "state", data: JSON.stringify({ version }), id: `s${version}`, retry: 5000 });
        for (const cmd of store.pendingCommands(device.id, ctx.now() - COMMAND_REPLAY_MS)) {
          await write("command", { id: cmd.id, type: cmd.type, payload: cmd.payload }, `c${cmd.id}`);
        }
        ping = setInterval(() => void stream.write(": ping\n\n").catch(() => stream.abort()), ctx.pingMs);
        await closed;
      } finally {
        clearInterval(ping);
        unsubscribe();
      }
    });
  });

  // --- admin ---------------------------------------------------------------------------------------------------

  const requireDevice = (id: string): Device => {
    const d = isId(id) ? store.getDevice(id) : null;
    if (!d) throw new HttpError(404, "unknown_device");
    return d;
  };

  const deviceJson = (d: Device) => ({
    id: d.id,
    name: d.name,
    status: d.tokenHash ? "active" : "pending",
    online: events.isOnline(d.id),
    createdAt: iso(d.createdAt),
    lastSeenAt: iso(d.lastSeenAt),
    stateVersion: d.stateVersion,
    settings: { uiLanguage: d.uiLanguage, preferredAudioLanguage: d.preferredAudioLanguage, subtitlesLanguage: d.subtitlesLanguage },
    effective: tv.settings(d),
  });

  const homeJson = (d: Device) =>
    store.getHome(d.id, catalog.catalogId).map((itemId) => {
      const item = catalog.item(itemId);
      return {
        itemId,
        title: item?.title ?? null,
        missing: !item,
        continue: item ? tv.continueFor(d.id, item) : null,
      };
    });

  app.post("/api/v1/admin/pair/approve", async (c) => {
    const body = await parseBody(c, approveBody);
    return c.json(pairing.approve(body.code, body.name.trim()));
  });

  app.get("/api/v1/admin/pair/pending", (c) =>
    c.json({ codes: pairing.listOpen().map((p) => ({ code: p.code, createdAt: iso(p.createdAt), expiresAt: iso(p.expiresAt), approved: p.approved })) }),
  );

  app.get("/api/v1/admin/devices", (c) =>
    c.json({ devices: store.listDevices().map((d) => ({ ...deviceJson(d), homeCount: store.getHome(d.id, catalog.catalogId).length })) }),
  );

  app.get("/api/v1/admin/devices/:id", (c) => {
    const d = requireDevice(c.req.param("id"));
    return c.json({ device: deviceJson(d), home: homeJson(d), homeMax: HOME_MAX_ITEMS });
  });

  app.patch("/api/v1/admin/devices/:id", async (c) => {
    const d = requireDevice(c.req.param("id"));
    const body = await parseBody(c, devicePatchBody);
    const updated = store.updateDevice(d.id, { ...body, ...(body.name !== undefined ? { name: body.name.trim() } : {}) })!;
    tv.notify(d.id, updated.stateVersion);
    return c.json({ device: deviceJson(updated) });
  });

  app.delete("/api/v1/admin/devices/:id", (c) => {
    const d = requireDevice(c.req.param("id"));
    store.deleteDevice(d.id);
    events.closeDevice(d.id);
    log.info("device deleted", { deviceId: d.id });
    return c.body(null, 204);
  });

  app.put("/api/v1/admin/devices/:id/home", async (c) => {
    const d = requireDevice(c.req.param("id"));
    const body = await parseBody(c, homeBody);
    const version = tv.setHome(d.id, body.itemIds);
    return c.json({ version, home: homeJson(store.getDevice(d.id)!) });
  });

  app.put("/api/v1/admin/devices/:id/cursor", async (c) => {
    const d = requireDevice(c.req.param("id"));
    const body = await parseBody(c, cursorBody);
    return c.json({ version: tv.setCursor(d.id, body.itemId, body.episodeId) });
  });

  app.get("/api/v1/admin/devices/:id/progress", (c) => {
    const d = requireDevice(c.req.param("id"));
    const catalogId = catalog.catalogId;
    const titleOf = (episodeId: string) => {
      const ref = catalog.episode(episodeId);
      return ref ? { itemTitle: ref.item.title, season: ref.episode.season ?? null, number: ref.episode.number ?? null, episodeTitle: ref.episode.title ?? null } : { missing: true };
    };
    return c.json({
      cursors: store.listCursors(d.id, catalogId).map((cur) => ({ itemId: cur.itemId, episodeId: cur.episodeId, updatedAt: iso(cur.updatedAt), ...titleOf(cur.episodeId) })),
      progress: store.listProgress(d.id, catalogId).map((p) => ({
        itemId: p.itemId,
        episodeId: p.episodeId,
        positionMs: p.positionMs,
        durationMs: p.durationMs,
        status: p.status,
        updatedAt: iso(p.updatedAt),
        ...titleOf(p.episodeId),
      })),
    });
  });

  app.get("/api/v1/admin/devices/:id/now", (c) => {
    const d = requireDevice(c.req.param("id"));
    const n = store.getNowPlaying(d.id);
    const ref = n ? catalog.episode(n.episodeId) : undefined;
    return c.json({
      online: events.isOnline(d.id),
      nowPlaying: n
        ? {
            itemId: n.itemId,
            episodeId: n.episodeId,
            sourceId: n.sourceId,
            itemTitle: ref?.item.title ?? null,
            episodeTitle: ref?.episode.title ?? null,
            positionMs: n.positionMs,
            durationMs: n.durationMs,
            state: n.state,
            updatedAt: iso(n.updatedAt),
          }
        : null,
    });
  });

  app.post("/api/v1/admin/devices/:id/commands", async (c) => {
    const d = requireDevice(c.req.param("id"));
    const body = await parseBody(c, commandBody);
    let payload: Record<string, unknown> = {};
    if (body.type === "play") {
      const ref = catalog.episode(body.episodeId);
      if (!ref) throw new HttpError(400, "unknown_episode");
      if (!ref.episode.playbackAllowed) throw new HttpError(400, "not_allowed", "playback of this episode is not allowed");
      payload = { itemId: ref.item.id, episodeId: ref.episode.id };
    }
    const cmd = store.insertCommand(d.id, body.type, payload, ctx.now());
    events.publish(d.id, { type: "command", data: { id: cmd.id, type: cmd.type, payload: cmd.payload } });
    log.info("command queued", { deviceId: d.id, type: cmd.type, commandId: cmd.id });
    return c.json({ id: cmd.id, online: events.isOnline(d.id) }, 202);
  });

  const catalogInfo = () => {
    const cur = catalog.current;
    return {
      id: cur.manifest.catalogId,
      buildId: cur.manifest.buildId,
      builtAt: cur.manifest.builtAt,
      name: cur.manifest.name,
      loadedAt: iso(cur.loadedAt),
      stats: cur.stats,
      adapters: cur.manifest.adapters,
      warnings: cur.warnings.map((w) => ({ file: w.file, path: w.path, message: w.message })),
    };
  };

  app.get("/api/v1/admin/catalog", (c) => c.json(catalogInfo()));

  app.get("/api/v1/admin/catalog/search", (c) => {
    const q = (c.req.query("q") ?? "").slice(0, 200);
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200);
    return c.json({
      items: catalog.search(q, limit).map((item) => ({
        ...tv.itemCard(item),
        episodeCount: item.episodes.length,
        playableCount: item.episodes.filter((e) => e.playbackAllowed).length,
      })),
    });
  });

  app.get("/api/v1/admin/catalog/items/:id", (c) => {
    const id = c.req.param("id");
    const item = isId(id) ? catalog.item(id) : undefined;
    if (!item) throw new HttpError(404, "unknown_item");
    return c.json({
      item: {
        ...tv.itemCard(item),
        originalTitle: item.originalTitle ?? null,
        synopsis: item.synopsis ?? null,
        genres: item.genres ?? [],
        autoAdvance: item.autoAdvance ?? true,
        episodes: item.episodes.map((e, index) => ({
          id: e.id,
          index,
          season: e.season ?? null,
          number: e.number ?? null,
          title: e.title ?? null,
          label: e.label ?? null,
          durationMs: e.durationMs ?? null,
          playbackAllowed: e.playbackAllowed,
          autoAdvance: e.autoAdvance ?? null,
          // Upstream URLs, headers and adapter refs are deliberately not exposed.
          sources: e.sources.map((s) => ({
            id: s.id,
            type: s.type,
            label: s.label ?? null,
            languages: s.languages,
            ...(s.type === "direct" ? { kind: s.media.kind, needsProxy: Boolean(s.media.headers && Object.keys(s.media.headers).length) } : { adapter: s.adapter }),
          })),
        })),
      },
    });
  });

  app.post("/api/v1/admin/catalog/reload", async (c) => {
    const r = await catalog.reload();
    if (!r.ok) {
      return c.json({ error: "invalid_catalog", issues: r.issues.map((i) => ({ severity: i.severity, file: i.file, path: i.path, message: i.message })) }, 422);
    }
    for (const { id, stateVersion } of store.bumpAllStateVersions()) tv.notify(id, stateVersion);
    return c.json({ catalog: catalogInfo() });
  });

  return app;
}
