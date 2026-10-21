// Catalog bundle contract v1. Normative text: docs/spec/catalog-bundle-v1.md.
// Mirrored by schema/{common,bundle,items}.v1.schema.json; keep both in sync.

export const BUNDLE_MANIFEST_FILE = "bundle.json";
export const BUNDLE_ITEMS_FILE = "items.json";
export const BUNDLE_ASSETS_DIR = "assets";

/** URL-path safe, durable across builds, never positional. */
export type Id = string;
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,119}$/;

/** Simplified BCP 47 language tag, e.g. "en", "tr", "pt-BR", "und". */
export type LanguageTag = string;

/** "ts" = progressive MPEG-TS over HTTP (for a channel, an endless response). */
export type MediaKind = "hls" | "dash" | "mp4" | "ts";

export interface BundleManifest {
  format: "izle-bundle";
  formatVersion: 1;
  catalogId: Id;
  buildId: string;
  /** ISO 8601 date-time with offset. */
  builtAt: string;
  name: string;
  generator?: { name: string; version: string };
  /** Hints only; per-device settings on the server win. */
  defaults?: { uiLanguage?: "tr" | "en"; preferredAudioLanguage?: LanguageTag };
  /** Adapter ids referenced by sources; the server verifies its resolver module provides them. */
  adapters: string[];
  items: typeof BUNDLE_ITEMS_FILE;
  assetsDir: typeof BUNDLE_ASSETS_DIR;
}

/** Content of items.json. */
export interface ItemsFile {
  items: CatalogItem[];
}

/** What can be played: shared by Episode and LiveItem (movies will carry their sources the same way later). */
export interface Playable {
  /** Required and explicit. false = never auto-selected, greyed in the hidden menu. */
  playbackAllowed: boolean;
  /** Preference order. May be empty only when playbackAllowed is false. */
  sources: Source[];
}

/** The fields every kind of item has. */
interface ItemBase {
  id: Id;
  title: string;
  originalTitle?: string | null;
  synopsis?: string | null;
  genres?: string[];
  /** "assets/<sha256-of-content>.<jpg|png|webp>" or null. */
  poster: string | null;
  /**
   * Optional landscape image (16:9, around 1280×720): "assets/<sha256-of-content>.<jpg|png|webp>" or null. Absent
   * or null, the TV crops the poster to a landscape band.
   */
  backdrop?: string | null;
}

/** A movie or a series: played through its episodes. */
export interface EpisodicItem extends ItemBase {
  kind: "movie" | "series";
  year?: number | null;
  rating?: number | null;
  /** Item-level default for auto-advancing to the next episode (true when absent). */
  autoAdvance?: boolean;
  /** Array order is the approved play order. A movie has exactly one episode. */
  episodes: Episode[];
}

/**
 * A TV channel: a stream with no beginning or end, addressed by its item id; no episodes, duration, resume or play
 * order.
 */
export interface LiveItem extends ItemBase, Playable {
  kind: "live";
}

/** `kind` decides the shape. */
export type CatalogItem = EpisodicItem | LiveItem;

export const isLiveItem = (item: CatalogItem): item is LiveItem => item.kind === "live";

export interface Episode extends Playable {
  /** Unique within the whole bundle (not only within its item). */
  id: Id;
  season?: number | null;
  number?: number | null;
  title?: string | null;
  label?: string | null;
  durationMs?: number | null;
  /** false = never auto-start the next episode after this one (season end / approval boundary). */
  autoAdvance?: boolean;
}

/** BCP 47 tags; null = unknown, [] = known to have none. */
export interface LanguageFacts {
  audio: LanguageTag[] | null;
  subtitles: LanguageTag[] | null;
}

export interface SubtitleTrack {
  url: string;
  language: LanguageTag;
  format: "vtt" | "srt" | "ttml";
  label?: string;
}

interface SourceBase {
  /** Unique within the episode or the live item. */
  id: Id;
  label?: string;
  languages: LanguageFacts;
  subtitleTracks?: SubtitleTrack[];
}

export interface DirectSource extends SourceBase {
  type: "direct";
  media: {
    kind: MediaKind;
    url: string;
    /** Upstream request headers. Media with headers is only ever played through the server proxy. */
    headers?: Record<string, string>;
  };
}

export interface AdapterSource extends SourceBase {
  type: "adapter";
  /** Adapter id; must be listed in the manifest's `adapters`. */
  adapter: string;
  /** Opaque JSON for the adapter. Never logged. */
  ref: Record<string, unknown>;
}

export type Source = DirectSource | AdapterSource;

/** A fully loaded, validated bundle. */
export interface Bundle {
  dir: string;
  manifest: BundleManifest;
  items: CatalogItem[];
}
