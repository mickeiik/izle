// Helpers for the owner's shell commands: calls to the running server's admin API, and the admin page's sign-in
// link (its base address) with its QR code.

import { networkInterfaces } from "node:os";
import { renderUnicodeCompact } from "uqr";
import { isWildcardHost, localServerUrl, type ServerConfig } from "./config.ts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * The base URL a phone would open the admin page at, and where it came from (for the note next to the link):
 * `publicUrl`; else a specific, non-loopback listen address; else this host's first non-internal IPv4 address; else
 * loopback (behind a reverse proxy the phone-facing address is the proxy's: `publicUrl` or `--base`).
 */
type LinkBase = { url: string; source: "publicUrl" | "listen.host" | "interface" | "loopback" };

export function linkBase(config: ServerConfig, interfaces = networkInterfaces): LinkBase {
  if (config.publicUrl) return { url: config.publicUrl, source: "publicUrl" };
  const host = config.listen.host;
  if (!isWildcardHost(host) && !LOOPBACK_HOSTS.has(host)) return { url: localServerUrl(config), source: "listen.host" };
  for (const addresses of Object.values(interfaces())) {
    const a = addresses?.find((x) => x.family === "IPv4" && !x.internal);
    if (a) return { url: `http://${a.address}:${config.listen.port}`, source: "interface" };
  }
  return { url: localServerUrl(config), source: "loopback" };
}

/** The token travels in the URL fragment, which browsers never send; the page stores it and removes it at once. */
export function signInLink(base: string, token: string): string {
  return `${base.replace(/\/+$/, "")}/admin/#token=${encodeURIComponent(token)}`;
}

/** The link as a QR code for a terminal (two module rows per text line, so it fits a small window). */
export function qrCode(text: string): string {
  return renderUnicodeCompact(text, { ecc: "M", border: 2 });
}

export class ServerUnreachableError extends Error {
  override name = "ServerUnreachableError";
}

/** The status and the JSON answer (null when it is not JSON). */
type AdminAnswer<T> = { status: number; json: T | null };

/** One call to the running server's admin API with the admin token. */
export async function adminCall<T>(server: string, token: string, method: string, route: string, body?: unknown): Promise<AdminAnswer<T>> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`${server.replace(/\/+$/, "")}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ServerUnreachableError(`no izle server answers at ${server}`);
  }
  const text = await res.text();
  try {
    return { status: res.status, json: text ? JSON.parse(text) : null };
  } catch {
    return { status: res.status, json: null };
  }
}
