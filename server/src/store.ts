import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import type { Actor } from "./actor.ts";
import type { CommandResult, CommandType } from "./commands.ts";
import type { ProgressReportStatus } from "./playback.ts";
import type { ProblemKind } from "./problems.ts";
import type { Scope } from "./tokens.ts";
import { MIGRATIONS } from "./store/schema.ts";

/** A database made by a newer server, which this one cannot open. */
export class DatabaseVersionError extends Error {
  override name = "DatabaseVersionError";
}

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
  autoplayOnStart: boolean;
  homeColumns: number;
  homeRows: number;
  /** The TV app as its User-Agent reported it; null until a TV that sends one connected. */
  appVersion: string | null;
  appVersionCode: number | null;
  androidSdk: number | null;
  updateCapability: UpdateCapability | null;
  /** When the TV first reported the version it has now. */
  appReportedAt: number | null;
}

/** Whether the TV installs an update by itself (Android 12+) or needs the viewer. */
export type UpdateCapability = "silent" | "guided";

/** The id of the one section every Home has: what was put on Home without a section. */
export const UNTITLED_SECTION = "untitled";

/** A section of a TV's Home as stored: `title` null for the untitled section. */
export interface HomeSectionRow {
  id: string;
  title: string | null;
  layout: string;
}

export interface HomeSectionWrite extends HomeSectionRow {
  itemIds: string[];
}

export interface TvAppInfo {
  version: string;
  versionCode: number;
  androidSdk: number;
  capability: UpdateCapability;
}

/** The TV app APK the server offers its TVs (its bytes are `<dataDir>/app/<sha256>.apk`). */
export interface StoredApk {
  versionName: string;
  versionCode: number;
  /** Lower-case hex. */
  sha256: string;
  size: number;
  source: "github" | "upload";
  releaseTag: string | null;
  storedAt: number;
}

interface PairCode {
  code: string;
  pairTokenHash: string;
  /** sha256 of the client address that started the code. */
  clientHash: string;
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

export interface Cursor {
  catalogId: string;
  itemId: string;
  episodeId: string;
  updatedAt: number;
  /** Placed by the wrap to the first episode after the last one was finished. */
  wrapped: boolean;
}

/** An episode as the catalog history knows it. */
export interface SeenEpisode {
  episodeId: string;
  itemId: string;
  /** When the first build carrying it was loaded; 0 for episodes present at the first load ever. */
  firstSeenAt: number;
  buildId: string;
  /** Set while the loaded catalog does not carry it. */
  removedAt: number | null;
}

/** A channel as the catalog history knows it (by its item id: it has no episodes). */
export type SeenItem = Omit<SeenEpisode, "episodeId">;

/** What a build changed against the catalog loaded before it. Each list holds at most 500 entries. */
export interface CatalogChanges {
  items: {
    added: Array<{ id: string; title: string; kind: string }>;
    /** Title from the catalog loaded before; null when that catalog was not in memory (a restart). */
    removed: Array<{ id: string; title: string | null }>;
  };
  episodes: {
    added: Array<{ id: string; itemId: string; itemTitle: string; season: number | null; number: number | null; label: string | null; playbackAllowed: boolean }>;
    removed: Array<{ id: string; itemId: string; itemTitle: string | null }>;
  };
}

/** One loaded build of a catalog, with the exact counts of its changes. */
export interface CatalogBuild {
  catalogId: string;
  buildId: string;
  builtAt: string;
  loadedAt: number;
  /** The first load of this catalog id: nothing in it counts as new. */
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
  actor: Actor;
  /** What the TV made of it; null until it reports, or with a TV that never does. */
  result: CommandResult | null;
  reason: string | null;
  resultAt: number | null;
}

/** A named token an agent or an app signs in with; only the hash of its secret is kept. */
export interface AccessToken {
  id: string;
  name: string;
  scope: Scope;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface StoredEvent {
  id: number;
  at: number;
  type: string;
  deviceId: string | null;
  actor: Actor;
  data: Record<string, unknown>;
}

/** Which events to read: after an id, for some devices (events without a device always pass), of some types. */
export interface EventFilter {
  after: number;
  limit: number;
  devices?: readonly string[];
  /** Event types, or prefixes ending in `.`. */
  types?: readonly string[];
  /** The newest `limit` events after `after` (still oldest first) instead of the oldest. */
  newest?: boolean;
}

/**
 * One playback of one episode, or of one channel, on one TV (the `last*` fields are the history's running state).
 * A channel's viewing has no episode, positions or duration, and is never seen.
 */
export interface Viewing {
  id: number;
  deviceId: string;
  deviceName: string;
  catalogId: string;
  itemId: string;
  itemKind: string;
  itemTitle: string;
  episodeId: string | null;
  episodeTitle: string | null;
  season: number | null;
  number: number | null;
  sourceId: string;
  startedAt: number;
  /** Null while the viewing runs. */
  endedAt: number | null;
  startPositionMs: number | null;
  endPositionMs: number | null;
  durationMs: number | null;
  watchedMs: number;
  endReason: ViewingEndReason | null;
  seen: boolean;
  trigger: ViewingTrigger;
  actor: Actor;
  commandId: number | null;
  /** The last progress report applied: when it arrived, what it said, and where it was sampled (null: none yet). */
  lastReportAt: number | null;
  lastPositionMs: number | null;
  lastPlaying: boolean;
  lastAnchorAt: number | null;
  lastState: ProgressReportStatus | null;
}

export type ViewingEndReason = "finished" | "stopped" | "replaced" | "lost";
export type ViewingTrigger = "viewer" | "autoplay" | "next" | "command" | "unknown";

export interface ViewingFilter {
  catalogId: string;
  deviceId?: string;
  itemId?: string;
  episodeId?: string;
  from?: number;
  to?: number;
  /** The id of the last viewing of the previous page (newest first by `startedAt`, then id). */
  before?: number;
  limit: number;
}

/** Viewings of one episode (or, with `episodeId` null, of one channel) summed up. */
export interface EpisodeViewingStats {
  itemId: string;
  episodeId: string | null;
  viewings: number;
  watchedMs: number;
  firstStartedAt: number;
  lastStartedAt: number;
  seenViewings: number;
  /** Ended viewings, not seen, with `watchedMs` under 10 minutes. */
  shortViewings: number;
  /** The position of the newest viewing: its last report while it runs, else where it ended. */
  lastPositionMs: number | null;
  lastDurationMs: number | null;
  /** How the viewings named the episode (for one that left the catalog). */
  season: number | null;
  number: number | null;
  episodeTitle: string | null;
}

export interface EpisodeSeenAt {
  itemId: string;
  episodeId: string;
  seenAt: number;
}

/** The owner's word on an episode. */
export interface EpisodeMark {
  episodeId: string;
  itemId: string;
  seen: boolean;
  at: number;
}

export type ProblemOrigin = "tv" | "server";

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
  /** Null for a channel, which has no episode and no timeline. */
  episodeId: string | null;
  sourceId: string | null;
  positionMs: number | null;
  durationMs: number | null;
  /** `starting` from a resolve until the player's first report, then the report's status. */
  state: "starting" | ProgressReportStatus;
  updatedAt: number;
  /** Whether the player was actually advancing when it sampled `positionMs` (a rebuffer stall reports false). */
  playing: boolean;
  /** When `positionMs` was sampled: the report's receipt time minus its age. */
  anchorAt: number;
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

/** The stored deep check of one source of an episode or a channel (`playableId`: the episode id, or the item id). */
export interface SourceCheck {
  catalogId: string;
  itemId: string;
  playableId: string;
  sourceId: string;
  fingerprint: string;
  checkedAt: number;
  verdict: "ok" | "warn" | "fail";
  report: Record<string, unknown>;
}

export type SourceCheckKey = Pick<SourceCheck, "catalogId" | "itemId" | "playableId" | "sourceId">;

export type DevicePatch = Partial<Pick<Device, "name" | "uiLanguage" | "preferredAudioLanguage" | "subtitlesLanguage" | "autoplayOnStart" | "homeColumns" | "homeRows">>;

type Row = Record<string, SQLOutputValue>;

const PATCHABLE = ["name", "uiLanguage", "preferredAudioLanguage", "subtitlesLanguage", "autoplayOnStart", "homeColumns", "homeRows"] as const;
/** 0/1 columns, read as booleans. */
const FLAGS = new Set(["autoplay_on_start", "wrapped", "playing", "baseline", "seen", "last_playing"]);
const TOKEN_COLUMNS = "id, name, scope, created_at, last_used_at";
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
  private afterCommitHooks: Array<() => void> = [];

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file, { enableForeignKeyConstraints: true });
    this.db.exec("PRAGMA busy_timeout = 5000");
    // The version is checked before anything is written, so a refused database is left as it was.
    const current = this.schemaVersion;
    if (current > MIGRATIONS.length) {
      this.close();
      throw new DatabaseVersionError(`database schema version ${current} is newer than this server (${MIGRATIONS.length})`);
    }
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
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
    // A fresh hook list per transaction: one that rolled back leaves its hooks behind, never run.
    const hooks: Array<() => void> = [];
    this.afterCommitHooks = hooks;
    this.db.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    let result: T;
    try {
      result = fn();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    } finally {
      this.inTransaction = false;
    }
    for (const hook of hooks) hook();
    return result;
  }

  /** Runs `fn` once the open transaction commits (never if it rolls back); outside a transaction, at once. */
  afterCommit(fn: () => void): void {
    if (this.inTransaction) this.afterCommitHooks.push(fn);
    else fn();
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

  /** Records the app a TV reports; the state version is not bumped (nothing the TV shows changed). */
  setDeviceApp(id: string, app: TvAppInfo, now: number): void {
    this.run(
      "UPDATE devices SET app_version = ?, app_version_code = ?, android_sdk = ?, update_capability = ?, app_reported_at = ? WHERE id = ?",
      app.version, app.versionCode, app.androidSdk, app.capability, now, id,
    );
  }

  // --- the TV app APK ------------------------------------------------------------------------------------------

  getAppApk(): StoredApk | null {
    return this.one("SELECT * FROM app_apk WHERE id = 1", [], "id");
  }

  setAppApk(apk: StoredApk): void {
    this.insert("app_apk", { id: 1, ...apk }, "id");
  }

  deleteAppApk(): boolean {
    return this.run("DELETE FROM app_apk WHERE id = 1") > 0;
  }

  // --- pairing -------------------------------------------------------------------------------------------------

  insertPairCode(p: Pick<PairCode, "code" | "pairTokenHash" | "clientHash" | "createdAt" | "expiresAt">): void {
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
   * Ends an open code now, so `pair/wait` answers 410 until the purge removes it. A new device approved on it is
   * deleted (it never got its token); an active device it was to replace is unbound and stays.
   */
  cancelPairCode(code: string, now: number): void {
    this.transaction(() => {
      const deviceId = this.get("SELECT device_id FROM pair_codes WHERE code = ?", code)?.device_id ?? null;
      this.run("UPDATE pair_codes SET expires_at = ?, device_id = NULL WHERE code = ?", now, code);
      if (typeof deviceId === "string") this.run("DELETE FROM devices WHERE id = ? AND token_hash IS NULL", deviceId);
    });
  }

  /**
   * Deletes pair codes that expired (or were delivered) more than `graceMs` ago, with the devices approved on them
   * that never collected their token. An active device an expired replacement code was bound to has a token: it stays.
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

  /** The device's home list in Home order (its sections in order, each with its items in order). */
  getHomeEntries(deviceId: string, catalogId: string): Array<{ itemId: string; addedAt: number; sectionId: string }> {
    return this.many(
      `SELECT e.item_id, e.added_at, e.section_id FROM home_entries e
         JOIN home_sections s ON s.device_id = e.device_id AND s.section_id = e.section_id
       WHERE e.device_id = ? AND e.catalog_id = ? ORDER BY s.position, e.position`,
      [deviceId, catalogId],
    );
  }

  /** The sections in display order, always with the untitled one (a new TV has no row until its first write). */
  getHomeSections(deviceId: string): HomeSectionRow[] {
    const rows = this.many<HomeSectionRow>("SELECT section_id AS id, title, layout FROM home_sections WHERE device_id = ? ORDER BY position", [deviceId]);
    return rows.some((r) => r.id === UNTITLED_SECTION) ? rows : [{ id: UNTITLED_SECTION, title: null, layout: "grid" }, ...rows];
  }

  /**
   * Replaces the device's Home. Items already on it keep the date they were put there (a reorder or a move to another
   * section changes nothing); new ones get `now`, so episodes added before an item went on the list are not new to it.
   */
  setHome(deviceId: string, catalogId: string, sections: HomeSectionWrite[], now: number): void {
    this.transaction(() => {
      const addedAt = new Map(this.getHomeEntries(deviceId, catalogId).map((e) => [e.itemId, e.addedAt]));
      this.run("DELETE FROM home_entries WHERE device_id = ?", deviceId);
      this.run("DELETE FROM home_sections WHERE device_id = ?", deviceId);
      const section = this.db.prepare("INSERT INTO home_sections (device_id, section_id, position, title, layout) VALUES (?, ?, ?, ?, ?)");
      const entry = this.db.prepare("INSERT INTO home_entries (device_id, position, catalog_id, item_id, added_at, section_id) VALUES (?, ?, ?, ?, ?, ?)");
      let position = 0;
      sections.forEach((s, i) => {
        section.run(deviceId, s.id, i, s.title, s.layout);
        for (const itemId of s.itemIds) entry.run(deviceId, position++, catalogId, itemId, addedAt.get(itemId) ?? now, s.id);
      });
    });
  }

  // --- progress & cursor ---------------------------------------------------------------------------------------

  getProgress(deviceId: string, catalogId: string, episodeId: string): Progress | null {
    return this.one("SELECT * FROM progress WHERE device_id = ? AND catalog_id = ? AND episode_id = ?", [deviceId, catalogId, episodeId], "device_id");
  }

  listProgress(deviceId: string, catalogId: string, itemId: string | null = null): Progress[] {
    const sql = "SELECT * FROM progress WHERE device_id = ? AND catalog_id = ? AND (? IS NULL OR item_id = ?) ORDER BY updated_at DESC";
    return this.many(sql, [deviceId, catalogId, itemId, itemId], "device_id");
  }

  upsertProgress(deviceId: string, p: Progress): void {
    this.insert("progress", { deviceId, ...p }, "device_id, catalog_id, episode_id");
  }

  deleteProgress(deviceId: string, catalogId: string, episodeId: string): void {
    this.run("DELETE FROM progress WHERE device_id = ? AND catalog_id = ? AND episode_id = ?", deviceId, catalogId, episodeId);
  }

  getCursor(deviceId: string, catalogId: string, itemId: string): Cursor | null {
    return this.one("SELECT * FROM item_cursor WHERE device_id = ? AND catalog_id = ? AND item_id = ?", [deviceId, catalogId, itemId], "device_id");
  }

  listCursors(deviceId: string, catalogId: string): Cursor[] {
    return this.many("SELECT * FROM item_cursor WHERE device_id = ? AND catalog_id = ? ORDER BY updated_at DESC", [deviceId, catalogId], "device_id");
  }

  /** `wrapped` defaults to false: only the wrap after the last episode sets it. */
  setCursor(deviceId: string, c: Omit<Cursor, "wrapped"> & { wrapped?: boolean }): void {
    this.insert("item_cursor", { deviceId, ...c, wrapped: c.wrapped ?? false }, "device_id, catalog_id, item_id");
  }

  // --- commands ------------------------------------------------------------------------------------------------

  insertCommand(deviceId: string, type: CommandType, payload: Record<string, unknown>, actor: Actor, now: number): Command {
    const row = { deviceId, type, payloadJson: JSON.stringify(payload), actorJson: JSON.stringify(actor), createdAt: now };
    return fromRow(this.insert("commands", row, undefined, " RETURNING *")!);
  }

  /** Unacknowledged commands created after `since`, oldest first. */
  pendingCommands(deviceId: string, since: number): Command[] {
    return this.many("SELECT * FROM commands WHERE device_id = ? AND acked_at IS NULL AND created_at > ? ORDER BY id", [deviceId, since]);
  }

  ackCommand(deviceId: string, id: number, now: number): boolean {
    return this.run("UPDATE commands SET acked_at = COALESCE(acked_at, ?) WHERE id = ? AND device_id = ?", now, id, deviceId) > 0;
  }

  getCommand(deviceId: string, id: number): Command | null {
    return this.one("SELECT * FROM commands WHERE id = ? AND device_id = ?", [id, deviceId]);
  }

  setCommandResult(id: number, result: CommandResult, reason: string | null, now: number): void {
    this.run("UPDATE commands SET result = ?, reason = ?, result_at = ? WHERE id = ?", result, reason, now, id);
  }

  purgeCommands(before: number): void {
    this.run("DELETE FROM commands WHERE created_at < ?", before);
  }

  // --- access tokens -------------------------------------------------------------------------------------------

  insertAccessToken(t: AccessToken & { secretHash: string }): AccessToken {
    return fromRow(this.insert("access_tokens", t, undefined, ` RETURNING ${TOKEN_COLUMNS}`)!);
  }

  getAccessTokenBy(key: "id" | "secret_hash" | "name", value: string): AccessToken | null {
    return this.one(`SELECT ${TOKEN_COLUMNS} FROM access_tokens WHERE ${key} = ?`, [value]);
  }

  /** Every access token, oldest first. */
  listAccessTokens(): AccessToken[] {
    return this.many(`SELECT ${TOKEN_COLUMNS} FROM access_tokens ORDER BY created_at, id`, []);
  }

  touchAccessToken(id: string, now: number): void {
    this.run("UPDATE access_tokens SET last_used_at = ? WHERE id = ?", now, id);
  }

  deleteAccessToken(id: string): boolean {
    return this.run("DELETE FROM access_tokens WHERE id = ?", id) > 0;
  }

  // --- events --------------------------------------------------------------------------------------------------

  /** Appends an event; its id is strictly increasing, the order the changes were stored in. */
  insertEvent(e: Omit<StoredEvent, "id">): number {
    const row = { at: e.at, type: e.type, deviceId: e.deviceId, actorJson: JSON.stringify(e.actor), dataJson: JSON.stringify(e.data) };
    return Number(this.insert("events", row, undefined, " RETURNING id")!.id);
  }

  listEvents(f: EventFilter): StoredEvent[] {
    const where = ["id > ?"];
    const params: SQLInputValue[] = [f.after];
    if (f.devices) {
      where.push(`(device_id IS NULL OR device_id IN (${f.devices.map(() => "?").join(", ") || "NULL"}))`);
      params.push(...f.devices);
    }
    if (f.types) {
      // The types are validated to letters, dots and underscores, so a LIKE pattern cannot be smuggled in.
      const clauses = f.types.map((t) => (t.endsWith(".") ? "type LIKE ? || '%'" : "type = ?"));
      where.push(`(${clauses.join(" OR ") || "0"})`);
      params.push(...f.types);
    }
    const rows = this.many<StoredEvent>(`SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY id ${f.newest ? "DESC" : ""} LIMIT ?`, [...params, f.limit]);
    return f.newest ? rows.reverse() : rows;
  }

  /** The id of the newest event ever appended (also after it was purged), or 0 when there was none. */
  lastEventId(): number {
    const r = this.get("SELECT COALESCE((SELECT MAX(id) FROM events), (SELECT seq FROM sqlite_sequence WHERE name = 'events'), 0) AS id")!;
    return Number(r.id);
  }

  oldestEventId(): number | null {
    const r = this.get("SELECT MIN(id) AS id FROM events")!;
    return r.id === null ? null : Number(r.id);
  }

  purgeEvents(before: number): number {
    return this.run("DELETE FROM events WHERE at < ?", before);
  }

  // --- problems ------------------------------------------------------------------------------------------------

  /** Stores a problem and keeps only the device's newest `keep` (by time, then insertion order). */
  insertProblem(p: Omit<Problem, "id">, keep: number): Problem {
    return this.transaction(() => {
      const r = this.insert("problems", p, undefined, " RETURNING *")!;
      const newest = "SELECT id FROM problems WHERE device_id = ? ORDER BY at DESC, id DESC LIMIT ?";
      this.run(`DELETE FROM problems WHERE device_id = ? AND id NOT IN (${newest})`, p.deviceId, p.deviceId, keep);
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

  // --- viewings ------------------------------------------------------------------------------------------------

  insertViewing(v: Omit<Viewing, "id">): Viewing {
    const { actor, ...rest } = v;
    return fromRow(this.insert("viewings", { ...rest, actorJson: JSON.stringify(actor) }, undefined, " RETURNING *")!);
  }

  getViewing(id: number): Viewing | null {
    return this.one("SELECT * FROM viewings WHERE id = ?", [id]);
  }

  /** The device's running viewing (there is at most one), or null. */
  runningViewing(deviceId: string): Viewing | null {
    return this.one("SELECT * FROM viewings WHERE device_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1", [deviceId]);
  }

  listRunningViewings(): Viewing[] {
    return this.many("SELECT * FROM viewings WHERE ended_at IS NULL ORDER BY id", []);
  }

  /** Writes the given fields of a viewing (the store's own field names, never request input). */
  updateViewing(id: number, patch: Partial<Omit<Viewing, "id" | "actor">>): void {
    const keys = Object.keys(patch) as Array<keyof typeof patch>;
    if (keys.length === 0) return;
    this.run(`UPDATE viewings SET ${keys.map((k) => `${column(k)} = ?`).join(", ")} WHERE id = ?`, ...keys.map((k) => sqlValue(patch[k])), id);
  }

  /** Viewings newest first (by `startedAt`, then id), those that pass the filter, at most `limit`. */
  listViewings(f: ViewingFilter): Viewing[] {
    const where = ["catalog_id = ?"];
    const params: SQLInputValue[] = [f.catalogId];
    const add = (clause: string, ...values: Array<SQLInputValue | undefined>) => {
      if (values[0] === undefined) return;
      where.push(clause);
      params.push(...(values as SQLInputValue[]));
    };
    add("device_id = ?", f.deviceId);
    add("item_id = ?", f.itemId);
    add("episode_id = ?", f.episodeId);
    add("started_at >= ?", f.from);
    add("started_at <= ?", f.to);
    if (f.before !== undefined) {
      // The page after a viewing: everything that sorts after it (older, or the same start with a lower id).
      const anchor = this.getViewing(f.before);
      if (!anchor) return [];
      add("(started_at < ? OR (started_at = ? AND id < ?))", anchor.startedAt, anchor.startedAt, anchor.id);
    }
    return this.many(`SELECT * FROM viewings WHERE ${where.join(" AND ")} ORDER BY started_at DESC, id DESC LIMIT ?`, [...params, f.limit]);
  }

  /** One row per episode with a viewing (of `deviceId` when given, else of every TV), in `itemId` when given. */
  episodeViewingStats(catalogId: string, deviceId: string | null, itemId: string | null = null): EpisodeViewingStats[] {
    const sql = `SELECT item_id, episode_id, COUNT(*) AS viewings, SUM(watched_ms) AS watched_ms,
         MIN(started_at) AS first_started_at, MAX(started_at) AS last_started_at, SUM(seen) AS seen_viewings,
         SUM(ended_at IS NOT NULL AND seen = 0 AND watched_ms < 600000) AS short_viewings,
         MAX(season) AS season, MAX(number) AS number, MAX(episode_title) AS episode_title,
         (SELECT COALESCE(n.last_position_ms, n.end_position_ms) FROM viewings n WHERE n.catalog_id = v.catalog_id AND n.episode_id = v.episode_id
            AND (? IS NULL OR n.device_id = ?) ORDER BY n.started_at DESC, n.id DESC LIMIT 1) AS last_position_ms,
         (SELECT n.duration_ms FROM viewings n WHERE n.catalog_id = v.catalog_id AND n.episode_id = v.episode_id AND n.duration_ms IS NOT NULL
            AND (? IS NULL OR n.device_id = ?) ORDER BY n.started_at DESC, n.id DESC LIMIT 1) AS last_duration_ms
       FROM viewings v WHERE catalog_id = ? AND (? IS NULL OR device_id = ?) AND (? IS NULL OR item_id = ?)
       GROUP BY item_id, episode_id`;
    return this.many(sql, [deviceId, deviceId, deviceId, deviceId, catalogId, deviceId, deviceId, itemId, itemId]);
  }

  /** When each episode was first seen by a viewing of any TV (`itemId` narrows to one item). */
  episodeSeenAt(catalogId: string, itemId: string | null = null): EpisodeSeenAt[] {
    const sql = "SELECT item_id, episode_id, MIN(ended_at) AS seen_at FROM viewings WHERE catalog_id = ? AND seen = 1 AND (? IS NULL OR item_id = ?) GROUP BY item_id, episode_id";
    return this.many(sql, [catalogId, itemId, itemId]);
  }

  episodeSeenByOther(catalogId: string, episodeId: string, exceptId: number): boolean {
    return this.get("SELECT 1 AS x FROM viewings WHERE catalog_id = ? AND episode_id = ? AND seen = 1 AND id != ?", catalogId, episodeId, exceptId) !== undefined;
  }

  /** The item of an episode the history knows (its newest viewing's), or null. */
  historyEpisodeItem(catalogId: string, episodeId: string): string | null {
    const r = this.get("SELECT item_id FROM viewings WHERE catalog_id = ? AND episode_id = ? ORDER BY started_at DESC, id DESC LIMIT 1", catalogId, episodeId);
    return r ? String(r.item_id) : null;
  }

  /** The title and kind the history last knew each item under (its newest viewing's), by item id. */
  historyItems(catalogId: string, itemId: string | null = null): Map<string, { kind: string; title: string }> {
    // SQLite's bare columns with MAX come from the row holding the maximum: the newest viewing of each item.
    const sql = "SELECT item_id, item_kind AS kind, item_title AS title, MAX(started_at) FROM viewings WHERE catalog_id = ? AND (? IS NULL OR item_id = ?) GROUP BY item_id";
    return new Map(this.many<{ itemId: string; kind: string; title: string }>(sql, [catalogId, itemId, itemId]).map(({ itemId: id, kind, title }) => [id, { kind, title }]));
  }

  /** The item ids with a viewing or a mark. */
  historyItemIds(catalogId: string): string[] {
    const sql = "SELECT item_id FROM viewings WHERE catalog_id = ? UNION SELECT item_id FROM episode_marks WHERE catalog_id = ?";
    return this.many<{ itemId: string }>(sql, [catalogId, catalogId]).map((r) => r.itemId);
  }

  /** The viewings started between `from` and `to` (inclusive). */
  viewingsBetween(catalogId: string, deviceId: string | null, from: number, to: number): Array<Pick<Viewing, "id" | "itemId" | "itemTitle" | "startedAt" | "watchedMs">> {
    const sql = "SELECT id, item_id, item_title, started_at, watched_ms FROM viewings WHERE catalog_id = ? AND started_at BETWEEN ? AND ? AND (? IS NULL OR device_id = ?) ORDER BY started_at, id";
    return this.many(sql, [catalogId, from, to, deviceId, deviceId]);
  }

  deleteViewing(id: number): boolean {
    return this.run("DELETE FROM viewings WHERE id = ?", id) > 0;
  }

  /** Deletes the viewings of a TV (when given) started before `before` (when given). */
  deleteViewings(catalogId: string, deviceId: string | null, before: number | null): number {
    return this.run("DELETE FROM viewings WHERE catalog_id = ? AND (? IS NULL OR device_id = ?) AND (? IS NULL OR started_at < ?)", catalogId, deviceId, deviceId, before, before);
  }

  /** Gives the viewings of a TV that is gone to another TV, under its name; how many moved. */
  adoptViewings(fromDeviceId: string, toDeviceId: string, toName: string): number {
    return this.run("UPDATE viewings SET device_id = ?, device_name = ? WHERE device_id = ?", toDeviceId, toName, fromDeviceId);
  }

  /** Records that `[fromMs, toMs]` was played; a range that continues the previous one extends it instead. */
  addViewingRange(viewingId: number, fromMs: number, toMs: number): void {
    const extended = this.run("UPDATE viewing_ranges SET to_ms = MAX(to_ms, ?) WHERE viewing_id = ? AND from_ms <= ? AND to_ms >= ?", toMs, viewingId, fromMs, fromMs);
    if (extended === 0) this.insert("viewing_ranges", { viewingId, fromMs, toMs });
  }

  /** The ranges of a viewing, unmerged, in position order. */
  viewingRanges(viewingId: number): Array<[number, number]> {
    return this.many<{ fromMs: number; toMs: number }>("SELECT from_ms, to_ms FROM viewing_ranges WHERE viewing_id = ? ORDER BY from_ms, to_ms", [viewingId]).map((r) => [r.fromMs, r.toMs]);
  }

  /** The ranges of every viewing of the item's episodes (of `deviceId` when given), by episode. */
  itemRanges(catalogId: string, deviceId: string | null, itemId: string): Map<string, Array<[number, number]>> {
    const sql = `SELECT v.episode_id, r.from_ms, r.to_ms FROM viewing_ranges r JOIN viewings v ON v.id = r.viewing_id
       WHERE v.catalog_id = ? AND v.item_id = ? AND (? IS NULL OR v.device_id = ?) ORDER BY v.episode_id, r.from_ms, r.to_ms`;
    const out = new Map<string, Array<[number, number]>>();
    for (const r of this.many<{ episodeId: string; fromMs: number; toMs: number }>(sql, [catalogId, itemId, deviceId, deviceId])) {
      out.set(r.episodeId, [...(out.get(r.episodeId) ?? []), [r.fromMs, r.toMs]]);
    }
    return out;
  }

  /** The command a viewing may be the result of: this TV's `play`, `next` or `previous` command with that id. */
  viewingCommand(deviceId: string, id: number): Command | null {
    return this.one("SELECT * FROM commands WHERE id = ? AND device_id = ? AND type IN ('play', 'next', 'previous')", [id, deviceId]);
  }

  // --- marks ---------------------------------------------------------------------------------------------------

  /** Every mark of the catalog (`itemId` narrows to one item), by episode id. */
  listMarks(catalogId: string, itemId: string | null = null): Map<string, EpisodeMark> {
    const marks = this.many<EpisodeMark>("SELECT episode_id, item_id, seen, at FROM episode_marks WHERE catalog_id = ? AND (? IS NULL OR item_id = ?)", [catalogId, itemId, itemId]);
    return new Map(marks.map((m) => [m.episodeId, m]));
  }

  getMark(catalogId: string, episodeId: string): EpisodeMark | null {
    return this.one("SELECT episode_id, item_id, seen, at FROM episode_marks WHERE catalog_id = ? AND episode_id = ?", [catalogId, episodeId]);
  }

  /** Sets the mark of each episode; `seen: null` removes it. */
  setMarks(catalogId: string, episodes: ReadonlyArray<{ episodeId: string; itemId: string }>, seen: boolean | null, at: number): void {
    for (const e of episodes) {
      if (seen === null) this.run("DELETE FROM episode_marks WHERE catalog_id = ? AND episode_id = ?", catalogId, e.episodeId);
      else this.insert("episode_marks", { catalogId, ...e, seen, at }, "catalog_id, episode_id");
    }
  }

  // --- catalog history (episodes in catalog_seen, channels by item id in catalog_seen_items) ----------------------

  /** Every episode the catalog has ever carried, present or removed, ordered by item then episode id. */
  catalogSeen(catalogId: string): SeenEpisode[] {
    return this.many("SELECT * FROM catalog_seen WHERE catalog_id = ? ORDER BY item_id, episode_id", [catalogId], "catalog_id");
  }

  insertSeen(catalogId: string, buildId: string, firstSeenAt: number, episodes: ReadonlyArray<{ episodeId: string; itemId: string }>): void {
    const insert = this.db.prepare("INSERT INTO catalog_seen (catalog_id, episode_id, item_id, first_seen_at, build_id) VALUES (?, ?, ?, ?, ?)");
    for (const e of episodes) insert.run(catalogId, e.episodeId, e.itemId, firstSeenAt, buildId);
  }

  /**
   * Marks episodes (or, with `channels`, channels) absent from the loaded catalog at `at`, keeping an earlier removal
   * time; `at` null marks them present again. Their first-seen date never changes.
   */
  setSeenRemoved(catalogId: string, ids: readonly string[], at: number | null, channels = false): void {
    const [table, key] = channels ? ["catalog_seen_items", "item_id"] : ["catalog_seen", "episode_id"];
    const update = this.db.prepare(`UPDATE ${table} SET removed_at = ? WHERE catalog_id = ? AND ${key} = ? AND (? IS NULL OR removed_at IS NULL)`);
    for (const id of ids) update.run(at, catalogId, id, at);
  }

  /** Episodes the loaded catalog files under another item than before. */
  moveSeen(catalogId: string, episodes: ReadonlyArray<{ episodeId: string; itemId: string }>): void {
    const update = this.db.prepare("UPDATE catalog_seen SET item_id = ? WHERE catalog_id = ? AND episode_id = ?");
    for (const e of episodes) update.run(e.itemId, catalogId, e.episodeId);
  }

  /** The item's present episodes that first appeared after `sinceMs`, oldest first. Baseline episodes (0) never do. */
  episodesSeenAfter(catalogId: string, itemId: string, sinceMs: number): string[] {
    const sql = `SELECT episode_id FROM catalog_seen WHERE catalog_id = ? AND item_id = ? AND removed_at IS NULL AND first_seen_at > ?
       ORDER BY first_seen_at, episode_id`;
    return this.many<{ episodeId: string }>(sql, [catalogId, itemId, sinceMs]).map((e) => e.episodeId);
  }

  /** Every item's present episodes with when they first appeared, oldest first (as episodesSeenAfter orders them). */
  listSeen(catalogId: string): Map<string, Array<{ episodeId: string; firstSeenAt: number }>> {
    const sql = "SELECT item_id, episode_id, first_seen_at FROM catalog_seen WHERE catalog_id = ? AND removed_at IS NULL ORDER BY first_seen_at, episode_id";
    const byItem = new Map<string, Array<{ episodeId: string; firstSeenAt: number }>>();
    for (const { itemId, episodeId, firstSeenAt } of this.many<{ itemId: string; episodeId: string; firstSeenAt: number }>(sql, [catalogId])) {
      byItem.set(itemId, [...(byItem.get(itemId) ?? []), { episodeId, firstSeenAt }]);
    }
    return byItem;
  }

  /** When each present episode of the catalog first appeared, by episode id (`itemId` narrows to one item). */
  episodeFirstSeen(catalogId: string, itemId: string | null = null): Map<string, number> {
    const sql = "SELECT episode_id, first_seen_at FROM catalog_seen WHERE catalog_id = ? AND removed_at IS NULL AND (? IS NULL OR item_id = ?)";
    return new Map(this.many<{ episodeId: string; firstSeenAt: number }>(sql, [catalogId, itemId, itemId]).map((r) => [r.episodeId, r.firstSeenAt]));
  }

  /** Every channel the catalog has ever carried, present or removed, ordered by item id. */
  catalogSeenItems(catalogId: string): SeenItem[] {
    return this.many("SELECT item_id, first_seen_at, build_id, removed_at FROM catalog_seen_items WHERE catalog_id = ? ORDER BY item_id", [catalogId]);
  }

  insertSeenItems(catalogId: string, buildId: string, firstSeenAt: number, itemIds: readonly string[]): void {
    const insert = this.db.prepare("INSERT INTO catalog_seen_items (catalog_id, item_id, first_seen_at, build_id) VALUES (?, ?, ?, ?)");
    for (const id of itemIds) insert.run(catalogId, id, firstSeenAt, buildId);
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
    const r = this.one<CatalogBuild & { changes: CatalogChanges }>("SELECT * FROM catalog_builds WHERE catalog_id = ? AND build_id = ?", [catalogId, buildId]);
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

  // --- source checks -------------------------------------------------------------------------------------------

  putSourceChecks(rows: readonly SourceCheck[]): void {
    this.transaction(() => {
      for (const { report, ...r } of rows) this.insert("source_checks", { ...r, reportJson: JSON.stringify(report) }, "catalog_id, item_id, playable_id, source_id");
    });
  }

  /** The stored checks of every playable of these items, without their reports. */
  listSourceChecks(catalogId: string, itemIds: readonly string[]): Array<Omit<SourceCheck, "report">> {
    if (itemIds.length === 0) return [];
    const list = itemIds.map(() => "?").join(", ");
    const sql = `SELECT catalog_id, item_id, playable_id, source_id, fingerprint, checked_at, verdict FROM source_checks WHERE catalog_id = ? AND item_id IN (${list})`;
    return this.many(sql, [catalogId, ...itemIds]);
  }

  getSourceChecks(catalogId: string, itemId: string, playableId: string): SourceCheck[] {
    return this.many("SELECT * FROM source_checks WHERE catalog_id = ? AND item_id = ? AND playable_id = ?", [catalogId, itemId, playableId]);
  }

  sourceCheckKeys(): SourceCheckKey[] {
    return this.many("SELECT catalog_id, item_id, playable_id, source_id FROM source_checks", []);
  }

  deleteSourceChecks(keys: readonly SourceCheckKey[]): void {
    this.transaction(() => {
      for (const k of keys) {
        this.run("DELETE FROM source_checks WHERE catalog_id = ? AND item_id = ? AND playable_id = ? AND source_id = ?", k.catalogId, k.itemId, k.playableId, k.sourceId);
      }
    });
  }
}
