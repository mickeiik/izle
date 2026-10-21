import { test } from "node:test";
import assert from "node:assert/strict";
import { deliveryPlan, PlaybackSessions } from "../src/resolve.ts";
import { fakeClock } from "./helpers.ts";

const hls = { kind: "hls" as const, url: "https://media.example.test/m.m3u8" };
const dash = { kind: "dash" as const, url: "https://media.example.test/m.mpd" };
const referer = { Referer: "https://site.example.test/" };

test("delivery plan: headers, inline playlists and proxy.always go through the proxy; DASH never does", () => {
  const plan = (s: Parameters<typeof deliveryPlan>[0], always = false) => deliveryPlan(s, always);
  const direct = { servable: true, proxyMain: false, proxySubtitles: [] };
  const proxied = { servable: true, proxyMain: true, proxySubtitles: [] };
  assert.deepEqual(plan({ media: hls }), direct);
  assert.deepEqual(plan({ media: hls, headers: {} }), direct, "empty headers are none");
  assert.deepEqual(plan({ media: hls, headers: referer }), proxied);
  assert.deepEqual(plan({ media: { kind: "mp4", url: "https://media.example.test/v.mp4" } }, true), proxied);
  assert.deepEqual(plan({ media: { kind: "hls", playlist: "#EXTM3U\n", baseUrl: "https://media.example.test/" } }), proxied);
  assert.deepEqual(plan({ media: dash }, true), direct, "proxy.always leaves DASH direct");
  assert.equal(plan({ media: dash, headers: referer }).servable, false, "DASH that needs headers cannot be served");
  assert.deepEqual(plan({ media: { kind: "ts", url: "https://media.example.test/live.ts" } }), direct, "MPEG-TS goes direct like MP4");
  assert.deepEqual(plan({ media: { kind: "ts", url: "https://media.example.test/live.ts" }, headers: referer }), proxied, "and is proxied with headers");
  const subtitleTracks = [{ headers: referer }, {}, { headers: {} }];
  assert.deepEqual(plan({ media: hls, subtitleTracks }).proxySubtitles, [true, false, false]);
  assert.deepEqual(plan({ media: hls, subtitleTracks }, true).proxySubtitles, [true, true, true]);
});

test("playback sessions: open, look up, expire after their lifetime", () => {
  const clock = fakeClock();
  const sessions = new PlaybackSessions(clock.now);
  const s = sessions.open({ deviceId: "tv", catalogId: "c", itemId: "i", episodeId: "e", sourceId: "s" });
  assert.match(s.id, /^[A-Za-z0-9]{16}$/);
  assert.deepEqual(sessions.get(s.id), { id: s.id, deviceId: "tv", catalogId: "c", itemId: "i", episodeId: "e", sourceId: "s", createdAt: clock.now() });
  assert.equal(sessions.get("nope"), undefined);
  clock.advance(12 * 60 * 60_000);
  assert.ok(sessions.get(s.id), "still valid at exactly the lifetime (12 h)");
  clock.advance(1);
  assert.equal(sessions.get(s.id), undefined);
});

test("playback sessions: a report names only its TV's own session, and what it played when it says which", () => {
  const sessions = new PlaybackSessions(fakeClock().now);
  const s = sessions.open({ deviceId: "tv", catalogId: "c", itemId: "i", episodeId: "e", sourceId: "s" });
  assert.equal(sessions.owned(s.id, "tv"), s, "nothing given: any playback");
  assert.equal(sessions.owned(s.id, "tv", { episodeId: "e" }), s);
  assert.equal(sessions.owned(s.id, "tv", { itemId: "i" }), s);
  assert.equal(sessions.owned(s.id, "tv", { episodeId: "other" }), undefined, "another episode");
  assert.equal(sessions.owned(s.id, "tv", { itemId: "i", episodeId: null }), undefined, "an episode session is not the item's channel");
  assert.equal(sessions.owned(s.id, "other-tv"), undefined, "another TV's session");
  assert.equal(sessions.owned("nope", "tv"), undefined);
  assert.equal(sessions.owned(null, "tv"), undefined);
  assert.equal(sessions.owned("", "tv"), undefined);
  // A channel's session has no episode: an episode id (even one equal to the item id) never names it.
  const live = sessions.open({ deviceId: "tv", catalogId: "c", itemId: "news", episodeId: null, sourceId: "main" });
  assert.equal(sessions.owned(live.id, "tv", { itemId: "news", episodeId: null }), live);
  assert.equal(sessions.owned(live.id, "tv", { episodeId: "news" }), undefined);
  assert.equal(sessions.owned(live.id, "tv", { itemId: "other", episodeId: null }), undefined);
});
