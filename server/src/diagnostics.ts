// Admin "test this episode" tool: runs every source through the same resolve path as the TV (adapters, deadlines,
// validation) without creating sessions, and optionally probes the upstream. The report is safe to show in the
// admin UI: hosts and header names only, never URLs, header values, refs or playlist text.

import type { MediaKind, ResolveResult, Source } from "@izle/contract";
import type { CatalogService } from "./catalog.ts";
import { isPlaylistText, summarizePlaylist, type PlaylistSummary } from "./hls.ts";
import { requireEpisode, requireSource } from "./lookup.ts";
import { MAX_PLAYLIST_BYTES } from "./proxy.ts";
import { deliveryPlan, type ResolveService, type TriedCode, type UpstreamStream } from "./resolve.ts";
import { errorName } from "./resolver.ts";

export const PROBE_TIMEOUT_MS = 10_000;

export interface StreamSummary {
  kind: MediaKind;
  inline: boolean;
  host: string | null;
  headerNames: string[];
  delivery: "direct" | "proxy" | "unsupported";
  languages: { audio: string[] | null; subtitles: string[] | null } | null;
  subtitleTracks: number;
  label: string | null;
  expiresAt: string | null;
}

export interface ProbeReport {
  ok: boolean;
  ms: number;
  status?: number;
  contentType?: string | null;
  playlist?: PlaylistSummary;
  error?: "timeout" | "network" | "not_a_playlist" | "too_large";
  name?: string;
}

export interface SourceReport {
  sourceId: string;
  type: Source["type"];
  adapterId?: string;
  ok: boolean;
  code?: TriedCode;
  name?: string;
  ms: number;
  /** Everything the adapter returned, in its order (adapter sources only). */
  results?: StreamSummary[];
  /** The stream the TV would get. */
  stream?: StreamSummary;
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
type Summarized = Pick<UpstreamStream, "media"> & Partial<Pick<UpstreamStream, "headers" | "languages" | "subtitleTracks" | "label" | "expiresAt">>;

function summarize(r: Summarized, proxyAlways: boolean): StreamSummary {
  const inline = "playlist" in r.media;
  const headerNames = Object.keys(r.headers ?? {}).sort();
  const plan = deliveryPlan(r, proxyAlways);
  const delivery = !plan.servable ? "unsupported" : plan.proxyMain ? "proxy" : "direct";
  return {
    kind: r.media.kind,
    inline,
    host: hostOf("playlist" in r.media ? r.media.baseUrl : r.media.url),
    headerNames,
    delivery,
    languages: r.languages ?? null,
    subtitleTracks: r.subtitleTracks?.length ?? 0,
    label: r.label ?? null,
    expiresAt: r.expiresAt ?? null,
  };
}

async function probe(stream: UpstreamStream, signal: AbortSignal | undefined): Promise<ProbeReport> {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  if ("playlist" in stream.media) {
    return { ok: true, ms: 0, playlist: summarizePlaylist(stream.media.playlist) };
  }
  const hls = stream.media.kind === "hls";
  const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(stream.media.url, {
      headers: { ...stream.headers, ...(hls ? {} : { Range: "bytes=0-1023" }) },
      redirect: "follow",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const base = { status: res.status, contentType: res.headers.get("content-type") };
    if (!hls || res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      return { ok: res.status === 200 || res.status === 206, ms: ms(), ...base };
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > MAX_PLAYLIST_BYTES) return { ok: false, ms: ms(), ...base, error: "too_large" };
    const text = Buffer.from(bytes).toString("utf8");
    if (!isPlaylistText(text)) return { ok: false, ms: ms(), ...base, error: "not_a_playlist" };
    return { ok: true, ms: ms(), ...base, playlist: summarizePlaylist(text) };
  } catch (err) {
    return { ok: false, ms: ms(), error: timeout.aborted ? "timeout" : "network", name: errorName(err) };
  }
}

export async function diagnoseEpisode(
  deps: { catalog: CatalogService; resolver: ResolveService },
  input: { episodeId: string; sourceId?: string | undefined; preferredAudioLanguage?: string | null | undefined; probe?: boolean | undefined },
  signal?: AbortSignal,
) {
  const ref = requireEpisode(deps.catalog, input.episodeId, 404, "unknown_episode");
  // Source ids are unique within an episode (the bundle validator refuses duplicates).
  const sources = input.sourceId === undefined ? ref.episode.sources : [requireSource(ref.episode, input.sourceId, 404, "unknown_source")];
  const proxyAlways = deps.resolver.proxyAlways;
  const reports: SourceReport[] = [];
  for (const source of sources) {
    const a = await deps.resolver.attempt(ref, source, {
      preferredAudioLanguage: input.preferredAudioLanguage ?? null,
      deadlineMs: deps.resolver.deadlineMs,
      signal,
    });
    const report: SourceReport = { sourceId: source.id, type: source.type, ok: a.ok, ms: a.ms };
    if (source.type === "adapter") report.adapterId = source.adapter;
    if (a.results) report.results = a.results.map((r: ResolveResult) => summarize(r, proxyAlways));
    if (!a.ok) {
      report.code = a.tried.code;
      if (a.tried.name) report.name = a.tried.name;
    } else {
      report.stream = summarize(a.stream, proxyAlways);
      if (input.probe !== false) report.probe = await probe(a.stream, signal);
    }
    reports.push(report);
  }
  return {
    itemId: ref.item.id,
    episodeId: ref.episode.id,
    playbackAllowed: ref.episode.playbackAllowed,
    sources: reports,
  };
}
