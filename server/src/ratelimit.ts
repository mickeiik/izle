/** Most keys a limiter tracks; when full, a new key evicts the oldest one. A memory bound, not a security control. */
const DEFAULT_MAX_KEYS = 50_000;
/** Expired windows dropped per hit, oldest first: upkeep stays constant per hit however many keys there are. */
const SWEEP_PER_HIT = 2;

/**
 * Fixed-window counter per key (e.g. per client IP, see `limiterKey`). In memory; a restart resets it. The windows
 * are kept in the order they started (a key whose window restarts moves to the end), so the expired ones are the
 * oldest and each hit drops a few of them without scanning the rest.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor(max: number, windowMs: number, now: () => number = Date.now, maxKeys = DEFAULT_MAX_KEYS) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
    this.maxKeys = maxKeys;
  }

  /** How many keys are tracked. */
  get size(): number {
    return this.windows.size;
  }

  /** Counts one hit; returns whether it is allowed and, if not, after how many seconds to retry. */
  hit(key: string): { ok: boolean; retryAfterSec: number } {
    const t = this.now();
    this.sweep(t);
    let w = this.windows.get(key);
    if (!w || w.resetAt <= t) {
      this.windows.delete(key);
      if (this.windows.size >= this.maxKeys) this.windows.delete(this.windows.keys().next().value!);
      w = { count: 0, resetAt: t + this.windowMs };
      this.windows.set(key, w);
    }
    w.count++;
    return w.count <= this.max ? { ok: true, retryAfterSec: 0 } : { ok: false, retryAfterSec: Math.ceil((w.resetAt - t) / 1000) };
  }

  /** Whether one more hit would be allowed now, without counting one; if not, after how many seconds to retry. */
  check(key: string): { ok: boolean; retryAfterSec: number } {
    const t = this.now();
    const w = this.windows.get(key);
    if (!w || w.resetAt <= t || w.count < this.max) return { ok: true, retryAfterSec: 0 };
    return { ok: false, retryAfterSec: Math.ceil((w.resetAt - t) / 1000) };
  }

  /** Drops up to SWEEP_PER_HIT expired windows from the oldest end. */
  private sweep(t: number): void {
    let left = SWEEP_PER_HIT;
    for (const [k, w] of this.windows) {
      if (left-- === 0 || w.resetAt > t) return;
      this.windows.delete(k);
    }
  }
}
