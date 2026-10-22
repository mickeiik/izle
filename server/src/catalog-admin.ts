// The owner's view of the loaded catalog (admin API): what is loaded and from which builds, the browser's hits, and an
// item with its episodes and sources. Upstream URLs, headers and adapter refs are never part of it. Also the reload
// that the admin route and SIGHUP share.

import { isLiveItem, type CatalogItem, type Source } from "@izle/contract";
import { SERVER, type Actor } from "./actor.ts";
import type { CatalogService, ReloadResult } from "./catalog.ts";
import type { BrowseHit } from "./catalog-browse.ts";
import type { AppContext } from "./context.ts";
import { errorName } from "./errors.ts";
import { episodeDetails, iso, itemCard, itemDetails } from "./presenters.ts";
import { hasHeaders } from "./resolve.ts";
import type { CatalogBuild } from "./store.ts";
import { VERSION } from "./version.ts";

/** Builds listed by `GET /admin/catalog`, newest first; older ones stay readable by id. */
const CATALOG_BUILDS_LISTED = 50;

export function buildJson(b: CatalogBuild) {
  return {
    buildId: b.buildId, builtAt: b.builtAt, loadedAt: iso(b.loadedAt), baseline: b.baseline, counts: { items: b.items, episodes: b.episodes },
    added: { items: b.itemsAdded, episodes: b.episodesAdded }, removed: { items: b.itemsRemoved, episodes: b.episodesRemoved },
  };
}

/**
 * The loaded catalog, the resolver module, the server version, the newest builds, what the latest update changed
 * and the browser's facets (its filter choices).
 */
export function catalogInfo(ctx: Pick<AppContext, "catalog" | "store" | "resolverModule" | "browse">) {
  const { catalog, store, resolverModule } = ctx;
  const cur = catalog.current;
  const builds = store.listCatalogBuilds(cur.manifest.catalogId, CATALOG_BUILDS_LISTED);
  // What the last real update brought: the baseline has no changes by definition.
  const latest = builds.find((b) => !b.baseline);
  return {
    id: cur.manifest.catalogId, buildId: cur.manifest.buildId, builtAt: cur.manifest.builtAt, name: cur.manifest.name, loadedAt: iso(cur.loadedAt),
    stats: cur.stats, adapters: cur.manifest.adapters, warnings: cur.warnings.map((w) => ({ file: w.file, path: w.path, message: w.message })),
    resolver: resolverModule ? { sha256: resolverModule.sha256, adapters: [...resolverModule.adapters.keys()] } : null, server: { version: VERSION },
    builds: builds.map(buildJson), changes: latest ? (store.getCatalogBuild(latest.catalogId, latest.buildId)?.changes ?? null) : null,
    facets: ctx.browse.facets(),
  };
}

type ReloadDeps = Pick<AppContext, "catalog" | "notifier" | "store" | "eventLog">;

/**
 * Re-reads the catalog bundle (the admin route and SIGHUP). After a good load every TV's state version is bumped,
 * so the TVs re-read their home screens; after a refused one the previous catalog stays and nothing is bumped.
 * Either way the event log says what happened, with the counts of the build the catalog history recorded.
 */
export async function reloadCatalog({ catalog, notifier, store, eventLog }: ReloadDeps, actor: Actor): Promise<ReloadResult> {
  const r = await catalog.reload();
  if (r.ok) {
    const { manifest, loadedAt } = r.catalog;
    // The history records nothing for a build that was already loaded: its counts are then 0.
    const b = store.listCatalogBuilds(manifest.catalogId, 1)[0];
    const fresh = b && b.buildId === manifest.buildId && b.loadedAt === loadedAt ? b : null;
    const added = { items: fresh?.itemsAdded ?? 0, episodes: fresh?.episodesAdded ?? 0 };
    const removed = { items: fresh?.itemsRemoved ?? 0, episodes: fresh?.episodesRemoved ?? 0 };
    eventLog.append("catalog.reloaded", null, actor, { buildId: manifest.buildId, added, removed });
    notifier.bumpAll();
  } else {
    eventLog.append("catalog.reload_failed", null, actor, { issues: r.issues.length });
  }
  return r;
}

/**
 * The reload for a signal handler: it never rejects. A reload that throws (the store is already closed during
 * shutdown) is logged with the error's class name, never its message, instead of ending the process.
 */
export async function reloadOnSignal(deps: ReloadDeps & Pick<AppContext, "log">, signal: string): Promise<void> {
  try {
    await reloadCatalog(deps, SERVER);
  } catch (err) {
    deps.log.warn("catalog reload failed", { signal, error: errorName(err) });
  }
}

/**
 * A browser hit: the item's card with its episode counts (null for a channel), whether OK can play it, when the
 * catalog first carried it (null when always there) and its episodes new since the query's `since`.
 */
export function searchHitJson(catalog: CatalogService, { entry, newEpisodes }: BrowseHit) {
  const { item } = entry;
  const counts = isLiveItem(item) ? { episodeCount: null, playableCount: null } : { episodeCount: item.episodes.length, playableCount: item.episodes.filter((e) => e.playbackAllowed).length };
  return { ...itemCard(catalog, item), ...counts, playable: entry.playable, firstSeenAt: entry.firstSeenAt === 0 ? null : iso(entry.firstSeenAt), newEpisodes };
}

/** A source as the owner sees it: what kind it is and whether it is proxied. Upstream URLs, headers and adapter refs are deliberately not exposed. */
function adminSource(s: Source) {
  return {
    id: s.id, type: s.type, label: s.label ?? null, languages: s.languages,
    ...(s.type === "direct" ? { kind: s.media.kind, needsProxy: hasHeaders(s.media.headers) } : { adapter: s.adapter }),
  };
}

/** An item with every episode and source, or a channel with its approval and sources, as the admin page's item view shows it. */
export function catalogItemJson(catalog: CatalogService, item: CatalogItem) {
  if (isLiveItem(item)) return { ...itemDetails(catalog, item), playbackAllowed: item.playbackAllowed, sources: item.sources.map(adminSource) };
  return {
    ...itemDetails(catalog, item),
    autoAdvance: item.autoAdvance ?? true,
    episodes: item.episodes.map((e, index) => ({ ...episodeDetails(e, index), autoAdvance: e.autoAdvance ?? null, sources: e.sources.map(adminSource) })),
  };
}
