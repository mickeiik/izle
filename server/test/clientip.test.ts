import { test } from "node:test";
import assert from "node:assert/strict";
import { clientAddress, compileTrustedProxies, limiterKey } from "../src/clientip.ts";

test("compileTrustedProxies accepts addresses and CIDR ranges and names the first bad entry", () => {
  const { list, invalid } = compileTrustedProxies(["127.0.0.1", "::1", "172.16.0.0/12", "fd00::/8", "::ffff:10.1.1.1"]);
  assert.equal(invalid, null);
  for (const a of ["127.0.0.1", "172.20.3.4", "10.1.1.1"]) assert.ok(list.check(a, "ipv4"), a);
  for (const a of ["::1", "fd12::5"]) assert.ok(list.check(a, "ipv6"), a);
  assert.ok(!list.check("172.32.0.1", "ipv4"));
  for (const bad of ["localhost", "10.0.0.0/33", "fd00::/129", "10.0.0.0/8/1", "10.0.0.0/", "1.2.3.4/x", "999.1.1.1"]) {
    assert.equal(compileTrustedProxies(["127.0.0.1", bad]).invalid, bad, bad);
  }
});

test("clientAddress walks X-Forwarded-For from the right through trusted proxies only", () => {
  const trusted = compileTrustedProxies(["127.0.0.1", "10.0.0.0/8"]).list;
  const cases: Array<[string | undefined, string | undefined, boolean, string, string]> = [
    ["127.0.0.1", "203.0.113.9", false, "127.0.0.1", "no trust configured: the header is ignored"],
    ["::FFFF:10.0.0.7", undefined, false, "10.0.0.7", "IPv4-mapped IPv6 addresses are unwrapped"],
    ["2001:db8::1", undefined, false, "2001:db8::1", "and only those"],
    ["198.51.100.4", "203.0.113.9", true, "198.51.100.4", "a direct client's own header is ignored"],
    ["127.0.0.1", "203.0.113.9", true, "203.0.113.9", "through the local proxy"],
    ["::ffff:127.0.0.1", " 203.0.113.9 ", true, "203.0.113.9", "a mapped proxy address, a padded header"],
    ["127.0.0.1", "1.1.1.1, 203.0.113.9", true, "203.0.113.9", "a client-supplied prefix is ignored"],
    ["127.0.0.1", "203.0.113.9, 10.2.3.4", true, "203.0.113.9", "two trusted hops"],
    ["127.0.0.1", "10.2.3.4", true, "10.2.3.4", "only trusted hops: the leftmost one is all we know"],
    ["127.0.0.1", undefined, true, "127.0.0.1", "no header"],
    [undefined, "203.0.113.9", true, "unknown", "no remote address"],
    ["127.0.0.1", "1.1.1.1, unknown", true, "unknown", "garbage from the proxy is used as is and never trusted further"],
  ];
  for (const [remote, xff, trust, expected, why] of cases) assert.equal(clientAddress(remote, xff, trust ? trusted : null), expected, why);
});

test("limiterKey counts an IPv6 client by its /64 and leaves everything else as it is", () => {
  assert.equal(limiterKey("2001:db8:1:2::1"), "2001:db8:1:2::/64");
  assert.equal(limiterKey("2001:0db8:0001:0002:ffff:eeee:dddd:cccc"), "2001:db8:1:2::/64", "leading zeros and the host half go");
  assert.equal(limiterKey("2001:DB8:1:2:a:b:c:d"), "2001:db8:1:2::/64", "case does not matter");
  assert.equal(limiterKey("2001:db8::"), "2001:db8:0:0::/64");
  assert.equal(limiterKey("2001:db8::5:6:7:8:9"), "2001:db8:0:5::/64");
  assert.equal(limiterKey("::1"), "0:0:0:0::/64");
  assert.equal(limiterKey("::"), "0:0:0:0::/64");
  assert.equal(limiterKey("fe80::1%eth0"), "fe80:0:0:0::/64", "a zone is dropped");
  assert.equal(limiterKey("64:ff9b::192.0.2.1"), "64:ff9b:0:0::/64", "an embedded IPv4 tail");
  assert.equal(limiterKey("1:2:3:4:5:6:192.0.2.1"), "1:2:3:4::/64");
  assert.equal(new Set(Array.from({ length: 100 }, (_, i) => limiterKey(`2001:db8:aa:bb:${i.toString(16)}::${i}`))).size, 1, "one key for the whole /64");
  assert.notEqual(limiterKey("2001:db8:aa:bb::1"), limiterKey("2001:db8:aa:bc::1"), "another /64 is another key");
  for (const same of ["203.0.113.9", "unknown", "10.0.0.1"]) assert.equal(limiterKey(same), same);
});
