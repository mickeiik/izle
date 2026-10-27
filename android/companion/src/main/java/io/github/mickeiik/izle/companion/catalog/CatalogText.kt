package io.github.mickeiik.izle.companion.catalog

import android.content.res.Resources
import io.github.mickeiik.izle.companion.R
import io.github.mickeiik.izle.companion.tv.episodeName
import io.github.mickeiik.izle.data.api.AdminCatalog
import io.github.mickeiik.izle.data.api.CatalogBuild
import io.github.mickeiik.izle.data.api.CatalogChanges
import io.github.mickeiik.izle.data.api.CatalogHit
import io.github.mickeiik.izle.data.api.CatalogIssue
import io.github.mickeiik.izle.data.api.CatalogSearch
import io.github.mickeiik.izle.data.api.CatalogStats
import io.github.mickeiik.izle.data.api.ChangedEpisode
import io.github.mickeiik.izle.domain.IsoTime
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

// The Catalog tab's and What's new's words, as the admin page says them (server/admin/view-catalog.js, lib.js).

/** "Series · 2013 · 3 episodes" (with [withNew], "· 2 new" after it), "Film · 2012", "Channel". */
fun catalogLine(res: Resources, hit: CatalogHit, withNew: Boolean = false): String = when (hit.kind) {
    "live" -> res.getString(R.string.catalog_kind_channel)
    "series" -> listOfNotNull(
        res.getString(R.string.catalog_kind_series),
        hit.year?.toString(),
        (hit.episodeCount ?: 0).let { res.getQuantityString(R.plurals.catalog_episodes, it, it) },
        hit.newEpisodes?.takeIf { withNew && it > 0 }?.let { res.getQuantityString(R.plurals.catalog_new, it, it) },
    ).joinToString(" · ")
    else -> listOfNotNull(res.getString(R.string.catalog_kind_film), hit.year?.toString()).joinToString(" · ")
}

/** A kind's word for a show known only by its kind ("Series"), null when unknown. */
fun kindWord(res: Resources, kind: String?): String? = when (kind) {
    "live" -> res.getString(R.string.catalog_kind_channel)
    "series" -> res.getString(R.string.catalog_kind_series)
    "movie" -> res.getString(R.string.catalog_kind_film)
    else -> null
}

fun sortLabel(res: Resources, sort: String): String = res.getString(
    when (sort) {
        CatalogSearch.SORT_NEWEST -> R.string.catalog_sort_newest
        CatalogSearch.SORT_YEAR -> R.string.catalog_sort_year
        else -> R.string.catalog_sort_title
    },
)

/** "25 Oct" in [zone]; null when [iso] is not a date-time. */
fun shortDate(iso: String?, zone: TimeZone = TimeZone.getDefault()): String? = format(iso, "d MMM", zone)

/** "25 Oct 09:12" in [zone]. */
fun dateTime(iso: String?, zone: TimeZone = TimeZone.getDefault()): String? = format(iso, "d MMM HH:mm", zone)

private fun format(iso: String?, pattern: String, zone: TimeZone): String? {
    val ms = iso?.let(IsoTime::parseEpochMs) ?: return null
    return SimpleDateFormat(pattern, Locale.ENGLISH).apply { timeZone = zone }.format(Date(ms))
}

/** "3 shows, 12 episodes": what [build] added; "nothing added". */
fun addedText(res: Resources, build: CatalogBuild): String {
    val parts = listOfNotNull(
        build.added.items.takeIf { it > 0 }?.let { res.getQuantityString(R.plurals.catalog_shows, it, it) },
        build.added.episodes.takeIf { it > 0 }?.let { res.getQuantityString(R.plurals.catalog_episodes, it, it) },
    )
    return if (parts.isEmpty()) res.getString(R.string.whats_new_nothing_added) else parts.joinToString(", ")
}

/** The What's new row: "25 Oct · 3 shows, 12 episodes". */
fun whatsNewRowText(res: Resources, build: CatalogBuild, zone: TimeZone = TimeZone.getDefault()): String =
    listOfNotNull(shortDate(build.loadedAt, zone), addedText(res, build)).joinToString(" · ")

/** A build's chip: "25 Oct" (with the time when [sameDay] another build has the same date), the baseline "First loaded". */
fun buildChipText(res: Resources, build: CatalogBuild, sameDay: Boolean = false, zone: TimeZone = TimeZone.getDefault()): String = when {
    build.baseline -> res.getString(R.string.whats_new_first_loaded)
    sameDay -> dateTime(build.loadedAt, zone) ?: build.buildId
    else -> shortDate(build.loadedAt, zone) ?: build.buildId
}

/** The chips of [builds], newest first: dates, with the time for a day that has more than one. */
fun buildChips(res: Resources, builds: List<CatalogBuild>, zone: TimeZone = TimeZone.getDefault()): List<Pair<CatalogBuild, String>> {
    val days = builds.filter { !it.baseline }.groupingBy { shortDate(it.loadedAt, zone) }.eachCount()
    return builds.map { b -> b to buildChipText(res, b, sameDay = (days[shortDate(b.loadedAt, zone)] ?: 0) > 1, zone = zone) }
}

/** "Build 7f3a · loaded 25 Oct 09:12 · +3 shows, +12 episodes, −1 show". */
fun buildSummary(res: Resources, build: CatalogBuild, zone: TimeZone = TimeZone.getDefault()): String {
    fun counted(n: Int, sign: String, plural: Int) = n.takeIf { it > 0 }?.let { sign + res.getQuantityString(plural, it, it) }
    val changes = listOfNotNull(
        counted(build.added.items, "+", R.plurals.catalog_shows),
        counted(build.added.episodes, "+", R.plurals.catalog_episodes),
        counted(build.removed.items, "−", R.plurals.catalog_shows),
        counted(build.removed.episodes, "−", R.plurals.catalog_episodes),
    )
    val head = res.getString(R.string.whats_new_build, build.buildId, dateTime(build.loadedAt, zone) ?: build.loadedAt)
    return if (changes.isEmpty()) head else "$head · ${changes.joinToString(", ")}"
}

/** New episodes by show, in catalog order: the show's id and title, its episodes' names. */
data class EpisodeGroup(val itemId: String, val title: String, val episodes: List<String>)

/** [changes]' new episodes grouped by show, leaving out the new shows' own (they are listed as new shows). */
fun newEpisodeGroups(changes: CatalogChanges): List<EpisodeGroup> {
    val newShows = changes.items.added.mapTo(HashSet()) { it.id }
    return changes.episodes.added.filter { it.itemId !in newShows }.groupBy(ChangedEpisode::itemId).map { (itemId, episodes) ->
        EpisodeGroup(itemId, episodes.first().itemTitle ?: itemId, episodes.map { episodeName(it.season, it.number, it.label, null) })
    }
}

/** What left: the shows by title (their id when the title is not known), then "Caminandes · 2 episodes" for a show that lost some. */
fun goneLines(res: Resources, changes: CatalogChanges): List<String> {
    val goneShows = changes.items.removed.mapTo(HashSet()) { it.id }
    val shows = changes.items.removed.map { it.title ?: it.id }
    val episodes = changes.episodes.removed.filter { it.itemId !in goneShows }.groupBy(ChangedEpisode::itemId).map { (itemId, eps) ->
        "${eps.first().itemTitle ?: itemId} · ${res.getQuantityString(R.plurals.catalog_episodes, eps.size, eps.size)}"
    }
    return shows + episodes
}

/** "bundle.json /items/3/title: must be a string" (lib.js `issueLine`). */
fun issueLine(issue: CatalogIssue): String = "${issue.file}${if (issue.path.isNotEmpty()) " ${issue.path}" else ""}: ${issue.message}"

/** "142 shows (40 films, 100 series, 2 channels) · 1200 episodes, 1100 playable · 1300 sources" (lib.js `catalogContents`). */
fun contentsText(res: Resources, s: CatalogStats): String = res.getString(
    R.string.catalog_contents,
    res.getQuantityString(R.plurals.catalog_shows, s.items, s.items),
    res.getQuantityString(R.plurals.catalog_films, s.movies, s.movies),
    s.series,
    res.getQuantityString(R.plurals.catalog_channels, s.live, s.live),
    res.getQuantityString(R.plurals.catalog_episodes, s.episodes, s.episodes),
    s.playableEpisodes,
    res.getQuantityString(R.plurals.catalog_sources, s.sources, s.sources),
)

/** About the catalog: its facts as label and value, in order. */
fun aboutFacts(res: Resources, c: AdminCatalog, zone: TimeZone = TimeZone.getDefault()): List<Pair<String, String>> {
    val unknown = res.getString(R.string.catalog_unknown)
    val resolver = c.resolver
    return listOf(
        res.getString(R.string.catalog_about_name) to c.name.ifEmpty { unknown },
        res.getString(R.string.catalog_about_id) to c.id,
        res.getString(R.string.catalog_about_build) to c.buildId,
        res.getString(R.string.catalog_about_built) to (dateTime(c.builtAt, zone) ?: unknown),
        res.getString(R.string.catalog_about_loaded) to (dateTime(c.loadedAt, zone) ?: unknown),
        res.getString(R.string.catalog_about_contents) to contentsText(res, c.stats),
        res.getString(R.string.catalog_about_resolver) to when {
            resolver == null -> res.getString(R.string.catalog_resolver_none)
            resolver.adapters.isEmpty() -> res.getString(R.string.catalog_resolver_nothing)
            else -> res.getString(R.string.catalog_resolver_provides, resolver.adapters.joinToString(", "))
        },
        res.getString(R.string.catalog_about_server) to (c.server?.version?.let { res.getString(R.string.catalog_server_version, it) } ?: unknown),
    )
}
