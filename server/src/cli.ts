import path from "node:path";
import { parseArgs } from "node:util";
import { main as validateMain } from "@izle/contract/cli";
import { BundleValidationError, formatIssue, loadBundle } from "@izle/contract";
import { loadAdminToken } from "./auth.ts";
import { ConfigError, loadConfig, type ServerConfig } from "./config.ts";
import { createLogger } from "./log.ts";
import { healthcheckAll, loadResolver, ResolverLoadError } from "./resolver.ts";
import { startServer } from "./server.ts";
import { adminCall, linkBase, localServerUrl, qrCode, ServerUnreachableError, signInLink } from "./shell.ts";
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
                                                   pair talks to the running server; --server <url> if it does not
                                                   listen where the config says
  izle-server validate-catalog <dir>               validate a catalog bundle (same as izle-validate)
  izle-server check-resolver [--config <file>]     load the configured resolver module, check that it provides
                                                   the catalog's adapters, and run every adapter's healthcheck
  izle-server --version                            print the version

Relative --config paths resolve against the directory npm or the shell was started in; relative paths inside the
config file resolve against the file's directory. IZLE_ADMIN_TOKEN overrides the admin token file.`;

/** Loads the resolver module like the server does, then runs the healthchecks. Exit status 1 on any problem. */
async function checkResolver(config: ServerConfig): Promise<number> {
  const out = (line: string) => void process.stdout.write(`${line}\n`);
  if (!config.resolver) {
    process.stderr.write("izle-server: no resolver module is configured (resolver.module in the config file)\n");
    return 1;
  }
  // The module's own log lines (redacted) go to stderr so stdout stays a readable report.
  const log = createLogger({ level: "info", write: (l) => void process.stderr.write(`${l}\n`) });
  const resolver = await loadResolver({ module: config.resolver.module, config: config.resolver.config, dataDir: config.dataDir, log });
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

/** `pair pending` / `pair approve <code> [name…]` against the running server's admin API. Exit status 1 on any problem. */
async function pair(config: ServerConfig, args: string[], serverUrl: string | undefined): Promise<number> {
  const out = (line: string) => void process.stdout.write(`${line}\n`);
  const fail = (line: string) => {
    process.stderr.write(`izle-server: ${line}\n`);
    return 1;
  };
  const [sub, ...rest] = args;
  if (sub !== "pending" && sub !== "approve") {
    process.stderr.write(`pair needs "pending" or "approve <code> [name…]"\n${USAGE}\n`);
    return 2;
  }
  const server = serverUrl ?? localServerUrl(config);
  const { token } = loadAdminToken(config, createLogger({ write: (l) => void process.stderr.write(`${l}\n`) }), { create: false });
  try {
    if (sub === "pending") {
      if (rest.length > 0) return fail(`pair pending takes no arguments`);
      const r = await adminCall(server, token, "GET", "/api/v1/admin/pair/pending");
      if (r.status === 401) return fail("the server did not accept the admin token; is it the one the server runs with?");
      if (r.status !== 200) return fail(`unexpected answer ${r.status} from ${server}`);
      const codes: Array<{ code: string; expiresAt: string; approved: boolean }> = r.json.codes;
      if (codes.length === 0) out("no TV is waiting; izle on the TV shows a 6-digit code when it is not paired");
      for (const c of codes) {
        const left = Math.max(0, Math.round((Date.parse(c.expiresAt) - Date.now()) / 1000));
        out(`${c.code}  ${c.approved ? "approved, waiting for the TV to collect its token" : `waiting for approval, expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`}`);
      }
      return 0;
    }
    const [code, ...nameWords] = rest;
    if (!/^[0-9]{6}$/.test(code ?? "")) return fail("pair approve needs the 6-digit code the TV shows");
    const name = nameWords.join(" ").trim();
    const r = await adminCall(server, token, "POST", "/api/v1/admin/pair/approve", { code, ...(name ? { name } : {}) });
    if (r.status === 404) return fail(`no TV is waiting with the code ${code}; the TV shows a new code every 10 minutes`);
    if (r.status === 409) return fail(`the code ${code} is already approved`);
    if (r.status === 401) return fail("the server did not accept the admin token; is it the one the server runs with?");
    if (r.status !== 200) return fail(`unexpected answer ${r.status} from ${server}${r.json?.message ? `: ${r.json.message}` : ""}`);
    out(`approved: "${r.json.name}" (${r.json.deviceId}) shows its home screen in a moment; put shows on it from the admin page`);
    return 0;
  } catch (err) {
    if (err instanceof ServerUnreachableError) return fail(`${err.message}; is it running? (--server <url> if it listens elsewhere)`);
    throw err;
  }
}

/** npm sets INIT_CWD to where `npm run` was invoked, so `npm run -w server dev -- --config x` behaves as typed. */
function invocationDir(): string {
  return process.env.INIT_CWD ?? process.cwd();
}

export async function main(argv: string[]): Promise<number> {
  const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : undefined;
  const rest = command === undefined ? argv : argv.slice(1);

  if (command === "validate-catalog") return validateMain(rest);

  let values: { config?: string; rotate?: boolean; link?: boolean; base?: string; server?: string; help?: boolean; version?: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        config: { type: "string", short: "c" },
        rotate: { type: "boolean" },
        link: { type: "boolean" },
        base: { type: "string" },
        server: { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    }));
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n${USAGE}\n`);
    return 2;
  }
  if (command !== "pair" && positionals.length > 0) {
    process.stderr.write(`unexpected argument "${positionals[0]}"\n${USAGE}\n`);
    return 2;
  }
  for (const [flag, owner] of [["rotate", "admin-token"], ["link", "admin-token"], ["base", "admin-token"], ["server", "pair"]] as const) {
    if (values[flag] !== undefined && command !== owner) {
      process.stderr.write(`--${flag} belongs to the ${owner} command\n${USAGE}\n`);
      return 2;
    }
  }
  if (values.base !== undefined && !/^https?:\/\/\S+$/.test(values.base)) {
    process.stderr.write(`--base must be an http(s) URL\n`);
    return 2;
  }
  if (values.server !== undefined && !/^https?:\/\/\S+$/.test(values.server)) {
    process.stderr.write(`--server must be an http(s) URL\n`);
    return 2;
  }
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  try {
    const config = loadConfig({ path: values.config ?? null, cwd: invocationDir() });
    const log = createLogger({ level: config.log.level });

    if (command === "check-resolver") return await checkResolver(config);

    if (command === "admin-token") {
      const { token, source } = loadAdminToken(config, createLogger({ write: (l) => void process.stderr.write(`${l}\n`) }), {
        rotate: values.rotate ?? false,
      });
      if (source === "env" && !values.rotate) process.stderr.write("note: IZLE_ADMIN_TOKEN is set and overrides the token file\n");
      if (!values.link) {
        process.stdout.write(`${token}\n`);
        return 0;
      }
      // The link carries the token, like the plain print does; the QR code is the same link for a phone's camera.
      const base = values.base !== undefined ? { url: values.base, source: "--base" } : linkBase(config);
      const link = signInLink(base.url, token);
      process.stdout.write(`${link}\n\n${qrCode(link)}\n`);
      if (base.source === "interface" || base.source === "loopback") {
        process.stderr.write(`note: the link uses ${base.source === "loopback" ? "the loopback address" : "this host's first address"}; set publicUrl in the config or pass --base <url> for the address your phone reaches\n`);
      }
      return 0;
    }
    if (command === "pair") return await pair(config, positionals, values.server);
    if (command !== undefined) {
      process.stderr.write(`unknown command "${command}"\n${USAGE}\n`);
      return 2;
    }

    const server = await startServer({ config, log });
    const shutdown = (signal: string) => {
      log.info("shutting down", { signal });
      void server.close().then(() => process.exit(0));
    };
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGHUP", () => {
      void server.ctx.catalog.reload().then((r) => {
        if (r.ok) for (const { id, stateVersion } of server.ctx.store.bumpAllStateVersions()) server.ctx.tv.notify(id, stateVersion);
      });
    });
    return -1; // keep running
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`izle-server: ${err.message}\n`);
      return 1;
    }
    if (err instanceof ResolverLoadError) {
      process.stderr.write(`izle-server: ${err.message}\n`);
      return 1;
    }
    if (err instanceof BundleValidationError) {
      process.stderr.write(`izle-server: the catalog bundle is invalid:\n`);
      for (const i of err.issues.filter((x) => x.severity === "error")) process.stderr.write(`  ✖ ${formatIssue(i)}\n`);
      return 1;
    }
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
      process.stderr.write(`izle-server: the port is already in use\n`);
      return 1;
    }
    throw err;
  }
}

// Entry point when run directly (`tsx src/cli.ts`); the bin wrapper calls main() itself.
if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const code = await main(process.argv.slice(2));
  if (code >= 0) process.exitCode = code;
}
