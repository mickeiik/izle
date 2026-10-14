/**
 * Long-poll waiters by key. `wait` resolves when `wake(key)` is called, after `timeoutMs`, or when the signal
 * aborts, whichever comes first; a key is forgotten once its last waiter is done.
 */
export class Waiters<K> {
  private readonly waiting = new Map<K, Set<() => void>>();

  wait(key: K, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const set = this.waiting.get(key) ?? new Set<() => void>();
      this.waiting.set(key, set);
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        set.delete(done);
        if (set.size === 0) this.waiting.delete(key);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      signal?.addEventListener("abort", done, { once: true });
      set.add(done);
    });
  }

  /** Ends the wait of everyone waiting on `key`. */
  wake(key: K): void {
    for (const done of this.waiting.get(key) ?? []) done();
  }
}
