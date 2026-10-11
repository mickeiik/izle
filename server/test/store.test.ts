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
  s.setHome("d1", "c", ["a", "b"]);
  s.upsertProgress("d1", { catalogId: "c", itemId: "a", episodeId: "a.1", positionMs: 5, durationMs: 10, status: "watching", updatedAt: 2 });
  s.insertCommand("d1", "stop", {}, 3);
  assert.throws(() =>
    s.transaction(() => {
      s.setHome("d1", "c", ["x"]);
      throw new Error("boom");
    }),
  );
  assert.deepEqual(s.getHome("d1", "c"), ["a", "b"]);
  assert.equal(s.deleteDevice("d1"), true);
  assert.deepEqual(s.getHome("d1", "c"), []);
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
    catalogId: "c",
    itemId: "i",
    episodeId: "e",
    sourceId: null,
    positionMs: 5,
    durationMs: 10,
    state: "paused",
    updatedAt: 2,
    playing: false,
    anchorAt: null,
    seq: 0,
  });
  const row = { catalogId: "c", itemId: "i", episodeId: "e", sourceId: "s", positionMs: 7, durationMs: 10, state: "playing", updatedAt: 3, playing: true, anchorAt: 2_900 };
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
  assert.deepEqual(
    s.listCompanionLinks("c", "e").map((l) => [l.sourceId, l.language, l.offsetMs]),
    [
      ["s", "fr", 500],
      ["t", null, 0],
    ],
  );
  assert.deepEqual(s.listCompanionLinks("c", "other"), []);
  s.close();
});
