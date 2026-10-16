import { randomInt } from "node:crypto";
import { SERVER, tvActor } from "./actor.ts";
import { newId, newToken, secretsEqual, sha256 } from "./auth.ts";
import type { Services } from "./context.ts";
import { HttpError, tooManyRequests } from "./errors.ts";
import type { EventLog } from "./eventlog.ts";
import type { Logger } from "./log.ts";
import type { ProxyService } from "./proxy.ts";
import { RateLimiter } from "./ratelimit.ts";
import type { Store } from "./store.ts";
import { Waiters } from "./waiters.ts";

const PAIR_CODE_TTL_MS = 10 * 60_000;
const MAX_OPEN_PAIR_CODES = 5;
export const MAX_PAIR_WAIT_MS = 25_000;
/** Expired and delivered pair codes (and the devices never collected) are deleted this long afterwards. */
const PAIR_CODE_PURGE_GRACE_MS = 60 * 60_000;
/** The 6-digit code a TV shows while it waits to be paired. */
export const PAIR_CODE = /^[0-9]{6}$/;

type PairWaitResult = { status: "pending" } | { status: "approved"; deviceId: string; deviceToken: string };

export interface PairingOptions {
  /** `pair/start` calls allowed per client address and window. */
  startLimit?: { max: number; windowMs: number };
}

/**
 * Pairing: the TV asks for a 6-digit code and long-polls with its pair token; the owner approves the code in the
 * admin API; the next poll creates the device token, hands it over once, and only its hash is kept.
 */
export class PairingService {
  private readonly waiters = new Waiters<string>();
  private readonly limiter: RateLimiter;
  private readonly store: Store;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly eventLog: EventLog;
  private readonly deps: Pick<Services, "events"> & { proxy: ProxyService };

  constructor(deps: Pick<Services, "store" | "log" | "now" | "eventLog" | "events"> & { proxy: ProxyService }, opts: PairingOptions = {}) {
    this.store = deps.store;
    this.log = deps.log;
    this.now = deps.now;
    this.eventLog = deps.eventLog;
    this.deps = deps;
    const limit = opts.startLimit ?? { max: 10, windowMs: 10 * 60_000 };
    this.limiter = new RateLimiter(limit.max, limit.windowMs, this.now);
  }

  start(clientKey: string): { code: string; pairToken: string; expiresAt: number } {
    const rate = this.limiter.hit(clientKey);
    if (!rate.ok) throw tooManyRequests("rate_limited", "too many pairing attempts", rate.retryAfterSec);
    const t = this.now();
    this.purge(t);
    if (this.store.listOpenPairCodes(t).length >= MAX_OPEN_PAIR_CODES) throw new HttpError(429, "too_many_pending", "too many pairing codes are waiting for approval");
    let code = "";
    for (let attempt = 0; attempt < 50 && !code; attempt++) {
      const candidate = String(randomInt(0, 1_000_000)).padStart(6, "0");
      if (!this.store.getPairCode(candidate)) code = candidate;
    }
    if (!code) throw new HttpError(503, "busy", "no free pairing code");
    const pairToken = newToken();
    const expiresAt = t + PAIR_CODE_TTL_MS;
    this.store.transaction(() => {
      this.store.insertPairCode({ code, pairTokenHash: sha256(pairToken), createdAt: t, expiresAt });
      // The TV has no id yet, so the server stands as the actor; the code is what the owner needs to see.
      this.eventLog.append("pairing.pending", null, SERVER, { code, expiresAt: new Date(expiresAt).toISOString() });
    });
    this.log.info("pairing started", { expiresInSec: Math.round(PAIR_CODE_TTL_MS / 1000) });
    return { code, pairToken, expiresAt };
  }

  /**
   * Owner approval. Creates the device (pending until the TV collects its token). Without a name the TV is called
   * "TV", or the first free "TV n", so two unnamed TVs stay apart in the admin page; the owner can rename it later.
   * With `replaces` (an active device) no device is created: the code is bound to that one, which the TV takes
   * over when it collects its token, keeping its name (`name` is ignored).
   */
  approve(code: string, name?: string | null, replaces?: string): { deviceId: string; name: string } {
    const t = this.now();
    const device = this.store.transaction(() => {
      const row = this.store.getPairCode(code);
      if (!row || row.deliveredAt !== null || row.expiresAt <= t) throw new HttpError(404, "unknown_code", "no open pairing code with this value");
      if (row.approvedAt !== null) throw new HttpError(409, "already_approved", "this code is already approved");
      if (replaces !== undefined) {
        const old = this.store.getDevice(replaces);
        if (!old || old.tokenHash === null) throw new HttpError(404, "unknown_device", "no active device with this id");
        this.store.approvePairCode(code, old.id, t);
        return { deviceId: old.id, name: old.name };
      }
      const id = newId();
      const deviceName = name?.trim() || this.defaultName();
      this.store.createDevice({ id, name: deviceName, tokenHash: null, now: t });
      this.store.approvePairCode(code, id, t);
      return { deviceId: id, name: deviceName };
    });
    this.log.info("pairing approved", { deviceId: device.deviceId, replaces: replaces !== undefined });
    this.waiters.wake(code);
    return device;
  }

  private defaultName(): string {
    const taken = new Set(this.store.listDevices().map((d) => d.name.trim().toLowerCase()));
    if (!taken.has("tv")) return "TV";
    for (let n = 2; ; n++) if (!taken.has(`tv ${n}`)) return `TV ${n}`;
  }

  /** Delivers the device token exactly once, or reports the code's state. */
  private check(code: string, pairToken: string): PairWaitResult {
    const t = this.now();
    const row = this.store.getPairCode(code);
    if (!row || !secretsEqual(row.pairTokenHash, sha256(pairToken))) throw new HttpError(404, "not_found");
    if (row.deliveredAt !== null || row.expiresAt <= t) throw new HttpError(410, "expired", "the pairing code expired", { status: "expired" });
    if (row.approvedAt === null || row.deviceId === null) return { status: "pending" };
    const deviceToken = newToken();
    const deviceId = row.deviceId;
    // A device that already has a token is being taken over (`approve` with `replaces`): the new token replaces it.
    const replaced = this.store.transaction(() => {
      const device = this.store.getDevice(deviceId);
      this.store.setDeviceToken(deviceId, sha256(deviceToken), t);
      this.store.markPairCodeDelivered(code, t);
      const taken = device?.tokenHash != null;
      this.eventLog.append("device.paired", deviceId, tvActor(deviceId), { name: device?.name ?? "", replaced: taken });
      return taken;
    });
    if (replaced) {
      // The old TV's token is dead: its streams and proxy sessions end now, its next request gets 401 and it shows
      // a pairing code by itself. Everything stored for the device stays for the new TV.
      this.deps.events.closeDevice(deviceId, false);
      this.deps.proxy.dropDevice(deviceId);
    }
    this.log.info("pairing completed", { deviceId, replaced });
    return { status: "approved", deviceId, deviceToken };
  }

  async wait(code: string, pairToken: string, waitMs: number, signal?: AbortSignal): Promise<PairWaitResult> {
    const first = this.check(code, pairToken);
    if (first.status !== "pending" || waitMs <= 0) return first;
    const row = this.store.getPairCode(code)!;
    const timeout = Math.max(0, Math.min(waitMs, MAX_PAIR_WAIT_MS, row.expiresAt - this.now()));
    await this.waiters.wait(code, timeout, signal);
    if (signal?.aborted) return { status: "pending" };
    return this.check(code, pairToken);
  }

  purge(t = this.now()): void {
    this.store.purgePairCodes(t, PAIR_CODE_PURGE_GRACE_MS);
  }

  listOpen(): Array<{ code: string; createdAt: number; expiresAt: number; approved: boolean }> {
    return this.store.listOpenPairCodes(this.now()).map((r) => ({ code: r.code, createdAt: r.createdAt, expiresAt: r.expiresAt, approved: r.approvedAt !== null }));
  }
}
