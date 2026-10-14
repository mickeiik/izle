import type { Bundle } from "./bundle.ts";

export interface ProbeTarget {
  itemId: string;
  episodeId: string;
  sourceId: string;
  what: "media" | "subtitle";
  url: string;
  headers?: Record<string, string>;
}

export interface ProbeResult {
  target: ProbeTarget;
  ok: boolean;
  status?: number;
  /** Error class name only; messages may contain URLs. */
  error?: string;
  ms: number;
}

export interface ProbeOptions {
  concurrency?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Every direct media URL and subtitle URL in the bundle. Adapter sources need a resolver and are skipped. */
export function probeTargets(bundle: Bundle): ProbeTarget[] {
  const targets: ProbeTarget[] = [];
  for (const item of bundle.items) {
    for (const ep of item.episodes) {
      for (const src of ep.sources) {
        const base = { itemId: item.id, episodeId: ep.id, sourceId: src.id };
        if (src.type === "direct") {
          targets.push({ ...base, what: "media", url: src.media.url, ...(src.media.headers ? { headers: src.media.headers } : {}) });
        }
        for (const t of src.subtitleTracks ?? []) targets.push({ ...base, what: "subtitle", url: t.url });
      }
    }
  }
  return targets;
}

/**
 * Range-GETs one byte of every target (HEAD is not used: some hosts answer it with errors) and reports 200/206 as
 * reachable. Redirects are followed.
 */
export async function probeBundle(bundle: Bundle, opts: ProbeOptions = {}): Promise<ProbeResult[]> {
  const targets = probeTargets(bundle);
  const doFetch = opts.fetch ?? fetch;
  const results: ProbeResult[] = new Array(targets.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < targets.length) {
      const index = next++;
      const target = targets[index]!;
      const started = Date.now();
      try {
        const res = await doFetch(target.url, {
          method: "GET",
          redirect: "follow",
          headers: { "User-Agent": "izle-validate/1", ...target.headers, Range: "bytes=0-0" },
          signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
        });
        await res.body?.cancel().catch(() => {});
        results[index] = { target, ok: res.status === 200 || res.status === 206, status: res.status, ms: Date.now() - started };
      } catch (err) {
        results[index] = { target, ok: false, error: (err as Error).name || "Error", ms: Date.now() - started };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 4) }, worker));
  return results;
}
