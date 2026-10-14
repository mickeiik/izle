import type { CatalogService } from "./catalog.ts";
import type { CommandService } from "./commands.ts";
import type { CompanionService } from "./companion.ts";
import type { ServerConfig } from "./config.ts";
import type { DeviceService } from "./devices.ts";
import type { EventHub } from "./events.ts";
import type { Logger } from "./log.ts";
import type { Notifier } from "./notifier.ts";
import type { PairingService } from "./pairing.ts";
import type { ProblemService } from "./problems.ts";
import type { ProxyService } from "./proxy.ts";
import type { PlaybackSessions, ResolveService } from "./resolve.ts";
import type { LoadedResolver } from "./resolver.ts";
import type { Store } from "./store.ts";
import type { TvService } from "./tv.ts";

/** The services the TV, companion, device and command services are built on. */
export interface Services {
  config: ServerConfig;
  store: Store;
  catalog: CatalogService;
  events: EventHub;
  notifier: Notifier;
  resolver: ResolveService;
  /** The playback sessions resolve opens; progress and problem reports name them. */
  sessions: PlaybackSessions;
  problems: ProblemService;
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
