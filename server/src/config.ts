import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { compileTrustedProxies } from "./clientip.ts";
import type { Level } from "./log.ts";

export interface ServerConfig {
  /** Absolute path of the config file, or null when running on defaults. */
  configPath: string | null;
  listen: { host: string; port: number };
  /** Public base URL behind a reverse proxy (informational in v1). */
  publicUrl: string | null;
  /** Addresses or CIDR ranges of reverse proxies whose `X-Forwarded-For` names the client. */
  trustedProxies: string[];
  dataDir: string;
  catalog: { dir: string };
  /** `deadlineMs` bounds one adapter call, `budgetMs` one TV resolve request (all sources together). */
  resolver: { module: string; config: Record<string, unknown>; deadlineMs: number; budgetMs: number } | null;
  /** `token` comes from IZLE_ADMIN_TOKEN and wins over `tokenFile`. */
  admin: { tokenFile: string; token: string | null };
  /** `alignTsSegments` trims junk bytes before the first MPEG-TS sync byte of proxied HLS segments. */
  proxy: { always: boolean; sessionTtlSec: number; alignTsSegments: boolean };
  /** Server-wide defaults for devices without their own setting (null = fall back to the catalog's hints). */
  defaults: { uiLanguage: "tr" | "en" | null; preferredAudioLanguage: string | null };
  log: { level: Level };
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** The sample catalog shipped in this repository, used when no catalog is configured. */
export const SAMPLE_CATALOG_DIR = fileURLToPath(new URL("../../sample-catalog", import.meta.url));

export const DEFAULT_PORT = 8787;
export const DEFAULT_RESOLVE_DEADLINE_MS = 12_000;
export const DEFAULT_RESOLVE_BUDGET_MS = 30_000;

/** Simplified BCP 47 language tag, as in the catalog contract (`LanguageTag`). */
export const LANGUAGE_TAG_PATTERN = "^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$";

// Unlike the API's, the config file's tags have no length limit.
const LANGUAGE_TAG = { type: "string", pattern: LANGUAGE_TAG_PATTERN };

const CONFIG_SCHEMA = {
  type: "object",
  properties: {
    $schema: { type: "string" },
    listen: {
      type: "object",
      properties: {
        host: { type: "string", minLength: 1 },
        port: { type: "integer", minimum: 0, maximum: 65535 },
      },
      additionalProperties: false,
    },
    publicUrl: { anyOf: [{ type: "string", pattern: "^https?://[^\\s]+$" }, { type: "null" }] },
    trustedProxies: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 64 },
    dataDir: { type: "string", minLength: 1 },
    catalog: {
      type: "object",
      required: ["dir"],
      properties: { dir: { type: "string", minLength: 1 } },
      additionalProperties: false,
    },
    resolver: {
      anyOf: [
        {
          type: "object",
          required: ["module"],
          properties: {
            module: { type: "string", minLength: 1 },
            config: { type: "object" },
            deadlineMs: { type: "integer", minimum: 100, maximum: 120_000 },
            budgetMs: { type: "integer", minimum: 100, maximum: 120_000 },
          },
          additionalProperties: false,
        },
        { type: "null" },
      ],
    },
    admin: {
      type: "object",
      properties: { tokenFile: { type: "string", minLength: 1 } },
      additionalProperties: false,
    },
    proxy: {
      type: "object",
      properties: {
        always: { type: "boolean" },
        sessionTtlSec: { type: "integer", minimum: 60, maximum: 86400 },
        alignTsSegments: { type: "boolean" },
      },
      additionalProperties: false,
    },
    defaults: {
      type: "object",
      properties: {
        uiLanguage: { anyOf: [{ enum: ["tr", "en"] }, { type: "null" }] },
        preferredAudioLanguage: { anyOf: [LANGUAGE_TAG, { type: "null" }] },
      },
      additionalProperties: false,
    },
    log: {
      type: "object",
      properties: { level: { enum: ["debug", "info", "warn", "error"] } },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const;

const validateConfigFile = new Ajv2020({ strict: true, allErrors: true }).compile(CONFIG_SCHEMA);

interface ConfigFile {
  listen?: { host?: string; port?: number };
  publicUrl?: string | null;
  trustedProxies?: string[];
  dataDir?: string;
  catalog?: { dir: string };
  resolver?: { module: string; config?: Record<string, unknown>; deadlineMs?: number; budgetMs?: number } | null;
  admin?: { tokenFile?: string };
  proxy?: { always?: boolean; sessionTtlSec?: number; alignTsSegments?: boolean };
  defaults?: { uiLanguage?: "tr" | "en" | null; preferredAudioLanguage?: string | null };
  log?: { level?: Level };
}

export interface LoadConfigOptions {
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
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    throw new ConfigError(`cannot read config file ${configPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ConfigError(`config file ${configPath} is not valid JSON`);
  }
  if (!validateConfigFile(parsed)) {
    const details = (validateConfigFile.errors ?? [])
      .filter((e) => e.keyword !== "anyOf")
      .map((e) => {
        const extra = (e.params as { additionalProperty?: string }).additionalProperty;
        return `${e.instancePath || "/"} ${extra ? `has unknown property "${extra}"` : e.message}`;
      });
    throw new ConfigError(`invalid config file ${configPath}: ${[...new Set(details)].join("; ")}`);
  }
  const file = parsed as ConfigFile;
  const { invalid } = compileTrustedProxies(file.trustedProxies ?? []);
  if (invalid !== null) {
    throw new ConfigError(`invalid config file ${configPath}: /trustedProxies "${invalid}" is not an IP address or CIDR range`);
  }
  return file;
}

export function loadConfig(opts: LoadConfigOptions = {}): ServerConfig {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  let file: ConfigFile = {};
  let configPath: string | null = null;
  let base = cwd;

  if (opts.path) {
    configPath = path.resolve(cwd, opts.path);
    base = path.dirname(configPath);
    file = readConfigFile(configPath);
  }

  const resolve = (p: string) => path.resolve(base, p);
  const dataDir = resolve(file.dataDir ?? "./data");
  const envToken = env.IZLE_ADMIN_TOKEN?.trim() || null;

  return {
    configPath,
    listen: { host: file.listen?.host ?? "0.0.0.0", port: file.listen?.port ?? DEFAULT_PORT },
    publicUrl: file.publicUrl ? file.publicUrl.replace(/\/+$/, "") : null,
    trustedProxies: file.trustedProxies ?? [],
    dataDir,
    catalog: { dir: file.catalog ? resolve(file.catalog.dir) : SAMPLE_CATALOG_DIR },
    resolver: file.resolver
      ? {
          module: resolve(file.resolver.module),
          config: file.resolver.config ?? {},
          deadlineMs: file.resolver.deadlineMs ?? DEFAULT_RESOLVE_DEADLINE_MS,
          budgetMs: file.resolver.budgetMs ?? DEFAULT_RESOLVE_BUDGET_MS,
        }
      : null,
    admin: { tokenFile: file.admin?.tokenFile ? resolve(file.admin.tokenFile) : path.join(dataDir, "admin.token"), token: envToken },
    proxy: {
      always: file.proxy?.always ?? false,
      sessionTtlSec: file.proxy?.sessionTtlSec ?? 21600,
      alignTsSegments: file.proxy?.alignTsSegments ?? false,
    },
    defaults: {
      uiLanguage: file.defaults?.uiLanguage ?? null,
      preferredAudioLanguage: file.defaults?.preferredAudioLanguage ?? null,
    },
    log: { level: file.log?.level ?? "info" },
  };
}
