// Admin "test this episode (or channel)": every source through the TV's resolve path without creating sessions, and
// optionally an upstream probe. The report has hosts and header names only, never URLs, header values, refs or
// playlist text.

import type { ResolveResult } from "@izle/contract";
import { episodeIdOf, playableOf, type CatalogService } from "./catalog.ts";
import { errorName } from "./errors.ts";
import { isPlaylistText, summarizePlaylist, type PlaylistSummary } from "./hls.ts";
import { requirePlayableRef, requireSource, type PlayableId } from "./lookup.ts";
import { MAX_PLAYLIST_BYTES, readText } from "./proxy.ts";
import { deliveryPlan, type ResolveService, type UpstreamStream } from "./resolve.ts";
import { stopwatch } from "./stopwatch.ts";

const PROBE_TIMEOUT_MS = 10_000;

interface ProbeReport {
  ok: boolean;
  ms: number;
  status?: number;
  contentType?: string | null;
  playlist?: PlaylistSummary;
  error?: "timeout" | "network" | "not_a_playlist" | "too_large";
  name?: string;
}

function summarize(r: ResolveResult | UpstreamStream, proxyAlways: boolean) {
  const plan = deliveryPlan(r, proxyAlways);
  return {
    kind: r.media.kind, inline: "playlist" in r.media, host: URL.parse("playlist" in r.media ? r.media.baseUrl : r.media.url)?.host || null,
    headerNames: Object.keys(r.headers ?? {}).sort(), delivery: !plan.servable ? "unsupported" : plan.proxyMain ? "proxy" : "direct",
    languages: r.languages ?? null, subtitleTracks: r.subtitleTracks?.length ?? 0, label: r.label ?? null, expiresAt: r.expiresAt ?? null,
  };
}

async function probe(stream: UpstreamStream, signal: AbortSignal | undefined, fetchUpstream: typeof fetch): Promise<ProbeReport> {
  if ("playlist" in stream.media) return { ok: true, ms: 0, playlist: summarizePlaylist(stream.media.playlist) };
  const ms = stopwatch();
  const hls = stream.media.kind === "hls";
  const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  try {
    const res = await fetchUpstream(stream.media.url, {
      headers: { ...stream.headers, ...(hls ? {} : { Range: "bytes=0-1023" }) },
      redirect: "follow",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const base = { status: res.status, contentType: res.headers.get("content-type") };
    if (!hls || res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      return { ok: res.status === 200 || res.status === 206, ms: ms(), ...base };
    }
    const text = await readText(res, MAX_PLAYLIST_BYTES);
    if (text === null) return { ok: false, ms: ms(), ...base, error: "too_large" };
    if (!isPlaylistText(text)) return { ok: false, ms: ms(), ...base, error: "not_a_playlist" };
    return { ok: true, ms: ms(), ...base, playlist: summarizePlaylist(text) };
  } catch (err) {
    return { ok: false, ms: ms(), error: timeout.aborted ? "timeout" : "network", name: errorName(err) };
  }
}

/** `POST /admin/diagnostics/resolve`: an episode by its id, or a channel by its item id. */
export type DiagnosticsInput = PlayableId & {
  sourceId?: string;
  preferredAudioLanguage?: string | null;
  probe?: boolean;
};

export async function diagnosePlayable(
  deps: { catalog: CatalogService; resolver: ResolveService; fetch: typeof fetch },
  input: DiagnosticsInput,
  signal?: AbortSignal,
) {
  const ref = requirePlayableRef(deps.catalog, input, 404);
  const playable = playableOf(ref);
  const sources = input.sourceId === undefined ? playable.sources : [requireSource(playable, input.sourceId, 404, "unknown_source")];
  const { proxyAlways, deadlineMs } = deps.resolver;
  const attemptOpts = { preferredAudioLanguage: input.preferredAudioLanguage ?? null, deadlineMs, signal };
  const reports = [];
  for (const source of sources) {
    const a = await deps.resolver.attempt(ref, source, attemptOpts);
    const outcome = a.ok
      ? { stream: summarize(a.stream, proxyAlways), ...(input.probe !== false ? { probe: await probe(a.stream, signal, deps.fetch) } : {}) }
      : { code: a.tried.code, ...(a.tried.name ? { name: a.tried.name } : {}) };
    reports.push({
      sourceId: source.id, type: source.type, ok: a.ok, ms: a.ms, ...(source.type === "adapter" ? { adapterId: source.adapter } : {}),
      // Everything the adapter returned, in its order.
      ...(a.results ? { results: a.results.map((r) => summarize(r, proxyAlways)) } : {}), ...outcome,
    });
  }
  return { itemId: ref.item.id, episodeId: episodeIdOf(ref), playbackAllowed: playable.playbackAllowed, sources: reports };
}
