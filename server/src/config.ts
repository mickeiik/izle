import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { compileTrustedProxies } from "./clientip.ts";
import { invalidPrivateUpstream } from "./egress.ts";
import type { Level } from "./log.ts";

export interface ServerConfig {
  /** Absolute path of the config file, or null when running on defaults. */
  configPath: string | null;
  listen: { host: string; port: number };
  /** Public base URL behind a reverse proxy: the base of the admin sign-in link `admin-token --link` prints. */
  publicUrl: string | null;
  /** Addresses or CIDR ranges of reverse proxies whose `X-Forwarded-For` names the client. */
  trustedProxies: string[];
  dataDir: string;
  catalog: { dir: string };
  /** `deadlineMs` bounds one adapter call, `budgetMs` one TV resolve request (all sources together). */
  resolver: { module: string; config: Record<string, unknown>; deadlineMs: number; budgetMs: number } | null;
  /** `token` comes from IZLE_ADMIN_TOKEN and wins over `tokenFile`. */
  admin: { tokenFile: string; token: string | null };
  /**
   * `alignTsSegments` trims junk bytes before the first MPEG-TS sync byte of proxied HLS segments;
   * `privateUpstreams` lists the loopback, private or link-local upstreams the proxy may reach anyway (hosts,
   * addresses or CIDR ranges, optionally with a port).
   */
  proxy: { always: boolean; sessionTtlSec: number; alignTsSegments: boolean; privateUpstreams: string[] };
  /** Server-wide defaults for devices without their own setting (null = fall back to the catalog's hints). */
  defaults: { uiLanguage: "tr" | "en" | null; preferredAudioLanguage: string | null };
  log: { level: Level };
  /** How long the event log is kept. */
  events: { retentionDays: number };
  /**
   * The TV app's updates: where the APK the server offers its TVs comes from (`github`: the latest release of
   * `repo`, checked every `checkIntervalHours`; `manual`: only what the owner uploads), and whether TVs that can
   * install silently do so on their own (`auto`).
   */
  appUpdates: { source: AppUpdateSource; repo: string; checkIntervalHours: number; auto: boolean };
}

export type AppUpdateSource = "github" | "manual";

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** The sample catalog shipped in this repository, used when no catalog is configured. */
export const SAMPLE_CATALOG_DIR = fileURLToPath(new URL("../../sample-catalog", import.meta.url));

const DEFAULT_PORT = 8787;
const DEFAULT_EVENT_RETENTION_DAYS = 7;
export const DEFAULT_RESOLVE_DEADLINE_MS = 12_000;
export const DEFAULT_RESOLVE_BUDGET_MS = 30_000;
export const DEFAULT_APP_REPO = "mickeiik/izle";
/** `owner/name` of a GitHub repository (neither part `.` or `..`). */
export const REPO_PATTERN = "^(?!\\.\\.?/)[A-Za-z0-9_.-]+/(?!\\.\\.?$)[A-Za-z0-9_.-]+$";

/** Simplified BCP 47 language tag, as in the catalog contract (`LanguageTag`). */
export const LANGUAGE_TAG_PATTERN = "^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$";

/** A JSON Schema object with these properties (the `required` ones too) and no others. */
export const objectSchema = (properties: object, required: string[] = []) => ({
  type: "object", ...(required.length > 0 ? { required } : {}), properties, additionalProperties: false,
});

const NULL = { type: "null" };
const TEXT = { type: "string", minLength: 1 };
const MS = { type: "integer", minimum: 100, maximum: 120_000 };
const RESOLVER = objectSchema({ module: TEXT, config: { type: "object" }, deadlineMs: MS, budgetMs: MS }, ["module"]);

const CONFIG_SCHEMA = objectSchema({
  $schema: { type: "string" },
  listen: objectSchema({ host: TEXT, port: { type: "integer", minimum: 0, maximum: 65535 } }),
  publicUrl: { anyOf: [{ type: "string", pattern: "^https?://[^\\s]+$" }, NULL] },
  trustedProxies: { type: "array", items: TEXT, maxItems: 64 },
  dataDir: TEXT,
  catalog: objectSchema({ dir: TEXT }, ["dir"]),
  resolver: { anyOf: [RESOLVER, NULL] },
  admin: objectSchema({ tokenFile: TEXT }),
  proxy: objectSchema({
    always: { type: "boolean" }, sessionTtlSec: { type: "integer", minimum: 60, maximum: 86400 }, alignTsSegments: { type: "boolean" },
    privateUpstreams: { type: "array", items: TEXT, maxItems: 64 },
  }),
  // Unlike the API's, the config file's language tags have no length limit.
  defaults: objectSchema({
    uiLanguage: { anyOf: [{ enum: ["tr", "en"] }, NULL] },
    preferredAudioLanguage: { anyOf: [{ type: "string", pattern: LANGUAGE_TAG_PATTERN }, NULL] },
  }),
  log: objectSchema({ level: { enum: ["debug", "info", "warn", "error"] } }),
  events: objectSchema({ retentionDays: { type: "integer", minimum: 1, maximum: 90 } }),
  appUpdates: objectSchema({
    source: { enum: ["github", "manual"] }, repo: { type: "string", pattern: REPO_PATTERN, maxLength: 200 },
    checkIntervalHours: { type: "integer", minimum: 1, maximum: 168 }, auto: { type: "boolean" },
  }),
});

const validateConfigFile = new Ajv2020({ strict: true, allErrors: true }).compile(CONFIG_SCHEMA);

interface ConfigFile {
  listen?: { host?: string; port?: number };
  publicUrl?: string | null;
  trustedProxies?: string[];
  dataDir?: string;
  catalog?: { dir: string };
  resolver?: { module: string; config?: Record<string, unknown>; deadlineMs?: number; budgetMs?: number } | null;
  admin?: { tokenFile?: string };
  proxy?: { always?: boolean; sessionTtlSec?: number; alignTsSegments?: boolean; privateUpstreams?: string[] };
  defaults?: { uiLanguage?: "tr" | "en" | null; preferredAudioLanguage?: string | null };
  log?: { level?: Level };
  events?: { retentionDays?: number };
  appUpdates?: { source?: AppUpdateSource; repo?: string; checkIntervalHours?: number; auto?: boolean };
}

interface LoadConfigOptions {
  /** Config file path; relative paths inside it resolve against its directory. */
  path?: string | null;
  env?: NodeJS.ProcessEnv;
  /** Base for a relative `path` and, without a file, for the default data directory. */
  cwd?: string;
}

/** Whether a listen host binds every interface (`0.0.0.0`, `::`, or an empty host, which the config file refuses). */
export function isWildcardHost(host: string): boolean {
  return host === "" || host === "0.0.0.0" || host === "::";
}

/**
 * Where this host's own server answers: the listen address, with a wildcard host turned into loopback. `port`
 * defaults to the configured one; the running server passes the port it bound.
 */
export function localServerUrl(config: Pick<ServerConfig, "listen">, port = config.listen.port): string {
  const host = config.listen.host;
  const h = isWildcardHost(host) ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
  return `http://${h}:${port}`;
}

/** The server's SQLite database, in the data directory. */
export function databaseFile(config: Pick<ServerConfig, "dataDir">): string {
  return path.join(config.dataDir, "izle.db");
}

/** Reads, parses and validates a config file; a ConfigError says what is wrong with it. */
function readConfigFile(configPath: string): ConfigFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    if (err instanceof SyntaxError) throw new ConfigError(`config file ${configPath} is not valid JSON`);
    throw new ConfigError(`cannot read config file ${configPath}`);
  }
  if (!validateConfigFile(parsed)) {
    const details = (validateConfigFile.errors ?? []).filter((e) => e.keyword !== "anyOf").map((e) => {
      const extra = (e.params as { additionalProperty?: string }).additionalProperty;
      return `${e.instancePath || "/"} ${extra ? `has unknown property "${extra}"` : e.message}`;
    });
    throw new ConfigError(`invalid config file ${configPath}: ${[...new Set(details)].join("; ")}`);
  }
  const file = parsed as ConfigFile;
  const { invalid } = compileTrustedProxies(file.trustedProxies ?? []);
  if (invalid !== null) throw new ConfigError(`invalid config file ${configPath}: /trustedProxies "${invalid}" is not an IP address or CIDR range`);
  const upstream = invalidPrivateUpstream(file.proxy?.privateUpstreams ?? []);
  if (upstream !== null) {
    throw new ConfigError(`invalid config file ${configPath}: /proxy/privateUpstreams "${upstream}" is not a host name, IP address or CIDR range (optionally with :port)`);
  }
  return file;
}

export function loadConfig(opts: LoadConfigOptions = {}): ServerConfig {
  const cwd = opts.cwd ?? process.cwd();
  const configPath = opts.path ? path.resolve(cwd, opts.path) : null;
  const file: ConfigFile = configPath ? readConfigFile(configPath) : {};
  const resolve = (p: string) => path.resolve(configPath ? path.dirname(configPath) : cwd, p);
  const dataDir = resolve(file.dataDir ?? "./data");
  const r = file.resolver;
  return {
    configPath,
    listen: { host: "0.0.0.0", port: DEFAULT_PORT, ...file.listen },
    publicUrl: file.publicUrl ? file.publicUrl.replace(/\/+$/, "") : null,
    trustedProxies: file.trustedProxies ?? [],
    dataDir,
    catalog: { dir: file.catalog ? resolve(file.catalog.dir) : SAMPLE_CATALOG_DIR },
    resolver: r
      ? { module: resolve(r.module), config: r.config ?? {}, deadlineMs: r.deadlineMs ?? DEFAULT_RESOLVE_DEADLINE_MS, budgetMs: r.budgetMs ?? DEFAULT_RESOLVE_BUDGET_MS }
      : null,
    admin: {
      tokenFile: file.admin?.tokenFile ? resolve(file.admin.tokenFile) : path.join(dataDir, "admin.token"),
      token: (opts.env ?? process.env).IZLE_ADMIN_TOKEN?.trim() || null,
    },
    proxy: { always: false, sessionTtlSec: 21600, alignTsSegments: false, privateUpstreams: [], ...file.proxy },
    defaults: { uiLanguage: null, preferredAudioLanguage: null, ...file.defaults },
    log: { level: "info", ...file.log },
    events: { retentionDays: DEFAULT_EVENT_RETENTION_DAYS, ...file.events },
    appUpdates: { source: "github", repo: DEFAULT_APP_REPO, checkIntervalHours: 24, auto: true, ...file.appUpdates },
  };
}
