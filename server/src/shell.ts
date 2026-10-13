import { networkInterfaces } from "node:os";
import { renderUnicodeCompact } from "uqr";
import type { ServerConfig } from "./config.ts";

/**
 * Helpers for the owner's shell commands (`izle-server pair …`, `izle-server admin-token --link`): where the running
 * server answers on this host, calls to its admin API, and the admin page's sign-in link with its QR code.
 */

/** Where this host's own server answers: the listen address, with a wildcard host turned into loopback. */
export function localServerUrl(config: ServerConfig): string {
  const host = config.listen.host;
  const h = host === "" || host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
  return `http://${h}:${config.listen.port}`;
}

export interface LinkBase {
  url: string;
  /** Where the address came from, for the note printed next to the link. */
  source: "publicUrl" | "listen.host" | "interface" | "loopback";
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * The base URL a phone would open the admin page at: `publicUrl` when set; else a specific, non-loopback listen
 * address; else the first non-internal IPv4 address of this host; else loopback (a server behind a reverse proxy
 * listens on loopback, and its phone-facing address is the proxy's: `publicUrl` or `--base`).
 */
export function linkBase(config: ServerConfig, interfaces: () => ReturnType<typeof networkInterfaces> = networkInterfaces): LinkBase {
  if (config.publicUrl) return { url: config.publicUrl, source: "publicUrl" };
  const host = config.listen.host;
  if (host !== "" && host !== "0.0.0.0" && host !== "::" && !LOOPBACK_HOSTS.has(host)) return { url: localServerUrl(config), source: "listen.host" };
  for (const addresses of Object.values(interfaces())) {
    const a = addresses?.find((x) => x.family === "IPv4" && !x.internal);
    if (a) return { url: `http://${a.address}:${config.listen.port}`, source: "interface" };
  }
  return { url: localServerUrl(config), source: "loopback" };
}

/**
 * The admin page's sign-in link. The token travels in the URL fragment, which browsers never send to the server
 * or a reverse proxy; the page stores it and removes it from the address bar at once.
 */
export function signInLink(base: string, token: string): string {
  return `${base.replace(/\/+$/, "")}/admin/#token=${encodeURIComponent(token)}`;
}

/** The link as a QR code for a terminal (two module rows per text line, so it fits a small window). */
export function qrCode(text: string): string {
  return renderUnicodeCompact(text, { ecc: "M", border: 2 });
}

export interface AdminCallResult {
  status: number;
  // The admin API's JSON, or null when the body was not JSON.
  json: any;
}

export class ServerUnreachableError extends Error {
  override name = "ServerUnreachableError";
}

/** One call to the running server's admin API with the admin token. */
export async function adminCall(server: string, token: string, method: string, route: string, body?: unknown): Promise<AdminCallResult> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`${server.replace(/\/+$/, "")}${route}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  } catch {
    throw new ServerUnreachableError(`no izle server answers at ${server}`);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}
