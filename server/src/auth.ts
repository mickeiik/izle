import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ConfigError, type ServerConfig } from "./config.ts";
import type { Logger } from "./log.ts";

const MIN_ADMIN_TOKEN_LENGTH = 24;

/** 32 random bytes, base64url (43 characters). */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * A random alphanumeric identifier (not a secret). Always a valid catalog-style Id (base64url could start with
 * "-" or "_"), and short enough that log redaction leaves it readable.
 */
export function newId(length = 12): string {
  let out = "";
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      // 248 = 4 × 62: rejecting larger bytes keeps the distribution uniform.
      if (b < 248) out += ALNUM[b % 62];
      if (out.length === length) break;
    }
  }
  return out;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Constant-time comparison of two secrets of any length (both are hashed first). */
export function secretsEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

/** Extracts the token from an `Authorization: Bearer <token>` header. */
export function bearerToken(header: string | undefined | null): string | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return m ? m[1]! : null;
}

function checkLength(token: string, source: string): string {
  if (token.length < MIN_ADMIN_TOKEN_LENGTH) {
    throw new ConfigError(`admin token from ${source} is shorter than ${MIN_ADMIN_TOKEN_LENGTH} characters`);
  }
  return token;
}

function writeTokenFile(file: string, token: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
}

/**
 * Returns the admin token: IZLE_ADMIN_TOKEN if set (with `warnShadowed`, warning when a token file exists too), else the content of `admin.tokenFile`, creating the file with a
 * new random token on first start (unless `create` is false). `rotate` replaces the file's token, and is refused
 * while IZLE_ADMIN_TOKEN is set (the old token would stay the one in use). Refuses tokens shorter than 24
 * characters. The token itself is never logged.
 */
export function loadAdminToken(
  config: ServerConfig,
  log: Logger,
  opts: { create?: boolean; rotate?: boolean; warnShadowed?: boolean } = {},
): { token: string; source: "env" | "file" } {
  const file = config.admin.tokenFile;
  if (opts.rotate) {
    if (config.admin.token) {
      throw new ConfigError("IZLE_ADMIN_TOKEN is set and overrides the token file, so --rotate would not replace the token in use; change or remove the variable instead");
    }
    const token = newToken();
    writeTokenFile(file, token);
    log.info("admin token rotated", { file });
    return { token, source: "file" };
  }
  if (config.admin.token) {
    const token = checkLength(config.admin.token, "IZLE_ADMIN_TOKEN");
    // A token file left behind (or written by a --rotate run without the variable) is not the token in use.
    if (opts.warnShadowed && existsSync(file)) log.warn("IZLE_ADMIN_TOKEN overrides the admin token file; the file's token is not accepted", { file });
    return { token, source: "env" };
  }
  let existing: string | null = null;
  try {
    existing = readFileSync(file, "utf8").trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new ConfigError(`cannot read admin token file ${file}`);
  }
  if (existing !== null) return { token: checkLength(existing, file), source: "file" };
  if (opts.create === false) throw new ConfigError(`admin token file ${file} does not exist`);
  const token = newToken();
  writeTokenFile(file, token);
  log.info("admin token created; print it with `izle-server admin-token`", { file });
  return { token, source: "file" };
}
