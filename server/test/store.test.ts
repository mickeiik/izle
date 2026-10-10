import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { SCHEMA_VERSION, Store } from "../src/store.ts";
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
