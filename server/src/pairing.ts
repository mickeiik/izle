import { randomInt } from "node:crypto";
import { SERVER, tvActor, type Actor } from "./actor.ts";
import { newId, newToken, secretsEqual, sha256 } from "./auth.ts";
import { HttpError, tooManyRequests } from "./errors.ts";
import type { EventLog } from "./eventlog.ts";
import type { EventHub } from "./events.ts";
import type { Logger } from "./log.ts";
import type { ProxyService } from "./proxy.ts";
import { RateLimiter } from "./ratelimit.ts";
import type { Store } from "./store.ts";
import { Waiters } from "./waiters.ts";

const PAIR_CODE_TTL_MS = 10 * 60_000;
/** Server-wide backstop; the per-client cap is what stops one client from holding the pool. */
const MAX_OPEN_PAIR_CODES = 10;
/** One TV needs one code; the second covers an app restart mid-pairing. */
const MAX_OPEN_PAIR_CODES_PER_CLIENT = 2;
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

interface PairingDeps {
  store: Store;
  eventLog: EventLog;
  events: EventHub;
  proxy: ProxyService;
  log: Logger;
  now: () => number;
}

/**
 * Pairing: the TV asks for a 6-digit code and long-polls with its pair token; the owner approves the code in the
 * admin API; the next poll creates the device token, hands it over once, and only its hash is kept.
 */
export class PairingService {
  private readonly waiters = new Waiters<string>();
  private readonly limiter: RateLimiter;
  private readonly s: PairingDeps;

  constructor(deps: PairingDeps, opts: PairingOptions = {}) {
    this.s = deps;
    const limit = opts.startLimit ?? { max: 10, windowMs: 10 * 60_000 };
    this.limiter = new RateLimiter(limit.max, limit.windowMs, deps.now);
  }

  start(clientKey: string): { code: string; pairToken: string; expiresAt: number } {
    const rate = this.limiter.hit(clientKey);
    if (!rate.ok) throw tooManyRequests("rate_limited", "too many pairing attempts", rate.retryAfterSec);
    const t = this.s.now();
    this.purge(t);
    // Refused by its own codes waiting for approval first; a start never touches another client's code (clients
    // behind one NAT, or every client without trustedProxies behind a proxy, share an address and pair one after
    // the other).
    const open = this.s.store.listOpenPairCodes(t);
    const clientHash = sha256(clientKey);
    const retryAfterSec = (rows: typeof open) => Math.max(1, Math.ceil((Math.min(...rows.map((r) => r.expiresAt)) - t) / 1000));
    const own = open.filter((r) => r.clientHash === clientHash && r.approvedAt === null);
    if (own.length >= MAX_OPEN_PAIR_CODES_PER_CLIENT) throw tooManyRequests("too_many_pending", "this client already has pairing codes waiting for approval", retryAfterSec(own));
    if (open.length >= MAX_OPEN_PAIR_CODES) throw tooManyRequests("too_many_pending", "too many pairing codes are waiting for approval", retryAfterSec(open));
    let code = "";
    for (let attempt = 0; attempt < 50 && !code; attempt++) {
      const candidate = String(randomInt(0, 1_000_000)).padStart(6, "0");
      if (!this.s.store.getPairCode(candidate)) code = candidate;
    }
    if (!code) throw new HttpError(503, "busy", "no free pairing code");
    const pairToken = newToken();
    const expiresAt = t + PAIR_CODE_TTL_MS;
    this.s.store.transaction(() => {
      this.s.store.insertPairCode({ code, pairTokenHash: sha256(pairToken), clientHash, createdAt: t, expiresAt });
      // The TV has no id yet, so the server stands as the actor; the code is what the owner needs to see.
      this.s.eventLog.append("pairing.pending", null, SERVER, { code, expiresAt: new Date(expiresAt).toISOString() });
    });
    this.s.log.info("pairing started", { expiresInSec: Math.round(PAIR_CODE_TTL_MS / 1000) });
    return { code, pairToken, expiresAt };
  }

  /**
   * Creates the device (pending until the TV collects its token), named "TV" or the first free "TV n" by default so
   * two unnamed TVs stay apart. With `replaces` (an active device) the code is bound to that one instead, which the
   * TV takes over, name included, when it collects its token.
   */
  approve(code: string, name?: string | null, replaces?: string): { deviceId: string; name: string } {
    const t = this.s.now();
    const device = this.s.store.transaction(() => {
      const row = this.s.store.getPairCode(code);
      if (!row || row.deliveredAt !== null || row.expiresAt <= t) throw new HttpError(404, "unknown_code", "no open pairing code with this value");
      if (row.approvedAt !== null) throw new HttpError(409, "already_approved", "this code is already approved");
      if (replaces !== undefined) {
        const old = this.s.store.getDevice(replaces);
        if (!old || old.tokenHash === null) throw new HttpError(404, "unknown_device", "no active device with this id");
        this.s.store.approvePairCode(code, old.id, t);
        return { deviceId: old.id, name: old.name };
      }
      const id = newId();
      const deviceName = name?.trim() || this.defaultName();
      this.s.store.createDevice({ id, name: deviceName, tokenHash: null, now: t });
      this.s.store.approvePairCode(code, id, t);
      return { deviceId: id, name: deviceName };
    });
    this.s.log.info("pairing approved", { deviceId: device.deviceId, replaces: replaces !== undefined });
    this.waiters.wake(code);
    return device;
  }

  /** Owner cancellation of an open code (one the owner's TV does not show). False: no open code. */
  cancel(code: string, actor: Actor): boolean {
    const t = this.s.now();
    const cancelled = this.s.store.transaction(() => {
      const row = this.s.store.getPairCode(code);
      if (!row || row.deliveredAt !== null || row.expiresAt <= t) return false;
      this.s.store.cancelPairCode(code, t);
      this.s.eventLog.append("pairing.cancelled", null, actor, { code });
      return true;
    });
    if (!cancelled) return false;
    this.s.log.info("pairing cancelled", { by: actor.type });
    this.waiters.wake(code);
    return true;
  }

  private defaultName(): string {
    const taken = new Set(this.s.store.listDevices().map((d) => d.name.trim().toLowerCase()));
    if (!taken.has("tv")) return "TV";
    for (let n = 2; ; n++) if (!taken.has(`tv ${n}`)) return `TV ${n}`;
  }

  /** Delivers the device token exactly once, or reports the code's state. */
  private check(code: string, pairToken: string): PairWaitResult {
    const t = this.s.now();
    const row = this.s.store.getPairCode(code);
    if (!row || !secretsEqual(row.pairTokenHash, sha256(pairToken))) throw new HttpError(404, "not_found");
    if (row.deliveredAt !== null || row.expiresAt <= t) throw new HttpError(410, "expired", "the pairing code expired", { status: "expired" });
    if (row.approvedAt === null || row.deviceId === null) return { status: "pending" };
    const deviceToken = newToken();
    const deviceId = row.deviceId;
    const replaced = this.s.store.transaction(() => {
      // A code is deleted with its device (a cascade), so an open one always has its device.
      const device = this.s.store.getDevice(deviceId)!;
      this.s.store.setDeviceToken(deviceId, sha256(deviceToken), t);
      this.s.store.markPairCodeDelivered(code, t);
      const taken = device.tokenHash !== null; // `approve` with `replaces`: the new token replaces the old one
      this.s.eventLog.append("device.paired", deviceId, tvActor(deviceId), { name: device.name, replaced: taken });
      return taken;
    });
    if (replaced) {
      // The old TV's token is dead: its streams and proxy sessions end now, its next request gets 401 and it shows
      // a pairing code by itself. Everything stored for the device stays for the new TV.
      this.s.events.closeDevice(deviceId, false);
      this.s.proxy.dropDevice(deviceId);
    }
    this.s.log.info("pairing completed", { deviceId, replaced });
    return { status: "approved", deviceId, deviceToken };
  }

  async wait(code: string, pairToken: string, waitMs: number, signal?: AbortSignal): Promise<PairWaitResult> {
    const first = this.check(code, pairToken);
    if (first.status !== "pending" || waitMs <= 0) return first;
    const row = this.s.store.getPairCode(code)!;
    const timeout = Math.max(0, Math.min(waitMs, MAX_PAIR_WAIT_MS, row.expiresAt - this.s.now()));
    await this.waiters.wait(code, timeout, signal);
    if (signal?.aborted) return { status: "pending" };
    return this.check(code, pairToken);
  }

  purge(t = this.s.now()): void {
    this.s.store.purgePairCodes(t, PAIR_CODE_PURGE_GRACE_MS);
  }

  listOpen(): Array<{ code: string; createdAt: number; expiresAt: number; approved: boolean }> {
    return this.s.store.listOpenPairCodes(this.s.now()).map((r) => ({ code: r.code, createdAt: r.createdAt, expiresAt: r.expiresAt, approved: r.approvedAt !== null }));
  }
}
