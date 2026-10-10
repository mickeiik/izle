import path from "node:path";
import { parseArgs } from "node:util";
import { main as validateMain } from "@izle/contract/cli";
import { loadAdminToken } from "./auth.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { BundleValidationError, formatIssue } from "@izle/contract";
import { createLogger } from "./log.ts";
import { startServer } from "./server.ts";

const USAGE = `usage:
  izle-server [--config <file>]                    start the server (defaults: port 8787, sample catalog, ./data)
  izle-server admin-token [--config <file>] [--rotate]
                                                   print the admin token (creating it if needed); --rotate replaces it
  izle-server validate-catalog <dir>               validate a catalog bundle (same as izle-validate)

Relative --config paths resolve against the directory npm or the shell was started in; relative paths inside the
config file resolve against the file's directory. IZLE_ADMIN_TOKEN overrides the admin token file.`;

/** npm sets INIT_CWD to where `npm run` was invoked, so `npm run -w server dev -- --config x` behaves as typed. */
function invocationDir(): string {
  return process.env.INIT_CWD ?? process.cwd();
}

export async function main(argv: string[]): Promise<number> {
  const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : undefined;
  const rest = command === undefined ? argv : argv.slice(1);

  if (command === "validate-catalog") return validateMain(rest);

  let values: { config?: string; rotate?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: rest,
      options: { config: { type: "string", short: "c" }, rotate: { type: "boolean" }, help: { type: "boolean", short: "h" } },
    }));
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n${USAGE}\n`);
    return 2;
  }
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  try {
    const config = loadConfig({ path: values.config ?? null, cwd: invocationDir() });
    const log = createLogger({ level: config.log.level });

    if (command === "admin-token") {
      const { token, source } = loadAdminToken(config, createLogger({ write: (l) => void process.stderr.write(`${l}\n`) }), {
        rotate: values.rotate ?? false,
      });
      if (source === "env" && !values.rotate) process.stderr.write("note: IZLE_ADMIN_TOKEN is set and overrides the token file\n");
      process.stdout.write(`${token}\n`);
      return 0;
    }
    if (command !== undefined) {
      process.stderr.write(`unknown command "${command}"\n${USAGE}\n`);
      return 2;
    }
    if (values.rotate) {
      process.stderr.write(`--rotate belongs to the admin-token command\n${USAGE}\n`);
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
