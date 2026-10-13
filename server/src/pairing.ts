import { randomInt, timingSafeEqual } from "node:crypto";
import { newId, newToken, sha256 } from "./auth.ts";
import { HttpError } from "./errors.ts";
import type { Logger } from "./log.ts";
import { RateLimiter } from "./ratelimit.ts";
import type { Store } from "./store.ts";

export const PAIR_CODE_TTL_MS = 10 * 60_000;
export const MAX_OPEN_PAIR_CODES = 5;
export const MAX_PAIR_WAIT_MS = 25_000;

export type PairWaitResult = { status: "pending" } | { status: "approved"; deviceId: string; deviceToken: string };

export interface PairingOptions {
  ttlMs?: number;
  maxOpen?: number;
  /** `pair/start` calls allowed per client address and window. */
  startLimit?: { max: number; windowMs: number };
}

function hashesEqual(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, "hex");
  const b = Buffer.from(bHex, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Pairing: the TV asks for a 6-digit code and long-polls with its pair token; the owner approves the code in the
 * admin API; the next poll creates the device token, hands it over once, and only its hash is kept.
 */
export class PairingService {
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly limiter: RateLimiter;
  private readonly ttlMs: number;
  private readonly maxOpen: number;
  private readonly store: Store;
  private readonly log: Logger;
  private readonly now: () => number;

  constructor(store: Store, log: Logger, now: () => number = Date.now, opts: PairingOptions = {}) {
    this.store = store;
    this.log = log;
    this.now = now;
    this.ttlMs = opts.ttlMs ?? PAIR_CODE_TTL_MS;
    this.maxOpen = opts.maxOpen ?? MAX_OPEN_PAIR_CODES;
    const limit = opts.startLimit ?? { max: 10, windowMs: 10 * 60_000 };
    this.limiter = new RateLimiter(limit.max, limit.windowMs, now);
  }

  start(clientKey: string): { code: string; pairToken: string; expiresAt: number } {
    const rate = this.limiter.hit(clientKey);
    if (!rate.ok) {
      throw new HttpError(429, "rate_limited", "too many pairing attempts", {}, { "Retry-After": String(rate.retryAfterSec) });
    }
    const t = this.now();
    this.store.purgePairCodes(t, 60 * 60_000);
    if (this.store.listOpenPairCodes(t).length >= this.maxOpen) {
      throw new HttpError(429, "too_many_pending", "too many pairing codes are waiting for approval");
    }
    let code = "";
    for (let attempt = 0; attempt < 50 && !code; attempt++) {
      const candidate = String(randomInt(0, 1_000_000)).padStart(6, "0");
      if (!this.store.getPairCode(candidate)) code = candidate;
    }
    if (!code) throw new HttpError(503, "busy", "no free pairing code");
    const pairToken = newToken();
    const expiresAt = t + this.ttlMs;
    this.store.insertPairCode({ code, pairTokenHash: sha256(pairToken), now: t, expiresAt });
    this.log.info("pairing started", { expiresInSec: Math.round(this.ttlMs / 1000) });
    return { code, pairToken, expiresAt };
  }

  /**
   * Owner approval. Creates the device (pending until the TV collects its token). Without a name the TV is called
   * "TV", or the first free "TV n", so two unnamed TVs stay apart in the admin page; the owner can rename it later.
   */
  approve(code: string, name?: string | null): { deviceId: string; name: string } {
    const t = this.now();
    const device = this.store.transaction(() => {
      const row = this.store.getPairCode(code);
      if (!row || row.deliveredAt !== null || row.expiresAt <= t) throw new HttpError(404, "unknown_code", "no open pairing code with this value");
      if (row.approvedAt !== null) throw new HttpError(409, "already_approved", "this code is already approved");
      const id = newId();
      const deviceName = name?.trim() || this.defaultName();
      this.store.createDevice({ id, name: deviceName, tokenHash: null, now: t });
      this.store.approvePairCode(code, id, t);
      return { deviceId: id, name: deviceName };
    });
    this.log.info("pairing approved", { deviceId: device.deviceId });
    for (const wake of this.waiters.get(code) ?? []) wake();
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
    if (!row || !hashesEqual(row.pairTokenHash, sha256(pairToken))) throw new HttpError(404, "not_found");
    if (row.deliveredAt !== null || row.expiresAt <= t) throw new HttpError(410, "expired", "the pairing code expired", { status: "expired" });
    if (row.approvedAt === null || row.deviceId === null) return { status: "pending" };
    const deviceToken = newToken();
    const deviceId = row.deviceId;
    this.store.transaction(() => {
      this.store.setDeviceToken(deviceId, sha256(deviceToken), t);
      this.store.markPairCodeDelivered(code, t);
    });
    this.log.info("pairing completed", { deviceId });
    return { status: "approved", deviceId, deviceToken };
  }

  async wait(code: string, pairToken: string, waitMs: number, signal?: AbortSignal): Promise<PairWaitResult> {
    const first = this.check(code, pairToken);
    if (first.status !== "pending" || waitMs <= 0) return first;
    const row = this.store.getPairCode(code)!;
    const timeout = Math.max(0, Math.min(waitMs, MAX_PAIR_WAIT_MS, row.expiresAt - this.now()));
    await new Promise<void>((resolve) => {
      let set = this.waiters.get(code);
      if (!set) {
        set = new Set();
        this.waiters.set(code, set);
      }
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        set.delete(done);
        if (set.size === 0) this.waiters.delete(code);
        resolve();
      };
      const timer = setTimeout(done, timeout);
      signal?.addEventListener("abort", done, { once: true });
      set.add(done);
    });
    if (signal?.aborted) return { status: "pending" };
    return this.check(code, pairToken);
  }

  listOpen(): Array<{ code: string; createdAt: number; expiresAt: number; approved: boolean }> {
    return this.store
      .listOpenPairCodes(this.now())
      .map((r) => ({ code: r.code, createdAt: r.createdAt, expiresAt: r.expiresAt, approved: r.approvedAt !== null }));
  }
}
