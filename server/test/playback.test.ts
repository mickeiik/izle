import { test } from "node:test";
import assert from "node:assert/strict";
import type { EpisodicItem, Source } from "@izle/contract";
import { autoNextIndex, cursorAfterReport, cursorIndex, isPlayable, orderSources } from "../src/playback.ts";
import { fixtureItems } from "./helpers.ts";

const items = fixtureItems().items as EpisodicItem[];
const show = items.find((i) => i.id === "show")!;
const locked = items.find((i) => i.id === "locked")!;
/** Saved positions with these episodes finished. */
const finished = (...ids: string[]) => new Map(ids.map((id) => [id, { status: "finished" as const }]));
const watched = finished("show.e1", "show.e2", "show.e4", "show.e5");
const at = (episodeId: string) => ({ episodeId, wrapped: false });

test("cursor: without one, the first allowed unfinished episode (else the first); a given one wins or moves on", () => {
  assert.equal(cursorIndex(show, null, new Map()), 0);
  assert.equal(cursorIndex(show, null, finished("show.e1")), 1);
  assert.equal(cursorIndex(show, null, finished("show.e1", "show.e2")), 3, "skips the not-allowed e3");
  assert.equal(cursorIndex(show, null, watched), 0);
  assert.equal(cursorIndex(locked, null, new Map()), -1);
  assert.equal(isPlayable(locked), false);
  assert.equal(cursorIndex(show, at("show.e4"), finished("show.e4")), 3);
  assert.equal(cursorIndex(show, at("show.e3"), new Map()), 3, "e3 is not allowed → next allowed e4");
  assert.equal(cursorIndex(show, at("gone"), finished("show.e1")), 1);
});

// The fixture's show as if a later build appended e6 (not allowed), e7 and e8, after it was watched to the end.
const grown: EpisodicItem = {
  ...show,
  episodes: [
    ...show.episodes, { ...show.episodes[4]!, id: "show.e6", playbackAllowed: false, sources: [] }, { ...show.episodes[4]!, id: "show.e7" },
    { ...show.episodes[4]!, id: "show.e8" },
  ],
};
const wrapped = { episodeId: "show.e1", wrapped: true };

test("cursor: a wrapped cursor plays the first appended episode with playbackAllowed in play order", () => {
  assert.equal(cursorIndex(grown, wrapped, watched, new Set(["show.e8", "show.e7"])), 6, "play order, not the set's order");
  assert.equal(cursorIndex(grown, wrapped, watched, new Set(["show.e6", "show.e8"])), 7, "an appended episode that is not allowed is skipped");
  assert.equal(cursorIndex(grown, wrapped, watched, new Set(["show.e6"])), 0, "none allowed: the cursor episode");
});

test("cursor: without appended episodes, or with an ordinary cursor, the rules are unchanged", () => {
  assert.equal(cursorIndex(grown, wrapped, watched), 0, "wrapped without appended episodes: the cursor episode");
  assert.equal(cursorIndex(grown, wrapped, watched, new Set()), 0);
  assert.equal(cursorIndex(grown, at("show.e1"), watched, new Set(["show.e7"])), 0, "an ordinary cursor ignores them");
  assert.equal(cursorIndex(grown, null, watched, new Set(["show.e7"])), 6, "without a cursor: the first unfinished allowed episode");
  assert.equal(cursorIndex(grown, { episodeId: "show.e3", wrapped: true }, watched, new Set(["show.e6"])), 3, "a disallowed cursor moves on as before");
});

test("cursor after a report: finished moves on (wrapping after the last), anything else stays; changes", () => {
  const at = (episodeId: string, wrapped = false) => ({ episodeId, wrapped });
  assert.deepEqual(cursorAfterReport(show, 0, "finished", at("show.e1")), { episodeId: "show.e2", wrapped: false, changed: true });
  assert.deepEqual(cursorAfterReport(show, 1, "finished", at("show.e2")), { episodeId: "show.e4", wrapped: false, changed: true }, "e3 skipped; autoAdvance:false does not matter");
  assert.deepEqual(cursorAfterReport(show, 4, "finished", at("show.e5")), { episodeId: "show.e1", wrapped: true, changed: true }, "after the last: wrapped to the first");
  assert.deepEqual(cursorAfterReport(show, 3, "finished", null), { episodeId: "show.e5", wrapped: false, changed: true });
  assert.deepEqual(cursorAfterReport(show, 0, "playing", at("show.e1")), { episodeId: "show.e1", wrapped: false, changed: false }, "a heartbeat changes nothing");
  assert.deepEqual(cursorAfterReport(show, 0, "paused", at("show.e1")), { episodeId: "show.e1", wrapped: false, changed: false });
  assert.deepEqual(cursorAfterReport(show, 0, "stopped", at("show.e1")), { episodeId: "show.e1", wrapped: false, changed: true }, "leaving the player is a change");
  // A heartbeat changes the state only when the cursor moves or stops being wrapped.
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

test("source order: audio match (or no dialogue) > unknown > mismatch, stable, exclusions removed, failures last", () => {
  const sources = show.episodes[0]!.sources as Source[];
  const ids = (s: Source[]) => s.map((x) => x.id);
  // Languages match on their primary subtag, either way round.
  const langs = (id: string, audio: string[] | null) => ({ id, languages: { audio, subtitles: [] } }) as unknown as Source;
  const pt = [langs("en", ["en"]), langs("unknown", null), langs("silent", []), langs("pt", ["pt"]), langs("tr", ["tr-TR"])];
  assert.deepEqual(ids(orderSources(pt, { preferredAudioLanguage: "pt-BR" })), ["silent", "pt", "unknown", "en", "tr"]);
  assert.deepEqual(ids(orderSources(pt, { preferredAudioLanguage: "tr" })), ["silent", "tr", "unknown", "en", "pt"]);
  assert.deepEqual(ids(orderSources(sources, { preferredAudioLanguage: "tr" })), ["tr-dub", "multi", "unknown", "en-orig"]);
  assert.deepEqual(ids(orderSources(sources, { preferredAudioLanguage: "en" })), ["en-orig", "multi", "unknown", "tr-dub"]);
  assert.deepEqual(ids(orderSources(sources, { preferredAudioLanguage: null })), ["unknown", "en-orig", "tr-dub", "multi"]);
  assert.deepEqual(ids(orderSources(sources, { preferredAudioLanguage: "tr", exclude: new Set(["tr-dub"]) })), ["multi", "unknown", "en-orig"]);
  assert.deepEqual(ids(orderSources(sources, { preferredAudioLanguage: "tr", failed: new Set(["tr-dub", "unknown"]) })), ["multi", "en-orig", "tr-dub", "unknown"]);
});
