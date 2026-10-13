/** Fixed-window counter per key (e.g. per client IP). In memory; a restart resets it. */
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(max: number, windowMs: number, now: () => number = Date.now) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
  }

  /** Counts one hit; returns whether it is allowed and, if not, after how many seconds to retry. */
  hit(key: string): { ok: boolean; retryAfterSec: number } {
    const t = this.now();
    if (this.windows.size > 10_000) {
      for (const [k, w] of this.windows) if (w.resetAt <= t) this.windows.delete(k);
    }
    let w = this.windows.get(key);
    if (!w || w.resetAt <= t) {
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
}
