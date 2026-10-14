import { test } from "node:test";
import assert from "node:assert/strict";
import type { CatalogItem, Source } from "@izle/contract";
import {
  audioRank,
  autoNextIndex,
  cursorAfterFinished,
  cursorAfterReport,
  cursorIndex,
  firstAllowedIndex,
  isPlayable,
  orderSources,
  type ProgressLike,
} from "../src/playback.ts";
import { fixtureItems } from "./helpers.ts";

const items = fixtureItems().items as CatalogItem[];
const show = items.find((i) => i.id === "show")!;
const locked = items.find((i) => i.id === "locked")!;
const progress = (entries: Array<[string, ProgressLike["status"]]>) =>
  new Map(entries.map(([episodeId, status]) => [episodeId, { episodeId, positionMs: 0, durationMs: null, status }]));

test("cursor: first allowed unfinished episode without a cursor, wrapping to the first when all are finished", () => {
  assert.equal(cursorIndex(show, null, new Map()), 0);
  assert.equal(cursorIndex(show, null, progress([["show.e1", "finished"]])), 1);
  assert.equal(cursorIndex(show, null, progress([["show.e1", "finished"], ["show.e2", "finished"]])), 3, "skips the not-allowed e3");
  const all = progress(["show.e1", "show.e2", "show.e4", "show.e5"].map((e) => [e, "finished"] as [string, "finished"]));
  assert.equal(cursorIndex(show, null, all), 0);
  assert.equal(cursorIndex(locked, null, new Map()), -1);
  assert.equal(isPlayable(locked), false);
});

test("cursor: an explicit cursor wins; a cursor on a disallowed or vanished episode moves on", () => {
  assert.equal(cursorIndex(show, "show.e4", progress([["show.e4", "finished"]])), 3);
  assert.equal(cursorIndex(show, "show.e3", new Map()), 3, "e3 is not allowed → next allowed e4");
  assert.equal(cursorIndex(show, "gone", progress([["show.e1", "finished"]])), 1);
});

// The fixture's show as if a later build appended e6 (not allowed), e7 and e8, after it was watched to the end.
const grown: CatalogItem = {
  ...show,
  episodes: [
    ...show.episodes,
    { ...show.episodes[4]!, id: "show.e6", playbackAllowed: false, sources: [] },
    { ...show.episodes[4]!, id: "show.e7" },
    { ...show.episodes[4]!, id: "show.e8" },
  ],
};
const wrapped = { episodeId: "show.e1", wrapped: true };
const watched = progress(["show.e1", "show.e2", "show.e4", "show.e5"].map((e) => [e, "finished"] as [string, "finished"]));

test("cursor: a wrapped cursor plays the first appended episode with playbackAllowed in play order", () => {
  assert.equal(cursorIndex(grown, wrapped, watched, new Set(["show.e8", "show.e7"])), 6, "play order, not the set's order");
  assert.equal(cursorIndex(grown, wrapped, watched, new Set(["show.e6", "show.e8"])), 7, "an appended episode that is not allowed is skipped");
  assert.equal(cursorIndex(grown, wrapped, watched, new Set(["show.e6"])), 0, "none allowed: the cursor episode");
});

test("cursor: without appended episodes, or with an ordinary cursor, the rules are unchanged", () => {
  assert.equal(cursorIndex(grown, wrapped, watched), 0, "wrapped without appended episodes: the cursor episode");
  assert.equal(cursorIndex(grown, wrapped, watched, new Set()), 0);
  assert.equal(cursorIndex(grown, { episodeId: "show.e1", wrapped: false }, watched, new Set(["show.e7"])), 0, "an ordinary cursor ignores them");
  assert.equal(cursorIndex(grown, "show.e1", watched, new Set(["show.e7"])), 0, "a bare episode id is an ordinary cursor");
  assert.equal(cursorIndex(grown, null, watched, new Set(["show.e7"])), 6, "without a cursor: the first unfinished allowed episode");
  assert.equal(cursorIndex(grown, { episodeId: "show.e3", wrapped: true }, watched, new Set(["show.e6"])), 3, "a disallowed cursor moves on as before");
});

test("finishing an episode advances the cursor to the next allowed one and wraps after the last", () => {
  assert.equal(cursorAfterFinished(show, 0), 1);
  assert.equal(cursorAfterFinished(show, 1), 3, "autoAdvance:false does not stop the cursor; e3 is skipped");
  assert.equal(cursorAfterFinished(show, 4), 0);
  assert.equal(firstAllowedIndex(show), 0);
});

test("cursor after a report: finished moves on (wrapping after the last), anything else stays on the episode", () => {
  const at = (episodeId: string, wrapped = false) => ({ episodeId, wrapped });
  assert.deepEqual(cursorAfterReport(show, 0, "finished", at("show.e1")), { episodeId: "show.e2", wrapped: false, changed: true });
  assert.deepEqual(cursorAfterReport(show, 1, "finished", at("show.e2")), { episodeId: "show.e4", wrapped: false, changed: true }, "the disallowed e3 is skipped");
  assert.deepEqual(cursorAfterReport(show, 4, "finished", at("show.e5")), { episodeId: "show.e1", wrapped: true, changed: true }, "after the last: wrapped to the first");
  assert.deepEqual(cursorAfterReport(show, 3, "finished", null), { episodeId: "show.e5", wrapped: false, changed: true });
  assert.deepEqual(cursorAfterReport(show, 0, "playing", at("show.e1")), { episodeId: "show.e1", wrapped: false, changed: false }, "a heartbeat changes nothing");
  assert.deepEqual(cursorAfterReport(show, 0, "paused", at("show.e1")), { episodeId: "show.e1", wrapped: false, changed: false });
  assert.deepEqual(cursorAfterReport(show, 0, "stopped", at("show.e1")), { episodeId: "show.e1", wrapped: false, changed: true }, "leaving the player is a change");
});

test("cursor after a report: a heartbeat changes the state only when the cursor moves or stops being wrapped", () => {
  const at = (episodeId: string, wrapped = false) => ({ episodeId, wrapped });
  assert.deepEqual(cursorAfterReport(show, 3, "playing", at("show.e1")), { episodeId: "show.e4", wrapped: false, changed: true }, "another episode");
  assert.deepEqual(cursorAfterReport(show, 0, "playing", null), { episodeId: "show.e1", wrapped: false, changed: true }, "no cursor yet");
  assert.deepEqual(cursorAfterReport(show, 0, "playing", at("show.e1", true)), { episodeId: "show.e1", wrapped: false, changed: true }, "wrapped becomes ordinary");
  assert.deepEqual(cursorAfterReport(show, 4, "finished", at("show.e1", true)), { episodeId: "show.e1", wrapped: true, changed: true });
  assert.deepEqual(cursorAfterReport(locked, 0, "finished", null), { episodeId: "locked.main", wrapped: true, changed: true }, "nothing allowed: the cursor stays");
});

test("auto-next respects play order, playbackAllowed and autoAdvance boundaries", () => {
  assert.equal(autoNextIndex(show, 0), 1);
  assert.equal(autoNextIndex(show, 1), -1, "e2 has autoAdvance:false");
  assert.equal(autoNextIndex(show, 3), 4);
  assert.equal(autoNextIndex(show, 4), -1, "end of the series");
  assert.equal(autoNextIndex({ ...show, autoAdvance: false }, 0), -1, "item-level autoAdvance:false");
  assert.equal(autoNextIndex({ ...show, autoAdvance: false, episodes: show.episodes.map((e, i) => (i === 0 ? { ...e, autoAdvance: true } : e)) }, 0), 1);
});

test("audio rank: match (or no dialogue, or no preference) < unknown < mismatch", () => {
  assert.equal(audioRank({ audio: ["tr-TR"], subtitles: [] }, "tr"), 0);
  assert.equal(audioRank({ audio: ["en"], subtitles: [] }, "pt-BR"), 2);
  assert.equal(audioRank({ audio: ["pt"], subtitles: [] }, "pt-BR"), 0);
  assert.equal(audioRank({ audio: null, subtitles: null }, "tr"), 1);
  assert.equal(audioRank({ audio: [], subtitles: [] }, "tr"), 0);
  assert.equal(audioRank({ audio: ["en"], subtitles: [] }, null), 0);
});

test("source order: audio match > unknown > mismatch, stable, exclusions removed, failures last", () => {
  const sources = show.episodes[0]!.sources as Source[];
  const ids = (s: Source[]) => s.map((x) => x.id);
  assert.deepEqual(ids(orderSources(sources, { preferredAudioLanguage: "tr" })), ["tr-dub", "multi", "unknown", "en-orig"]);
  assert.deepEqual(ids(orderSources(sources, { preferredAudioLanguage: "en" })), ["en-orig", "multi", "unknown", "tr-dub"]);
  assert.deepEqual(ids(orderSources(sources, { preferredAudioLanguage: null })), ["unknown", "en-orig", "tr-dub", "multi"]);
  assert.deepEqual(ids(orderSources(sources, { preferredAudioLanguage: "tr", exclude: new Set(["tr-dub"]) })), ["multi", "unknown", "en-orig"]);
  assert.deepEqual(ids(orderSources(sources, { preferredAudioLanguage: "tr", failed: new Set(["tr-dub", "unknown"]) })), ["multi", "en-orig", "tr-dub", "unknown"]);
});
