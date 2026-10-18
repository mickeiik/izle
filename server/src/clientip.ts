import { BlockList, isIP } from "node:net";

/** `::ffff:192.0.2.1` (an IPv4 client on a dual-stack socket) → `192.0.2.1`; anything else unchanged. */
function normalizeIp(address: string): string {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return m ? m[1]! : address;
}

/**
 * Compiles the `trustedProxies` config entries (addresses or CIDR ranges, IPv4 or IPv6). `invalid` is the first
 * entry that is neither, or null.
 */
export function compileTrustedProxies(entries: string[]): { list: BlockList; invalid: string | null } {
  const list = new BlockList();
  for (const entry of entries) {
    const [raw = "", prefix, extra] = entry.trim().split("/");
    const address = prefix === undefined ? normalizeIp(raw) : raw;
    const family = isIP(address);
    if (family === 0 || extra !== undefined) return { list, invalid: entry };
    const type = family === 4 ? "ipv4" : "ipv6";
    if (prefix === undefined) {
      list.addAddress(address, type);
      continue;
    }
    const bits = /^\d{1,3}$/.test(prefix) ? Number(prefix) : NaN;
    if (!(bits >= 0 && bits <= (family === 4 ? 32 : 128))) return { list, invalid: entry };
    list.addSubnet(address, bits, type);
  }
  return { list, invalid: null };
}

function isTrusted(list: BlockList, address: string): boolean {
  const family = isIP(address);
  return family !== 0 && list.check(address, family === 4 ? "ipv4" : "ipv6");
}

/**
 * The client's address for per-client limits. A request from a trusted proxy is attributed to the address that
 * proxy put last in `X-Forwarded-For`; chains of trusted proxies are walked from the right. Entries left of the
 * first untrusted hop are ignored, since a client can send any `X-Forwarded-For` it likes.
 */
export function clientAddress(remote: string | undefined, forwardedFor: string | undefined, trusted: BlockList | null): string {
  let address = remote ? normalizeIp(remote) : "unknown";
  if (!trusted || !forwardedFor) return address;
  const hops = forwardedFor.split(",").map((h) => h.trim()).filter((h) => h !== "");
  while (hops.length > 0 && isTrusted(trusted, address)) address = normalizeIp(hops.pop()!);
  return address;
}

/**
 * The key a client address is counted under by the rate limits: an IPv6 address by its /64 (the block one
 * subscriber or host gets, so a single client cannot mint a fresh key per request), anything else as it is.
 */
export function limiterKey(address: string): string {
  if (isIP(address) !== 6) return address;
  const [head = "", tail] = address.split("%")[0]!.split("::");
  const groups = (part: string | undefined) => (part ? part.split(":") : []);
  // An embedded IPv4 address (`::1.2.3.4`) fills the last 32 bits, two groups.
  const count = (parts: string[]) => parts.reduce((n, p) => n + (p.includes(".") ? 2 : 1), 0);
  const front = groups(head);
  const all = tail === undefined ? front : [...front, ...Array<string>(8 - count(front) - count(groups(tail))).fill("0"), ...groups(tail)];
  return `${all.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":")}::/64`;
}
