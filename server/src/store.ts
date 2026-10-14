import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

// Schema migrations, applied in order; PRAGMA user_version records how many ran. Never edit a shipped migration,
// append a new one.
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT UNIQUE,                 -- sha256 of the device token; NULL while pairing is not completed
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    ui_language TEXT,                       -- NULL = server/catalog default
    preferred_audio_language TEXT,
    subtitles_language TEXT,                -- NULL = subtitles off
    state_version INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE pair_codes (
    code TEXT PRIMARY KEY,
    pair_token_hash TEXT NOT NULL,
    device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    approved_at INTEGER,
    delivered_at INTEGER
  );
  CREATE TABLE home_entries (
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    catalog_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    PRIMARY KEY (device_id, position)
  );
  CREATE TABLE progress (
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    catalog_id TEXT NOT NULL,
    episode_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    position_ms INTEGER NOT NULL,
    duration_ms INTEGER,
    status TEXT NOT NULL CHECK (status IN ('watching', 'finished')),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (device_id, catalog_id, episode_id)
  );
  CREATE TABLE item_cursor (
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    catalog_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    episode_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (device_id, catalog_id, item_id)
  );
  CREATE TABLE commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    acked_at INTEGER
  );
  CREATE INDEX commands_by_device ON commands (device_id, acked_at);
  CREATE TABLE now_playing (
    device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
    catalog_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    episode_id TEXT NOT NULL,
    source_id TEXT,
    position_ms INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER,
    state TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  // 2 — "Listen along": a precise playback anchor on now_playing and the owner's companion links.
  `
  ALTER TABLE now_playing ADD COLUMN playing INTEGER NOT NULL DEFAULT 0;   -- the player was actually advancing
  ALTER TABLE now_playing ADD COLUMN anchor_at INTEGER;                    -- when position_ms was sampled (epoch ms)
  ALTER TABLE now_playing ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;       -- bumped on every write (admin long-polls)
  CREATE TABLE companion_links (
    catalog_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    episode_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    language TEXT,                          -- NULL = the player's default audio track
    offset_ms INTEGER NOT NULL DEFAULT 0,   -- companion position when the TV is at 0
    rate REAL NOT NULL DEFAULT 1.0,         -- companion seconds per TV second
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (catalog_id, episode_id, source_id)
  );
  CREATE INDEX companion_links_by_item ON companion_links (catalog_id, item_id);
  `,
  // 3 — problem reports (what went wrong on a TV, for the remote owner) and the per-TV "autoplay on start" setting.
  `
  CREATE TABLE problems (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    at INTEGER NOT NULL,                    -- when it happened (epoch ms)
    origin TEXT NOT NULL CHECK (origin IN ('tv', 'server')),
    kind TEXT NOT NULL,                     -- playback | resolve | proxy | network | other
    code TEXT NOT NULL,
    catalog_id TEXT,                        -- with item_id: set when the episode was in the catalog
    item_id TEXT,
    episode_id TEXT,
    source_id TEXT,
    position_ms INTEGER,
    http_status INTEGER,
    detail TEXT,                            -- redacted before it is stored; never logged
    app_version TEXT
  );
  CREATE INDEX problems_by_device ON problems (device_id, at);
  ALTER TABLE devices ADD COLUMN autoplay_on_start INTEGER NOT NULL DEFAULT 0;
  `,
  // 4 — catalog history: which build first carried each episode, a record per loaded build, when an item went on a
  // home list, and whether a cursor was placed by the wrap after the last episode (new episodes then play first).
  `
  ALTER TABLE home_entries ADD COLUMN added_at INTEGER;            -- when the item first went on this TV's list (epoch ms)
  UPDATE home_entries SET added_at = CAST(strftime('%s','now') AS INTEGER) * 1000;
  ALTER TABLE item_cursor ADD COLUMN wrapped INTEGER NOT NULL DEFAULT 0;   -- 1: placed by the wrap after the last episode
  CREATE TABLE catalog_builds (
    catalog_id TEXT NOT NULL, build_id TEXT NOT NULL, built_at TEXT NOT NULL, loaded_at INTEGER NOT NULL,
    baseline INTEGER NOT NULL DEFAULT 0, items INTEGER NOT NULL, episodes INTEGER NOT NULL,
    items_added INTEGER NOT NULL, items_removed INTEGER NOT NULL, episodes_added INTEGER NOT NULL, episodes_removed INTEGER NOT NULL,
    changes_json TEXT NOT NULL,                                     -- lists capped at 500 each; counts exact
    PRIMARY KEY (catalog_id, build_id));
  CREATE INDEX catalog_builds_by_time ON catalog_builds (catalog_id, loaded_at);
  CREATE TABLE catalog_seen (
    catalog_id TEXT NOT NULL, episode_id TEXT NOT NULL, item_id TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL,                                 -- 0 for episodes present at the first load ever
    build_id TEXT NOT NULL, removed_at INTEGER,                     -- set while absent from the loaded catalog
    PRIMARY KEY (catalog_id, episode_id));
  CREATE INDEX catalog_seen_by_item ON catalog_seen (catalog_id, item_id, first_seen_at);
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

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

export interface PairCode {
  code: string;
  pairTokenHash: string;
  deviceId: string | null;
  createdAt: number;
  expiresAt: number;
  approvedAt: number | null;
  deliveredAt: number | null;
}

export type ProgressStatus = "watching" | "finished";

export interface Progress {
  catalogId: string;
  itemId: string;
  episodeId: string;
  positionMs: number;
  durationMs: number | null;
  status: ProgressStatus;
  updatedAt: number;
}

export interface Cursor {
  catalogId: string;
  itemId: string;
  episodeId: string;
  updatedAt: number;
  /** Placed by the wrap to the first episode after the last one was finished: the item was watched to the end. */
  wrapped: boolean;
}

/** An item on a device's home list and when it was put there (epoch ms; null only for rows written outside the store). */
export interface HomeEntry {
  itemId: string;
  addedAt: number | null;
}

/** An episode of a catalog as the history knows it: when it first appeared and whether it is gone now. */
export interface SeenEpisode {
  episodeId: string;
  itemId: string;
  /** When the first build carrying it was loaded (epoch ms); 0 for episodes present at the first load ever. */
  firstSeenAt: number;
  /** The build that first carried it. */
  buildId: string;
  /** Set while the loaded catalog does not carry it. */
  removedAt: number | null;
}

/** What a build changed against the catalog loaded before it. Each list holds at most 500 entries; the build's counts are exact. */
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

/** One loaded build of a catalog. Counts are exact; the lists in its changes are capped. */
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
  type: string;
  payload: Record<string, unknown>;
  createdAt: number;
  ackedAt: number | null;
}

export type ProblemOrigin = "tv" | "server";

/** Something that went wrong on a TV: reported by the TV itself, or recorded by the server for it. */
export interface Problem {
  id: number;
  deviceId: string;
  /** When it happened (epoch ms). */
  at: number;
  origin: ProblemOrigin;
  /** `playback`, `resolve`, `proxy`, `network` or `other`. */
  kind: string;
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
  state: string;
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

type Row = Record<string, unknown>;
const str = (v: unknown) => v as string;
const strOrNull = (v: unknown) => (v === null || v === undefined ? null : String(v));
const num = (v: unknown) => Number(v);
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function toDevice(r: Row): Device {
  return {
    id: str(r.id),
    name: str(r.name),
    tokenHash: strOrNull(r.token_hash),
    createdAt: num(r.created_at),
    lastSeenAt: numOrNull(r.last_seen_at),
    uiLanguage: strOrNull(r.ui_language),
    preferredAudioLanguage: strOrNull(r.preferred_audio_language),
    subtitlesLanguage: strOrNull(r.subtitles_language),
    stateVersion: num(r.state_version),
    autoplayOnStart: num(r.autoplay_on_start) === 1,
  };
}

function toPairCode(r: Row): PairCode {
  return {
    code: str(r.code),
    pairTokenHash: str(r.pair_token_hash),
    deviceId: strOrNull(r.device_id),
    createdAt: num(r.created_at),
    expiresAt: num(r.expires_at),
    approvedAt: numOrNull(r.approved_at),
    deliveredAt: numOrNull(r.delivered_at),
  };
}

function toProgress(r: Row): Progress {
  return {
    catalogId: str(r.catalog_id),
    itemId: str(r.item_id),
    episodeId: str(r.episode_id),
    positionMs: num(r.position_ms),
    durationMs: numOrNull(r.duration_ms),
    status: str(r.status) as ProgressStatus,
    updatedAt: num(r.updated_at),
  };
}

function toCompanionLink(r: Row): CompanionLink {
  return {
    catalogId: str(r.catalog_id),
    itemId: str(r.item_id),
    episodeId: str(r.episode_id),
    sourceId: str(r.source_id),
    language: strOrNull(r.language),
    offsetMs: num(r.offset_ms),
    rate: num(r.rate),
    updatedAt: num(r.updated_at),
  };
}

function toCursor(r: Row): Cursor {
  return {
    catalogId: str(r.catalog_id),
    itemId: str(r.item_id),
    episodeId: str(r.episode_id),
    updatedAt: num(r.updated_at),
    wrapped: num(r.wrapped) === 1,
  };
}

function toSeenEpisode(r: Row): SeenEpisode {
  return {
    episodeId: str(r.episode_id),
    itemId: str(r.item_id),
    firstSeenAt: num(r.first_seen_at),
    buildId: str(r.build_id),
    removedAt: numOrNull(r.removed_at),
  };
}

function toCatalogBuild(r: Row): CatalogBuild {
  return {
    catalogId: str(r.catalog_id),
    buildId: str(r.build_id),
    builtAt: str(r.built_at),
    loadedAt: num(r.loaded_at),
    baseline: num(r.baseline) === 1,
    items: num(r.items),
    episodes: num(r.episodes),
    itemsAdded: num(r.items_added),
    itemsRemoved: num(r.items_removed),
    episodesAdded: num(r.episodes_added),
    episodesRemoved: num(r.episodes_removed),
  };
}

function toCommand(r: Row): Command {
  return {
    id: num(r.id),
    deviceId: str(r.device_id),
    type: str(r.type),
    payload: JSON.parse(str(r.payload_json)) as Record<string, unknown>,
    createdAt: num(r.created_at),
    ackedAt: numOrNull(r.acked_at),
  };
}

function toProblem(r: Row): Problem {
  return {
    id: num(r.id),
    deviceId: str(r.device_id),
    at: num(r.at),
    origin: str(r.origin) as ProblemOrigin,
    kind: str(r.kind),
    code: str(r.code),
    catalogId: strOrNull(r.catalog_id),
    itemId: strOrNull(r.item_id),
    episodeId: strOrNull(r.episode_id),
    sourceId: strOrNull(r.source_id),
    positionMs: numOrNull(r.position_ms),
    httpStatus: numOrNull(r.http_status),
    detail: strOrNull(r.detail),
    appVersion: strOrNull(r.app_version),
  };
}

export type DevicePatch = Partial<Pick<Device, "name" | "uiLanguage" | "preferredAudioLanguage" | "subtitlesLanguage" | "autoplayOnStart">>;

/** Typed access to the SQLite database. All methods are synchronous (node:sqlite). */
export class Store {
  readonly db: DatabaseSync;
  // Tracked by hand: DatabaseSync#isOpen / #isTransaction need Node 22.15+ / 22.16+.
  private open = true;
  private inTransaction = false;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file, { enableForeignKeyConstraints: true });
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.migrate();
  }

  private migrate(): void {
    const current = Number((this.db.prepare("PRAGMA user_version").get() as Row).user_version);
    if (current > MIGRATIONS.length) {
      throw new Error(`database schema version ${current} is newer than this server (${MIGRATIONS.length})`);
    }
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  get schemaVersion(): number {
    return Number((this.db.prepare("PRAGMA user_version").get() as Row).user_version);
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
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }

  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }

  private run(sql: string, ...params: SQLInputValue[]): number {
    return Number(this.db.prepare(sql).run(...params).changes);
  }

  // --- devices -------------------------------------------------------------------------------------------------

  createDevice(d: { id: string; name: string; tokenHash: string | null; now: number }): Device {
    this.run("INSERT INTO devices (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)", d.id, d.name, d.tokenHash, d.now);
    return this.getDevice(d.id)!;
  }

  setDeviceToken(id: string, tokenHash: string, now: number): void {
    this.run("UPDATE devices SET token_hash = ?, last_seen_at = ? WHERE id = ?", tokenHash, now, id);
  }

  getDevice(id: string): Device | null {
    const r = this.get("SELECT * FROM devices WHERE id = ?", id);
    return r ? toDevice(r) : null;
  }

  getDeviceByTokenHash(tokenHash: string): Device | null {
    const r = this.get("SELECT * FROM devices WHERE token_hash = ?", tokenHash);
    return r ? toDevice(r) : null;
  }

  listDevices(): Device[] {
    return this.all("SELECT * FROM devices ORDER BY created_at, id").map(toDevice);
  }

  /** Applies a patch (undefined fields are left alone, null clears) and bumps the state version. */
  updateDevice(id: string, patch: DevicePatch): Device | null {
    const columns: Array<[keyof DevicePatch, string]> = [
      ["name", "name"],
      ["uiLanguage", "ui_language"],
      ["preferredAudioLanguage", "preferred_audio_language"],
      ["subtitlesLanguage", "subtitles_language"],
      ["autoplayOnStart", "autoplay_on_start"],
    ];
    const sets: string[] = [];
    const values: SQLInputValue[] = [];
    for (const [key, column] of columns) {
      const value = patch[key];
      if (value !== undefined) {
        sets.push(`${column} = ?`);
        values.push(typeof value === "boolean" ? (value ? 1 : 0) : value);
      }
    }
    sets.push("state_version = state_version + 1");
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
    return r ? num(r.state_version) : 0;
  }

  bumpAllStateVersions(): Array<{ id: string; stateVersion: number }> {
    return this.all("UPDATE devices SET state_version = state_version + 1 RETURNING id, state_version").map((r) => ({
      id: str(r.id),
      stateVersion: num(r.state_version),
    }));
  }

  // --- pairing -------------------------------------------------------------------------------------------------

  insertPairCode(p: { code: string; pairTokenHash: string; now: number; expiresAt: number }): void {
    this.run(
      "INSERT INTO pair_codes (code, pair_token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)",
      p.code,
      p.pairTokenHash,
      p.now,
      p.expiresAt,
    );
  }

  getPairCode(code: string): PairCode | null {
    const r = this.get("SELECT * FROM pair_codes WHERE code = ?", code);
    return r ? toPairCode(r) : null;
  }

  /** Codes that are neither expired nor delivered. */
  listOpenPairCodes(now: number): PairCode[] {
    return this.all("SELECT * FROM pair_codes WHERE expires_at > ? AND delivered_at IS NULL ORDER BY created_at", now).map(toPairCode);
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

  getHome(deviceId: string, catalogId: string): string[] {
    return this.getHomeEntries(deviceId, catalogId).map((e) => e.itemId);
  }

  getHomeEntries(deviceId: string, catalogId: string): HomeEntry[] {
    return this.all("SELECT item_id, added_at FROM home_entries WHERE device_id = ? AND catalog_id = ? ORDER BY position", deviceId, catalogId).map(
      (r) => ({ itemId: str(r.item_id), addedAt: numOrNull(r.added_at) }),
    );
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
    const r = this.get("SELECT * FROM progress WHERE device_id = ? AND catalog_id = ? AND episode_id = ?", deviceId, catalogId, episodeId);
    return r ? toProgress(r) : null;
  }

  listProgress(deviceId: string, catalogId: string, itemId?: string): Progress[] {
    return itemId === undefined
      ? this.all("SELECT * FROM progress WHERE device_id = ? AND catalog_id = ? ORDER BY updated_at DESC", deviceId, catalogId).map(toProgress)
      : this.all(
          "SELECT * FROM progress WHERE device_id = ? AND catalog_id = ? AND item_id = ? ORDER BY updated_at DESC",
          deviceId,
          catalogId,
          itemId,
        ).map(toProgress);
  }

  upsertProgress(deviceId: string, p: Progress): void {
    this.run(
      `INSERT INTO progress (device_id, catalog_id, episode_id, item_id, position_ms, duration_ms, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (device_id, catalog_id, episode_id) DO UPDATE SET
         item_id = excluded.item_id, position_ms = excluded.position_ms, duration_ms = excluded.duration_ms,
         status = excluded.status, updated_at = excluded.updated_at`,
      deviceId,
      p.catalogId,
      p.episodeId,
      p.itemId,
      p.positionMs,
      p.durationMs,
      p.status,
      p.updatedAt,
    );
  }

  deleteProgress(deviceId: string, catalogId: string, episodeId: string): void {
    this.run("DELETE FROM progress WHERE device_id = ? AND catalog_id = ? AND episode_id = ?", deviceId, catalogId, episodeId);
  }

  /** When the device last reported progress on any episode of the item (epoch ms), or null. */
  lastProgressAt(deviceId: string, catalogId: string, itemId: string): number | null {
    const r = this.get("SELECT MAX(updated_at) AS at FROM progress WHERE device_id = ? AND catalog_id = ? AND item_id = ?", deviceId, catalogId, itemId);
    return numOrNull(r?.at);
  }

  getCursor(deviceId: string, catalogId: string, itemId: string): Cursor | null {
    const r = this.get("SELECT * FROM item_cursor WHERE device_id = ? AND catalog_id = ? AND item_id = ?", deviceId, catalogId, itemId);
    return r ? toCursor(r) : null;
  }

  listCursors(deviceId: string, catalogId: string): Cursor[] {
    return this.all("SELECT * FROM item_cursor WHERE device_id = ? AND catalog_id = ? ORDER BY updated_at DESC", deviceId, catalogId).map(toCursor);
  }

  /** Upserts the item's cursor. `wrapped` defaults to false: only the wrap after the last episode sets it. */
  setCursor(deviceId: string, c: Omit<Cursor, "wrapped"> & { wrapped?: boolean }): void {
    this.run(
      `INSERT INTO item_cursor (device_id, catalog_id, item_id, episode_id, updated_at, wrapped) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (device_id, catalog_id, item_id) DO UPDATE SET episode_id = excluded.episode_id, updated_at = excluded.updated_at,
         wrapped = excluded.wrapped`,
      deviceId,
      c.catalogId,
      c.itemId,
      c.episodeId,
      c.updatedAt,
      c.wrapped ? 1 : 0,
    );
  }

  // --- commands ------------------------------------------------------------------------------------------------

  insertCommand(deviceId: string, type: string, payload: Record<string, unknown>, now: number): Command {
    const r = this.get(
      "INSERT INTO commands (device_id, type, payload_json, created_at) VALUES (?, ?, ?, ?) RETURNING *",
      deviceId,
      type,
      JSON.stringify(payload),
      now,
    );
    return toCommand(r!);
  }

  /** Unacknowledged commands created after `since`, oldest first. */
  pendingCommands(deviceId: string, since: number): Command[] {
    return this.all("SELECT * FROM commands WHERE device_id = ? AND acked_at IS NULL AND created_at > ? ORDER BY id", deviceId, since).map(
      toCommand,
    );
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
      const r = this.get(
        `INSERT INTO problems (device_id, at, origin, kind, code, catalog_id, item_id, episode_id, source_id, position_ms, http_status, detail, app_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        p.deviceId,
        p.at,
        p.origin,
        p.kind,
        p.code,
        p.catalogId,
        p.itemId,
        p.episodeId,
        p.sourceId,
        p.positionMs,
        p.httpStatus,
        p.detail,
        p.appVersion,
      );
      this.run(
        "DELETE FROM problems WHERE device_id = ? AND id NOT IN (SELECT id FROM problems WHERE device_id = ? ORDER BY at DESC, id DESC LIMIT ?)",
        p.deviceId,
        p.deviceId,
        keep,
      );
      return toProblem(r!);
    });
  }

  /** The device's problems, newest first. */
  listProblems(deviceId: string, limit: number): Problem[] {
    return this.all("SELECT * FROM problems WHERE device_id = ? ORDER BY at DESC, id DESC LIMIT ?", deviceId, limit).map(toProblem);
  }

  /** How many problems happened since `since`, and when the latest one did (null: none stored). */
  problemStats(deviceId: string, since: number): { recent: number; lastAt: number | null } {
    const r = this.get("SELECT COUNT(CASE WHEN at >= ? THEN 1 END) AS recent, MAX(at) AS last_at FROM problems WHERE device_id = ?", since, deviceId)!;
    return { recent: num(r.recent), lastAt: numOrNull(r.last_at) };
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
    const r = this.get(
      `INSERT INTO now_playing (device_id, catalog_id, item_id, episode_id, source_id, position_ms, duration_ms, state, updated_at, playing, anchor_at, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT (device_id) DO UPDATE SET catalog_id = excluded.catalog_id, item_id = excluded.item_id,
         episode_id = excluded.episode_id, source_id = excluded.source_id, position_ms = excluded.position_ms,
         duration_ms = excluded.duration_ms, state = excluded.state, updated_at = excluded.updated_at,
         playing = excluded.playing, anchor_at = excluded.anchor_at, seq = now_playing.seq + 1
       RETURNING seq`,
      deviceId,
      n.catalogId,
      n.itemId,
      n.episodeId,
      n.sourceId,
      n.positionMs,
      n.durationMs,
      n.state,
      n.updatedAt,
      n.playing ? 1 : 0,
      n.anchorAt,
    );
    return num(r!.seq);
  }

  getNowPlaying(deviceId: string): NowPlaying | null {
    const r = this.get("SELECT * FROM now_playing WHERE device_id = ?", deviceId);
    return r
      ? {
          catalogId: str(r.catalog_id),
          itemId: str(r.item_id),
          episodeId: str(r.episode_id),
          sourceId: strOrNull(r.source_id),
          positionMs: num(r.position_ms),
          durationMs: numOrNull(r.duration_ms),
          state: str(r.state),
          updatedAt: num(r.updated_at),
          playing: num(r.playing) === 1,
          anchorAt: numOrNull(r.anchor_at),
          seq: num(r.seq),
        }
      : null;
  }

  // --- catalog history -----------------------------------------------------------------------------------------

  /** Every episode the catalog has ever carried, present or removed, ordered by item then episode id. */
  catalogSeen(catalogId: string): SeenEpisode[] {
    return this.all("SELECT * FROM catalog_seen WHERE catalog_id = ? ORDER BY item_id, episode_id", catalogId).map(toSeenEpisode);
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
    return this.all(
      `SELECT episode_id FROM catalog_seen WHERE catalog_id = ? AND item_id = ? AND removed_at IS NULL AND first_seen_at > ?
       ORDER BY first_seen_at, episode_id`,
      catalogId,
      itemId,
      sinceMs,
    ).map((r) => str(r.episode_id));
  }

  /** Stores a loaded build. A build id loaded again later (a rollback) replaces its row with the new load. */
  recordCatalogBuild(b: CatalogBuild, changes: CatalogChanges): void {
    this.run(
      `INSERT INTO catalog_builds (catalog_id, build_id, built_at, loaded_at, baseline, items, episodes,
         items_added, items_removed, episodes_added, episodes_removed, changes_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (catalog_id, build_id) DO UPDATE SET built_at = excluded.built_at, loaded_at = excluded.loaded_at,
         baseline = excluded.baseline, items = excluded.items, episodes = excluded.episodes,
         items_added = excluded.items_added, items_removed = excluded.items_removed,
         episodes_added = excluded.episodes_added, episodes_removed = excluded.episodes_removed, changes_json = excluded.changes_json`,
      b.catalogId,
      b.buildId,
      b.builtAt,
      b.loadedAt,
      b.baseline ? 1 : 0,
      b.items,
      b.episodes,
      b.itemsAdded,
      b.itemsRemoved,
      b.episodesAdded,
      b.episodesRemoved,
      JSON.stringify(changes),
    );
  }

  /** The catalog's builds, most recently loaded first (without their change lists). */
  listCatalogBuilds(catalogId: string, limit: number): CatalogBuild[] {
    return this.all(
      `SELECT catalog_id, build_id, built_at, loaded_at, baseline, items, episodes, items_added, items_removed, episodes_added, episodes_removed
       FROM catalog_builds WHERE catalog_id = ? ORDER BY loaded_at DESC, rowid DESC LIMIT ?`,
      catalogId,
      limit,
    ).map(toCatalogBuild);
  }

  getCatalogBuild(catalogId: string, buildId: string): { build: CatalogBuild; changes: CatalogChanges } | null {
    const r = this.get("SELECT * FROM catalog_builds WHERE catalog_id = ? AND build_id = ?", catalogId, buildId);
    return r ? { build: toCatalogBuild(r), changes: JSON.parse(str(r.changes_json)) as CatalogChanges } : null;
  }

  // --- companion links -----------------------------------------------------------------------------------------

  getCompanionLink(catalogId: string, episodeId: string, sourceId: string): CompanionLink | null {
    const r = this.get("SELECT * FROM companion_links WHERE catalog_id = ? AND episode_id = ? AND source_id = ?", catalogId, episodeId, sourceId);
    return r ? toCompanionLink(r) : null;
  }

  listCompanionLinks(catalogId: string, episodeId: string): CompanionLink[] {
    return this.all("SELECT * FROM companion_links WHERE catalog_id = ? AND episode_id = ? ORDER BY source_id", catalogId, episodeId).map(toCompanionLink);
  }

  putCompanionLink(l: CompanionLink): void {
    this.run(
      `INSERT INTO companion_links (catalog_id, item_id, episode_id, source_id, language, offset_ms, rate, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (catalog_id, episode_id, source_id) DO UPDATE SET item_id = excluded.item_id, language = excluded.language,
         offset_ms = excluded.offset_ms, rate = excluded.rate, updated_at = excluded.updated_at`,
      l.catalogId,
      l.itemId,
      l.episodeId,
      l.sourceId,
      l.language,
      l.offsetMs,
      l.rate,
      l.updatedAt,
    );
  }
}
