// Admin "test this episode" tool: runs every source through the same resolve path as the TV (adapters, deadlines,
// validation) without creating sessions, and optionally probes the upstream. The report is safe to show in the
// admin UI: hosts and header names only, never URLs, header values, refs or playlist text.

import type { ResolveResult, Source } from "@izle/contract";
import type { CatalogService } from "./catalog.ts";
import { errorName } from "./errors.ts";
import { isPlaylistText, summarizePlaylist, type PlaylistSummary } from "./hls.ts";
import { requireEpisode, requireSource } from "./lookup.ts";
import { MAX_PLAYLIST_BYTES, readText } from "./proxy.ts";
import { deliveryPlan, type ResolveService, type TriedCode, type UpstreamStream } from "./resolve.ts";
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

interface SourceReport {
  sourceId: string;
  type: Source["type"];
  adapterId?: string;
  ok: boolean;
  code?: TriedCode;
  name?: string;
  ms: number;
  /** Everything the adapter returned, in its order (adapter sources only). */
  results?: ReturnType<typeof summarize>[];
  /** The stream the TV would get. */
  stream?: ReturnType<typeof summarize>;
  probe?: ProbeReport;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/** An adapter's result, or the stream resolve picked from it. */
function summarize(r: ResolveResult | UpstreamStream, proxyAlways: boolean) {
  const plan = deliveryPlan(r, proxyAlways);
  return {
    kind: r.media.kind, inline: "playlist" in r.media, host: hostOf("playlist" in r.media ? r.media.baseUrl : r.media.url),
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

/** What the admin asks to test (`POST /admin/diagnostics/resolve`, validated in validation.ts). */
export interface DiagnosticsInput {
  episodeId: string;
  /** Only this source; every source of the episode otherwise. */
  sourceId?: string;
  preferredAudioLanguage?: string | null;
  /** Whether to probe the upstream of each stream found (default true). */
  probe?: boolean;
}

export async function diagnoseEpisode(
  deps: { catalog: CatalogService; resolver: ResolveService; fetch: typeof fetch },
  input: DiagnosticsInput,
  signal?: AbortSignal,
) {
  const ref = requireEpisode(deps.catalog, input.episodeId, 404, "unknown_episode");
  const sources = input.sourceId === undefined ? ref.episode.sources : [requireSource(ref.episode, input.sourceId, 404, "unknown_source")];
  const { proxyAlways, deadlineMs } = deps.resolver;
  const attemptOpts = { preferredAudioLanguage: input.preferredAudioLanguage ?? null, deadlineMs, signal };
  const reports: SourceReport[] = [];
  for (const source of sources) {
    const a = await deps.resolver.attempt(ref, source, attemptOpts);
    const report: SourceReport = { sourceId: source.id, type: source.type, ok: a.ok, ms: a.ms };
    if (source.type === "adapter") report.adapterId = source.adapter;
    if (a.results) report.results = a.results.map((r) => summarize(r, proxyAlways));
    if (!a.ok) {
      report.code = a.tried.code;
      if (a.tried.name) report.name = a.tried.name;
    } else {
      report.stream = summarize(a.stream, proxyAlways);
      if (input.probe !== false) report.probe = await probe(a.stream, signal, deps.fetch);
    }
    reports.push(report);
  }
  const { item, episode } = ref;
  return { itemId: item.id, episodeId: episode.id, playbackAllowed: episode.playbackAllowed, sources: reports };
}
