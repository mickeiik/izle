import path from "node:path";
import { BundleValidationError, formatIssue, isLiveItem, loadBundle, type BundleManifest, type BundleStats, type CatalogItem, type Episode, type EpisodicItem, type LiveItem, type Playable, type ValidationIssue } from "@izle/contract";
import type { Logger } from "./log.ts";

/** An episode of a movie or series, in its item. */
export interface EpisodeRef {
  kind: "episode";
  item: EpisodicItem;
  episode: Episode;
  /** Position in the item's play order. */
  index: number;
}

/** A live channel: its item carries the approval and the sources itself. */
export interface LiveRef {
  kind: "live";
  item: LiveItem;
}

/**
 * What the TV API plays: an episode (named by its episode id) or a channel (named by its item id). The two id
 * spaces are separate, so a ref always says which kind it is.
 */
export type PlayableRef = EpisodeRef | LiveRef;

/** The approval and sources a ref names: the episode's, or the channel's own. */
export const playableOf = (ref: PlayableRef): Playable => (ref.kind === "episode" ? ref.episode : ref.item);

/** The episode id a ref names, null for a channel (what stored rows and adapter requests carry). */
export const episodeIdOf = (ref: PlayableRef): string | null => (ref.kind === "episode" ? ref.episode.id : null);

/** A ref for a channel; `item` must be a live item. */
export const liveRef = (item: LiveItem): LiveRef => ({ kind: "live", item });

/**
 * What a stored row, a session or a report plays: an episode of an item, or (`episodeId` null) a channel. Stored
 * rows outlive catalogs, so `CatalogService.playing` looks a key up leniently (undefined when gone); a request body
 * names what to play with a `PlayableId` instead, looked up strictly by `requirePlayableRef` (lookup.ts), which
 * answers the request with an error.
 */
export interface PlayingKey {
  itemId: string;
  episodeId: string | null;
}

/** The key of what a ref plays. */
export const playingKey = (ref: PlayableRef): PlayingKey => ({ itemId: ref.item.id, episodeId: episodeIdOf(ref) });

/** The one equality: both fields, because an episode id may equal an item id (a recorded bug). */
export const samePlaying = (a: PlayingKey, b: PlayingKey): boolean => a.itemId === b.itemId && a.episodeId === b.episodeId;

/** How the admin API names what plays (problems, now playing, Listen along, saved positions, viewing rows). */
export interface PlayingDescription {
  itemId: string;
  itemKind: string | null;
  itemTitle: string | null;
  episodeId: string | null;
  episodeTitle: string | null;
  season: number | null;
  number: number | null;
  missing: boolean;
}

/**
 * The description of a ref itself, with no lookup: a viewing records the titles of what was resolved, not what the
 * catalog says by the time the adapter answered (a reload may have happened in between).
 */
export function describePlayable(ref: PlayableRef): PlayingDescription {
  const episode = ref.kind === "episode" ? ref.episode : null;
  return {
    itemId: ref.item.id, itemKind: ref.item.kind, itemTitle: ref.item.title,
    episodeId: episode?.id ?? null, episodeTitle: episode?.title ?? null, season: episode?.season ?? null, number: episode?.number ?? null, missing: false,
  };
}

export interface LoadedCatalog {
  dir: string;
  manifest: BundleManifest;
  items: CatalogItem[];
  itemsById: Map<string, CatalogItem>;
  episodesById: Map<string, EpisodeRef>;
  warnings: ValidationIssue[];
  stats: BundleStats;
  loadedAt: number;
}

export type ReloadResult = { ok: true; catalog: LoadedCatalog } | { ok: false; issues: ValidationIssue[] };

/** Called after every successful load with the catalog now active and the one it replaced (null at start). */
type CatalogLoadedHook = (next: LoadedCatalog, previous: LoadedCatalog | null) => void;

const ASSET_FILE = /^[0-9a-f]{64}\.(jpg|png|webp)$/;

/** An item's image path in the bundle (`assets/<sha256>.<ext>`) as the URL GET /assets/:file serves it at. */
const assetUrl = (rel: string | null | undefined): string | null => (rel ? `/assets/${path.posix.basename(rel)}` : null);

/** How titles are ordered: the catalog browser and the viewing history sort alike. */
export const byTitle = (a: string, b: string): number => a.localeCompare(b);

/** Case-, accent- and Turkish-dotless-i-insensitive form the catalog browser matches text and genres in. */
export function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").replace(/ı/g, "i").toLowerCase();
}

/** Loads the catalog bundle from a local directory and keeps it in memory; reloads replace it atomically. */
export class CatalogService {
  private loaded: LoadedCatalog | null = null;
  readonly dir: string;
  private readonly log: Logger;
  private readonly now: () => number;
  /**
   * Adapter ids the resolver module provides; null = no resolver configured. With a module, a bundle that names
   * an adapter the module does not provide is refused (at start and on reload).
   */
  private readonly adapters: ReadonlySet<string> | null;
  private readonly onLoaded: CatalogLoadedHook | undefined;

  constructor(
    dir: string,
    log: Logger,
    now: () => number = Date.now,
    adapters: ReadonlySet<string> | null = null,
    options: { onLoaded?: CatalogLoadedHook } = {},
  ) {
    this.dir = dir;
    this.log = log;
    this.now = now;
    this.adapters = adapters;
    this.onLoaded = options.onLoaded;
  }

  private async read(): Promise<LoadedCatalog> {
    const { bundle, warnings, stats } = await loadBundle(this.dir);
    const missing = this.adapters ? bundle.manifest.adapters.filter((a) => !this.adapters!.has(a)) : [];
    const issue = (a: string) => ({ severity: "error" as const, file: "bundle.json", path: "/adapters", message: `adapter "${a}" is not provided by the resolver module` });
    if (missing.length > 0) throw new BundleValidationError(this.dir, missing.map(issue));
    const { items } = bundle;
    const itemsById = new Map<string, CatalogItem>();
    const episodesById = new Map<string, EpisodeRef>();
    for (const item of items) {
      itemsById.set(item.id, item);
      if (isLiveItem(item)) continue; // a channel has no episodes: it is found by its item id
      item.episodes.forEach((episode, index) => episodesById.set(episode.id, { kind: "episode", item, episode, index }));
    }
    return { dir: bundle.dir, manifest: bundle.manifest, items, itemsById, episodesById, warnings, stats, loadedAt: this.now() };
  }

  private report(c: LoadedCatalog, msg: string): void {
    this.log.info(msg, { catalogId: c.manifest.catalogId, buildId: c.manifest.buildId, items: c.stats.items, episodes: c.stats.episodes, live: c.stats.live });
    for (const w of c.warnings) this.log.warn("catalog warning", { issue: formatIssue(w) });
    if (this.adapters === null && c.manifest.adapters.length > 0) {
      this.log.warn("catalog references adapters but no resolver module is configured; their sources are unavailable", { adapters: c.manifest.adapters });
    }
  }

  /** Makes `c` the active catalog and tells the hook. */
  private activate(c: LoadedCatalog, msg: string): void {
    const previous = this.loaded;
    this.loaded = c;
    this.report(c, msg);
    if (!this.onLoaded) return;
    // The catalog is active either way: a failing hook (the history) must not turn a good load into a failed one.
    try {
      this.onLoaded(c, previous);
    } catch (err) {
      this.log.error("catalog load hook failed", { catalogId: c.manifest.catalogId, buildId: c.manifest.buildId, error: err });
    }
  }

  /** Initial load; throws BundleValidationError when the bundle is invalid. */
  async load(): Promise<void> {
    this.activate(await this.read(), "catalog loaded");
  }

  /** Reloads from disk. On failure the previous catalog stays active. */
  async reload(): Promise<ReloadResult> {
    let c: LoadedCatalog;
    try {
      c = await this.read();
    } catch (err) {
      const issues = err instanceof BundleValidationError ? err.issues : [{ severity: "error" as const, file: ".", path: "", message: "cannot load bundle" }];
      this.log.error("catalog reload failed; keeping the previous catalog", { errors: issues.filter((i) => i.severity === "error").length });
      return { ok: false, issues };
    }
    this.activate(c, "catalog reloaded");
    return { ok: true, catalog: c };
  }

  get current(): LoadedCatalog {
    if (!this.loaded) throw new Error("catalog not loaded");
    return this.loaded;
  }

  get catalogId(): string {
    return this.current.manifest.catalogId;
  }

  item(id: string): CatalogItem | undefined {
    return this.current.itemsById.get(id);
  }

  episode(id: string): EpisodeRef | undefined {
    return this.current.episodesById.get(id);
  }

  /** Lenient lookup: the episode (by its id) or the channel (by its item id) a key names, undefined when gone. */
  playing(key: PlayingKey): PlayableRef | undefined {
    if (key.episodeId !== null) return this.episode(key.episodeId);
    const item = this.item(key.itemId);
    return item && isLiveItem(item) ? liveRef(item) : undefined;
  }

  /**
   * How the admin API names what plays: titles from the current catalog, `missing` when it is gone. An episode's
   * item still gives its title after the episode left; a channel is missing only when its item is gone (an item
   * that became a series is still named by it).
   */
  describe(key: PlayingKey): PlayingDescription {
    const ref = this.playing(key);
    if (ref) return describePlayable(ref);
    const item = this.item(key.itemId);
    return { itemId: item?.id ?? key.itemId, itemKind: item?.kind ?? null, itemTitle: item?.title ?? null, episodeId: key.episodeId, episodeTitle: null, season: null, number: null, missing: key.episodeId !== null || !item };
  }

  /** Relative URL of an item's poster, served by GET /assets/:file. */
  posterUrl(item: CatalogItem): string | null {
    return assetUrl(item.poster);
  }

  /** Relative URL of an item's backdrop (its landscape image), served by GET /assets/:file. */
  backdropUrl(item: CatalogItem): string | null {
    return assetUrl(item.backdrop);
  }

  /** Absolute path of a poster or backdrop file, or null when the name is not a content-addressed asset of this catalog. */
  assetPath(file: string): string | null {
    if (!ASSET_FILE.test(file)) return null;
    return path.join(this.current.dir, this.current.manifest.assetsDir, file);
  }
}
