// The owner's phones (the companion app), connected from a TV: the TV's hidden menu shows an invite (a QR code of
// `<server>/connect#<invite>` and a 6-digit code) and the phone claims it, getting its own secret at owner level.
// Being in front of the TV is the security (the owner approved the TV at pairing): no confirmation, no approval step.
// The secret is `izph_` + 32 random bytes (base64url), shown once; the server keeps its sha256 and never logs it, and
// keeps only the sha256 of an invite as well.

import { randomInt } from "node:crypto";
import { phoneActor, type Actor } from "./actor.ts";
import { newId, newToken, sha256 } from "./auth.ts";
import { HttpError, tooManyRequests } from "./errors.ts";
import type { EventLog } from "./eventlog.ts";
import type { Logger } from "./log.ts";
import { iso } from "./presenters.ts";
import { RateLimiter } from "./ratelimit.ts";
import type { Device, Phone, PhoneInvite, Store } from "./store.ts";
import { Waiters } from "./waiters.ts";

/** Lets secret scanners recognize the secret, and the server tell it from the owner token and access tokens. */
export const PHONE_SECRET_PREFIX = "izph_";
export const PHONE_INVITE_TTL_MS = 5 * 60_000;
export const MAX_INVITE_WAIT_MS = 25_000;
/** The 6-digit code a TV shows next to its QR code. */
export const PHONE_CODE = /^[0-9]{6}$/;
export const PHONE_NAME_MAX = 60;
const LIMIT_WINDOW_MS = 10 * 60_000;
/** Invites one TV may create per window. */
const MAX_INVITES_PER_TV = 10;
/** Failed claims (unknown, used or expired invite or code) per client address and window. */
const MAX_FAILED_CLAIMS = 10;
/** Expired invites are deleted this long afterwards (until then the TV's long-poll answers 410, not 404). */
const INVITE_PURGE_GRACE_MS = 60 * 60_000;
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

export function phoneJson(p: Phone) {
  return { id: p.id, name: p.name, createdAt: iso(p.createdAt), lastUsedAt: iso(p.lastUsedAt), deviceId: p.deviceId };
}

export type InviteStatus =
  | { status: "open"; code: string; expiresAt: string }
  | { status: "claimed"; phone: { id: string; name: string } };

export type ClaimInput = ({ invite: string } | { code: string }) & { name: string };

interface PhoneDeps {
  store: Store;
  eventLog: EventLog;
  log: Logger;
  now: () => number;
}

export class PhoneService {
  private readonly s: PhoneDeps;
  private readonly waiters = new Waiters<string>();
  private readonly invites: RateLimiter;
  private readonly failedClaims: RateLimiter;
  /** What to close when a phone is disconnected (its open event streams and long-polls), by phone id. */
  private readonly closers = new Map<string, Set<() => void>>();

  constructor(deps: PhoneDeps) {
    this.s = deps;
    this.invites = new RateLimiter(MAX_INVITES_PER_TV, LIMIT_WINDOW_MS, deps.now);
    this.failedClaims = new RateLimiter(MAX_FAILED_CLAIMS, LIMIT_WINDOW_MS, deps.now);
  }

  /** A new invite for the TV, replacing the one it had (which stops working); the invite is returned here only. */
  invite(device: Device): { code: string; invite: string; expiresAt: number } {
    const rate = this.invites.hit(device.id);
    if (!rate.ok) throw tooManyRequests("rate_limited", "too many phone invites from this TV", rate.retryAfterSec);
    const t = this.s.now();
    const invite = newToken();
    const expiresAt = t + PHONE_INVITE_TTL_MS;
    const code = this.s.store.transaction(() => {
      let free = "";
      for (let attempt = 0; attempt < 50 && !free; attempt++) {
        const candidate = String(randomInt(0, 1_000_000)).padStart(6, "0");
        if (!this.s.store.phoneInviteCodeTaken(candidate, t)) free = candidate;
      }
      if (!free) throw new HttpError(503, "busy", "no free phone code");
      this.s.store.setPhoneInvite({ deviceId: device.id, code: free, inviteHash: sha256(invite), createdAt: t, expiresAt });
      return free;
    });
    this.s.log.info("phone invite created", { deviceId: device.id, expiresInSec: PHONE_INVITE_TTL_MS / 1000 });
    // A long-poll on the replaced invite answers for the new one.
    this.waiters.wake(device.id);
    return { code, invite, expiresAt };
  }

  /** The TV's latest invite: open, claimed (until its expiry time), 410 once expired, 404 without one. */
  status(deviceId: string): InviteStatus {
    const row = this.s.store.getPhoneInvite(deviceId);
    if (!row) throw new HttpError(404, "not_found", "this TV has no phone invite");
    if (row.expiresAt <= this.s.now()) throw new HttpError(410, "expired", "the phone invite expired", { status: "expired" });
    if (row.claimedAt !== null) return { status: "claimed", phone: { id: row.phoneId!, name: row.phoneName! } };
    return { status: "open", code: row.code, expiresAt: iso(row.expiresAt)! };
  }

  /** Long-polls the TV's invite: answers at once unless it is open, else when it is claimed or `waitMs` elapses. */
  async wait(deviceId: string, waitMs: number, signal?: AbortSignal): Promise<InviteStatus> {
    const first = this.status(deviceId);
    if (first.status !== "open" || waitMs <= 0) return first;
    const row = this.s.store.getPhoneInvite(deviceId)!;
    const timeout = Math.max(0, Math.min(waitMs, MAX_INVITE_WAIT_MS, row.expiresAt - this.s.now()));
    await this.waiters.wait(deviceId, timeout, signal);
    if (signal?.aborted) return first;
    return this.status(deviceId);
  }

  /**
   * Claims an open invite (by the invite or its code) for a new phone; the secret is returned here and nowhere else.
   * A claim that finds nothing counts against the client address (`clientKey`, an IPv6 one by its /64).
   */
  claim(clientKey: string, input: ClaimInput): { phone: Phone; secret: string; deviceId: string } {
    const locked = this.failedClaims.check(clientKey);
    if (!locked.ok) throw tooManyRequests("rate_limited", "too many failed phone claims from this address; try again later", locked.retryAfterSec);
    const name = input.name.trim();
    if (name.length < 1 || name.length > PHONE_NAME_MAX) {
      throw new HttpError(400, "invalid_request", `name must be 1 to ${PHONE_NAME_MAX} characters`, { details: [{ path: "/name", message: `must be 1 to ${PHONE_NAME_MAX} characters after trimming` }] });
    }
    const t = this.s.now();
    const secret = `${PHONE_SECRET_PREFIX}${newToken()}`;
    const claimed = this.s.store.transaction(() => {
      const row = "invite" in input ? this.s.store.getPhoneInviteByHash(sha256(input.invite)) : this.s.store.getOpenPhoneInviteByCode(input.code, t);
      if (!row || !isOpen(row, t)) return null;
      const phone = this.s.store.insertPhone({ id: newId(), name, secretHash: sha256(secret), deviceId: row.deviceId, createdAt: t, lastUsedAt: null });
      this.s.store.claimPhoneInvite(row.deviceId, phone, t);
      this.s.eventLog.append("phone.connected", row.deviceId, phoneActor(phone), { phoneId: phone.id, name: phone.name, deviceId: row.deviceId });
      return phone;
    });
    if (!claimed) {
      this.failedClaims.hit(clientKey);
      // Never the presented invite or code.
      this.s.log.warn("phone claim failed", { client: clientKey, by: "invite" in input ? "invite" : "code" });
      throw new HttpError(404, "not_found", "no open invite with this value");
    }
    const deviceId = claimed.deviceId!;
    this.s.log.info("phone connected", { phoneId: claimed.id, deviceId });
    this.waiters.wake(deviceId);
    return { phone: claimed, secret, deviceId };
  }

  list(): Phone[] {
    return this.s.store.listPhones();
  }

  /**
   * Disconnects a phone: its requests answer 401 from now on, and its open event streams and long-polls end before
   * any later event (its own `phone.disconnected` included).
   */
  remove(id: string, actor: Actor): void {
    const removed = this.s.store.transaction(() => {
      const phone = this.s.store.getPhoneBy("id", id);
      if (!phone) return false;
      this.s.store.deletePhone(id);
      // Registered before the event, so the streams close before its subscribers hear of it.
      this.s.store.afterCommit(() => {
        const closers = this.closers.get(id);
        this.closers.delete(id);
        for (const close of closers ?? []) close();
      });
      this.s.eventLog.append("phone.disconnected", phone.deviceId, actor, { phoneId: id, name: phone.name });
      return true;
    });
    if (!removed) throw new HttpError(404, "not_found", "no phone with this id");
    this.s.log.info("phone disconnected", { phoneId: id, by: actor.type });
  }

  /** Calls `close` when the phone is disconnected; returns the unregistration. */
  onRemove(id: string, close: () => void): () => void {
    let closers = this.closers.get(id);
    if (!closers) this.closers.set(id, (closers = new Set()));
    closers.add(close);
    return () => {
      closers.delete(close);
      if (closers.size === 0 && this.closers.get(id) === closers) this.closers.delete(id);
    };
  }

  exists(id: string): boolean {
    return this.s.store.getPhoneBy("id", id) !== null;
  }

  /** The phone a presented secret belongs to, or null; records its use at most once a minute. */
  authenticate(secret: string): Phone | null {
    const phone = this.s.store.getPhoneBy("secret_hash", sha256(secret));
    if (!phone) return null;
    const t = this.s.now();
    if (phone.lastUsedAt === null || t - phone.lastUsedAt >= LAST_USED_WRITE_INTERVAL_MS) {
      this.s.store.touchPhone(phone.id, t);
      phone.lastUsedAt = t;
    }
    return phone;
  }

  purge(t = this.s.now()): void {
    this.s.store.purgePhoneInvites(t, INVITE_PURGE_GRACE_MS);
  }
}

const isOpen = (row: PhoneInvite, t: number) => row.claimedAt === null && row.expiresAt > t;
