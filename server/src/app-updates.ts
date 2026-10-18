// The TV app APK the server offers its TVs: one at a time, uploaded by the owner or fetched from the latest release
// of the configured GitHub repository (only with `appUpdates.source: "github"`, verified against the release's
// SHA256SUMS). Its bytes are `<dataDir>/app/<sha256>.apk`, its metadata a row in the store. Every open TV stream
// hears of a new one (`event: app`). The server never checks the APK's signature: Android refuses an update that is
// not signed like the installed app.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { SERVER, type Actor } from "./actor.ts";
import type { ServerConfig } from "./config.ts";
import { errorName, HttpError } from "./errors.ts";
import type { EventLog } from "./eventlog.ts";
import type { EventHub } from "./events.ts";
import type { Logger } from "./log.ts";
import { iso } from "./presenters.ts";
import type { Store, StoredApk, TvAppInfo } from "./store.ts";
import { VERSION } from "./version.ts";

export const APK_MEDIA_TYPE = "application/vnd.android.package-archive";
/** The largest APK the server stores. */
export const APK_MAX_BYTES = 64 * 1024 * 1024;
/** What an APK's file name must be: the release asset's name, `izle-tv-X.Y.Z[-suffix].apk` (minor, patch < 100). */
export const APK_FILENAME = /^izle-tv-(0|[1-9]\d*)\.([1-9]?\d)\.([1-9]?\d)(-[0-9A-Za-z.-]+)?\.apk$/;
const APK_FILENAME_MAX = 128;
/** Android's largest versionCode. */
const VERSION_CODE_MAX = 2_100_000_000;
/** The first check after the server started listening, when the source is GitHub. */
export const FIRST_CHECK_DELAY_MS = 60_000;

const TV_USER_AGENT = /^izle-tv\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?) \(Android (\d{1,3}); (\d{1,9}); (silent|guided)\)$/;
const TV_USER_AGENT_MAX = 200;
const RELEASE_TAG = /^v(\d+\.\d+\.\d+)$/;
const CHECKSUMS_NAME = "SHA256SUMS";
const CHECKSUMS_MAX_BYTES = 16 * 1024;
/** The release JSON (its notes and asset list); GitHub's are a few KiB. */
const RELEASE_MAX_BYTES = 1024 * 1024;
const API_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const TEMP_FILE = /^\.upload-[0-9a-f]{16}\.tmp$/;
const APK_FILE = /^[0-9a-f]{64}\.apk$/;

/** The TV app's versionCode for a version name, as the app's Gradle build computes it (`1.2.3` → 10203). */
export function versionCodeOf(versionName: string): number {
  const [major = 0, minor = 0, patch = 0] = versionName.split("-")[0]!.split(".").map(Number);
  return major * 10_000 + minor * 100 + patch;
}

/** The version an APK file name carries; null for a name that is not `izle-tv-X.Y.Z[-suffix].apk`. */
export function parseApkName(name: string): { versionName: string; versionCode: number } | null {
  if (name.length > APK_FILENAME_MAX || !APK_FILENAME.test(name)) return null;
  const versionName = name.slice("izle-tv-".length, -".apk".length);
  const versionCode = versionCodeOf(versionName);
  return versionCode <= VERSION_CODE_MAX ? { versionName, versionCode } : null;
}

/** What a TV's User-Agent says about its app; null for anything else (an older app sends OkHttp's default). */
export function parseTvUserAgent(ua: string | undefined | null): TvAppInfo | null {
  if (!ua || ua.length > TV_USER_AGENT_MAX) return null;
  const m = TV_USER_AGENT.exec(ua);
  if (!m) return null;
  return { version: m[1]!, androidSdk: Number(m[2]), versionCode: Number(m[3]), capability: m[4] as TvAppInfo["capability"] };
}

/** The stored APK as the admin API shows it. */
export function apkJson(apk: StoredApk) {
  const { versionName, versionCode, sha256, size, source, releaseTag, storedAt } = apk;
  return { versionName, versionCode, sha256, size, source, releaseTag, storedAt: iso(storedAt) };
}

/** Why an APK was not stored. */
export type ApkRejection = "invalid_filename" | "too_large" | "not_an_apk" | "checksum_mismatch";

export class ApkRejected extends Error {
  override name = "ApkRejected";
  readonly reason: ApkRejection;

  constructor(reason: ApkRejection) {
    super(reason);
    this.reason = reason;
  }
}

/** A GitHub check that ended without an APK; `reason` is one of a few codes. */
class CheckFailed extends Error {
  override name = "CheckFailed";
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

export type CheckResult = "fetched" | "up_to_date" | "failed";
export interface CheckOutcome {
  result: CheckResult;
  reason: string | null;
  apk: StoredApk | null;
}

interface AppUpdateDeps {
  store: Store;
  eventLog: EventLog;
  events: EventHub;
  log: Logger;
  now: () => number;
  config: Pick<ServerConfig, "dataDir" | "appUpdates">;
  /** How the GitHub API and the release assets are fetched (default: the global fetch). */
  fetch?: typeof fetch;
  /** Default `https://api.github.com`. */
  githubApiBase?: string;
  /** Default 64 MiB. */
  maxBytes?: number;
  /** `apiMs` bounds the release query and the checksum download (30 s), `downloadMs` the APK download (5 min). */
  timeouts?: { apiMs?: number; downloadMs?: number };
}

export class AppUpdateService {
  /** Where the APK files are kept. */
  readonly dir: string;
  readonly maxBytes: number;
  private readonly s: AppUpdateDeps;
  private readonly fetch: typeof fetch;
  private readonly githubApiBase: string;
  private readonly apiMs: number;
  private readonly downloadMs: number;
  /** Ends a running check when the server stops. */
  private readonly aborter = new AbortController();
  private running: Promise<CheckOutcome> | null = null;
  private last: { at: number; result: CheckResult; reason: string | null } | null = null;
  private nextAt: number | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  /** The tail of the commit queue: stores and removals commit and delete files one at a time. */
  private committing: Promise<unknown> = Promise.resolve();

  constructor(deps: AppUpdateDeps) {
    this.s = deps;
    this.dir = path.join(deps.config.dataDir, "app");
    this.maxBytes = deps.maxBytes ?? APK_MAX_BYTES;
    this.fetch = deps.fetch ?? globalThis.fetch;
    this.githubApiBase = (deps.githubApiBase ?? "https://api.github.com").replace(/\/+$/, "");
    this.apiMs = deps.timeouts?.apiMs ?? API_TIMEOUT_MS;
    this.downloadMs = deps.timeouts?.downloadMs ?? DOWNLOAD_TIMEOUT_MS;
  }

  get config() {
    return this.s.config.appUpdates;
  }

  /** The APK offered to the TVs, or null. */
  current(): StoredApk | null {
    return this.s.store.getAppApk();
  }

  private file(sha256: string): string {
    return path.join(this.dir, `${sha256}.apk`);
  }

  /** Unlinks an APK file, unless it is (again) the current one. Called in `serially` only. */
  private async discard(sha256: string): Promise<void> {
    if (this.current()?.sha256 === sha256) return;
    await unlink(this.file(sha256)).catch(() => {});
  }

  /**
   * Runs `fn` once every earlier one ended. A store's rename, its row and the deletion of the file it replaced, or a
   * removal and the deletion of its file, never interleave with another: a file is never deleted after a concurrent
   * store of the same bytes made it current again.
   */
  private serially<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.committing.then(fn);
    this.committing = run.catch(() => {});
    return run;
  }

  /**
   * At startup: forgets an APK whose file is gone (a restored backup has the row, not the file), and deletes what
   * an interrupted store left behind (temp files, APKs no row names).
   */
  reconcile(): void {
    const apk = this.current();
    if (apk && !existsSync(this.file(apk.sha256))) {
      this.s.store.transaction(() => this.s.store.deleteAppApk());
      this.s.log.warn("apk missing", { versionName: apk.versionName });
    }
    const keep = apk && existsSync(this.file(apk.sha256)) ? `${apk.sha256}.apk` : null;
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return; // nothing stored yet
    }
    for (const name of names) {
      if (TEMP_FILE.test(name) || (APK_FILE.test(name) && name !== keep)) {
        try {
          unlinkSync(path.join(this.dir, name));
        } catch {
          // gone already
        }
      }
    }
  }

  /** The current APK with a stream of its bytes, or null when none is stored (or its file just went). */
  async openApk(): Promise<{ apk: StoredApk; size: number; body: ReadableStream<Uint8Array> } | null> {
    const apk = this.current();
    if (!apk) return null;
    let handle;
    try {
      handle = await open(this.file(apk.sha256), "r");
    } catch {
      return null;
    }
    const { size } = await handle.stat();
    // The stream closes the file when it ends or the TV goes away.
    return { apk, size, body: Readable.toWeb(handle.createReadStream()) as unknown as ReadableStream<Uint8Array> };
  }

  /**
   * Stores `body` as the current APK: at most `maxBytes`, a zip (`PK\x03\x04`), with `expectedSha` when given
   * (lower-case hex). Written to a temp file, synced and renamed to its content address; the row and its event in
   * one transaction; the file of the APK it replaces is deleted once that committed (the rename, the commit and
   * that deletion in `serially`). Every open TV stream hears of it. Throws ApkRejected; nothing changes then, and
   * `body` is left to the caller, unread past the refusal (cancelling a request's body can drop its connection
   * before the answer); any other error cancels it.
   */
  async store(body: ReadableStream<Uint8Array> | null, name: string, source: StoredApk["source"], releaseTag: string | null, actor: Actor, expectedSha?: string): Promise<StoredApk> {
    const version = parseApkName(name);
    if (!version) throw new ApkRejected("invalid_filename");
    if (!body) throw new ApkRejected("not_an_apk");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const temp = path.join(this.dir, `.upload-${randomBytes(8).toString("hex")}.tmp`);
    const handle = await open(temp, "wx", 0o600);
    const hash = createHash("sha256");
    const reader = body.getReader();
    let size = 0;
    let complete = false;
    let rejected = false;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (let i = 0; i < value.byteLength && size + i < ZIP_MAGIC.length; i++) {
          if (value[i] !== ZIP_MAGIC[size + i]) throw new ApkRejected("not_an_apk");
        }
        size += value.byteLength;
        if (size > this.maxBytes) throw new ApkRejected("too_large");
        hash.update(value);
        for (let off = 0; off < value.byteLength; ) off += (await handle.write(value, off, value.byteLength - off)).bytesWritten;
      }
      if (size < ZIP_MAGIC.length) throw new ApkRejected("not_an_apk");
      await handle.sync();
      complete = true;
    } catch (err) {
      rejected = err instanceof ApkRejected;
      throw err;
    } finally {
      await handle.close();
      if (!complete) {
        if (rejected) reader.releaseLock();
        else await reader.cancel().catch(() => {});
        await unlink(temp).catch(() => {});
      }
    }
    const sha256 = hash.digest("hex");
    if (expectedSha !== undefined && sha256 !== expectedSha) {
      await unlink(temp).catch(() => {});
      throw new ApkRejected("checksum_mismatch");
    }
    return this.serially(async () => {
      try {
        await rename(temp, this.file(sha256));
      } catch (err) {
        await unlink(temp).catch(() => {});
        throw err;
      }
      const apk: StoredApk = { ...version, sha256, size, source, releaseTag, storedAt: this.s.now() };
      const { store, eventLog } = this.s;
      let previous: StoredApk | null;
      try {
        previous = store.transaction(() => {
          const before = store.getAppApk();
          store.setAppApk(apk);
          const { versionName, versionCode } = apk;
          if (source === "upload") eventLog.append("app.uploaded", null, actor, { versionName, versionCode, source });
          else eventLog.append("app.fetched", null, actor, { versionName, versionCode, source, releaseTag });
          return before;
        });
      } catch (err) {
        await this.discard(sha256);
        throw err;
      }
      this.s.events.publishAll({ type: "app", data: { versionCode: apk.versionCode } });
      // A prefix of the digest only: the redaction would turn the whole one into <token>.
      this.s.log.info("apk stored", { versionName: apk.versionName, versionCode: apk.versionCode, size, source, sha256Prefix: sha256.slice(0, 12) });
      if (previous && previous.sha256 !== sha256) await this.discard(previous.sha256);
      return apk;
    });
  }

  /**
   * Forgets the current APK and deletes its file; null when none was stored. Every open TV stream hears of it
   * (`event: app` with versionCode 0: nothing on offer).
   */
  remove(actor: Actor): Promise<StoredApk | null> {
    return this.serially(async () => {
      const { store, eventLog } = this.s;
      const removed = store.transaction(() => {
        const apk = store.getAppApk();
        if (!apk) return null;
        store.deleteAppApk();
        eventLog.append("app.removed", null, actor, { versionName: apk.versionName });
        return apk;
      });
      if (!removed) return null;
      this.s.events.publishAll({ type: "app", data: { versionCode: 0 } });
      this.s.log.info("apk removed", { versionName: removed.versionName, versionCode: removed.versionCode });
      await this.discard(removed.sha256);
      return removed;
    });
  }

  /** The GitHub check as the admin API shows it. */
  checkStatus() {
    return { lastAt: iso(this.last?.at ?? null), nextAt: iso(this.nextAt), result: this.last?.result ?? null, reason: this.last?.reason ?? null, running: this.running !== null };
  }

  /**
   * Looks at the latest release of the configured repository and fetches its APK when it differs from the stored
   * one. One check at a time: `409 check_running` while one runs, `409 github_disabled` with a manual source.
   */
  async check(actor: Actor): Promise<CheckOutcome> {
    if (this.config.source !== "github") throw new HttpError(409, "github_disabled", "the TV app comes from uploads only (appUpdates.source)");
    if (this.running) throw new HttpError(409, "check_running", "a check is already running");
    const run = this.runCheck(actor);
    this.running = run;
    try {
      return await run;
    } finally {
      this.running = null;
    }
  }

  private async runCheck(actor: Actor): Promise<CheckOutcome> {
    let outcome: CheckOutcome;
    try {
      outcome = await this.checkLatest(actor);
    } catch (err) {
      let reason: string;
      if (err instanceof CheckFailed || err instanceof ApkRejected) reason = err.reason;
      else {
        reason = "internal";
        if (!this.stopped) this.s.log.error("app check error", { error: err });
      }
      outcome = { result: "failed", reason, apk: this.stopped ? null : this.current() };
    }
    // The server is stopping (the store may be closed): nothing more to record.
    if (this.stopped) return outcome;
    this.last = { at: this.s.now(), result: outcome.result, reason: outcome.reason };
    if (outcome.result === "failed") {
      const reason = outcome.reason;
      this.s.store.transaction(() => this.s.eventLog.append("app.check_failed", null, actor, { reason }));
      this.s.log.warn("app check failed", { reason, repo: this.config.repo });
    }
    return outcome;
  }

  /** A GET with the server's User-Agent, ended after `timeoutMs` (the body too) or when the server stops. */
  private async get(url: string, timeoutMs: number, headers: Record<string, string> = {}): Promise<Response> {
    const signal = AbortSignal.any([this.aborter.signal, AbortSignal.timeout(timeoutMs)]);
    try {
      return await this.fetch(url, { headers: { "User-Agent": `izle-server/${VERSION}`, ...headers }, signal, redirect: "follow" });
    } catch {
      throw new CheckFailed("network");
    }
  }

  /** A response's status as a failure: `http_<status>` (the body is dropped). */
  private static failStatus(res: Response, reason = `http_${res.status}`): never {
    void res.body?.cancel().catch(() => {});
    throw new CheckFailed(reason);
  }

  /** The whole body, or `reason` once it is longer than `max` bytes. */
  private static async readCapped(res: Response, max: number, reason: string): Promise<Buffer> {
    if (Number(res.headers.get("content-length")) > max) AppUpdateService.failStatus(res, reason);
    if (!res.body) return Buffer.alloc(0);
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > max) {
          void reader.cancel().catch(() => {});
          throw new CheckFailed(reason);
        }
        chunks.push(value);
      }
    } catch (err) {
      if (err instanceof CheckFailed) throw err;
      throw new CheckFailed("network");
    }
    return Buffer.concat(chunks);
  }

  private async checkLatest(actor: Actor): Promise<CheckOutcome> {
    const res = await this.get(`${this.githubApiBase}/repos/${this.config.repo}/releases/latest`, this.apiMs, {
      Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
    });
    if (res.status === 404) AppUpdateService.failStatus(res, "no_release");
    if (res.status === 403 || res.status === 429) AppUpdateService.failStatus(res, "rate_limited");
    if (!res.ok) AppUpdateService.failStatus(res);
    let release: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse((await AppUpdateService.readCapped(res, RELEASE_MAX_BYTES, "bad_release")).toString("utf8"));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new CheckFailed("bad_release");
      release = parsed as Record<string, unknown>;
    } catch (err) {
      throw err instanceof CheckFailed ? err : new CheckFailed("bad_release");
    }
    if (release.prerelease === true || release.draft === true) throw new CheckFailed("prerelease");
    const tag = release.tag_name;
    if (typeof tag !== "string" || !RELEASE_TAG.test(tag)) throw new CheckFailed("bad_tag");
    // The APK asset is named after the tag; never the -debug build next to it.
    const assetName = `izle-tv-${tag.slice(1)}.apk`;
    const version = parseApkName(assetName);
    if (!version) throw new CheckFailed("bad_tag");
    const assets = Array.isArray(release.assets) ? (release.assets as unknown[]) : [];
    const asset = (wanted: string) => {
      const a = assets.find((x): x is Record<string, unknown> => x !== null && typeof x === "object" && (x as { name?: unknown }).name === wanted);
      const href = a?.browser_download_url;
      return a && typeof href === "string" && /^https?:\/\//.test(href) ? { href, size: a.size } : null;
    };
    const apkAsset = asset(assetName);
    if (!apkAsset) throw new CheckFailed("no_apk_asset");
    const sumsAsset = asset(CHECKSUMS_NAME);
    if (!sumsAsset) throw new CheckFailed("no_checksums");
    if (typeof apkAsset.size === "number" && apkAsset.size > this.maxBytes) throw new CheckFailed("too_large");

    const sumsRes = await this.get(sumsAsset.href, this.apiMs);
    if (!sumsRes.ok) AppUpdateService.failStatus(sumsRes);
    const sums = (await AppUpdateService.readCapped(sumsRes, CHECKSUMS_MAX_BYTES, "checksums_too_large")).toString("utf8");
    const expected = checksumFor(sums, assetName);
    if (!expected) throw new CheckFailed("checksum_missing");

    // The same APK, one newer than the release, or the owner's upload of the release's version (a patched build:
    // its suffix leaves the versionCode alone): nothing to fetch. A fetched APK of the same version with other
    // bytes is fetched again (the release asset was re-published).
    const current = this.current();
    const { versionCode } = version;
    if (current && (current.sha256 === expected || current.versionCode > versionCode || (current.source === "upload" && current.versionCode === versionCode))) {
      this.s.log.debug("app check: up to date", { versionCode: current.versionCode, releaseVersionCode: versionCode });
      return { result: "up_to_date", reason: null, apk: current };
    }

    const apkRes = await this.get(apkAsset.href, this.downloadMs);
    if (!apkRes.ok) AppUpdateService.failStatus(apkRes);
    if (Number(apkRes.headers.get("content-length")) > this.maxBytes) AppUpdateService.failStatus(apkRes, "too_large");
    try {
      return { result: "fetched", reason: null, apk: await this.store(apkRes.body, assetName, "github", tag, actor, expected) };
    } catch (err) {
      if (err instanceof ApkRejected) {
        // store() leaves a refused body to its caller.
        void apkRes.body?.cancel().catch(() => {});
        throw err;
      }
      // The download broke off (network, timeout, the server stopping).
      throw new CheckFailed("network");
    }
  }

  /** Checks `firstDelayMs` from now (GitHub source only), then every `checkIntervalHours`. */
  schedule(firstDelayMs = FIRST_CHECK_DELAY_MS): void {
    if (this.config.source !== "github" || this.stopped) return;
    this.arm(firstDelayMs);
  }

  private arm(ms: number): void {
    clearTimeout(this.timer);
    this.nextAt = this.s.now() + ms;
    this.timer = setTimeout(() => void this.scheduled(), ms);
    this.timer.unref();
  }

  private async scheduled(): Promise<void> {
    this.nextAt = null;
    try {
      await this.check(SERVER);
    } catch (err) {
      // A check the owner started is running: this one is skipped.
      if (!(err instanceof HttpError)) this.s.log.error("app check error", { name: errorName(err) });
    }
    if (!this.stopped) this.arm(this.config.checkIntervalHours * 3_600_000);
  }

  /** Stops the schedule and ends a running check (server shutdown). */
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.nextAt = null;
    this.aborter.abort();
    await this.running?.catch(() => {});
  }
}

/** The lower-case sha256 SHA256SUMS lists for `name` (`<hex>  <name>`, or `<hex> *<name>`), or null. */
export function checksumFor(sums: string, name: string): string | null {
  for (const line of sums.split(/\r?\n/)) {
    const m = /^([0-9A-Fa-f]{64})\s[ *]?(.+)$/.exec(line.trim());
    if (m && m[2] === name) return m[1]!.toLowerCase();
  }
  return null;
}
