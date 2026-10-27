package io.github.mickeiik.izle.companion.device

import android.content.res.Resources
import io.github.mickeiik.izle.companion.R
import io.github.mickeiik.izle.companion.tv.clockTime
import io.github.mickeiik.izle.companion.tv.dayText
import io.github.mickeiik.izle.companion.tv.episodeName
import io.github.mickeiik.izle.companion.tv.shortTimeAgo
import io.github.mickeiik.izle.data.api.Problem
import io.github.mickeiik.izle.domain.IsoTime
import java.util.TimeZone

// A TV's problems in words (docs/ux/companion-tv.md, "A problem's sheet"): the title by kind and code, where it
// happened, when and by whom. Activity's `problem.recorded` says it with the same title.

/**
 * A problem in words by its [kind] and [code]: "The source refused (403)", "Player error: io bad http status", "The TV
 * lost the server"; a code without words shows as it is.
 */
fun problemTitle(res: Resources, kind: String, code: String): String {
    if (kind == KIND_NETWORK) return res.getString(R.string.problem_network)
    PROBLEM_WORDS[code]?.let { return res.getString(it) }
    UPSTREAM_REFUSED.matchEntire(code)?.let { return res.getString(R.string.problem_upstream_refused, it.groupValues[1]) }
    if (kind == KIND_PLAYBACK && code.startsWith(PLAYER_CODE)) {
        return res.getString(R.string.problem_player_error, code.removePrefix(PLAYER_CODE).lowercase().replace('_', ' '))
    }
    return code
}

/** [problemTitle] of [p]. */
fun problemTitle(res: Resources, p: Problem): String = problemTitle(res, p.kind, p.code)

/**
 * Where it happened: "Caminandes · S1 · E2 — Gran Dillama", a film's or channel's title alone, "caminandes (no longer
 * in the catalog)"; null without an item.
 */
fun problemPlace(res: Resources, p: Problem): String? {
    if (p.missing) return (p.itemId ?: p.episodeId)?.let { "$it (${res.getString(R.string.problem_missing)})" }
    val title = p.itemTitle ?: return null
    return listOfNotNull(title, problemEpisode(p)).joinToString(" · ")
}

/** A series' episode ("S1 · E2 — Gran Dillama"); null for a film, a channel or a missing one. */
fun problemEpisode(p: Problem): String? {
    if (p.missing || p.itemKind == "movie" || p.itemKind == "live") return null
    if (p.episodeId == null && p.episodeTitle == null && p.number == null) return null
    return episodeName(p.season, p.number, null, p.episodeTitle)
}

/** A problem's row: "Caminandes · S1 · E2 — Gran Dillama · 2 h ago" (the place or the time alone when that is all). */
fun problemRowLine(res: Resources, p: Problem, nowMs: Long = System.currentTimeMillis()): String? =
    listOfNotNull(problemPlace(res, p), p.at?.let(IsoTime::parseEpochMs)?.let { shortTimeAgo(res, it, nowMs) })
        .takeIf { it.isNotEmpty() }?.joinToString(" · ")

/** The sheet's caption: "Today 14:05 · reported by the TV" (or "… by the server"). */
fun problemCaption(res: Resources, p: Problem, nowMs: Long = System.currentTimeMillis(), zone: TimeZone = TimeZone.getDefault()): String {
    val at = p.at?.let(IsoTime::parseEpochMs)?.let { "${dayText(res, it, nowMs, zone)} ${clockTime(it, zone)}" }
    val by = res.getString(if (p.origin == Problem.ORIGIN_SERVER) R.string.problem_by_server else R.string.problem_by_tv)
    return listOfNotNull(at, by).joinToString(" · ")
}

/** The kind as its badge: Playback, Resolve, Proxy, Network, Other. */
fun problemKindText(res: Resources, kind: String): String = res.getString(
    when (kind) {
        KIND_PLAYBACK -> R.string.problem_kind_playback
        "resolve" -> R.string.problem_kind_resolve
        "proxy" -> R.string.problem_kind_proxy
        KIND_NETWORK -> R.string.problem_kind_network
        else -> R.string.problem_kind_other
    },
)

private const val KIND_PLAYBACK = "playback"
private const val KIND_NETWORK = "network"

/** A TV's player errors are its player's error names (`ERROR_CODE_IO_BAD_HTTP_STATUS`). */
private const val PLAYER_CODE = "ERROR_CODE_"

private val UPSTREAM_REFUSED = Regex("""upstream_(401|403|410)""")

private val PROBLEM_WORDS = mapOf(
    "no_playable_source" to R.string.problem_no_playable_source,
    "source_failed" to R.string.problem_source_failed,
    "upstream_error" to R.string.problem_upstream_error,
    "upstream_unreachable" to R.string.problem_upstream_unreachable,
    "not_a_playlist" to R.string.problem_unplayable,
    "playlist_too_large" to R.string.problem_unplayable,
    "not_media" to R.string.problem_unplayable,
    "egress_denied" to R.string.problem_egress_denied,
)
