import { Hono } from "hono";
import type { AppContext } from "./context.ts";
import { clientKeyFor, registerMiddleware, type Env } from "./http/middleware.ts";
import { registerAdminCatalog } from "./http/routes/admin-catalog.ts";
import { registerAdminCommands, registerAdminDevices } from "./http/routes/admin-devices.ts";
import { registerCompanion } from "./http/routes/companion.ts";
import { registerEvents } from "./http/routes/events.ts";
import { registerPairing } from "./http/routes/pairing.ts";
import { registerProxy } from "./http/routes/proxy.ts";
import { registerTv } from "./http/routes/tv.ts";
import { registerStatic } from "./http/static.ts";

/**
 * The HTTP app: one Hono instance, with every area's routes registered on it in a fixed order (middleware first).
 * Access logs name the route template, so routes are never mounted as sub-apps.
 */
export function createApp(ctx: AppContext): Hono<Env> {
  const app = new Hono<Env>();
  const clientKey = clientKeyFor(ctx.config);
  registerMiddleware(app, ctx, clientKey);
  registerStatic(app, ctx);
  registerProxy(app, ctx);
  registerPairing(app, ctx, clientKey);
  registerTv(app, ctx);
  registerEvents(app, ctx);
  registerAdminDevices(app, ctx);
  registerCompanion(app, ctx);
  registerAdminCommands(app, ctx);
  registerAdminCatalog(app, ctx);
  return app;
}
