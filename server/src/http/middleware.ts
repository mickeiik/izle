// What runs around every route: security headers and the access log, the API's cache and body limits (the APK
// upload excepted), error answers, and the two token checks (device tokens on /tv, where the User-Agent reports the
// TV's app version; on /admin the owner token or an access token, with the sign-in throttle, and the scope each
// admin route needs).

import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { routePath } from "hono/route";
import { OWNER, type Actor } from "../actor.ts";
import { parseTvUserAgent } from "../app-updates.ts";
import { bearerToken, secretsEqual, sha256 } from "../auth.ts";
import { clientAddress, compileTrustedProxies } from "../clientip.ts";
import type { ServerConfig } from "../config.ts";
import type { AppContext } from "../context.ts";
import { sameApp } from "../devices.ts";
import { HttpError, tooManyRequests, unauthorized } from "../errors.ts";
import { RateLimiter } from "../ratelimit.ts";
import { stopwatch } from "../stopwatch.ts";
import type { Device } from "../store.ts";
import { ACCESS_TOKEN_PREFIX, type Scope } from "../tokens.ts";

/**
 * The app's Hono environment: TV routes find the device their token belongs to in `c.get("device")`, admin routes
 * who is calling in `c.get("actor")` (the owner, or an access token).
 */
export type Env = { Variables: { device: Device; actor: Actor } };

/** What a route needs: an access-token scope, or the owner token. */
type Required = Scope | "owner";

/** Scopes in order; each includes the ones before it, and the owner has them all. */
const LEVEL: Record<Required, number> = { read: 0, control: 1, manage: 2, owner: 3 };

/**
 * The scope each admin route needs, by method and route template. Every `GET` needs `read`, except the access
 * tokens; everything not listed here needs the owner token (pairing approval, deleting a TV, deleting and adopting
 * history, diagnostics, Listen along resolves and links, the access tokens).
 */
const ROUTE_SCOPES: ReadonlyArray<[method: string, route: string, required: Required]> = [
  ["GET", "/api/v1/admin/tokens", "owner"],
  ["POST", "/api/v1/admin/devices/:id/commands", "control"],
  ["PUT", "/api/v1/admin/devices/:id/home", "manage"],
  ["POST", "/api/v1/admin/devices/:id/home/items", "manage"],
  ["PATCH", "/api/v1/admin/devices/:id/home/items/:itemId", "manage"],
  ["DELETE", "/api/v1/admin/devices/:id/home/items/:itemId", "manage"],
  ["PUT", "/api/v1/admin/devices/:id/cursor", "manage"],
  ["PATCH", "/api/v1/admin/devices/:id", "manage"],
  ["POST", "/api/v1/admin/history/marks", "manage"],
  ["DELETE", "/api/v1/admin/devices/:id/problems", "manage"],
  ["POST", "/api/v1/admin/catalog/reload", "manage"],
  ["PUT", "/api/v1/admin/app/apk", "manage"],
  ["DELETE", "/api/v1/admin/app/apk", "manage"],
  ["POST", "/api/v1/admin/app/check", "manage"],
];

/** The scope a request to an admin route needs. */
export function requiredScope(method: string, route: string): Required {
  const listed = ROUTE_SCOPES.find(([m, r]) => m === method && r === route);
  if (listed) return listed[2];
  return method === "GET" ? "read" : "owner";
}

/** Failed admin authentications allowed per client address and window before the address is locked out. */
const ADMIN_AUTH_MAX_FAILURES = 10;
const ADMIN_AUTH_WINDOW_MS = 10 * 60_000;
const API_BODY_LIMIT = 64 * 1024;
/** The one route whose body may be larger than API_BODY_LIMIT: the APK upload, which streams and caps its own. */
const LARGE_BODY_ROUTE = "/api/v1/admin/app/apk";

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
    const ms = stopwatch();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
    await next();
    // Route templates only: raw paths can carry tokens.
    const route = c.res.status === 404 && routePath(c, -1) === "*" ? "<unmatched>" : routePath(c, -1);
    // A request made with an access token is logged with the token's id, never the secret (and under a key without
    // the word "token", which the redaction would drop).
    const actor = c.get("actor");
    const fields = { method: c.req.method, route, status: c.res.status, ms: ms(), deviceId: c.get("device")?.id, actorId: actor?.type === "token" ? actor.tokenId : undefined };
    // Health checks and the proxy's steady stream of segment requests only show up at debug level.
    if (route === "/healthz" || (route.startsWith("/p/") && c.res.status < 400)) log.debug("request", fields);
    else log.info("request", fields);
  });

  app.use("/api/*", async (c, next) => {
    await next();
    if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
  });
  const apiBodyLimit = bodyLimit({ maxSize: API_BODY_LIMIT, onError: (c) => c.json({ error: "body_too_large" }, 413) });
  app.use("/api/*", (c, next) => (c.req.method === "PUT" && routePath(c, -1) === LARGE_BODY_ROUTE ? next() : apiBodyLimit(c, next)));

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
    if (!device) throw unauthorized("izle", "missing or invalid device token");
    const t = ctx.now();
    if (device.lastSeenAt === null || t - device.lastSeenAt > 60_000) store.touchDevice(device.id, t);
    // The app version comes with every request, in the User-Agent; a change is recorded (anything else is ignored).
    const app = parseTvUserAgent(c.req.header("User-Agent"));
    c.set("device", app && !sameApp(device, app) ? ctx.devices.recordApp(device, app) : device);
    await next();
  });

  // Failed admin authentications are counted per client address (as for pair/start). Once an address has used up
  // its failures, every admin request from it answers 429 until the window ends, even with the right token, so the
  // lockout tells a guesser nothing. Successes are never counted, nor are requests without a token or a token that
  // lacks the route's scope.
  const adminFailures = new RateLimiter(ADMIN_AUTH_MAX_FAILURES, ADMIN_AUTH_WINDOW_MS, ctx.now);
  /** Who a bearer token is: the owner, or an access token with its scope; null for a wrong or revoked one. */
  const authenticate = (token: string): { actor: Actor; level: Required } | null => {
    // The prefix tells an access token from the owner token; a wrong or revoked one is a failure like any other.
    if (token.startsWith(ACCESS_TOKEN_PREFIX)) {
      const t = ctx.tokens.authenticate(token);
      return t ? { actor: { type: "token", tokenId: t.id, name: t.name }, level: t.scope } : null;
    }
    return secretsEqual(token, ctx.adminToken) ? { actor: OWNER, level: "owner" } : null;
  };
  const adminAuth = createMiddleware<Env>(async (c, next) => {
    const client = clientKey(c);
    const locked = adminFailures.check(client);
    if (!locked.ok) throw tooManyRequests("too_many_attempts", "too many wrong admin tokens from this address; try again later", locked.retryAfterSec);
    const token = bearerToken(c.req.header("Authorization"));
    // A request without a token is not a guess: it is answered 401 (which signs the admin page out) but not counted,
    // so tokenless requests from the owner's address (another site's page in their browser) cannot lock them out.
    if (!token) throw unauthorized("izle-admin", "missing or invalid admin token");
    const who = authenticate(token);
    if (!who) {
      adminFailures.hit(client);
      // Where the attempt came from and what it tried to reach; never the presented token.
      log.warn("admin auth failed", { client, route: routePath(c, -1), reason: "wrong token" });
      const after = adminFailures.check(client);
      if (!after.ok) log.warn("admin auth locked out", { client, failures: ADMIN_AUTH_MAX_FAILURES, retryAfterSec: after.retryAfterSec });
      throw unauthorized("izle-admin", "missing or invalid admin token");
    }
    c.set("actor", who.actor);
    // An unmatched path answers 404 to everyone; a matched route needs its scope.
    const route = routePath(c, -1);
    const required = route === "*" ? "read" : requiredScope(c.req.method, route);
    if (LEVEL[who.level] < LEVEL[required]) {
      throw new HttpError(403, "insufficient_scope", `this route needs the ${required === "owner" ? "owner token" : `${required} scope`}`, { required });
    }
    await next();
  });

  app.use("/api/v1/tv/*", tvAuth);
  app.use("/api/v1/admin/*", adminAuth);
}
