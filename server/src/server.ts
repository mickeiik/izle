import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadAdminToken } from "./auth.ts";
import { CatalogService } from "./catalog.ts";
import { CommandService } from "./commands.ts";
import { CompanionService } from "./companion.ts";
import { DEFAULT_RESOLVE_BUDGET_MS, DEFAULT_RESOLVE_DEADLINE_MS, localServerUrl, type ServerConfig } from "./config.ts";
import type { AppContext } from "./context.ts";
import { DeviceService } from "./devices.ts";
import { EventHub } from "./events.ts";
import { CatalogHistory } from "./history.ts";
import { createLogger, type Logger } from "./log.ts";
import { PairingService, type PairingOptions } from "./pairing.ts";
import { ProblemService } from "./problems.ts";
import { ProxyService } from "./proxy.ts";
import { PlaybackSessions, ResolveService } from "./resolve.ts";
import { Notifier } from "./notifier.ts";
import { loadResolver, type LoadedResolver } from "./resolver.ts";
import { Store } from "./store.ts";
import { TvService } from "./tv.ts";
import { VERSION } from "./version.ts";

const ADMIN_UI_DIR = fileURLToPath(new URL("../admin", import.meta.url));

export interface StartOptions {
  config: ServerConfig;
  log?: Logger;
  /** Clock override (tests). */
  now?: () => number;
  /** SSE ping interval (default 20 s). */
  pingMs?: number;
  pairing?: PairingOptions;
  /** Upstream fetch of the media proxy and the diagnostics probe (default: the global fetch). */
  fetch?: typeof fetch;
}

export interface RunningServer {
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
  const resolverModule: LoadedResolver | null = config.resolver
    ? await loadResolver({ module: config.resolver.module, config: config.resolver.config, dataDir: config.dataDir, log })
    : null;
  // The store comes first so that the catalog history records the first load too (it is the baseline).
  const store = new Store(path.join(config.dataDir, "izle.db"));
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
  const events = new EventHub();
  // Resolve opens playback sessions; problem reports name the episode and source of a TV's session.
  const sessions = new PlaybackSessions(now);
  const problems = new ProblemService({ store, catalog, log, now, session: (id) => sessions.get(id) });
  const proxy = new ProxyService({
    log,
    now,
    ttlMs: config.proxy.sessionTtlSec * 1000,
    alignTsSegments: config.proxy.alignTsSegments,
    fetch: fetchUpstream,
    onProblem: (p) => problems.recordProxy(p),
  });
  const resolver = new ResolveService({
    catalog,
    log,
    now,
    proxy,
    sessions,
    adapters: resolverModule?.adapters ?? null,
    proxyAlways: config.proxy.always,
    deadlineMs: config.resolver?.deadlineMs ?? DEFAULT_RESOLVE_DEADLINE_MS,
    budgetMs: config.resolver?.budgetMs ?? DEFAULT_RESOLVE_BUDGET_MS,
  });
  const services = { config, store, catalog, events, notifier: new Notifier(store, events), resolver, problems, log, now };
  const tv = new TvService(services);
  const ctx: AppContext = {
    ...services,
    tv,
    companion: new CompanionService(services),
    pairing: new PairingService(store, log, now, opts.pairing),
    proxy,
    devices: new DeviceService({ ...services, tv, proxy }),
    commands: new CommandService(services),
    resolverModule,
    adminToken,
    pingMs: opts.pingMs ?? 20_000,
    fetch: fetchUpstream,
    adminUiDir: ADMIN_UI_DIR,
  };
  const app = createApp(ctx);

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
  const url = localServerUrl(config, port);
  log.info("listening", { version: VERSION, host: config.listen.host, port, adminAuth: source, catalogDir: catalog.dir, dataDir: config.dataDir });

  const housekeeping = setInterval(() => {
    const t = now();
    store.purgePairCodes(t, 60 * 60_000);
    store.purgeCommands(t - 7 * 24 * 60 * 60_000);
    problems.purge();
  }, 10 * 60_000);
  housekeeping.unref();

  let closing: Promise<void> | null = null;
  return {
    url,
    ctx,
    close() {
      closing ??= (async () => {
        clearInterval(housekeeping);
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
