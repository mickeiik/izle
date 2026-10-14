// The owner's view of the loaded catalog (admin API): what is loaded and from which builds, search results, and an
// item with its episodes and sources. Upstream URLs, headers and adapter refs are never part of it.

import type { CatalogItem } from "@izle/contract";
import type { CatalogService } from "./catalog.ts";
import { episodeDetails, iso, itemCard, itemDetails } from "./presenters.ts";
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
        ...(s.type === "direct" ? { kind: s.media.kind, needsProxy: Boolean(s.media.headers && Object.keys(s.media.headers).length) } : { adapter: s.adapter }),
      })),
    })),
  };
}
