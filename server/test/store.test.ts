import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { MIGRATIONS, SCHEMA_VERSION, Store } from "../src/store.ts";
import { tempDir } from "./helpers.ts";

test("migrations run once and record the schema version", async () => {
  const file = path.join(await tempDir(), "data", "izle.db");
  const a = new Store(file);
  assert.equal(a.schemaVersion, SCHEMA_VERSION);
  a.createDevice({ id: "d1", name: "TV", tokenHash: "h", now: 1 });
  a.close();
  const b = new Store(file);
  assert.equal(b.schemaVersion, SCHEMA_VERSION);
  assert.equal(b.getDevice("d1")?.name, "TV");
  b.close();
});

test("refuses a database written by a newer server", async () => {
  const file = path.join(await tempDir(), "izle.db");
  const raw = new DatabaseSync(file);
  raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  raw.close();
  assert.throws(() => new Store(file), /newer than this server/);
});

test("deleting a device cascades to its rows; transactions roll back on error", async () => {
  const s = new Store(path.join(await tempDir(), "izle.db"));
  s.createDevice({ id: "d1", name: "TV", tokenHash: "h1", now: 1 });
  s.setHome("d1", "c", ["a", "b"], 1);
  s.upsertProgress("d1", { catalogId: "c", itemId: "a", episodeId: "a.1", positionMs: 5, durationMs: 10, status: "watching", updatedAt: 2 });
  s.insertCommand("d1", "stop", {}, { type: "owner" }, 3);
  assert.throws(() =>
    s.transaction(() => {
      s.setHome("d1", "c", ["x"], 2);
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

test("migration 2: now_playing gains its anchor and seq, companion links exist; old rows read as defaults", async () => {
  const file = path.join(await tempDir(), "izle.db");
  const raw = new DatabaseSync(file);
  raw.exec(MIGRATIONS[0]!);
  raw.exec("PRAGMA user_version = 1");
  raw.exec("INSERT INTO devices (id, name, token_hash, created_at) VALUES ('d1', 'TV', 'h', 1)");
  raw.exec(
    "INSERT INTO now_playing (device_id, catalog_id, item_id, episode_id, source_id, position_ms, duration_ms, state, updated_at) VALUES ('d1', 'c', 'i', 'e', NULL, 5, 10, 'paused', 2)",
  );
  raw.close();

  const s = new Store(file);
  assert.equal(s.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(s.getNowPlaying("d1"), {
    catalogId: "c", itemId: "i", episodeId: "e", sourceId: null, positionMs: 5, durationMs: 10, state: "paused", updatedAt: 2, playing: false,
    anchorAt: null, seq: 0,
  });
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

test("migration 3: devices gain autoplay (off), problems are kept per device, newest first, and go with the device", async () => {
  const file = path.join(await tempDir(), "izle.db");
  const raw = new DatabaseSync(file);
  raw.exec(MIGRATIONS[0]!);
  raw.exec(MIGRATIONS[1]!);
  raw.exec("PRAGMA user_version = 2");
  raw.exec("INSERT INTO devices (id, name, token_hash, created_at) VALUES ('d1', 'TV', 'h', 1)");
  raw.close();

  const s = new Store(file);
  assert.equal(s.schemaVersion, SCHEMA_VERSION);
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

test("migration 4: home entries keep the date they were added, cursors carry the wrap flag", async () => {
  const file = path.join(await tempDir(), "izle.db");
  const raw = new DatabaseSync(file);
  for (const m of MIGRATIONS.slice(0, 3)) raw.exec(m);
  raw.exec("PRAGMA user_version = 3");
  raw.exec("INSERT INTO devices (id, name, token_hash, created_at) VALUES ('d1', 'TV', 'h', 1)");
  raw.exec("INSERT INTO home_entries (device_id, position, catalog_id, item_id) VALUES ('d1', 0, 'c', 'a'), ('d1', 1, 'c', 'b')");
  raw.exec("INSERT INTO item_cursor (device_id, catalog_id, item_id, episode_id, updated_at) VALUES ('d1', 'c', 'a', 'a.2', 5)");
  raw.close();

  const before = Date.now();
  const s = new Store(file);
  assert.equal(s.schemaVersion, SCHEMA_VERSION);
  const backfilled = s.getHomeEntries("d1", "c");
  const at = backfilled[0]!.addedAt!;
  assert.ok(at >= Math.floor(before / 1000) * 1000 && at <= Date.now(), "existing rows are backfilled to the migration time");
  assert.deepEqual(backfilled, [{ itemId: "a", addedAt: at }, { itemId: "b", addedAt: at }]);
  assert.deepEqual(s.getCursor("d1", "c", "a"), { catalogId: "c", itemId: "a", episodeId: "a.2", updatedAt: 5, wrapped: false });

  s.setHome("d1", "c", ["b", "a"], at + 1000);
  const reordered = [{ itemId: "b", addedAt: at }, { itemId: "a", addedAt: at }];
  assert.deepEqual(s.getHomeEntries("d1", "c"), reordered, "a reorder changes no date");
  s.setHome("d1", "c", ["b", "x", "a"], at + 2000);
  assert.deepEqual(s.getHomeEntries("d1", "c").map((e) => [e.itemId, e.addedAt]), [["b", at], ["x", at + 2000], ["a", at]]);
  s.setHome("d1", "c", ["x"], at + 3000);
  s.setHome("d1", "c", ["x", "a"], at + 4000);
  assert.deepEqual(s.getHomeEntries("d1", "c").map((e) => [e.itemId, e.addedAt]), [["x", at + 2000], ["a", at + 4000]], "taken off and put back: a new date");

  s.setCursor("d1", { catalogId: "c", itemId: "a", episodeId: "a.1", updatedAt: 6, wrapped: true });
  assert.equal(s.getCursor("d1", "c", "a")?.wrapped, true);
  assert.deepEqual(s.listCursors("d1", "c").map((c) => [c.itemId, c.wrapped]), [["a", true]]);
  s.setCursor("d1", { catalogId: "c", itemId: "a", episodeId: "a.1", updatedAt: 7 });
  assert.equal(s.getCursor("d1", "c", "a")?.wrapped, false, "a write without the flag is an ordinary cursor");

  assert.equal(s.lastProgressAt("d1", "c", "a"), null);
  const p = { catalogId: "c", itemId: "a", positionMs: 1, durationMs: 10, status: "watching" as const };
  s.upsertProgress("d1", { ...p, episodeId: "a.1", updatedAt: 9 });
  s.upsertProgress("d1", { ...p, episodeId: "a.2", updatedAt: 4 });
  assert.equal(s.lastProgressAt("d1", "c", "a"), 9);
  assert.equal(s.lastProgressAt("d1", "c", "b"), null);
  s.close();
});

test("migration 5: saved positions become imported viewings; access tokens and events have rows; hooks run after commit only", async () => {
  const file = path.join(await tempDir(), "izle.db");
  const raw = new DatabaseSync(file);
  for (const m of MIGRATIONS.slice(0, 4)) raw.exec(m);
  raw.exec("PRAGMA user_version = 4");
  raw.exec("INSERT INTO devices (id, name, token_hash, created_at) VALUES ('d1', 'Salon', 'h', 1), ('d2', 'Kitchen', 'h2', 1)");
  raw.exec(`INSERT INTO progress (device_id, catalog_id, episode_id, item_id, position_ms, duration_ms, status, updated_at) VALUES
    ('d1', 'c', 'a.1', 'a', 1200000, 1200000, 'finished', 20), ('d1', 'c', 'a.2', 'a', 300000, NULL, 'watching', 30), ('d2', 'c', 'f.main', 'f', 100, 5000, 'watching', 10)`);
  raw.exec("INSERT INTO commands (device_id, type, payload_json, created_at) VALUES ('d1', 'stop', '{}', 5)");
  raw.close();

  const s = new Store(file);
  assert.equal(s.schemaVersion, SCHEMA_VERSION);
  const db = new DatabaseSync(file);
  const viewings = db.prepare("SELECT * FROM viewings ORDER BY id").all();
  assert.deepEqual(viewings.map((v) => [v.device_id, v.device_name, v.episode_id, v.item_id, v.started_at, v.ended_at, v.end_position_ms, v.duration_ms, v.end_reason, v.seen]), [
    ["d2", "Kitchen", "f.main", "f", 10, 10, 100, 5000, "stopped", 0],
    ["d1", "Salon", "a.1", "a", 20, 20, 1200000, 1200000, "finished", 1],
    ["d1", "Salon", "a.2", "a", 30, 30, 300000, null, "stopped", 0],
  ], "one imported viewing per saved position, oldest first");
  assert.deepEqual(new Set(viewings.map((v) => [v.imported, v.trigger, v.start_position_ms, v.source_id, v.watched_ms, v.command_id].join())), new Set(["1,unknown,,,,"]));
  assert.equal(viewings[1]!.actor_json, '{"type":"tv","deviceId":"d1"}');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM viewing_ranges").get()!.n, 0);
  db.close();

  // Commands from before have no actor; new ones carry theirs and the result columns.
  assert.deepEqual(s.pendingCommands("d1", 0).map((c) => [c.actor, c.result, c.reason, c.resultAt]), [[null, null, null, null]]);
  const cmd = s.insertCommand("d1", "pause", {}, { type: "token", tokenId: "t1", name: "agent" }, 6);
  assert.deepEqual([cmd.actor, cmd.result], [{ type: "token", tokenId: "t1", name: "agent" }, null]);

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

test("migration 6: devices from before read no app version; one APK row at most", async () => {
  const file = path.join(await tempDir(), "izle.db");
  const raw = new DatabaseSync(file);
  for (const m of MIGRATIONS.slice(0, 5)) raw.exec(m);
  raw.exec("PRAGMA user_version = 5");
  raw.exec("INSERT INTO devices (id, name, token_hash, created_at) VALUES ('d1', 'Salon', 'h', 1)");
  raw.close();

  const s = new Store(file);
  assert.equal(s.schemaVersion, SCHEMA_VERSION);
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

test("catalog history rows: episodes seen after a date, removal and return, builds newest first", async () => {
  const s = new Store(path.join(await tempDir(), "izle.db"));
  s.insertSeen("c", "b1", 0, [{ episodeId: "a.1", itemId: "a" }, { episodeId: "a.2", itemId: "a" }]);
  s.insertSeen("c", "b2", 100, [{ episodeId: "a.3", itemId: "a" }]);
  s.insertSeen("other", "o1", 100, [{ episodeId: "a.4", itemId: "a" }]);
  assert.deepEqual(s.episodesSeenAfter("c", "a", 0), ["a.3"], "baseline episodes (0) never count");
  assert.deepEqual(s.episodesSeenAfter("c", "a", 50), ["a.3"]);
  assert.deepEqual(s.episodesSeenAfter("c", "a", 100), []);
  assert.deepEqual(s.episodesSeenAfter("c", "b", 0), []);

  s.markSeenRemoved("c", ["a.3"], 200);
  s.markSeenRemoved("c", ["a.3"], 300);
  assert.deepEqual(s.episodesSeenAfter("c", "a", 0), [], "removed episodes do not count");
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
