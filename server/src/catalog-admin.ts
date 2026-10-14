// The owner's view of the loaded catalog (admin API): what is loaded and from which builds, search results, and an
// item with its episodes and sources. Upstream URLs, headers and adapter refs are never part of it. Also the reload
// that the admin route and SIGHUP share.

import type { CatalogItem } from "@izle/contract";
import type { CatalogService, ReloadResult } from "./catalog.ts";
import { errorName } from "./errors.ts";
import type { Logger } from "./log.ts";
import type { Notifier } from "./events.ts";
import { episodeDetails, iso, itemCard, itemDetails } from "./presenters.ts";
import { hasHeaders } from "./resolve.ts";
import type { LoadedResolver } from "./resolver.ts";
import type { CatalogBuild, Store } from "./store.ts";
import { VERSION } from "./version.ts";

/** Builds listed by `GET /admin/catalog`, newest first; older ones stay readable by id. */
export const CATALOG_BUILDS_LISTED = 50;

export interface CatalogInfoDeps {
  catalog: CatalogService;
  store: Store;
  resolverModule: LoadedResolver | null;
}

export function buildJson(b: CatalogBuild) {
  return {
    buildId: b.buildId,
    builtAt: b.builtAt,
    loadedAt: iso(b.loadedAt),
    baseline: b.baseline,
    counts: { items: b.items, episodes: b.episodes },
    added: { items: b.itemsAdded, episodes: b.episodesAdded },
    removed: { items: b.itemsRemoved, episodes: b.episodesRemoved },
  };
}

/** The loaded catalog, the resolver module, the server version, the newest builds and what the latest update changed. */
export function catalogInfo({ catalog, store, resolverModule }: CatalogInfoDeps) {
  const cur = catalog.current;
  const builds = store.listCatalogBuilds(cur.manifest.catalogId, CATALOG_BUILDS_LISTED);
  // What the last real update brought: the baseline has no changes by definition.
  const latest = builds.find((b) => !b.baseline);
  return {
    id: cur.manifest.catalogId,
    buildId: cur.manifest.buildId,
    builtAt: cur.manifest.builtAt,
    name: cur.manifest.name,
    loadedAt: iso(cur.loadedAt),
    stats: cur.stats,
    adapters: cur.manifest.adapters,
    warnings: cur.warnings.map((w) => ({ file: w.file, path: w.path, message: w.message })),
    resolver: resolverModule ? { sha256: resolverModule.sha256, adapters: [...resolverModule.adapters.keys()] } : null,
    server: { version: VERSION },
    builds: builds.map(buildJson),
    changes: latest ? (store.getCatalogBuild(latest.catalogId, latest.buildId)?.changes ?? null) : null,
  };
}

export interface ReloadDeps {
  catalog: CatalogService;
  notifier: Notifier;
}

/**
 * Re-reads the catalog bundle (the admin route and SIGHUP). After a good load every TV's state version is bumped,
 * so the TVs re-read their home screens; after a refused one the previous catalog stays and nothing is bumped.
 */
export async function reloadCatalog({ catalog, notifier }: ReloadDeps): Promise<ReloadResult> {
  const r = await catalog.reload();
  if (r.ok) notifier.bumpAll();
  return r;
}

/**
 * The reload for a signal handler: it never rejects. A reload that throws (the store is already closed during
 * shutdown) is logged with the error's class name, never its message, instead of ending the process.
 */
export async function reloadOnSignal(deps: ReloadDeps & { log: Logger }, signal: string): Promise<void> {
  try {
    await reloadCatalog(deps);
  } catch (err) {
    deps.log.warn("catalog reload failed", { signal, error: errorName(err) });
  }
}

/** A search hit: the item's card with its episode counts. */
export function searchHitJson(catalog: CatalogService, item: CatalogItem) {
  return {
    ...itemCard(catalog, item),
    episodeCount: item.episodes.length,
    playableCount: item.episodes.filter((e) => e.playbackAllowed).length,
  };
}

/** An item with every episode and source, as the admin page's item view shows it. */
export function catalogItemJson(catalog: CatalogService, item: CatalogItem) {
  return {
    ...itemDetails(catalog, item),
    autoAdvance: item.autoAdvance ?? true,
    episodes: item.episodes.map((e, index) => ({
      ...episodeDetails(e, index),
      autoAdvance: e.autoAdvance ?? null,
      // Upstream URLs, headers and adapter refs are deliberately not exposed.
      sources: e.sources.map((s) => ({
        id: s.id,
        type: s.type,
        label: s.label ?? null,
        languages: s.languages,
        ...(s.type === "direct" ? { kind: s.media.kind, needsProxy: hasHeaders(s.media.headers) } : { adapter: s.adapter }),
      })),
    })),
  };
}
