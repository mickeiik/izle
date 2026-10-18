import type { AppUpdateService } from "./app-updates.ts";
import type { CatalogService } from "./catalog.ts";
import type { CommandService } from "./commands.ts";
import type { CompanionService } from "./companion.ts";
import type { ServerConfig } from "./config.ts";
import type { DeviceService } from "./devices.ts";
import type { EventLog } from "./eventlog.ts";
import type { EventHub, Notifier } from "./events.ts";
import type { Logger } from "./log.ts";
import type { PairingService } from "./pairing.ts";
import type { ProblemService } from "./problems.ts";
import type { ProxyService } from "./proxy.ts";
import type { PlaybackSessions, ResolveService } from "./resolve.ts";
import type { LoadedResolver } from "./resolver.ts";
import type { Store } from "./store.ts";
import type { TokenService } from "./tokens.ts";
import type { TvService } from "./tv.ts";
import type { ViewingService } from "./viewings.ts";

/** The services the TV, companion, device and command services are built on. */
export interface Services {
  config: ServerConfig;
  store: Store;
  catalog: CatalogService;
  events: EventHub;
  notifier: Notifier;
  /** The stored event log every change appends to (in its transaction). */
  eventLog: EventLog;
  resolver: ResolveService;
  /** The playback sessions resolve opens; progress and problem reports name them. */
  sessions: PlaybackSessions;
  problems: ProblemService;
  /** The viewing history: resolves and progress reports feed it. */
  viewings: ViewingService;
  /** The TV app APK the server offers its TVs, and where it comes from. */
  appUpdates: AppUpdateService;
  log: Logger;
  now: () => number;
}

/** Everything the HTTP layer works with: the services, and the settings of the running server. */
export interface AppContext extends Services {
  tv: TvService;
  companion: CompanionService;
  pairing: PairingService;
  proxy: ProxyService;
  devices: DeviceService;
  commands: CommandService;
  tokens: TokenService;
  /** The loaded resolver module, or null when none is configured. */
  resolverModule: LoadedResolver | null;
  adminToken: string;
  /** SSE keep-alive comment interval. */
  pingMs: number;
  /** How the server reaches upstreams outside the resolver module (the proxy, the diagnostics probe). */
  fetch: typeof fetch;
  /** Directory of the static admin UI. */
  adminUiDir: string;
}
