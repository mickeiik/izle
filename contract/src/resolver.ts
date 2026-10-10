// Resolver module API v1. Normative text: docs/spec/resolver-module-v1.md.
// A resolver module is owner-written, owner-trusted code loaded by izle-server from a local path.

import type { LanguageFacts, MediaKind, SubtitleTrack } from "./bundle.ts";

export const RESOLVER_API_VERSION = 1;

/** Maximum length of an inline playlist returned by an adapter (2 MiB). */
export const MAX_INLINE_PLAYLIST_BYTES = 2 * 1024 * 1024;

/** The default export (or the module namespace) of a resolver module. */
export interface ResolverModule {
  apiVersion: typeof RESOLVER_API_VERSION;
  createAdapters(ctx: AdapterContext): Adapter[] | Promise<Adapter[]>;
}

export type LogLevel = "info" | "warn" | "error";

export interface AdapterContext {
  /** The `resolver.config` object from the server configuration. */
  config: Record<string, unknown>;
  /** A directory the module may use for its own state (created by the server). */
  dataDir: string;
  fetch: typeof fetch;
  /** Redacted logger: URLs, tokens, headers and refs are stripped before anything is written. */
  log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void;
}

export interface Adapter {
  /** Matches `adapter` in bundle sources and the manifest's `adapters` list. */
  id: string;
  /** Returns candidate streams in preference order; an empty array means "nothing playable". */
  resolve(req: ResolveRequest): Promise<ResolveResult[]>;
  healthcheck?(signal: AbortSignal): Promise<void>;
}

export interface ResolveRequest {
  catalogId: string;
  itemId: string;
  episodeId: string;
  sourceId: string;
  ref: Record<string, unknown>;
  preferredAudioLanguage: string | null;
  /** Aborted when the TV goes away or the deadline passes. Pass it to every fetch. */
  signal: AbortSignal;
  /** Time budget for this call in milliseconds. */
  deadlineMs: number;
}

export type ResolvedMedia =
  | { kind: MediaKind; url: string }
  | { kind: "hls"; playlist: string; baseUrl: string };

export interface ResolveResult {
  media: ResolvedMedia;
  /** Upstream request headers. The server proxies such media; headers never reach the TV. */
  headers?: Record<string, string>;
  languages?: LanguageFacts;
  subtitleTracks?: Array<SubtitleTrack & { headers?: Record<string, string> }>;
  label?: string;
  /** ISO 8601 validity hint so the client can re-resolve before expiry. */
  expiresAt?: string;
}
