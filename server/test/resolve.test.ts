import { test } from "node:test";
import assert from "node:assert/strict";
import { deliveryPlan, PLAYBACK_SESSION_TTL_MS, PlaybackSessions } from "../src/resolve.ts";
import { fakeClock } from "./helpers.ts";

const hls = { kind: "hls" as const, url: "https://media.example.test/m.m3u8" };
const dash = { kind: "dash" as const, url: "https://media.example.test/m.mpd" };
const referer = { Referer: "https://site.example.test/" };

test("delivery plan: plain media goes direct; headers, inline playlists and proxy.always go through the proxy", () => {
  assert.deepEqual(deliveryPlan({ media: hls }, false), { servable: true, proxyMain: false, proxySubtitles: [] });
  assert.deepEqual(deliveryPlan({ media: hls, headers: {} }, false), { servable: true, proxyMain: false, proxySubtitles: [] }, "empty headers are none");
  assert.deepEqual(deliveryPlan({ media: hls, headers: referer }, false), { servable: true, proxyMain: true, proxySubtitles: [] });
  assert.deepEqual(deliveryPlan({ media: { kind: "mp4", url: "https://media.example.test/v.mp4" } }, true), { servable: true, proxyMain: true, proxySubtitles: [] });
  assert.deepEqual(deliveryPlan({ media: { kind: "hls", playlist: "#EXTM3U\n", baseUrl: "https://media.example.test/" } }, false), {
    servable: true,
    proxyMain: true,
    proxySubtitles: [],
  });
});

test("delivery plan: DASH is never proxied, and DASH that needs headers cannot be served", () => {
  assert.deepEqual(deliveryPlan({ media: dash }, true), { servable: true, proxyMain: false, proxySubtitles: [] }, "proxy.always leaves DASH direct");
  assert.equal(deliveryPlan({ media: dash, headers: referer }, false).servable, false);
});

test("delivery plan: each subtitle track goes through the proxy when it has headers, or with proxy.always", () => {
  const subtitleTracks = [{ headers: referer }, {}, { headers: {} }];
  assert.deepEqual(deliveryPlan({ media: hls, subtitleTracks }, false).proxySubtitles, [true, false, false]);
  assert.deepEqual(deliveryPlan({ media: hls, subtitleTracks }, true).proxySubtitles, [true, true, true]);
});

test("playback sessions: open, look up, expire after their lifetime", () => {
  const clock = fakeClock();
  const sessions = new PlaybackSessions(clock.now);
  const s = sessions.open({ deviceId: "tv", catalogId: "c", itemId: "i", episodeId: "e", sourceId: "s" });
  assert.match(s.id, /^[A-Za-z0-9]{16}$/);
  assert.deepEqual(sessions.get(s.id), { id: s.id, deviceId: "tv", catalogId: "c", itemId: "i", episodeId: "e", sourceId: "s", createdAt: clock.now() });
  assert.equal(sessions.get("nope"), undefined);
  clock.advance(PLAYBACK_SESSION_TTL_MS);
  assert.ok(sessions.get(s.id), "still valid at exactly the lifetime");
  clock.advance(1);
  assert.equal(sessions.get(s.id), undefined);
});

test("playback sessions: a report names only its TV's own session, and the episode it played when it says which", () => {
  const sessions = new PlaybackSessions(fakeClock().now);
  const s = sessions.open({ deviceId: "tv", catalogId: "c", itemId: "i", episodeId: "e", sourceId: "s" });
  assert.equal(sessions.owned(s.id, "tv"), s, "no episode given: any episode");
  assert.equal(sessions.owned(s.id, "tv", "e"), s);
  assert.equal(sessions.owned(s.id, "tv", "other"), undefined, "another episode");
  assert.equal(sessions.owned(s.id, "other-tv"), undefined, "another TV's session");
  assert.equal(sessions.owned("nope", "tv"), undefined);
  assert.equal(sessions.owned(null, "tv"), undefined);
  assert.equal(sessions.owned("", "tv"), undefined);
});
