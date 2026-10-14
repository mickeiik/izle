// What runs around every route: security headers and the access log, the API's cache and body limits, error
// answers, and the two token checks (device tokens on /tv, the admin token with its sign-in throttle on /admin).

import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { routePath } from "hono/route";
import { bearerToken, secretsEqual, sha256 } from "../auth.ts";
import { clientAddress, compileTrustedProxies } from "../clientip.ts";
import type { ServerConfig } from "../config.ts";
import type { AppContext } from "../context.ts";
import { HttpError } from "../errors.ts";
import { RateLimiter } from "../ratelimit.ts";
import type { Device } from "../store.ts";

/** The app's Hono environment: TV routes find the device their token belongs to in `c.get("device")`. */
export type Env = { Variables: { device: Device } };

/** Failed admin authentications allowed per client address and window before the address is locked out. */
export const ADMIN_AUTH_MAX_FAILURES = 10;
export const ADMIN_AUTH_WINDOW_MS = 10 * 60_000;
const API_BODY_LIMIT = 64 * 1024;

/** The address a request is counted under (pair/start, admin sign-ins): `X-Forwarded-For` only from trusted proxies. */
export function clientKeyFor(config: ServerConfig): (c: Context) => string {
  const trustedProxies = config.trustedProxies.length > 0 ? compileTrustedProxies(config.trustedProxies).list : null;
  return (c) => {
    let remote: string | undefined;
    try {
      remote = getConnInfo(c).remote.address;
    } catch {
      // not served from a Node socket (e.g. app.fetch in tests)
    }
    return clientAddress(remote, c.req.header("X-Forwarded-For"), trustedProxies);
  };
}

export function registerMiddleware(app: Hono<Env>, ctx: AppContext, clientKey: (c: Context) => string): void {
  const { store, log } = ctx;

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
    // Health checks and the proxy's steady stream of segment requests only show up at debug level.
    if (route === "/healthz" || (route.startsWith("/p/") && c.res.status < 400)) log.debug("request", fields);
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

  // Failed admin authentications are counted per client address (as for pair/start). Once an address has used up
  // its failures, every admin request from it answers 429 until the window ends, even with the right token, so the
  // lockout tells a guesser nothing. Successes are never counted.
  const adminFailures = new RateLimiter(ADMIN_AUTH_MAX_FAILURES, ADMIN_AUTH_WINDOW_MS, ctx.now);
  const adminAuth = createMiddleware<Env>(async (c, next) => {
    const client = clientKey(c);
    const locked = adminFailures.check(client);
    if (!locked.ok) {
      throw new HttpError(429, "too_many_attempts", "too many wrong admin tokens from this address; try again later", {}, { "Retry-After": String(locked.retryAfterSec) });
    }
    const token = bearerToken(c.req.header("Authorization"));
    if (!token || !secretsEqual(token, ctx.adminToken)) {
      adminFailures.hit(client);
      // Where the attempt came from and what it tried to reach; never the presented token.
      log.warn("admin auth failed", { client, route: routePath(c, -1), reason: token ? "wrong token" : "no token" });
      const after = adminFailures.check(client);
      if (!after.ok) log.warn("admin auth locked out", { client, failures: ADMIN_AUTH_MAX_FAILURES, retryAfterSec: after.retryAfterSec });
      throw new HttpError(401, "unauthorized", "missing or invalid admin token", {}, { "WWW-Authenticate": 'Bearer realm="izle-admin"' });
    }
    await next();
  });

  app.use("/api/v1/tv/*", tvAuth);
  app.use("/api/v1/admin/*", adminAuth);
}
