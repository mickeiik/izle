// `GET /admin/status`: every active TV in one call, with where the event log stands, read first, so that reading
// the status and then the events after `lastEventId` misses nothing.

import type { Hono } from "hono";
import type { AppContext } from "../../context.ts";
import { iso } from "../../presenters.ts";
import { VERSION } from "../../version.ts";
import type { Env } from "../middleware.ts";

export function status(ctx: AppContext) {
  const { store, catalog, devices, pairing, eventLog, events, viewings } = ctx;
  const lastEventId = eventLog.lastId();
  const { manifest } = catalog.current;
  return {
    serverNowMs: ctx.now(),
    server: { version: VERSION },
    catalog: { id: manifest.catalogId, buildId: manifest.buildId },
    pairing: { pending: pairing.listOpen().length },
    devices: store.listDevices().filter((d) => d.tokenHash !== null).map((d) => {
      // The "now" object while the TV has a running viewing; GET …/now itself keeps answering the last report.
      const n = store.getNowPlaying(d.id);
      const playing = n && viewings.running(d.id) ? devices.now(d, n).nowPlaying : null;
      return { id: d.id, name: d.name, online: events.isOnline(d.id), lastSeenAt: iso(d.lastSeenAt), nowPlaying: playing };
    }),
    lastEventId,
  };
}

export function registerAdminStatus(app: Hono<Env>, ctx: AppContext): void {
  app.get("/api/v1/admin/status", (c) => c.json(status(ctx)));
}
