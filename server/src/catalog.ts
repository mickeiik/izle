import path from "node:path";
import {
  loadBundle,
  type BundleManifest,
  type BundleStats,
  type CatalogItem,
  type Episode,
  type ValidationIssue,
  BundleValidationError,
  formatIssue,
} from "@izle/contract";
import type { Logger } from "./log.ts";

export interface EpisodeRef {
  item: CatalogItem;
  episode: Episode;
  /** Position in the item's play order. */
  index: number;
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
export type CatalogLoadedHook = (next: LoadedCatalog, previous: LoadedCatalog | null) => void;

const POSTER_FILE = /^[0-9a-f]{64}\.(jpg|png|webp)$/;

/** Case-, accent- and Turkish-dotless-i-insensitive form used for catalog search. */
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
    if (missing.length > 0) {
      throw new BundleValidationError(
        this.dir,
        missing.map((a) => ({ severity: "error" as const, file: "bundle.json", path: "/adapters", message: `adapter "${a}" is not provided by the resolver module` })),
      );
    }
    const itemsById = new Map<string, CatalogItem>();
    const episodesById = new Map<string, EpisodeRef>();
    for (const item of bundle.items) {
      itemsById.set(item.id, item);
      item.episodes.forEach((episode, index) => episodesById.set(episode.id, { item, episode, index }));
    }
    return { dir: bundle.dir, manifest: bundle.manifest, items: bundle.items, itemsById, episodesById, warnings, stats, loadedAt: this.now() };
  }

  private report(c: LoadedCatalog, msg: string): void {
    this.log.info(msg, { catalogId: c.manifest.catalogId, buildId: c.manifest.buildId, items: c.stats.items, episodes: c.stats.episodes });
    for (const w of c.warnings) this.log.warn("catalog warning", { issue: formatIssue(w) });
    if (this.adapters === null && c.manifest.adapters.length > 0) {
      this.log.warn("catalog references adapters but no resolver module is configured; their sources are unavailable", {
        adapters: c.manifest.adapters,
      });
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

  /** Relative URL of an item's poster, served by GET /assets/:file. */
  posterUrl(item: CatalogItem): string | null {
    return item.poster ? `/assets/${path.posix.basename(item.poster)}` : null;
  }

  /** Absolute path of a poster file, or null when the name is not a content-addressed asset of this catalog. */
  assetPath(file: string): string | null {
    if (!POSTER_FILE.test(file)) return null;
    return path.join(this.current.dir, this.current.manifest.assetsDir, file);
  }

  search(query: string, limit: number): CatalogItem[] {
    const q = fold(query.trim());
    const items = this.current.items.filter(
      (i) => q === "" || fold(i.title).includes(q) || (i.originalTitle && fold(i.originalTitle).includes(q)) || fold(i.id).includes(q),
    );
    return items.sort((a, b) => a.title.localeCompare(b.title)).slice(0, limit);
  }
}
