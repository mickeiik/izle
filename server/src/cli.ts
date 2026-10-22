import path from "node:path";
import { parseArgs } from "node:util";
import { main as validateMain } from "@izle/contract/cli";
import { BundleValidationError, formatIssue, loadBundle } from "@izle/contract";
import { loadAdminToken } from "./auth.ts";
import { BackupError, backupDatabase } from "./backup.ts";
import { reloadOnSignal } from "./catalog-admin.ts";
import { ConfigError, databaseFile, loadConfig, localServerUrl, SAMPLE_CATALOG_DIR, type ServerConfig } from "./config.ts";
import { createLogger } from "./log.ts";
import { PAIR_CODE } from "./pairing.ts";
import { SCOPES, type Scope } from "./tokens.ts";
import { healthcheckAll, loadResolver, ResolverLoadError } from "./resolver.ts";
import { startServer } from "./server.ts";
import { adminCall, linkBase, qrCode, ServerUnreachableError, signInLink } from "./shell.ts";
import { VERSION } from "./version.ts";

const USAGE = `usage:
  izle-server [--config <file>]                    start the server (defaults: port 8787, sample catalog, ./data)
  izle-server admin-token [--config <file>] [--rotate] [--link [--base <url>]]
                                                   print the admin token (creating it if needed); --rotate replaces it;
                                                   --link prints a sign-in link for the admin page and its QR code
                                                   (base address: --base, else publicUrl, else this host's address)
  izle-server pair pending [--config <file>]       list the pairing codes waiting for approval
  izle-server pair approve <code> [<name…>] [--config <file>]
                                                   approve the code a TV shows (name: "TV", "TV 2", … when omitted)
  izle-server pair cancel <code> [--config <file>] clear a waiting code that none of your TVs shows
                                                   pair talks to the running server; --server <url> if it does not
                                                   listen where the config says
  izle-server token create <name…> --scope <read|control|manage> [--config <file>]
                                                   create an access token for an agent or an app and print its
                                                   secret, once (read: see everything; control: also send commands;
                                                   manage: also change home lists, cursors, settings, marks)
  izle-server token list [--config <file>]         list the access tokens
  izle-server token revoke <id> [--config <file>]  revoke one; requests with it answer 401 from now on
                                                   token talks to the running server, like pair (--server <url>)
  izle-server backup <file> [--config <file>] [--force]
                                                   copy the database to <file> (mode 0600) while the server keeps
                                                   running; --force replaces an existing file
  izle-server validate-catalog <dir>               validate a catalog bundle (same as izle-validate)
  izle-server check-resolver [--config <file>]     load the configured resolver module, check that it provides
                                                   the catalog's adapters, and run every adapter's healthcheck
  izle-server --version                            print the version

Relative --config paths resolve against the directory npm or the shell was started in; relative paths inside the
config file resolve against the file's directory. IZLE_ADMIN_TOKEN overrides the admin token file.`;

const out = (line: string) => void process.stdout.write(`${line}\n`);
const TOKEN_REFUSED = "the server did not accept the admin token; is it the one the server runs with?";
/** For the commands' own log lines (redacted, like the server's), so stdout stays what the command prints. */
const stderrLog = createLogger({ write: (l) => void process.stderr.write(`${l}\n`) });

/** A problem the command ran into, on stderr; exit status 1. */
function fail(line: string): number {
  process.stderr.write(`izle-server: ${line}\n`);
  return 1;
}

/** An answer of the running server that the command did not expect: the token refused, or what the server said. */
function unexpected(server: string, r: { status: number; json: unknown }): number {
  const message = (r.json as { message?: string } | null)?.message;
  return fail(r.status === 401 ? TOKEN_REFUSED : `unexpected answer ${r.status} from ${server}${message ? `: ${message}` : ""}`);
}

/** A command line that cannot be run: why, then the usage, on stderr; exit status 2. */
function usage(message: string): number {
  process.stderr.write(`${message}\n${USAGE}\n`);
  return 2;
}

/** Loads the resolver module like the server does, then runs the healthchecks. Exit status 1 on any problem. */
async function checkResolver(config: ServerConfig): Promise<number> {
  if (!config.resolver) return fail("no resolver module is configured (resolver.module in the config file)");
  const resolver = await loadResolver({ module: config.resolver.module, config: config.resolver.config, dataDir: config.dataDir, log: stderrLog });
  out(`resolver module ${resolver.file}`);
  out(`sha256 ${resolver.sha256}`);
  out(`adapters: ${[...resolver.adapters.keys()].join(", ") || "(none)"}`);
  let ok = true;
  try {
    const { bundle } = await loadBundle(config.catalog.dir);
    const missing = bundle.manifest.adapters.filter((a) => !resolver.adapters.has(a));
    if (missing.length > 0) {
      ok = false;
      for (const a of missing) out(`✖ catalog ${bundle.manifest.catalogId} needs adapter "${a}", which the module does not provide`);
    } else {
      out(`✔ catalog ${bundle.manifest.catalogId}: all ${bundle.manifest.adapters.length} declared adapter(s) provided`);
    }
  } catch (err) {
    ok = false;
    out(`✖ catalog ${config.catalog.dir} cannot be loaded${err instanceof BundleValidationError ? " (invalid bundle; run validate-catalog)" : ""}`);
  }
  for (const h of await healthcheckAll(resolver)) {
    if (h.ok) out(`✔ ${h.adapterId}: ${h.skipped ? "no healthcheck" : `healthy (${h.ms} ms)`}`);
    else {
      ok = false;
      out(`✖ ${h.adapterId}: healthcheck failed (${h.code}, ${h.name}, ${h.ms} ms)`);
    }
  }
  return ok ? 0 : 1;
}

/**
 * `pair pending` / `pair approve <code> [name…]` / `pair cancel <code>` against the running server's admin API. Exit
 * status 1 on any problem.
 */
async function pair(config: ServerConfig, args: string[], serverUrl: string | undefined): Promise<number> {
  const [sub, ...rest] = args;
  if (sub !== "pending" && sub !== "approve" && sub !== "cancel") return usage(`pair needs "pending", "approve <code> [name…]" or "cancel <code>"`);
  const server = serverUrl ?? localServerUrl(config);
  const { token } = loadAdminToken(config, stderrLog, { create: false });
  if (sub === "pending") {
    if (rest.length > 0) return fail(`pair pending takes no arguments`);
    const r = await adminCall<{ codes: Array<{ code: string; expiresAt: string; approved: boolean }> }>(server, token, "GET", "/api/v1/admin/pair/pending");
    if (r.status !== 200) return unexpected(server, r);
    const codes = r.json!.codes;
    if (codes.length === 0) out("no TV is waiting; izle on the TV shows a 6-digit code when it is not paired");
    for (const c of codes) {
      const left = Math.max(0, Math.round((Date.parse(c.expiresAt) - Date.now()) / 1000));
      out(`${c.code}  ${c.approved ? "approved, waiting for the TV to collect its token" : `waiting for approval, expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`}`);
    }
    return 0;
  }
  if (sub === "cancel") {
    const [code, ...more] = rest;
    if (!PAIR_CODE.test(code ?? "") || more.length > 0) return fail("pair cancel needs one 6-digit code (pair pending lists them)");
    const r = await adminCall(server, token, "DELETE", `/api/v1/admin/pair/pending/${code}`);
    if (r.status === 404) return fail(`no code ${code} is waiting; it was collected, cleared or expired`);
    if (r.status !== 204) return unexpected(server, r);
    out(`cleared: the code ${code} no longer pairs; a TV that showed it asks for a new one`);
    return 0;
  }
  const [code, ...nameWords] = rest;
  if (!PAIR_CODE.test(code ?? "")) return fail("pair approve needs the 6-digit code the TV shows");
  const name = nameWords.join(" ").trim();
  const body = { code, ...(name ? { name } : {}) };
  const r = await adminCall<{ deviceId: string; name: string }>(server, token, "POST", "/api/v1/admin/pair/approve", body);
  if (r.status === 404) return fail(`no TV is waiting with the code ${code}; the TV shows a new code every 10 minutes`);
  if (r.status === 409) return fail(`the code ${code} is already approved`);
  if (r.status !== 200) return unexpected(server, r);
  out(`approved: "${r.json!.name}" (${r.json!.deviceId}) shows its home screen in a moment; put shows on it from the admin page`);
  return 0;
}

/** `token create <name…> --scope <scope>` / `token list` / `token revoke <id>` against the running server. */
async function token(config: ServerConfig, args: string[], serverUrl: string | undefined, scope: string | undefined): Promise<number> {
  const [sub, ...rest] = args;
  if (sub !== "create" && sub !== "list" && sub !== "revoke") return usage(`token needs "create <name…> --scope <scope>", "list" or "revoke <id>"`);
  if (scope !== undefined && sub !== "create") return usage("--scope belongs to token create");
  const server = serverUrl ?? localServerUrl(config);
  const { token: adminToken } = loadAdminToken(config, stderrLog, { create: false });
  type Token = { id: string; name: string; scope: Scope; createdAt: string; lastUsedAt: string | null };
  if (sub === "list") {
    if (rest.length > 0) return fail("token list takes no arguments");
    const r = await adminCall<{ tokens: Token[] }>(server, adminToken, "GET", "/api/v1/admin/tokens");
    if (r.status !== 200) return unexpected(server, r);
    if (r.json!.tokens.length === 0) out("no access tokens; create one with `izle-server token create <name> --scope <scope>`");
    for (const t of r.json!.tokens) out(`${t.id}  ${t.scope.padEnd(7)}  ${t.lastUsedAt ? `last used ${t.lastUsedAt}` : "never used"}  ${t.name}`);
    return 0;
  }
  if (sub === "revoke") {
    const [id, ...extra] = rest;
    if (!id || extra.length > 0) return fail("token revoke needs the token's id (see token list)");
    const r = await adminCall(server, adminToken, "DELETE", `/api/v1/admin/tokens/${encodeURIComponent(id)}`);
    if (r.status === 404) return fail(`no access token with the id ${id}`);
    if (r.status !== 204) return unexpected(server, r);
    out(`revoked access token ${id}; requests with it answer 401 from now on`);
    return 0;
  }
  const name = rest.join(" ").trim();
  if (!name) return fail("token create needs a name");
  if (!SCOPES.includes(scope as Scope)) return fail(`token create needs --scope ${SCOPES.join("|")}`);
  const r = await adminCall<{ token: Token; secret: string }>(server, adminToken, "POST", "/api/v1/admin/tokens", { name, scope });
  if (r.status === 409) return fail(`an access token named "${name}" exists`);
  if (r.status !== 201) return unexpected(server, r);
  // The secret alone on stdout, like admin-token, so a script can capture it; it is shown only now.
  process.stderr.write(`created access token "${r.json!.token.name}" (${r.json!.token.id}, scope ${r.json!.token.scope}); its secret, shown only now:\n`);
  out(r.json!.secret);
  return 0;
}

/**
 * `admin-token`: prints the admin token (creating it, or with `rotate` replacing it), or with `link` the admin page's
 * sign-in link and its QR code.
 */
function adminToken(config: ServerConfig, opts: { rotate: boolean; link: boolean; base: string | undefined }): number {
  const { token, source } = loadAdminToken(config, stderrLog, { rotate: opts.rotate });
  if (source === "env") process.stderr.write("note: IZLE_ADMIN_TOKEN is set and overrides the token file\n");
  if (!opts.link) {
    out(token);
    return 0;
  }
  // The link carries the token, like the plain print does; the QR code is the same link for a phone's camera.
  const base = opts.base !== undefined ? { url: opts.base, source: "--base" } : linkBase(config);
  const link = signInLink(base.url, token);
  out(`${link}\n\n${qrCode(link)}`);
  if (base.source === "interface" || base.source === "loopback") {
    process.stderr.write(`note: the link uses ${base.source === "loopback" ? "the loopback address" : "this host's first address"}; set publicUrl in the config or pass --base <url> for the address your phone reaches\n`);
  }
  return 0;
}

const size = (bytes: number) => (bytes < 1024 ? `${bytes} bytes` : bytes < 1024 ** 2 ? `${Math.round(bytes / 1024)} KiB` : `${(bytes / 1024 ** 2).toFixed(1)} MiB`);

/** `backup <file>`: a consistent copy of the database, taken while the server keeps running (BackupError → exit 1). */
function backup(config: ServerConfig, file: string, force: boolean): number {
  const target = path.resolve(invocationDir(), file);
  const { bytes } = backupDatabase(databaseFile(config), target, { force });
  const separately = [
    `the admin token (${config.admin.token ? "IZLE_ADMIN_TOKEN" : config.admin.tokenFile})`,
    config.configPath ? `the config file (${config.configPath})` : null,
    config.catalog.dir !== SAMPLE_CATALOG_DIR ? `the catalog (${config.catalog.dir})` : null,
    config.resolver ? `the resolver module (${config.resolver.module})` : null,
  ].filter((x) => x !== null);
  const list = separately.length > 1 ? `${separately.slice(0, -1).join(", ")} and ${separately.at(-1)}` : separately[0];
  out(`backup written to ${target} (${size(bytes)})`);
  out(`not in the backup: ${list}; back them up separately`);
  return 0;
}

/** npm sets INIT_CWD to where `npm run` was invoked, so `npm run -w server dev -- --config x` behaves as typed. */
function invocationDir(): string {
  return process.env.INIT_CWD ?? process.cwd();
}

const OPTIONS = {
  config: { type: "string", short: "c" }, rotate: { type: "boolean" }, link: { type: "boolean" }, base: { type: "string" },
  server: { type: "string" }, scope: { type: "string" }, force: { type: "boolean" }, help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" },
} as const;

export async function main(argv: string[]): Promise<number> {
  const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : undefined;
  const rest = command === undefined ? argv : argv.slice(1);

  if (command === "validate-catalog") return validateMain(rest);

  let parsed;
  try {
    parsed = parseArgs({ args: rest, allowPositionals: true, options: OPTIONS });
  } catch (err) {
    return usage((err as Error).message);
  }
  const { values, positionals } = parsed;
  const maxPositionals = command === "pair" || command === "token" ? Infinity : command === "backup" ? 1 : 0;
  if (positionals.length > maxPositionals) return usage(`unexpected argument "${positionals[maxPositionals]}"`);
  const owners = [["rotate", "admin-token"], ["link", "admin-token"], ["base", "admin-token"], ["server", "pair, token"], ["scope", "token"], ["force", "backup"]] as const;
  for (const [flag, owner] of owners) {
    const commands = owner.split(", ");
    if (values[flag] !== undefined && !commands.includes(command ?? "")) return usage(`--${flag} belongs to the ${commands.join(" and ")} command${commands.length > 1 ? "s" : ""}`);
  }
  for (const flag of ["base", "server"] as const) {
    const url = values[flag];
    if (url !== undefined && !/^https?:\/\/\S+$/.test(url)) {
      process.stderr.write(`--${flag} must be an http(s) URL\n`);
      return 2;
    }
  }
  if (values.help || values.version) {
    out(values.help ? USAGE : VERSION);
    return 0;
  }
  if (command === "backup" && positionals.length === 0) return usage("backup needs the file to write the copy to");

  try {
    const config = loadConfig({ path: values.config ?? null, cwd: invocationDir() });
    const log = createLogger({ level: config.log.level });

    if (command === "check-resolver") return await checkResolver(config);
    if (command === "backup") return backup(config, positionals[0]!, values.force ?? false);
    if (command === "admin-token") return adminToken(config, { rotate: values.rotate ?? false, link: values.link ?? false, base: values.base });
    if (command === "pair") return await pair(config, positionals, values.server);
    if (command === "token") return await token(config, positionals, values.server, values.scope);
    if (command !== undefined) return usage(`unknown command "${command}"`);

    const server = await startServer({ config, log });
    const shutdown = (signal: string) => {
      log.info("shutting down", { signal });
      void server.close().then(() => process.exit(0));
    };
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGHUP", () => void reloadOnSignal(server.ctx, "SIGHUP"));
    return -1; // keep running
  } catch (err) {
    if (err instanceof ConfigError || err instanceof ResolverLoadError || err instanceof BackupError) return fail(err.message);
    if (err instanceof ServerUnreachableError) return fail(`${err.message}; is it running? (--server <url> if it listens elsewhere)`);
    if (err instanceof BundleValidationError) {
      const errors = err.issues.filter((x) => x.severity === "error").map((i) => `\n  ✖ ${formatIssue(i)}`);
      return fail(`the catalog bundle is invalid:${errors.join("")}`);
    }
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") return fail("the port is already in use");
    throw err;
  }
}

// Entry point when run directly (`tsx src/cli.ts`); the bin wrapper calls main() itself.
if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const code = await main(process.argv.slice(2));
  if (code >= 0) process.exitCode = code;
}
