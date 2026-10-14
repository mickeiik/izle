import type { CommandService } from "./commands.ts";
import type { CompanionService } from "./companion.ts";
import type { DeviceService } from "./devices.ts";
import type { PairingService } from "./pairing.ts";
import type { ProxyService } from "./proxy.ts";
import type { LoadedResolver } from "./resolver.ts";
import type { Services, TvService } from "./tv.ts";

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
  /** Directory of the static admin UI. */
  adminUiDir: string;
}
