import { isLiveItem, type Bundle } from "./bundle.ts";

export interface ProbeTarget {
  itemId: string;
  /** null for a live item's own sources. */
  episodeId: string | null;
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

/**
 * Range-GETs one byte of every direct media and subtitle URL in the bundle (HEAD is not used: some hosts answer it
 * with errors) and reports 200/206 as reachable; a live item's sources are probed like an episode's. Redirects are
 * followed. Adapter sources need a resolver: skipped.
 */
export async function probeBundle(bundle: Bundle, { concurrency = 4 } = {}): Promise<ProbeResult[]> {
  const targets: ProbeTarget[] = [];
  for (const item of bundle.items) {
    const playables = isLiveItem(item)
      ? [{ episodeId: null, sources: item.sources }]
      : item.episodes.map((ep) => ({ episodeId: ep.id, sources: ep.sources }));
    for (const { episodeId, sources } of playables) {
      for (const src of sources) {
        const base = { itemId: item.id, episodeId, sourceId: src.id };
        if (src.type === "direct") targets.push({ ...base, what: "media", url: src.media.url, headers: src.media.headers });
        for (const t of src.subtitleTracks ?? []) targets.push({ ...base, what: "subtitle", url: t.url });
      }
    }
  }
  const results: ProbeResult[] = new Array(targets.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < targets.length) {
      const index = next++;
      const target = targets[index]!;
      const started = Date.now();
      try {
        const headers = { "User-Agent": "izle-validate/1", ...target.headers, Range: "bytes=0-0" };
        const res = await fetch(target.url, { headers, signal: AbortSignal.timeout(20_000) });
        await res.body?.cancel().catch(() => {});
        results[index] = { target, ok: res.status === 200 || res.status === 206, status: res.status, ms: Date.now() - started };
      } catch (err) {
        results[index] = { target, ok: false, error: (err as Error).name || "Error", ms: Date.now() - started };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return results;
}
