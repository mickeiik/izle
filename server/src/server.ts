import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import { createApp, type AppContext } from "./app.ts";
import { loadAdminToken } from "./auth.ts";
import { CatalogService } from "./catalog.ts";
import { DEFAULT_RESOLVE_BUDGET_MS, DEFAULT_RESOLVE_DEADLINE_MS, type ServerConfig } from "./config.ts";
import { EventHub } from "./events.ts";
import { createLogger, type Logger } from "./log.ts";
import { PairingService, type PairingOptions } from "./pairing.ts";
import { ProxyService } from "./proxy.ts";
import { ResolveService } from "./resolve.ts";
import { loadResolver, type LoadedResolver } from "./resolver.ts";
import { Store } from "./store.ts";
import { TvService } from "./tv.ts";
import { VERSION } from "./version.ts";

export const ADMIN_UI_DIR = fileURLToPath(new URL("../admin", import.meta.url));

export interface StartOptions {
  config: ServerConfig;
  log?: Logger;
  /** Clock override (tests). */
  now?: () => number;
  /** SSE ping interval (default 20 s). */
  pingMs?: number;
  pairing?: PairingOptions;
}

export interface RunningServer {
  url: string;
  port: number;
  ctx: AppContext;
  app: Hono<any>;
  close(): Promise<void>;
}

/** Loads everything, starts listening, and returns a handle. Throws (nothing listening) when startup fails. */
export async function startServer(opts: StartOptions): Promise<RunningServer> {
  const { config } = opts;
  const log = opts.log ?? createLogger({ level: config.log.level });
  const now = opts.now ?? Date.now;

  const { token: adminToken, source } = loadAdminToken(config, log);
  // The resolver module comes from a local path in the config; nothing is ever downloaded.
  const resolverModule: LoadedResolver | null = config.resolver
    ? await loadResolver({ module: config.resolver.module, config: config.resolver.config, dataDir: config.dataDir, log })
    : null;
  const catalog = new CatalogService(config.catalog.dir, log, now, resolverModule ? new Set(resolverModule.adapters.keys()) : null);
  await catalog.load();
  const store = new Store(path.join(config.dataDir, "izle.db"));
  const events = new EventHub();
  const proxy = new ProxyService({
    log,
    now,
    ttlMs: config.proxy.sessionTtlSec * 1000,
    alignTsSegments: config.proxy.alignTsSegments,
  });
  const resolver = new ResolveService({
    catalog,
    log,
    now,
    proxy,
    adapters: resolverModule?.adapters ?? null,
    proxyAlways: config.proxy.always,
    deadlineMs: config.resolver?.deadlineMs ?? DEFAULT_RESOLVE_DEADLINE_MS,
    budgetMs: config.resolver?.budgetMs ?? DEFAULT_RESOLVE_BUDGET_MS,
  });
  const services = { config, store, catalog, events, resolver, log, now };
  const ctx: AppContext = {
    ...services,
    tv: new TvService(services),
    pairing: new PairingService(store, log, now, opts.pairing),
    proxy,
    resolverModule,
    adminToken,
    pingMs: opts.pingMs ?? 20_000,
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
  const host = config.listen.host === "0.0.0.0" || config.listen.host === "::" ? "127.0.0.1" : config.listen.host;
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
  log.info("listening", { version: VERSION, host: config.listen.host, port, adminAuth: source, catalogDir: catalog.dir, dataDir: config.dataDir });

  const housekeeping = setInterval(() => {
    const t = now();
    store.purgePairCodes(t, 60 * 60_000);
    store.purgeCommands(t - 7 * 24 * 60 * 60_000);
  }, 10 * 60_000);
  housekeeping.unref();

  let closing: Promise<void> | null = null;
  return {
    url,
    port,
    ctx,
    app,
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
