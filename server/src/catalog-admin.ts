// The owner's view of the loaded catalog (admin API), never with upstream URLs, headers or adapter refs; and the
// reload that the admin route and SIGHUP share.

import { isLiveItem, type CatalogItem, type Source } from "@izle/contract";
import { SERVER, type Actor } from "./actor.ts";
import { liveRef, type CatalogService, type PlayableRef, type ReloadResult } from "./catalog.ts";
import type { BrowseHit } from "./catalog-browse.ts";
import type { AppContext } from "./context.ts";
import type { CheckSummary } from "./diagnostics.ts";
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

/** After a good load every TV re-reads its home screen; the event log has the counts the catalog history recorded. */
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

/** Never rejects: a reload that throws (the store closed during shutdown) is logged by the error's class name. */
export async function reloadOnSignal(deps: ReloadDeps & Pick<AppContext, "log">, signal: string): Promise<void> {
  try {
    await reloadCatalog(deps, SERVER);
  } catch (err) {
    deps.log.warn("catalog reload failed", { signal, error: errorName(err) });
  }
}

/** A browser hit: the item's card, its episode counts (null for a channel) and when the catalog first carried it. */
export function searchHitJson(catalog: CatalogService, { entry, newEpisodes }: BrowseHit) {
  const { item } = entry;
  const counts = isLiveItem(item) ? { episodeCount: null, playableCount: null } : { episodeCount: item.episodes.length, playableCount: item.episodes.filter((e) => e.playbackAllowed).length };
  return { ...itemCard(catalog, item), ...counts, playable: entry.playable, firstSeenAt: entry.firstSeenAt === 0 ? null : iso(entry.firstSeenAt), newEpisodes };
}

/** What kind a source is and whether it is proxied; upstream URLs, headers and adapter refs are deliberately left out. */
function adminSource(s: Source) {
  return {
    id: s.id, type: s.type, label: s.label ?? null, languages: s.languages,
    ...(s.type === "direct" ? { kind: s.media.kind, needsProxy: hasHeaders(s.media.headers) } : { adapter: s.adapter }),
  };
}

/** The item with its sources, and each episode's (or the channel's) stored check summary from `check`. */
export function catalogItemJson(catalog: CatalogService, item: CatalogItem, check: (ref: PlayableRef) => CheckSummary) {
  if (isLiveItem(item)) {
    return { ...itemDetails(catalog, item), playbackAllowed: item.playbackAllowed, sources: item.sources.map(adminSource), check: check(liveRef(item)) };
  }
  return {
    ...itemDetails(catalog, item),
    autoAdvance: item.autoAdvance ?? true,
    episodes: item.episodes.map((episode, index) => ({
      ...episodeDetails(episode, index), autoAdvance: episode.autoAdvance ?? null, sources: episode.sources.map(adminSource),
      check: check({ kind: "episode", item, episode, index }),
    })),
  };
}
