// Where the media proxy may connect. Upstream playlist text and upstream redirects name the URLs the proxy fetches,
// so without a policy a playlist author could steer the server's requests into its own network (loopback services,
// the LAN, cloud metadata). Every destination is vetted: IP literals before the request, host names in the
// connection's own DNS lookup, so the address that was checked is the address connected to. Loopback, private,
// link-local, CGNAT, multicast, reserved and unspecified addresses are refused unless the owner lists the upstream
// in `proxy.privateUpstreams`.

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { pipeline, Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { compileTrustedProxies } from "./clientip.ts";

const DENIED_RANGES: ReadonlyArray<[network: string, prefix: number, type: "ipv4" | "ipv6"]> = [
  ["0.0.0.0", 8, "ipv4"], // "this network", unspecified
  ["10.0.0.0", 8, "ipv4"],
  ["100.64.0.0", 10, "ipv4"], // CGNAT
  ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"], // link-local, cloud metadata
  ["172.16.0.0", 12, "ipv4"],
  ["192.0.0.0", 24, "ipv4"], // IETF protocol assignments
  ["192.168.0.0", 16, "ipv4"],
  ["198.18.0.0", 15, "ipv4"], // benchmarking
  ["224.0.0.0", 4, "ipv4"], // multicast
  ["240.0.0.0", 4, "ipv4"], // reserved, broadcast
  ["::", 96, "ipv6"], // unspecified, loopback, IPv4-compatible
  ["64:ff9b:1::", 48, "ipv6"], // local-use NAT64
  ["100::", 64, "ipv6"], // discard
  ["fc00::", 7, "ipv6"], // unique local
  ["fe80::", 10, "ipv6"], // link-local
  ["fec0::", 10, "ipv6"], // site-local (deprecated)
  ["ff00::", 8, "ipv6"], // multicast
];

const DENIED = new BlockList();
for (const [network, prefix, type] of DENIED_RANGES) DENIED.addSubnet(network, prefix, type);

/** Why a destination was refused; never the URL or the address. */
export type EgressRefusal = "scheme" | "credentials_in_url" | "private_address";

/** A destination the policy refuses. Its message names the reason only. */
export class EgressDenied extends Error {
  override name = "EgressDenied";
  readonly code = "EGRESS_DENIED";
  readonly reason: EgressRefusal;
  constructor(reason: EgressRefusal) {
    super(`destination refused: ${reason}`);
    this.reason = reason;
  }
}

/** The refusal behind a failed upstream request (thrown itself, or as the `cause` of a network error), or null. */
export function egressRefusal(err: unknown): EgressDenied | null {
  if (err instanceof EgressDenied) return err;
  const cause = (err as { cause?: unknown } | null)?.cause;
  return cause instanceof EgressDenied ? cause : null;
}

/** The IPv4 address an IPv4-mapped (`::ffff:a.b.c.d`) or NAT64 (`64:ff9b::a.b.c.d`) IPv6 address carries, or null. */
function embeddedIpv4(v6: string): string | null {
  let canonical: string;
  try {
    canonical = new URL(`http://[${v6.split("%")[0]}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
  const m = /^(?:::ffff:|64:ff9b::)(?:([0-9a-f]{1,4}):)?([0-9a-f]{1,4})$/.exec(canonical);
  if (!m) return null;
  const high = parseInt(m[1] ?? "0", 16);
  const low = parseInt(m[2]!, 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

/** An address as the policy checks it: IPv4 inside IPv6 as plain IPv4, the zone of a scoped address dropped. */
function checkedAddress(address: string): { address: string; type: "ipv4" | "ipv6" } | null {
  const plain = address.split("%")[0]!;
  const family = isIP(plain);
  if (family === 4) return { address: plain, type: "ipv4" };
  if (family !== 6) return null;
  const v4 = embeddedIpv4(plain);
  return v4 ? { address: v4, type: "ipv4" } : { address: plain, type: "ipv6" };
}

interface Rule {
  /** A host name (lowercase, no trailing dot), or null: `net` decides. */
  name: string | null;
  net: BlockList | null;
  /** null = any port. */
  port: number | null;
}

const HOST_NAME = /^(?=.{1,253}$)[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*$/;

/** One `proxy.privateUpstreams` entry as a rule, or null when it is none of the accepted forms. */
function compileRule(entry: string): Rule | null {
  const e = entry.trim().toLowerCase().replace(/\.$/, "");
  if (e.includes("/") || isIP(e) !== 0) {
    const { list, invalid } = compileTrustedProxies([e]);
    return invalid === null ? { name: null, net: list, port: null } : null;
  }
  const withPort = /^\[([0-9a-f:.]+)\]:(\d{1,5})$/.exec(e) ?? /^([^:]+):(\d{1,5})$/.exec(e);
  const host = withPort ? withPort[1]! : e;
  const port = withPort ? Number(withPort[2]) : null;
  if (port !== null && !(port >= 1 && port <= 65535)) return null;
  if (isIP(host) !== 0) {
    const { list, invalid } = compileTrustedProxies([host]);
    return invalid === null ? { name: null, net: list, port } : null;
  }
  // A name made only of digits and dots is an IPv4 address with a typo, not a host.
  return HOST_NAME.test(host) && !/^[\d.]+$/.test(host) ? { name: host, net: null, port } : null;
}

/** The first `proxy.privateUpstreams` entry that is not a host, address, CIDR range or one of those with a port. */
export function invalidPrivateUpstream(entries: string[]): string | null {
  return entries.find((e) => compileRule(e) === null) ?? null;
}

/** The URL's host as rules see it: lowercase, no brackets, no trailing dot. */
const hostOf = (url: URL): string => url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
const portOf = (url: URL): number => (url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80);

export interface EgressPolicy {
  /** Whether a connection to `address` for `host`:`port` is allowed. */
  allows(host: string, port: number, address: string): boolean;
  /** Throws EgressDenied for a URL that is refused before any lookup: its scheme, credentials or IP literal. */
  check(url: URL): void;
}

/** The policy, with `privateUpstreams` (validated config entries) as the owner's exceptions. */
export function egressPolicy(privateUpstreams: string[] = []): EgressPolicy {
  const rules = privateUpstreams.map(compileRule).filter((r) => r !== null);
  const allows = (host: string, port: number, address: string): boolean => {
    const a = checkedAddress(address);
    if (a === null) return false;
    if (!DENIED.check(a.address, a.type)) return true;
    const name = host.toLowerCase();
    return rules.some((r) => (r.port === null || r.port === port) && (r.name !== null ? r.name === name : r.net!.check(a.address, a.type)));
  };
  return {
    allows,
    check(url) {
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new EgressDenied("scheme");
      if (url.username || url.password) throw new EgressDenied("credentials_in_url");
      const host = hostOf(url);
      if (isIP(host) !== 0 && !allows(host, portOf(url), host)) throw new EgressDenied("private_address");
    },
  };
}

/** How the proxy talks to upstreams: one GET, redirects answered as they are (the caller vets each Location). */
export type UpstreamFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal; redirect: "manual" }) => Promise<Response>;

/** Defaults the global fetch sends too, so upstreams see the same request as before the policy. */
const DEFAULT_HEADERS = { accept: "*/*", "accept-encoding": "gzip, br", "user-agent": "node" };
const NULL_BODY_STATUS = new Set([204, 205, 304]);

/** The upstream response as a fetch Response; the body is decoded like fetch does (gzip, deflate, br). */
function toResponse(res: IncomingMessage): Response {
  const status = res.statusCode ?? 0;
  const headers = new Headers();
  for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
    try {
      headers.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!);
    } catch {
      // a header fetch would refuse too
    }
  }
  if (NULL_BODY_STATUS.has(status)) {
    res.resume();
    return new Response(null, { status, headers });
  }
  const encoding = (res.headers["content-encoding"] ?? "").trim().toLowerCase();
  const decoder = encoding === "gzip" || encoding === "x-gzip" ? createGunzip() : encoding === "deflate" ? createInflate() : encoding === "br" ? createBrotliDecompress() : null;
  const body: Readable = decoder ? pipeline(res, decoder, () => {}) : res;
  return new Response(Readable.toWeb(body) as ReadableStream<Uint8Array>, { status, headers });
}

/**
 * An UpstreamFetch over node:http(s) that enforces `policy`: the URL is checked first, and a host name is resolved
 * by the connection's own lookup, which hands the socket only the addresses the policy allows (the request fails
 * with EgressDenied when none is left). Failures reject like fetch: a TypeError whose `cause` is the error.
 */
export function egressFetch(policy: EgressPolicy): UpstreamFetch {
  const agents = { "http:": new HttpAgent({ keepAlive: true }), "https:": new HttpsAgent({ keepAlive: true }) };
  return (url, init) =>
    new Promise<Response>((resolve, reject) => {
      const u = new URL(url);
      try {
        policy.check(u);
      } catch (err) {
        reject(new TypeError("fetch failed", { cause: err }));
        return;
      }
      const host = hostOf(u);
      const port = portOf(u);
      const lookup: LookupFunction = (hostname, options, callback) => {
        dnsLookup(hostname, { family: options.family ?? 0, hints: options.hints ?? 0, all: true }, (err, found: LookupAddress[]) => {
          if (err) return callback(err, "", 0);
          const allowed = found.filter((a) => policy.allows(host, port, a.address));
          if (allowed.length === 0) return callback(new EgressDenied("private_address"), "", 0);
          if (options.all) return callback(null, allowed);
          callback(null, allowed[0]!.address, allowed[0]!.family);
        });
      };
      const headers: Record<string, string> = { ...DEFAULT_HEADERS };
      for (const [name, value] of Object.entries(init.headers)) headers[name.toLowerCase()] = value;
      const send = u.protocol === "https:" ? httpsRequest : httpRequest;
      const req = send(u, { method: "GET", headers, agent: agents[u.protocol as "http:" | "https:"], lookup, signal: init.signal }, (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status > 599) {
          res.destroy();
          reject(new TypeError("fetch failed", { cause: Object.assign(new Error("invalid status"), { code: "INVALID_STATUS" }) }));
          return;
        }
        resolve(toResponse(res));
      });
      req.on("error", (err) => reject(new TypeError("fetch failed", { cause: err })));
      req.end();
    });
}
