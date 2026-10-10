import { test } from "node:test";
import assert from "node:assert/strict";
import { clientAddress, compileTrustedProxies, normalizeIp } from "../src/clientip.ts";

test("normalizeIp unwraps IPv4-mapped IPv6 addresses only", () => {
  assert.equal(normalizeIp("::ffff:192.0.2.1"), "192.0.2.1");
  assert.equal(normalizeIp("::FFFF:10.0.0.7"), "10.0.0.7");
  assert.equal(normalizeIp("2001:db8::1"), "2001:db8::1");
  assert.equal(normalizeIp("192.0.2.1"), "192.0.2.1");
});

test("compileTrustedProxies accepts addresses and CIDR ranges and names the first bad entry", () => {
  const { list, invalid } = compileTrustedProxies(["127.0.0.1", "::1", "172.16.0.0/12", "fd00::/8", "::ffff:10.1.1.1"]);
  assert.equal(invalid, null);
  assert.ok(list.check("127.0.0.1", "ipv4"));
  assert.ok(list.check("172.20.3.4", "ipv4"));
  assert.ok(!list.check("172.32.0.1", "ipv4"));
  assert.ok(list.check("::1", "ipv6"));
  assert.ok(list.check("fd12::5", "ipv6"));
  assert.ok(list.check("10.1.1.1", "ipv4"));
  for (const bad of ["localhost", "10.0.0.0/33", "fd00::/129", "10.0.0.0/8/1", "10.0.0.0/", "1.2.3.4/x", "999.1.1.1"]) {
    assert.equal(compileTrustedProxies(["127.0.0.1", bad]).invalid, bad, bad);
  }
});

test("clientAddress walks X-Forwarded-For from the right through trusted proxies only", () => {
  const trusted = compileTrustedProxies(["127.0.0.1", "10.0.0.0/8"]).list;
  // No trust configured: the header is ignored.
  assert.equal(clientAddress("127.0.0.1", "203.0.113.9", null), "127.0.0.1");
  // Direct client (not a proxy): its own header is ignored.
  assert.equal(clientAddress("198.51.100.4", "203.0.113.9", trusted), "198.51.100.4");
  // Through the local proxy.
  assert.equal(clientAddress("127.0.0.1", "203.0.113.9", trusted), "203.0.113.9");
  assert.equal(clientAddress("::ffff:127.0.0.1", " 203.0.113.9 ", trusted), "203.0.113.9");
  // A client-supplied prefix is ignored: the proxy appended the real address last.
  assert.equal(clientAddress("127.0.0.1", "1.1.1.1, 203.0.113.9", trusted), "203.0.113.9");
  // Two trusted hops.
  assert.equal(clientAddress("127.0.0.1", "203.0.113.9, 10.2.3.4", trusted), "203.0.113.9");
  // Only trusted hops: the leftmost one is all we know.
  assert.equal(clientAddress("127.0.0.1", "10.2.3.4", trusted), "10.2.3.4");
  // Missing header or remote address.
  assert.equal(clientAddress("127.0.0.1", undefined, trusted), "127.0.0.1");
  assert.equal(clientAddress(undefined, "203.0.113.9", trusted), "unknown");
  // Garbage from the proxy is used as is (it is only a rate-limit key) and never trusted further.
  assert.equal(clientAddress("127.0.0.1", "1.1.1.1, unknown", trusted), "unknown");
});
