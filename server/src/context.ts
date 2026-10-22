import type { AppUpdateService } from "./app-updates.ts";
import type { CatalogService } from "./catalog.ts";
import type { CatalogBrowser } from "./catalog-browse.ts";
import type { CommandService } from "./commands.ts";
import type { CompanionService } from "./companion.ts";
import type { ServerConfig } from "./config.ts";
import type { DeviceService } from "./devices.ts";
import type { EventLog } from "./eventlog.ts";
import type { EventHub, Notifier } from "./events.ts";
import type { HomeService } from "./home.ts";
import type { Logger } from "./log.ts";
import type { PairingService } from "./pairing.ts";
import type { PlayingService } from "./playing.ts";
import type { ProblemService } from "./problems.ts";
import type { ProxyService } from "./proxy.ts";
import type { PlaybackSessions, ResolveService } from "./resolve.ts";
import type { LoadedResolver } from "./resolver.ts";
import type { Store } from "./store.ts";
import type { TokenService } from "./tokens.ts";
import type { TvService } from "./tv.ts";
import type { ViewingService } from "./viewings.ts";

/**
 * What the HTTP layer works with: every module of the running server, and its settings. The modules name their own
 * dependencies (each its deps interface); this is the routes' view of them all.
 */
export interface AppContext {
  config: ServerConfig;
  store: Store;
  catalog: CatalogService;
  /** The owner's catalog browser: filters, orders and facets over the loaded catalog. */
  browse: CatalogBrowser;
  events: EventHub;
  notifier: Notifier;
  /** The stored event log every change appends to (in its transaction). */
  eventLog: EventLog;
  resolver: ResolveService;
  /** The playback sessions resolve opens; progress and problem reports name them. */
  sessions: PlaybackSessions;
  problems: ProblemService;
  /** The viewing history's owner side: marks and deletions (playing.ts writes the viewings). */
  viewings: ViewingService;
  /** The TV app APK the server offers its TVs, and where it comes from. */
  appUpdates: AppUpdateService;
  /** Each TV's Home list: its entries as data, and the owner's operations on it. */
  home: HomeService;
  tv: TvService;
  /** What each TV is playing: the now-playing row, the running viewing and the long-poll on the row. */
  playing: PlayingService;
  companion: CompanionService;
  pairing: PairingService;
  proxy: ProxyService;
  devices: DeviceService;
  commands: CommandService;
  tokens: TokenService;
  log: Logger;
  now: () => number;
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
