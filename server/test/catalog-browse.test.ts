import { test } from "node:test";
import assert from "node:assert/strict";
import type { CatalogItem } from "@izle/contract";
import { browse, buildIndex, type BrowseQuery } from "../src/catalog-browse.ts";
import type { Json } from "./helpers.ts";

const source = { id: "s", type: "direct", languages: { audio: ["tr"], subtitles: [] }, media: { kind: "hls", url: "https://media.example.test/s.m3u8" } };
const episode = (id: string, playbackAllowed = true): Json => ({ id, playbackAllowed, sources: playbackAllowed ? [source] : [] });
const movie = (id: string, title: string, extra: Json = {}): Json => ({ id, kind: "movie", title, poster: null, episodes: [episode(`${id}.main`)], ...extra });
const series = (id: string, title: string, episodes: string[], extra: Json = {}): Json => ({ id, kind: "series", title, poster: null, episodes: episodes.map((e) => episode(e)), ...extra });
const channel = (id: string, title: string, playbackAllowed = true): Json => ({ id, kind: "live", title, poster: null, playbackAllowed, sources: playbackAllowed ? [source] : [] });

const T1 = Date.parse("2026-10-11T12:00:00Z");
const T2 = Date.parse("2026-10-12T12:00:00Z");

const items: CatalogItem[] = [
  movie("isik", "Işık", { originalTitle: "Light", year: 2010, genres: ["Drama"] }),
  movie("cafe", "Café Society", { year: 2016, genres: ["DRAMA", "Komedi"] }),
  movie("locked", "Locked", { episodes: [episode("locked.main", false)], genres: ["Komedi"] }),
  series("saga", "Saga", ["saga.e1", "saga.e2", "saga.e3"], { year: 2016, genres: ["Belgesel"] }),
  series("aaa", "Another", ["aaa.e1"]),
  channel("news", "Haber"),
  channel("dark", "Dark channel", false),
];
// "saga" has been there since the baseline and got two episodes at T1 and T2; "aaa" came at T1; channel "news" at T2.
const seen = new Map([
  ["isik", [{ episodeId: "isik.main", firstSeenAt: 0 }]],
  ["cafe", [{ episodeId: "cafe.main", firstSeenAt: 0 }]],
  ["locked", [{ episodeId: "locked.main", firstSeenAt: 0 }]],
  ["saga", [{ episodeId: "saga.e1", firstSeenAt: 0 }, { episodeId: "saga.e2", firstSeenAt: T1 }, { episodeId: "saga.e3", firstSeenAt: T2 }]],
  ["aaa", [{ episodeId: "aaa.e1", firstSeenAt: T1 }]],
]);
const seenItems = [
  { itemId: "news", firstSeenAt: T2, removedAt: null },
  { itemId: "dark", firstSeenAt: 0, removedAt: null },
  { itemId: "gone", firstSeenAt: T1, removedAt: T2 },
];
const index = buildIndex({ items }, seen, seenItems);

const query = (q: Partial<BrowseQuery> = {}): BrowseQuery => ({ q: "", playable: false, sort: "title", offset: 0, limit: 50, ...q });
const ids = (q: Partial<BrowseQuery> = {}) => browse(index, query(q)).hits.map((h) => h.entry.item.id);

test("browse: text matches title, original title and id, folded; never across two of them", () => {
  assert.deepEqual(ids({ q: "ışık" }), ["isik"]);
  assert.deepEqual(ids({ q: "ISIK" }), ["isik"], "dotless ı and ş fold to i and s");
  assert.deepEqual(ids({ q: " cafe " }), ["cafe"], "accents fold, spaces trim");
  assert.deepEqual(ids({ q: "light" }), ["isik"], "original title");
  assert.deepEqual(ids({ q: "aaa" }), ["aaa"], "id");
  assert.deepEqual(ids({ q: "isiklight" }), []);
  assert.equal(ids().length, items.length, "an empty query lists everything");
});

test("browse: facets count kinds, genres under their first spelling, and the years", () => {
  assert.deepEqual(index.facets, {
    kinds: { movie: 3, series: 2, live: 2 },
    genres: [{ name: "Drama", count: 2 }, { name: "Komedi", count: 2 }, { name: "Belgesel", count: 1 }],
    years: { min: 2010, max: 2016 },
  });
  const twice = buildIndex({ items: [movie("m", "M", { genres: ["drama", "Drama"] })] }, new Map(), []);
  assert.deepEqual(twice.facets.genres, [{ name: "drama", count: 1 }], "one item counts once per genre");
  const none = buildIndex({ items: [movie("m", "M"), channel("c", "C")] }, new Map(), []);
  assert.deepEqual([none.facets.genres, none.facets.years], [[], null]);
});

test("browse: kinds, genres (any of, folded), years, playable and excluded items", () => {
  assert.deepEqual(ids({ kinds: ["live"] }), ["dark", "news"]);
  assert.deepEqual(ids({ kinds: ["movie", "series"] }), ["aaa", "cafe", "isik", "locked", "saga"]);
  assert.deepEqual(ids({ genres: ["drama"] }), ["cafe", "isik"]);
  assert.deepEqual(ids({ genres: ["KOMEDİ".toLowerCase(), "belgesel"] }), ["cafe", "locked", "saga"]);
  assert.deepEqual(ids({ yearFrom: 2011 }), ["cafe", "saga"], "items without a year are out of any range");
  assert.deepEqual(ids({ yearTo: 2010 }), ["isik"]);
  assert.deepEqual(ids({ playable: true }), ["aaa", "cafe", "news", "isik", "saga"]);
  assert.deepEqual(ids({ exclude: new Set(["saga", "news", "aaa"]), kinds: ["series", "live"] }), ["dark"]);
});

test("browse: by title, by year (none last), by newest (ties by title)", () => {
  assert.deepEqual(ids(), ["aaa", "cafe", "dark", "news", "isik", "locked", "saga"]);
  assert.deepEqual(ids({ sort: "year" }), ["cafe", "saga", "isik", "aaa", "dark", "news", "locked"]);
  assert.deepEqual(ids({ sort: "newest" }), ["news", "saga", "aaa", "cafe", "dark", "isik", "locked"]);
});

test("browse: since is at or after a time and never matches the baseline; new episodes counted, null for a channel", () => {
  const since = (t: number) => browse(index, query({ since: t })).hits.map((h) => [h.entry.item.id, h.newEpisodes]);
  assert.deepEqual(since(T1), [["aaa", 1], ["news", null], ["saga", 2]]);
  assert.deepEqual(since(T2), [["news", null], ["saga", 1]], "exactly the build's load time matches");
  assert.deepEqual(since(T2 + 1), []);
  assert.deepEqual(since(1), [["aaa", 1], ["news", null], ["saga", 2]], "baseline rows (0) are never new");
  const plain = browse(index, query({ q: "saga" })).hits[0];
  assert.deepEqual([plain.newEpisodes, plain.entry.firstSeenAt, plain.entry.latestEpisodeAt], [0, 0, T2], "no since, no new episodes");
  assert.equal(browse(index, query({ q: "news" })).hits[0].entry.firstSeenAt, T2);
});

test("browse: pages count every match; an offset past the end is empty", () => {
  const page = browse(index, query({ offset: 2, limit: 3 }));
  assert.deepEqual([page.hits.map((h) => h.entry.item.id), page.total, page.offset], [["dark", "news", "isik"], 7, 2]);
  const past = browse(index, query({ offset: 50 }));
  assert.deepEqual([past.hits, past.total, past.offset], [[], 7, 50]);
});
