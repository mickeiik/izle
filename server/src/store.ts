import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import type { CommandType } from "./commands.ts";
import type { ProgressReportStatus } from "./playback.ts";
import type { ProblemKind } from "./problems.ts";
import { MIGRATIONS } from "./store/migrations.ts";

export { MIGRATIONS, SCHEMA_VERSION } from "./store/migrations.ts";

export interface Device {
  id: string;
  name: string;
  tokenHash: string | null;
  createdAt: number;
  lastSeenAt: number | null;
  uiLanguage: string | null;
  preferredAudioLanguage: string | null;
  subtitlesLanguage: string | null;
  stateVersion: number;
  /** When the app opens, the show watched last (else the first tile) starts after a countdown. */
  autoplayOnStart: boolean;
}

interface PairCode {
  code: string;
  pairTokenHash: string;
  deviceId: string | null;
  createdAt: number;
  expiresAt: number;
  approvedAt: number | null;
  deliveredAt: number | null;
}

export interface Progress {
  catalogId: string;
  itemId: string;
  episodeId: string;
  positionMs: number;
  durationMs: number | null;
  status: "watching" | "finished";
  updatedAt: number;
}

interface Cursor {
  catalogId: string;
  itemId: string;
  episodeId: string;
  updatedAt: number;
  /** Placed by the wrap to the first episode after the last one was finished: the item was watched to the end. */
  wrapped: boolean;
}

/** An episode as the catalog history knows it. */
export interface SeenEpisode {
  episodeId: string;
  itemId: string;
  /** When the first build carrying it was loaded (epoch ms); 0 for episodes present at the first load ever. */
  firstSeenAt: number;
  buildId: string;
  /** Set while the loaded catalog does not carry it. */
  removedAt: number | null;
}

/** What a build changed against the catalog loaded before it. Each list holds at most 500 entries. */
export interface CatalogChanges {
  items: {
    added: Array<{ id: string; title: string; kind: string }>;
    /** Title from the catalog loaded before; null when that catalog was not in memory (a restart). */
    removed: Array<{ id: string; title: string | null }>;
  };
  episodes: {
    added: Array<{
      id: string;
      itemId: string;
      itemTitle: string;
      season: number | null;
      number: number | null;
      label: string | null;
      playbackAllowed: boolean;
    }>;
    removed: Array<{ id: string; itemId: string; itemTitle: string | null }>;
  };
}

/** One loaded build of a catalog, with the exact counts of its changes. */
export interface CatalogBuild {
  catalogId: string;
  buildId: string;
  builtAt: string;
  loadedAt: number;
  /** The first load of this catalog id: everything in it was already there, nothing counts as new. */
  baseline: boolean;
  items: number;
  episodes: number;
  itemsAdded: number;
  itemsRemoved: number;
  episodesAdded: number;
  episodesRemoved: number;
}

export interface Command {
  id: number;
  deviceId: string;
  type: CommandType;
  payload: Record<string, unknown>;
  createdAt: number;
  ackedAt: number | null;
}

export type ProblemOrigin = "tv" | "server";

/** Something that went wrong on a TV: reported by the TV itself, or recorded by the server for it. */
export interface Problem {
  id: number;
  deviceId: string;
  at: number;
  origin: ProblemOrigin;
  kind: ProblemKind;
  code: string;
  /** Set (with `itemId`) when the episode was in the catalog when the problem was recorded. */
  catalogId: string | null;
  itemId: string | null;
  episodeId: string | null;
  sourceId: string | null;
  positionMs: number | null;
  httpStatus: number | null;
  detail: string | null;
  appVersion: string | null;
}

export interface NowPlaying {
  catalogId: string;
  itemId: string;
  episodeId: string;
  sourceId: string | null;
  positionMs: number;
  durationMs: number | null;
  /** `starting` from a resolve until the player's first report, then the report's status. */
  state: "starting" | ProgressReportStatus;
  updatedAt: number;
  /** Whether the player was actually advancing when it sampled `positionMs` (a rebuffer stall reports false). */
  playing: boolean;
  /** When `positionMs` was sampled: the report's receipt time minus its age (epoch ms); null for old rows. */
  anchorAt: number | null;
  /** Bumped on every write; the admin "now" route long-polls on it. */
  seq: number;
}

/** Owner-set timing between a TV source and a companion source of the same episode ("Listen along"). */
export interface CompanionLink {
  catalogId: string;
  itemId: string;
  episodeId: string;
  sourceId: string;
  /** Audio language to pick inside the companion stream; null = the player's default. */
  language: string | null;
  /** Companion position when the TV is at 0. */
  offsetMs: number;
  /** Companion seconds per TV second (1.0427 for a PAL transfer against a film-rate source). */
  rate: number;
  updatedAt: number;
}

export type DevicePatch = Partial<Pick<Device, "name" | "uiLanguage" | "preferredAudioLanguage" | "subtitlesLanguage" | "autoplayOnStart">>;

type Row = Record<string, SQLOutputValue>;

const PATCHABLE = ["name", "uiLanguage", "preferredAudioLanguage", "subtitlesLanguage", "autoplayOnStart"] as const;
/** 0/1 columns, read as booleans. */
const FLAGS = new Set(["autoplay_on_start", "wrapped", "playing", "baseline"]);
const column = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const sqlValue = (v: unknown) => (typeof v === "boolean" ? Number(v) : v) as SQLInputValue;

/**
 * A row as the store's types have it: snake_case columns in camelCase, flags as booleans, `*_json` columns parsed
 * (named without the suffix), and the `omit` column (the key the caller selected by) left out.
 */
function fromRow<T>(r: Row, omit?: string): T {
  const out: Record<string, unknown> = {};
  for (const [c, v] of Object.entries(r)) {
    if (c === omit) continue;
    const key = c.replace(/_json$/, "").replace(/_([a-z])/g, (_, l: string) => l.toUpperCase());
    out[key] = FLAGS.has(c) ? v === 1 : c.endsWith("_json") ? JSON.parse(v as string) : v;
  }
  return out as T;
}

/** Typed access to the SQLite database. All methods are synchronous (node:sqlite). */
export class Store {
  private readonly db: DatabaseSync;
  // Tracked by hand: DatabaseSync#isOpen / #isTransaction need Node 22.15+ / 22.16+.
  private open = true;
  private inTransaction = false;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file, { enableForeignKeyConstraints: true });
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    const current = this.schemaVersion;
    if (current > MIGRATIONS.length) {
      throw new Error(`database schema version ${current} is newer than this server (${MIGRATIONS.length})`);
    }
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.transaction(() => this.db.exec(`${MIGRATIONS[v]!}; PRAGMA user_version = ${v + 1}`));
    }
  }

  get schemaVersion(): number {
    return Number(this.get("PRAGMA user_version")!.user_version);
  }

  close(): void {
    if (this.open) this.db.close();
    this.open = false;
  }

  transaction<T>(fn: () => T): T {
    if (this.inTransaction) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    } finally {
      this.inTransaction = false;
    }
  }

  private get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...params);
  }

  private run(sql: string, ...params: SQLInputValue[]): number {
    return Number(this.db.prepare(sql).run(...params).changes);
  }

  private one<T>(sql: string, params: SQLInputValue[], omit?: string): T | null {
    const r = this.get(sql, ...params);
    return r ? fromRow<T>(r, omit) : null;
  }

  private many<T>(sql: string, params: SQLInputValue[], omit?: string): T[] {
    return this.db.prepare(sql).all(...params).map((r) => fromRow<T>(r, omit));
  }

  /**
   * Inserts `row` (the store's own field names as columns, never request input). With `key`, the columns of a
   * unique key, a conflicting row is updated instead: every other column takes the new value.
   */
  private insert(table: string, row: object, key?: string, returning = ""): Row | undefined {
    const columns = Object.keys(row).map(column);
    const update = columns.filter((c) => !key?.split(", ").includes(c)).map((c) => `${c} = excluded.${c}`);
    const upsert = key ? ` ON CONFLICT (${key}) DO UPDATE SET ${update.join(", ")}` : "";
    const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})${upsert}`;
    return this.get(`${sql}${returning}`, ...Object.values(row).map(sqlValue));
  }

  // --- devices -------------------------------------------------------------------------------------------------

  createDevice(d: { id: string; name: string; tokenHash: string | null; now: number }): Device {
    this.insert("devices", { id: d.id, name: d.name, tokenHash: d.tokenHash, createdAt: d.now });
    return this.getDevice(d.id)!;
  }

  setDeviceToken(id: string, tokenHash: string, now: number): void {
    this.run("UPDATE devices SET token_hash = ?, last_seen_at = ? WHERE id = ?", tokenHash, now, id);
  }

  getDevice(id: string): Device | null {
    return this.one("SELECT * FROM devices WHERE id = ?", [id]);
  }

  getDeviceByTokenHash(tokenHash: string): Device | null {
    return this.one("SELECT * FROM devices WHERE token_hash = ?", [tokenHash]);
  }

  listDevices(): Device[] {
    return this.many("SELECT * FROM devices ORDER BY created_at, id", []);
  }

  /** Applies a patch (undefined fields are left alone, null clears) and bumps the state version. */
  updateDevice(id: string, patch: DevicePatch): Device | null {
    const keys = PATCHABLE.filter((k) => patch[k] !== undefined);
    const sets = [...keys.map((k) => `${column(k)} = ?`), "state_version = state_version + 1"];
    const values = keys.map((k) => sqlValue(patch[k]));
    if (this.run(`UPDATE devices SET ${sets.join(", ")} WHERE id = ?`, ...values, id) === 0) return null;
    return this.getDevice(id);
  }

  deleteDevice(id: string): boolean {
    return this.run("DELETE FROM devices WHERE id = ?", id) > 0;
  }

  touchDevice(id: string, now: number): void {
    this.run("UPDATE devices SET last_seen_at = ? WHERE id = ?", now, id);
  }

  bumpStateVersion(id: string): number {
    const r = this.get("UPDATE devices SET state_version = state_version + 1 WHERE id = ? RETURNING state_version", id);
    return Number(r?.state_version ?? 0);
  }

  bumpAllStateVersions(): Array<{ id: string; stateVersion: number }> {
    return this.many("UPDATE devices SET state_version = state_version + 1 RETURNING id, state_version", []);
  }

  // --- pairing -------------------------------------------------------------------------------------------------

  insertPairCode(p: Pick<PairCode, "code" | "pairTokenHash" | "createdAt" | "expiresAt">): void {
    this.insert("pair_codes", p);
  }

  getPairCode(code: string): PairCode | null {
    return this.one("SELECT * FROM pair_codes WHERE code = ?", [code]);
  }

  /** Codes that are neither expired nor delivered. */
  listOpenPairCodes(now: number): PairCode[] {
    return this.many("SELECT * FROM pair_codes WHERE expires_at > ? AND delivered_at IS NULL ORDER BY created_at", [now]);
  }

  approvePairCode(code: string, deviceId: string, now: number): void {
    this.run("UPDATE pair_codes SET device_id = ?, approved_at = ? WHERE code = ?", deviceId, now, code);
  }

  markPairCodeDelivered(code: string, now: number): void {
    this.run("UPDATE pair_codes SET delivered_at = ? WHERE code = ?", now, code);
  }

  /**
   * Deletes pair codes that expired (or were delivered) more than `graceMs` ago, together with devices that were
   * approved but never collected their token.
   */
  purgePairCodes(now: number, graceMs: number): void {
    this.transaction(() => {
      this.run(
        `DELETE FROM devices WHERE token_hash IS NULL AND id IN
           (SELECT device_id FROM pair_codes WHERE device_id IS NOT NULL AND delivered_at IS NULL AND expires_at <= ?)`,
        now,
      );
      this.run("DELETE FROM pair_codes WHERE expires_at <= ? OR delivered_at <= ?", now - graceMs, now - graceMs);
    });
  }

  // --- home ----------------------------------------------------------------------------------------------------

  /** The device's home list, with when each item was put there (epoch ms; null for rows not written by the store). */
  getHomeEntries(deviceId: string, catalogId: string): Array<{ itemId: string; addedAt: number | null }> {
    return this.many("SELECT item_id, added_at FROM home_entries WHERE device_id = ? AND catalog_id = ? ORDER BY position", [deviceId, catalogId]);
  }

  /**
   * Replaces the device's home list. Items already on it keep the date they were put there (a reorder changes
   * nothing); new ones get `now`. Episodes added to the catalog before an item went on the list are not new to it.
   */
  setHome(deviceId: string, catalogId: string, itemIds: string[], now: number): void {
    this.transaction(() => {
      const addedAt = new Map(this.getHomeEntries(deviceId, catalogId).map((e) => [e.itemId, e.addedAt]));
      this.run("DELETE FROM home_entries WHERE device_id = ?", deviceId);
      const insert = this.db.prepare("INSERT INTO home_entries (device_id, position, catalog_id, item_id, added_at) VALUES (?, ?, ?, ?, ?)");
      itemIds.forEach((itemId, i) => insert.run(deviceId, i, catalogId, itemId, addedAt.get(itemId) ?? now));
    });
  }

  // --- progress & cursor ---------------------------------------------------------------------------------------

  getProgress(deviceId: string, catalogId: string, episodeId: string): Progress | null {
    const sql = "SELECT * FROM progress WHERE device_id = ? AND catalog_id = ? AND episode_id = ?";
    return this.one(sql, [deviceId, catalogId, episodeId], "device_id");
  }

  listProgress(deviceId: string, catalogId: string, itemId: string | null = null): Progress[] {
    return this.many(
      `SELECT * FROM progress WHERE device_id = ? AND catalog_id = ? AND (? IS NULL OR item_id = ?)
       ORDER BY updated_at DESC`,
      [deviceId, catalogId, itemId, itemId],
      "device_id",
    );
  }

  upsertProgress(deviceId: string, p: Progress): void {
    this.insert("progress", { deviceId, ...p }, "device_id, catalog_id, episode_id");
  }

  deleteProgress(deviceId: string, catalogId: string, episodeId: string): void {
    this.run("DELETE FROM progress WHERE device_id = ? AND catalog_id = ? AND episode_id = ?", deviceId, catalogId, episodeId);
  }

  /** When the device last reported progress on any episode of the item (epoch ms), or null. */
  lastProgressAt(deviceId: string, catalogId: string, itemId: string): number | null {
    return this.one<{ at: number | null }>(
      "SELECT MAX(updated_at) AS at FROM progress WHERE device_id = ? AND catalog_id = ? AND item_id = ?",
      [deviceId, catalogId, itemId],
    )!.at;
  }

  getCursor(deviceId: string, catalogId: string, itemId: string): Cursor | null {
    const sql = "SELECT * FROM item_cursor WHERE device_id = ? AND catalog_id = ? AND item_id = ?";
    return this.one(sql, [deviceId, catalogId, itemId], "device_id");
  }

  listCursors(deviceId: string, catalogId: string): Cursor[] {
    return this.many("SELECT * FROM item_cursor WHERE device_id = ? AND catalog_id = ? ORDER BY updated_at DESC", [deviceId, catalogId], "device_id");
  }

  /** Upserts the item's cursor. `wrapped` defaults to false: only the wrap after the last episode sets it. */
  setCursor(deviceId: string, c: Omit<Cursor, "wrapped"> & { wrapped?: boolean }): void {
    this.insert("item_cursor", { deviceId, ...c, wrapped: c.wrapped ?? false }, "device_id, catalog_id, item_id");
  }

  // --- commands ------------------------------------------------------------------------------------------------

  insertCommand(deviceId: string, type: CommandType, payload: Record<string, unknown>, now: number): Command {
    const row = { deviceId, type, payloadJson: JSON.stringify(payload), createdAt: now };
    return fromRow(this.insert("commands", row, undefined, " RETURNING *")!);
  }

  /** Unacknowledged commands created after `since`, oldest first. */
  pendingCommands(deviceId: string, since: number): Command[] {
    return this.many("SELECT * FROM commands WHERE device_id = ? AND acked_at IS NULL AND created_at > ? ORDER BY id", [deviceId, since]);
  }

  ackCommand(deviceId: string, id: number, now: number): boolean {
    return this.run("UPDATE commands SET acked_at = COALESCE(acked_at, ?) WHERE id = ? AND device_id = ?", now, id, deviceId) > 0;
  }

  purgeCommands(before: number): void {
    this.run("DELETE FROM commands WHERE created_at < ?", before);
  }

  // --- problems ------------------------------------------------------------------------------------------------

  /** Stores a problem and keeps only the device's newest `keep` (by time, then insertion order). */
  insertProblem(p: Omit<Problem, "id">, keep: number): Problem {
    return this.transaction(() => {
      const r = this.insert("problems", p, undefined, " RETURNING *")!;
      this.run(
        "DELETE FROM problems WHERE device_id = ? AND id NOT IN (SELECT id FROM problems WHERE device_id = ? ORDER BY at DESC, id DESC LIMIT ?)",
        p.deviceId,
        p.deviceId,
        keep,
      );
      return fromRow(r);
    });
  }

  /** The device's problems, newest first. */
  listProblems(deviceId: string, limit: number): Problem[] {
    return this.many("SELECT * FROM problems WHERE device_id = ? ORDER BY at DESC, id DESC LIMIT ?", [deviceId, limit]);
  }

  /** How many problems happened since `since`, and when the latest one did (null: none stored). */
  problemStats(deviceId: string, since: number): { recent: number; lastAt: number | null } {
    return this.one("SELECT COUNT(CASE WHEN at >= ? THEN 1 END) AS recent, MAX(at) AS last_at FROM problems WHERE device_id = ?", [since, deviceId])!;
  }

  clearProblems(deviceId: string): number {
    return this.run("DELETE FROM problems WHERE device_id = ?", deviceId);
  }

  purgeProblems(before: number): void {
    this.run("DELETE FROM problems WHERE at < ?", before);
  }

  // --- now playing ---------------------------------------------------------------------------------------------

  /** Upserts the device's now-playing row and returns its sequence number, bumped on every write. */
  setNowPlaying(deviceId: string, n: Omit<NowPlaying, "seq">): number {
    return this.transaction(() => {
      const seq = (this.getNowPlaying(deviceId)?.seq ?? 0) + 1;
      this.insert("now_playing", { deviceId, ...n, seq }, "device_id");
      return seq;
    });
  }

  getNowPlaying(deviceId: string): NowPlaying | null {
    return this.one("SELECT * FROM now_playing WHERE device_id = ?", [deviceId], "device_id");
  }

  // --- catalog history -----------------------------------------------------------------------------------------

  /** Every episode the catalog has ever carried, present or removed, ordered by item then episode id. */
  catalogSeen(catalogId: string): SeenEpisode[] {
    return this.many("SELECT * FROM catalog_seen WHERE catalog_id = ? ORDER BY item_id, episode_id", [catalogId], "catalog_id");
  }

  insertSeen(catalogId: string, buildId: string, firstSeenAt: number, episodes: ReadonlyArray<{ episodeId: string; itemId: string }>): void {
    const insert = this.db.prepare(
      "INSERT INTO catalog_seen (catalog_id, episode_id, item_id, first_seen_at, build_id) VALUES (?, ?, ?, ?, ?)",
    );
    for (const e of episodes) insert.run(catalogId, e.episodeId, e.itemId, firstSeenAt, buildId);
  }

  /** Marks episodes absent from the loaded catalog; an episode already marked keeps its first removal time. */
  markSeenRemoved(catalogId: string, episodeIds: readonly string[], at: number): void {
    const update = this.db.prepare("UPDATE catalog_seen SET removed_at = ? WHERE catalog_id = ? AND episode_id = ? AND removed_at IS NULL");
    for (const id of episodeIds) update.run(at, catalogId, id);
  }

  /** Episodes back in the loaded catalog: present again, with their first-seen date unchanged. */
  clearSeenRemoved(catalogId: string, episodeIds: readonly string[]): void {
    const update = this.db.prepare("UPDATE catalog_seen SET removed_at = NULL WHERE catalog_id = ? AND episode_id = ?");
    for (const id of episodeIds) update.run(catalogId, id);
  }

  /** Episodes the loaded catalog files under another item than before (their first-seen date is unchanged). */
  moveSeen(catalogId: string, episodes: ReadonlyArray<{ episodeId: string; itemId: string }>): void {
    const update = this.db.prepare("UPDATE catalog_seen SET item_id = ? WHERE catalog_id = ? AND episode_id = ?");
    for (const e of episodes) update.run(e.itemId, catalogId, e.episodeId);
  }

  /** The item's present episodes that first appeared after `sinceMs`, oldest first. Baseline episodes (0) never do. */
  episodesSeenAfter(catalogId: string, itemId: string, sinceMs: number): string[] {
    return this.many<{ episodeId: string }>(
      `SELECT episode_id FROM catalog_seen WHERE catalog_id = ? AND item_id = ? AND removed_at IS NULL AND first_seen_at > ?
       ORDER BY first_seen_at, episode_id`,
      [catalogId, itemId, sinceMs],
    ).map((e) => e.episodeId);
  }

  /** Stores a loaded build. A build id loaded again later (a rollback) replaces its row with the new load. */
  recordCatalogBuild(b: CatalogBuild, changes: CatalogChanges): void {
    this.insert("catalog_builds", { ...b, changesJson: JSON.stringify(changes) }, "catalog_id, build_id");
  }

  /** The catalog's builds, most recently loaded first (without their change lists). */
  listCatalogBuilds(catalogId: string, limit: number): CatalogBuild[] {
    return this.many(
      `SELECT catalog_id, build_id, built_at, loaded_at, baseline, items, episodes, items_added, items_removed, episodes_added, episodes_removed
       FROM catalog_builds WHERE catalog_id = ? ORDER BY loaded_at DESC, rowid DESC LIMIT ?`,
      [catalogId, limit],
    );
  }

  getCatalogBuild(catalogId: string, buildId: string): { build: CatalogBuild; changes: CatalogChanges } | null {
    const sql = "SELECT * FROM catalog_builds WHERE catalog_id = ? AND build_id = ?";
    const r = this.one<CatalogBuild & { changes: CatalogChanges }>(sql, [catalogId, buildId]);
    if (!r) return null;
    const { changes, ...build } = r;
    return { build, changes };
  }

  // --- companion links -----------------------------------------------------------------------------------------

  getCompanionLink(catalogId: string, episodeId: string, sourceId: string): CompanionLink | null {
    return this.one("SELECT * FROM companion_links WHERE catalog_id = ? AND episode_id = ? AND source_id = ?", [catalogId, episodeId, sourceId]);
  }

  listCompanionLinks(catalogId: string, episodeId: string): CompanionLink[] {
    return this.many("SELECT * FROM companion_links WHERE catalog_id = ? AND episode_id = ? ORDER BY source_id", [catalogId, episodeId]);
  }

  putCompanionLink(l: CompanionLink): void {
    this.insert("companion_links", l, "catalog_id, episode_id, source_id");
  }
}
