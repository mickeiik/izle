import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { DatabaseVersionError, SCHEMA_VERSION, Store } from "../src/store.ts";
import { INITIAL_VERSION } from "../src/store/schema.ts";
import { tempDir, untitled } from "./helpers.ts";

/** A database file left at schema version `version` by another izle. */
async function databaseAt(version: number): Promise<string> {
  const file = path.join(await tempDir(), "izle.db");
  const raw = new DatabaseSync(file);
  raw.exec(`CREATE TABLE devices (id TEXT PRIMARY KEY); PRAGMA user_version = ${version}`);
  raw.close();
  return file;
}

/** A new store with one device, `d1`, and its database file. */
async function storeWithDevice(name = "TV"): Promise<{ s: Store; file: string }> {
  const file = path.join(await tempDir(), "izle.db");
  const s = new Store(file);
  s.createDevice({ id: "d1", name, tokenHash: "h", now: 1 });
  return { s, file };
}

/** The file's schema version and journal mode, as a refused database must keep them. */
function versionAndJournal(file: string): [number, string] {
  const raw = new DatabaseSync(file);
  try {
    return [Number(raw.prepare("PRAGMA user_version").get()!.user_version), String(raw.prepare("PRAGMA journal_mode").get()!.journal_mode)];
  } finally {
    raw.close();
  }
}

test("a new database gets the initial schema and its version, and opens again as it is", async () => {
  assert.equal(INITIAL_VERSION, 11, "the schema without the pre-release migrations' leftovers; it never changes");
  const file = path.join(await tempDir(), "data", "izle.db");
  const a = new Store(file);
  assert.equal(a.schemaVersion, SCHEMA_VERSION);
  a.createDevice({ id: "d1", name: "TV", tokenHash: "h", now: 1 });
  a.close();
  const raw = new DatabaseSync(file);
  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  raw.close();
  assert.deepEqual(tables, [
    "access_tokens", "app_apk", "catalog_builds", "catalog_seen", "catalog_seen_items", "commands", "companion_links", "devices", "episode_marks",
    "events", "home_entries", "home_sections", "item_cursor", "now_playing", "pair_codes", "problems", "progress", "viewing_ranges", "viewings",
  ]);
  const b = new Store(file);
  assert.equal(b.schemaVersion, SCHEMA_VERSION);
  assert.equal(b.getDevice("d1")?.name, "TV");
  b.close();
});

test("refuses a database from an older pre-release izle, and leaves it as it is", async () => {
  for (const version of [1, INITIAL_VERSION - 1]) {
    const file = await databaseAt(version);
    const message = `${file} was made by an older pre-release izle (schema version ${version}) and cannot be upgraded: ` +
      `move the data directory ${path.dirname(file)} away (or delete it), then start the server and pair the TVs again`;
    assert.throws(() => new Store(file), (err) => err instanceof DatabaseVersionError && err.message === message);
    assert.deepEqual(versionAndJournal(file), [version, "delete"], "nothing was migrated or written");
  }
});

test("refuses a database written by a newer server", async () => {
  const file = await databaseAt(SCHEMA_VERSION + 1);
  assert.throws(() => new Store(file), (err) => err instanceof DatabaseVersionError && /newer than this server/.test(err.message));
  assert.deepEqual(versionAndJournal(file), [SCHEMA_VERSION + 1, "delete"]);
});

test("deleting a device cascades to its rows; transactions roll back on error", async () => {
  const s = new Store(path.join(await tempDir(), "izle.db"));
  s.createDevice({ id: "d1", name: "TV", tokenHash: "h1", now: 1 });
  s.setHome("d1", "c", untitled(["a", "b"]), 1);
  s.upsertProgress("d1", { catalogId: "c", itemId: "a", episodeId: "a.1", positionMs: 5, durationMs: 10, status: "watching", updatedAt: 2 });
  s.insertCommand("d1", "stop", {}, { type: "owner" }, 3);
  assert.throws(() =>
    s.transaction(() => {
      s.setHome("d1", "c", untitled(["x"]), 2);
      throw new Error("boom");
    }),
  );
  assert.deepEqual(s.getHomeEntries("d1", "c").map((e) => e.itemId), ["a", "b"]);
  assert.equal(s.deleteDevice("d1"), true);
  assert.deepEqual(s.getHomeEntries("d1", "c").map((e) => e.itemId), []);
  assert.equal(s.getProgress("d1", "c", "a.1"), null);
  assert.deepEqual(s.pendingCommands("d1", 0), []);
  s.close();
});

test("now playing carries its anchor and a per-device sequence number; companion links", async () => {
  const { s } = await storeWithDevice();
  assert.equal(s.getNowPlaying("d1"), null);
  const row = { catalogId: "c", itemId: "i", episodeId: "e", sourceId: "s", positionMs: 7, durationMs: 10, state: "playing" as const, updatedAt: 3, playing: true, anchorAt: 2_900 };
  assert.equal(s.setNowPlaying("d1", row), 1);
  assert.equal(s.setNowPlaying("d1", { ...row, positionMs: 8 }), 2);
  assert.deepEqual(s.getNowPlaying("d1"), { ...row, positionMs: 8, seq: 2 });
  s.createDevice({ id: "d2", name: "TV2", tokenHash: "h2", now: 1 });
  assert.equal(s.setNowPlaying("d2", row), 1, "sequence numbers are per device");

  assert.equal(s.getCompanionLink("c", "e", "s"), null);
  const link = { catalogId: "c", itemId: "i", episodeId: "e", sourceId: "s", language: "fr", offsetMs: -1250, rate: 1.0427, updatedAt: 4 };
  s.putCompanionLink(link);
  s.putCompanionLink({ ...link, sourceId: "t", language: null, offsetMs: 0, rate: 1 });
  s.putCompanionLink({ ...link, offsetMs: 500, updatedAt: 5 });
  assert.deepEqual(s.getCompanionLink("c", "e", "s"), { ...link, offsetMs: 500, updatedAt: 5 });
  const links = s.listCompanionLinks("c", "e").map((l) => [l.sourceId, l.language, l.offsetMs]);
  assert.deepEqual(links, [["s", "fr", 500], ["t", null, 0]]);
  assert.deepEqual(s.listCompanionLinks("c", "other"), []);
  s.close();
});

test("autoplay is off on a new device; problems are kept per device, newest first, and go with the device", async () => {
  const { s } = await storeWithDevice();
  assert.equal(s.getDevice("d1")?.autoplayOnStart, false);
  assert.equal(s.updateDevice("d1", { autoplayOnStart: true })?.autoplayOnStart, true);
  assert.equal(s.updateDevice("d1", { name: "Salon" })?.autoplayOnStart, true, "other patches leave it alone");
  assert.equal(s.updateDevice("d1", { autoplayOnStart: false })?.autoplayOnStart, false);

  s.createDevice({ id: "d2", name: "TV2", tokenHash: "h2", now: 1 });
  const base = { origin: "tv" as const, kind: "playback" as const, catalogId: null, itemId: null, episodeId: null, sourceId: null, positionMs: null, httpStatus: null, detail: null, appVersion: null };
  const at = [50, 10, 30, 30, 20];
  at.forEach((t, i) => s.insertProblem({ ...base, deviceId: "d1", at: t, code: `c${i}` }, 4));
  s.insertProblem({ ...base, deviceId: "d2", at: 5, code: "other" }, 4);
  assert.deepEqual(s.listProblems("d1", 10).map((p) => p.code), ["c0", "c3", "c2", "c4"], "the oldest (c1, at 10) went; ties newest-inserted first");
  assert.deepEqual(s.listProblems("d1", 2).map((p) => p.code), ["c0", "c3"]);
  assert.deepEqual(s.problemStats("d1", 25), { recent: 3, lastAt: 50 });
  assert.deepEqual(s.problemStats("d2", 25), { recent: 0, lastAt: 5 });
  s.purgeProblems(30);
  assert.deepEqual(s.listProblems("d1", 10).map((p) => p.code), ["c0", "c3", "c2"]);
  assert.equal(s.clearProblems("d1"), 3);
  assert.deepEqual(s.problemStats("d1", 0), { recent: 0, lastAt: null });
  assert.throws(() => s.insertProblem({ ...base, deviceId: "ghost", at: 1, code: "x" }, 4), /FOREIGN KEY/);
  s.deleteDevice("d2");
  assert.deepEqual(s.listProblems("d2", 10), [], "deleting a device deletes its problems");
  s.close();
});

test("home entries keep the date they were added, cursors carry the wrap flag", async () => {
  const { s } = await storeWithDevice();
  const at = 1_000;
  s.setHome("d1", "c", untitled(["a", "b"]), at);
  assert.deepEqual(s.getHomeEntries("d1", "c"), [{ itemId: "a", addedAt: at, sectionId: "untitled" }, { itemId: "b", addedAt: at, sectionId: "untitled" }]);
  s.setCursor("d1", { catalogId: "c", itemId: "a", episodeId: "a.2", updatedAt: 5 });
  assert.deepEqual(s.getCursor("d1", "c", "a"), { catalogId: "c", itemId: "a", episodeId: "a.2", updatedAt: 5, wrapped: false });

  s.setHome("d1", "c", untitled(["b", "a"]), at + 1000);
  const reordered = [{ itemId: "b", addedAt: at, sectionId: "untitled" }, { itemId: "a", addedAt: at, sectionId: "untitled" }];
  assert.deepEqual(s.getHomeEntries("d1", "c"), reordered, "a reorder changes no date");
  s.setHome("d1", "c", untitled(["b", "x", "a"]), at + 2000);
  assert.deepEqual(s.getHomeEntries("d1", "c").map((e) => [e.itemId, e.addedAt]), [["b", at], ["x", at + 2000], ["a", at]]);
  s.setHome("d1", "c", untitled(["x"]), at + 3000);
  s.setHome("d1", "c", untitled(["x", "a"]), at + 4000);
  assert.deepEqual(s.getHomeEntries("d1", "c").map((e) => [e.itemId, e.addedAt]), [["x", at + 2000], ["a", at + 4000]], "taken off and put back: a new date");

  s.setCursor("d1", { catalogId: "c", itemId: "a", episodeId: "a.1", updatedAt: 6, wrapped: true });
  assert.equal(s.getCursor("d1", "c", "a")?.wrapped, true);
  assert.deepEqual(s.listCursors("d1", "c").map((c) => [c.itemId, c.wrapped]), [["a", true]]);
  s.setCursor("d1", { catalogId: "c", itemId: "a", episodeId: "a.1", updatedAt: 7 });
  assert.equal(s.getCursor("d1", "c", "a")?.wrapped, false, "a write without the flag is an ordinary cursor");

  const p = { catalogId: "c", itemId: "a", positionMs: 1, durationMs: 10, status: "watching" as const };
  s.upsertProgress("d1", { ...p, episodeId: "a.1", updatedAt: 9 });
  s.upsertProgress("d1", { ...p, episodeId: "a.2", updatedAt: 4 });
  assert.deepEqual(s.listProgress("d1", "c").map((r) => [r.itemId, r.episodeId]), [["a", "a.1"], ["a", "a.2"]], "newest first");
  assert.deepEqual(s.listProgress("d1", "c", "b"), []);
  s.close();
});

test("commands carry who sent them; access tokens and events have rows; hooks run after commit only", async () => {
  const { s } = await storeWithDevice("Salon");
  const cmd = s.insertCommand("d1", "pause", {}, { type: "token", tokenId: "t1", name: "agent" }, 6);
  assert.deepEqual([cmd.actor, cmd.result, cmd.reason, cmd.resultAt], [{ type: "token", tokenId: "t1", name: "agent" }, null, null, null]);
  assert.deepEqual(s.pendingCommands("d1", 0).map((c) => c.actor), [{ type: "token", tokenId: "t1", name: "agent" }]);

  const token = { id: "tok000000001", name: "agent", scope: "read" as const, createdAt: 7, lastUsedAt: null };
  assert.deepEqual(s.insertAccessToken({ ...token, secretHash: "hash1" }), token);
  s.insertAccessToken({ ...token, id: "tok000000002", name: "other", secretHash: "hash2", createdAt: 8 });
  assert.throws(() => s.insertAccessToken({ ...token, id: "tok000000003", name: "again", secretHash: "hash1" }), /UNIQUE/, "one secret, one token");
  assert.deepEqual(s.getAccessTokenByHash("hash2")?.name, "other");
  assert.equal(s.getAccessTokenByHash("nope"), null);
  assert.deepEqual(s.getAccessTokenByName("agent"), token);
  s.touchAccessToken(token.id, 9);
  assert.deepEqual(s.listAccessTokens().map((x) => [x.id, x.lastUsedAt]), [["tok000000001", 9], ["tok000000002", null]]);
  assert.equal(s.deleteAccessToken(token.id), true);
  assert.equal(s.deleteAccessToken(token.id), false);
  assert.equal(s.getAccessToken(token.id), null);

  const ran: string[] = [];
  assert.throws(() =>
    s.transaction(() => {
      s.insertEvent({ at: 1, type: "x.y", deviceId: null, actor: { type: "server" }, data: {} });
      s.afterCommit(() => ran.push("rolled back"));
      throw new Error("boom");
    }),
  );
  s.transaction(() => {
    s.afterCommit(() => ran.push("inner"));
    s.insertEvent({ at: 1, type: "a.b", deviceId: "d1", actor: { type: "server" }, data: { n: 1 } });
    assert.deepEqual(ran, [], "hooks wait for the commit");
  });
  s.afterCommit(() => ran.push("outside"));
  assert.deepEqual(ran, ["inner", "outside"], "outside a transaction a hook runs at once");
  assert.deepEqual(s.listEvents({ after: 0, limit: 10 }).map((e) => [e.id, e.type, e.deviceId, e.data]), [[1, "a.b", "d1", { n: 1 }]], "the rolled-back event left nothing");
  assert.deepEqual([s.lastEventId(), s.oldestEventId()], [1, 1]);
  assert.equal(s.purgeEvents(2), 1);
  assert.deepEqual([s.lastEventId(), s.oldestEventId()], [1, null], "the last id survives the purge");
  s.close();
});

test("a new device reads no app version until its TV reports one; one APK row at most", async () => {
  const { s, file } = await storeWithDevice("Salon");
  const d = s.getDevice("d1")!;
  assert.deepEqual([d.appVersion, d.appVersionCode, d.androidSdk, d.updateCapability, d.appReportedAt], [null, null, null, null, null]);
  s.setDeviceApp("d1", { version: "0.2.0", versionCode: 200, androidSdk: 25, capability: "guided" }, 7);
  const after = s.getDevice("d1")!;
  assert.deepEqual([after.appVersion, after.appVersionCode, after.androidSdk, after.updateCapability, after.appReportedAt], ["0.2.0", 200, 25, "guided", 7]);
  assert.equal(after.stateVersion, d.stateVersion, "nothing the TV shows changed");

  assert.equal(s.getAppApk(), null);
  const apk = { versionName: "0.3.0", versionCode: 300, sha256: "a".repeat(64), size: 10, source: "upload" as const, releaseTag: null, storedAt: 5 };
  s.setAppApk(apk);
  s.setAppApk({ ...apk, versionName: "0.3.1", versionCode: 301, source: "github", releaseTag: "v0.3.1" });
  assert.deepEqual(s.getAppApk(), { ...apk, versionName: "0.3.1", versionCode: 301, source: "github", releaseTag: "v0.3.1" });
  assert.equal(s.deleteAppApk(), true);
  assert.equal(s.deleteAppApk(), false);
  const db = new DatabaseSync(file);
  assert.throws(() => db.exec("INSERT INTO app_apk (id, version_name, version_code, sha256, size, source, stored_at) VALUES (2, 'x', 1, 'x', 1, 'upload', 1)"), /CHECK/);
  assert.throws(() => db.exec("INSERT INTO app_apk (id, version_name, version_code, sha256, size, source, stored_at) VALUES (1, 'x', 1, 'x', 1, 'web', 1)"), /CHECK/);
  db.close();
  s.close();
});

test("pairing codes remember their client; cancelling one unbinds and removes its uncollected device", async () => {
  const s = new Store(path.join(await tempDir(), "izle.db"));
  s.createDevice({ id: "new", name: "TV", tokenHash: null, now: 1 });
  s.createDevice({ id: "old", name: "Salon", tokenHash: "h", now: 1 });
  for (const [code, client] of [["111111", "a"], ["222222", "b"], ["333333", "c"], ["444444", "d"]] as const) {
    s.insertPairCode({ code, pairTokenHash: `p${code[0]}`, clientHash: client.repeat(64), createdAt: Number(code[0]), expiresAt: 100 });
  }
  s.approvePairCode("111111", "new", 2);
  s.approvePairCode("222222", "old", 2);
  assert.equal(s.getPairCode("444444")!.clientHash, "d".repeat(64));
  s.cancelPairCode("111111", 50);
  s.cancelPairCode("222222", 50);
  assert.deepEqual([s.getPairCode("111111")!.expiresAt, s.getPairCode("111111")!.deviceId], [50, null]);
  assert.equal(s.getDevice("new"), null, "the device never collected is gone");
  assert.equal(s.getDevice("old")!.name, "Salon", "the device it was to replace stays");
  assert.deepEqual(s.listOpenPairCodes(50).map((c) => c.code), ["333333", "444444"]);
  s.close();
});

test("a new device gets the 4 × 2 home grid; a patch sets either alone and bumps the version", async () => {
  const { s } = await storeWithDevice("Salon");
  const d = s.updateDevice("d1", { autoplayOnStart: true })!;
  assert.deepEqual([d.homeColumns, d.homeRows, d.autoplayOnStart], [4, 2, true]);
  const wide = s.updateDevice("d1", { homeColumns: 6 })!;
  assert.deepEqual([wide.homeColumns, wide.homeRows, wide.stateVersion], [6, 2, d.stateVersion + 1]);
  const tall = s.updateDevice("d1", { homeRows: 4, name: "Oturma odası" })!;
  assert.deepEqual([tall.homeColumns, tall.homeRows, tall.name], [6, 4, "Oturma odası"]);
  assert.equal(s.updateDevice("d1", { autoplayOnStart: false })!.homeColumns, 6, "other patches leave it alone");
  s.createDevice({ id: "d2", name: "TV2", tokenHash: "h2", now: 1 });
  assert.deepEqual([s.getDevice("d2")!.homeColumns, s.getDevice("d2")!.homeRows], [4, 2]);
  s.close();
});

test("catalog history rows: episodes seen after a date, removal and return, builds newest first", async () => {
  const s = new Store(path.join(await tempDir(), "izle.db"));
  s.insertSeen("c", "b1", 0, [{ episodeId: "a.1", itemId: "a" }, { episodeId: "a.2", itemId: "a" }]);
  s.insertSeen("c", "b2", 100, [{ episodeId: "a.3", itemId: "a" }]);
  s.insertSeen("other", "o1", 100, [{ episodeId: "a.4", itemId: "a" }]);
  assert.deepEqual(s.episodesSeenAfter("c", "a", 0), ["a.3"], "baseline episodes (0) never count");
  assert.deepEqual(s.episodesSeenAfter("c", "a", 50), ["a.3"]);
  assert.deepEqual(s.episodesSeenAfter("c", "a", 100), []);
  assert.deepEqual(s.episodesSeenAfter("c", "b", 0), []);
  const seen = s.listSeen("c");
  assert.deepEqual([...seen.keys()], ["a"], "one catalog only");
  assert.deepEqual(seen.get("a"), [{ episodeId: "a.1", firstSeenAt: 0 }, { episodeId: "a.2", firstSeenAt: 0 }, { episodeId: "a.3", firstSeenAt: 100 }]);

  s.markSeenRemoved("c", ["a.3"], 200);
  s.markSeenRemoved("c", ["a.3"], 300);
  assert.deepEqual(s.episodesSeenAfter("c", "a", 0), [], "removed episodes do not count");
  assert.deepEqual(s.listSeen("c").get("a")?.map((e) => e.episodeId), ["a.1", "a.2"]);
  assert.equal(s.catalogSeen("c").find((e) => e.episodeId === "a.3")?.removedAt, 200, "the first removal time stays");
  s.clearSeenRemoved("c", ["a.3"]);
  assert.deepEqual(s.episodesSeenAfter("c", "a", 0), ["a.3"]);
  s.moveSeen("c", [{ episodeId: "a.3", itemId: "b" }]);
  assert.deepEqual(s.episodesSeenAfter("c", "b", 0), ["a.3"]);
  assert.deepEqual(s.catalogSeen("c").map((e) => [e.episodeId, e.itemId, e.firstSeenAt, e.buildId, e.removedAt]), [
    ["a.1", "a", 0, "b1", null], ["a.2", "a", 0, "b1", null], ["a.3", "b", 100, "b2", null],
  ]);

  const counts = { items: 2, episodes: 3, itemsAdded: 0, itemsRemoved: 0, episodesAdded: 1, episodesRemoved: 0 };
  const build = (buildId: string, loadedAt: number) =>
    ({ catalogId: "c", buildId, builtAt: "2026-10-14T00:00:00Z", loadedAt, baseline: false, ...counts });
  const changes = { items: { added: [], removed: [] }, episodes: { added: [], removed: [{ id: "a.9", itemId: "a", itemTitle: null }] } };
  s.recordCatalogBuild({ ...build("b1", 10), baseline: true, episodesAdded: 0 }, { items: { added: [], removed: [] }, episodes: { added: [], removed: [] } });
  s.recordCatalogBuild(build("b2", 20), changes);
  s.recordCatalogBuild(build("b3", 30), changes);
  assert.deepEqual(s.listCatalogBuilds("c", 10).map((b) => [b.buildId, b.baseline]), [["b3", false], ["b2", false], ["b1", true]]);
  assert.deepEqual(s.listCatalogBuilds("c", 1).map((b) => b.buildId), ["b3"]);
  assert.deepEqual(s.listCatalogBuilds("other", 10), []);
  assert.deepEqual(s.getCatalogBuild("c", "b2"), { build: build("b2", 20), changes });
  assert.equal(s.getCatalogBuild("c", "ghost"), null);
  s.recordCatalogBuild(build("b2", 40), changes);
  assert.deepEqual(s.listCatalogBuilds("c", 10).map((b) => b.buildId), ["b2", "b3", "b1"], "a build loaded again moves to its new load time");
  s.close();
});

test("now playing and viewings may name a channel; viewing ids are never reused; ranges go with their viewing", async () => {
  const { s, file } = await storeWithDevice("Salon");
  const actor = { type: "tv" as const, deviceId: "d1" };
  const base = { deviceId: "d1", deviceName: "Salon", catalogId: "c", itemId: "news", itemKind: "live", itemTitle: "News", episodeTitle: null, season: null, number: null, sourceId: "hls", startedAt: 70, endedAt: null, startPositionMs: null, endPositionMs: null, durationMs: null, watchedMs: 0, endReason: null, seen: false, trigger: "viewer" as const, actor, commandId: null, lastReportAt: null, lastPositionMs: null, lastPlaying: false, lastAnchorAt: null, lastState: null };
  const episode = (episodeId: string, startedAt: number, seen: boolean) =>
    s.insertViewing({ ...base, itemId: "i", itemKind: "series", itemTitle: "Show", episodeId, startedAt, endedAt: startedAt + 10, seen, endReason: seen ? "finished" : "stopped" });
  episode("e1", 10, false);
  episode("e2", 30, true);
  episode("e3", 50, false);
  s.addViewingRange(1, 0, 100);
  s.addViewingRange(2, 0, 1000);
  assert.equal(s.deleteViewing(3), true);
  assert.deepEqual(s.listViewings({ catalogId: "c", limit: 10 }).map((v) => [v.id, v.episodeId, v.seen, v.actor]), [[2, "e2", true, actor], [1, "e1", false, actor]]);
  assert.deepEqual([s.viewingRanges(1), s.viewingRanges(2)], [[[0, 100]], [[0, 1000]]]);

  const live = s.insertViewing({ ...base, episodeId: null });
  assert.deepEqual([live.id, live.episodeId, live.startPositionMs], [4, null, null], "the id sequence continues past the deleted viewing");
  assert.equal(s.runningViewing("d1")?.id, 4);
  const stats = s.episodeViewingStats("c", null, "news");
  assert.deepEqual(stats.map((x) => [x.itemId, x.episodeId, x.viewings]), [["news", null, 1]], "a channel's viewings are summed under a null episode");
  assert.equal(s.historyEpisodeItem("c", "news"), null, "a channel's item id is no episode id");
  assert.deepEqual([...s.historyItems("c").entries()], [["i", { kind: "series", title: "Show" }], ["news", { kind: "live", title: "News" }]]);

  const playing = { catalogId: "c", itemId: "i", episodeId: "e", sourceId: "s", positionMs: 5, durationMs: 10, state: "paused" as const, updatedAt: 2, playing: true, anchorAt: 1 };
  assert.equal(s.setNowPlaying("d1", playing), 1);
  const row = { catalogId: "c", itemId: "news", episodeId: null, sourceId: "hls", positionMs: null, durationMs: null, state: "playing" as const, updatedAt: 5, playing: true, anchorAt: 5 };
  assert.equal(s.setNowPlaying("d1", row), 2, "the sequence number carries on");
  assert.deepEqual(s.getNowPlaying("d1"), { ...row, seq: 2 });

  s.addViewingRange(2, 1000, 1100);
  assert.throws(() => s.addViewingRange(999, 0, 1), /FOREIGN KEY/, "ranges belong to viewings");
  assert.equal(s.deleteViewing(2), true);
  assert.deepEqual(s.viewingRanges(2), [], "deleting a viewing deletes its ranges");
  const db = new DatabaseSync(file);
  assert.deepEqual(db.prepare("SELECT name, seq FROM sqlite_sequence WHERE name LIKE 'viewings%'").all().map((r) => [r.name, r.seq]), [["viewings", 4]]);
  assert.throws(() => db.exec("INSERT INTO now_playing (device_id, catalog_id, item_id, state, updated_at, anchor_at) VALUES ('ghost', 'c', 'i', 'playing', 1, 1)"), /FOREIGN KEY/);
  db.close();
  s.close();
});

test("catalog history rows for channels: seen by item id, removal and return", async () => {
  const s = new Store(path.join(await tempDir(), "izle.db"));
  s.insertSeenItems("c", "b1", 0, ["news", "music"]);
  s.insertSeenItems("c", "b2", 100, ["sport"]);
  s.insertSeenItems("other", "o1", 100, ["sport"]);
  s.markSeenItemsRemoved("c", ["sport"], 200);
  s.markSeenItemsRemoved("c", ["sport"], 300);
  assert.deepEqual(s.catalogSeenItems("c"), [
    { itemId: "music", firstSeenAt: 0, buildId: "b1", removedAt: null },
    { itemId: "news", firstSeenAt: 0, buildId: "b1", removedAt: null },
    { itemId: "sport", firstSeenAt: 100, buildId: "b2", removedAt: 200 },
  ], "one catalog only; the first removal time stays");
  s.clearSeenItemsRemoved("c", ["sport"]);
  assert.deepEqual(s.catalogSeenItems("c").find((i) => i.itemId === "sport"), { itemId: "sport", firstSeenAt: 100, buildId: "b2", removedAt: null });
  assert.deepEqual(s.catalogSeenItems("other").map((i) => i.removedAt), [null]);
  assert.throws(() => s.insertSeenItems("c", "b3", 400, ["news"]), /UNIQUE|PRIMARY KEY/, "one row per channel");
  s.close();
});

test("Home is cut into sections in the owner's order, per TV; sections go with their device", async () => {
  const { s, file } = await storeWithDevice("Salon");
  s.createDevice({ id: "d3", name: "Yeni", tokenHash: null, now: 2 });
  const untitledGrid = { id: "untitled", title: null, layout: "grid" };
  assert.deepEqual(s.getHomeSections("d3"), [untitledGrid], "a TV reads as the untitled section alone before its first write");
  s.setHome("d1", "c", untitled(["b"]), 10);
  s.setHome("d1", "c", untitled(["b", "a"]), 11);
  assert.deepEqual(s.getHomeSections("d1"), [untitledGrid]);

  s.setHome("d1", "c", [{ id: "Abc12345", title: "Kids", layout: "row", itemIds: ["a"] }, { ...untitledGrid, itemIds: ["b", "x"] }], 50);
  assert.deepEqual(s.getHomeSections("d1"), [{ id: "Abc12345", title: "Kids", layout: "row" }, untitledGrid]);
  assert.deepEqual(s.getHomeEntries("d1", "c"), [
    { itemId: "a", addedAt: 11, sectionId: "Abc12345" }, { itemId: "b", addedAt: 10, sectionId: "untitled" }, { itemId: "x", addedAt: 50, sectionId: "untitled" },
  ], "Home order; a move to another section keeps the date");
  s.setHome("d3", "c", [{ id: "Abc12345", title: "Same id, other TV", layout: "grid", itemIds: [] }], 60);
  assert.deepEqual(s.getHomeSections("d3"), [untitledGrid, { id: "Abc12345", title: "Same id, other TV", layout: "grid" }], "section ids are per TV");
  s.close();

  const check = new DatabaseSync(file, { enableForeignKeyConstraints: true });
  assert.throws(() => check.exec("INSERT INTO home_entries (device_id, position, catalog_id, item_id, added_at, section_id) VALUES ('d1', 9, 'c', 'q', 1, 'gone0000')"), /FOREIGN KEY/,
    "an entry names a section of its own TV");
  check.exec("DELETE FROM devices WHERE id = 'd1'");
  assert.deepEqual(check.prepare("SELECT device_id FROM home_sections ORDER BY device_id").all().map((r) => r.device_id), ["d3"], "deleting a TV deletes its sections");
  assert.equal(check.prepare("SELECT COUNT(*) AS n FROM home_entries WHERE device_id = 'd1'").get()?.n, 0);
  check.close();
});
