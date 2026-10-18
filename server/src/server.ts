import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { SERVER, tvActor } from "./actor.ts";
import { AppUpdateService, FIRST_CHECK_DELAY_MS } from "./app-updates.ts";
import { loadAdminToken } from "./auth.ts";
import { CatalogService } from "./catalog.ts";
import { limiterKey } from "./clientip.ts";
import { CommandService } from "./commands.ts";
import { CompanionService } from "./companion.ts";
import { databaseFile, DEFAULT_RESOLVE_BUDGET_MS, DEFAULT_RESOLVE_DEADLINE_MS, localServerUrl, type ServerConfig } from "./config.ts";
import type { AppContext } from "./context.ts";
import { DeviceService } from "./devices.ts";
import { EventLog } from "./eventlog.ts";
import { EventHub, Notifier } from "./events.ts";
import { CatalogHistory } from "./history.ts";
import { clientKeyFor, registerMiddleware, type Env } from "./http/middleware.ts";
import { registerAdmin } from "./http/routes/admin.ts";
import { registerAdminApp } from "./http/routes/admin-app.ts";
import { registerAdminEvents } from "./http/routes/admin-events.ts";
import { registerAdminHistory } from "./http/routes/admin-history.ts";
import { registerAdminHome } from "./http/routes/admin-home.ts";
import { registerAdminStatus } from "./http/routes/admin-status.ts";
import { registerAdminTokens } from "./http/routes/admin-tokens.ts";
import { registerTv } from "./http/routes/tv.ts";
import { registerStatic } from "./http/static.ts";
import { createLogger, type Logger } from "./log.ts";
import { PairingService, type PairingOptions } from "./pairing.ts";
import { ProblemService } from "./problems.ts";
import { ProxyService } from "./proxy.ts";
import { PlaybackSessions, ResolveService } from "./resolve.ts";
import { loadResolver } from "./resolver.ts";
import { Store } from "./store.ts";
import { TokenService } from "./tokens.ts";
import { TvService } from "./tv.ts";
import { VERSION } from "./version.ts";
import { ViewingService, VIEWING_SWEEP_MS } from "./viewings.ts";

interface StartOptions {
  config: ServerConfig;
  log?: Logger;
  /** Clock override (tests). */
  now?: () => number;
  /** SSE ping interval (default 20 s). */
  pingMs?: number;
  /** How long a TV stays online after its last event stream closed (default 60 s; tests shorten it). */
  offlineGraceMs?: number;
  pairing?: PairingOptions;
  /** Upstream fetch of the media proxy, the diagnostics probe and the TV app check (default: the global fetch). */
  fetch?: typeof fetch;
  /** Where the TV app check finds GitHub's API (default `https://api.github.com`; tests serve a fake). */
  githubApiBase?: string;
  /** TV app updates (tests): the APK size cap, the check's timeouts, and the delay of the first check (60 s). */
  appUpdates?: { maxBytes?: number; timeouts?: { apiMs?: number; downloadMs?: number }; firstCheckDelayMs?: number };
}

interface RunningServer {
  url: string;
  ctx: AppContext;
  close(): Promise<void>;
}

/** Loads everything, starts listening, and returns a handle. Throws (nothing listening) when startup fails. */
export async function startServer(opts: StartOptions): Promise<RunningServer> {
  const { config } = opts;
  const log = opts.log ?? createLogger({ level: config.log.level });
  const now = opts.now ?? Date.now;
  const fetchUpstream = opts.fetch ?? globalThis.fetch;

  const { token: adminToken, source } = loadAdminToken(config, log);
  // The resolver module comes from a local path in the config; nothing is ever downloaded.
  const resolverModule = config.resolver
    ? await loadResolver({ module: config.resolver.module, config: config.resolver.config, dataDir: config.dataDir, log })
    : null;
  // The store comes first so that the catalog history records the first load too (it is the baseline).
  const store = new Store(databaseFile(config));
  const history = new CatalogHistory(store, log);
  const catalog = new CatalogService(config.catalog.dir, log, now, resolverModule ? new Set(resolverModule.adapters.keys()) : null, {
    onLoaded: (next, previous) => void history.record(next, previous),
  });
  try {
    await catalog.load();
  } catch (err) {
    store.close();
    throw err;
  }
  const events = new EventHub(opts.offlineGraceMs);
  const eventLog = new EventLog(store, log, now, config.events.retentionDays);
  const viewings = new ViewingService({ store, catalog, eventLog, events, log, now });
  events.onOnline = (deviceId, online) => {
    viewings.onOnline(deviceId, online);
    eventLog.append(online ? "device.online" : "device.offline", deviceId, tvActor(deviceId), {});
  };
  const appUpdates = new AppUpdateService({
    store, eventLog, events, log, now, config, fetch: fetchUpstream, githubApiBase: opts.githubApiBase,
    maxBytes: opts.appUpdates?.maxBytes, timeouts: opts.appUpdates?.timeouts,
  });
  appUpdates.reconcile();
  const sessions = new PlaybackSessions(now);
  const problems = new ProblemService({ store, catalog, log, now, sessions, eventLog });
  const { sessionTtlSec, alignTsSegments, always: proxyAlways } = config.proxy;
  const proxy = new ProxyService({ log, now, ttlMs: sessionTtlSec * 1000, alignTsSegments, fetch: fetchUpstream, onProblem: (p) => problems.recordProxy(p) });
  const resolver = new ResolveService({
    catalog, log, now, proxy, sessions, adapters: resolverModule?.adapters ?? null, proxyAlways,
    deadlineMs: config.resolver?.deadlineMs ?? DEFAULT_RESOLVE_DEADLINE_MS,
    budgetMs: config.resolver?.budgetMs ?? DEFAULT_RESOLVE_BUDGET_MS,
  });
  const services = { config, store, catalog, events, notifier: new Notifier(store, events), eventLog, resolver, sessions, problems, viewings, appUpdates, log, now };
  const tv = new TvService(services);
  const ctx: AppContext = {
    ...services, tv, companion: new CompanionService(services), pairing: new PairingService({ ...services, proxy }, opts.pairing), proxy,
    devices: new DeviceService({ ...services, tv, proxy }), commands: new CommandService({ ...services, tv }), tokens: new TokenService(store, log, now),
    resolverModule, adminToken, pingMs: opts.pingMs ?? 20_000, fetch: fetchUpstream, adminUiDir: fileURLToPath(new URL("../admin", import.meta.url)),
  };

  // One app with every area's routes, middleware first: access logs name the route template, so no sub-apps.
  const app = new Hono<Env>();
  const clientKey = clientKeyFor(config);
  registerMiddleware(app, ctx, clientKey);
  registerStatic(app, ctx);
  // pair/start's rate limit counts an IPv6 client by its /64.
  registerTv(app, ctx, (c) => limiterKey(clientKey(c)));
  registerAdmin(app, ctx);
  registerAdminTokens(app, ctx);
  registerAdminApp(app, ctx);
  registerAdminEvents(app, ctx, clientKey);
  registerAdminStatus(app, ctx);
  registerAdminHistory(app, ctx);
  registerAdminHome(app, ctx);

  let server: Server;
  try {
    server = await new Promise<Server>((resolve, reject) => {
      const s = serve({ fetch: app.fetch, port: config.listen.port, hostname: config.listen.host }) as Server;
      s.once("listening", () => resolve(s));
      s.once("error", reject);
    });
  } catch (err) {
    store.close();
    throw err;
  }
  const port = (server.address() as AddressInfo).port;
  log.info("listening", { version: VERSION, host: config.listen.host, port, adminAuth: source, catalogDir: catalog.dir, dataDir: config.dataDir });
  // Every TV is offline until it connects, and the streams of consumers have to be reopened.
  eventLog.append("server.started", null, SERVER, { version: VERSION });

  const housekeeping = setInterval(() => {
    ctx.pairing.purge();
    ctx.commands.purge();
    problems.purge();
    eventLog.purge();
  }, 10 * 60_000);
  housekeeping.unref();
  // Viewings whose TV fell silent or offline end as lost.
  const sweep = setInterval(() => viewings.sweep(), VIEWING_SWEEP_MS);
  sweep.unref();
  // With the GitHub source: the TV app's latest release, a minute after the start, then every checkIntervalHours.
  appUpdates.schedule(opts.appUpdates?.firstCheckDelayMs ?? FIRST_CHECK_DELAY_MS);

  let closing: Promise<void> | null = null;
  return {
    url: localServerUrl(config, port),
    ctx,
    close() {
      closing ??= (async () => {
        clearInterval(housekeeping);
        clearInterval(sweep);
        await appUpdates.stop();
        events.closeAll();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
        store.close();
        log.info("stopped");
      })();
      return closing;
    },
  };
}
