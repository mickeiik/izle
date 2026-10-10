package io.github.mickeiik.izle.domain

import io.github.mickeiik.izle.data.api.ContinueInfo

/** How an episode is named on screen; the UI turns it into localized text. */
sealed interface EpisodeName {
    /** Movies have no episode name. */
    data object None : EpisodeName

    /** The catalog's own label ("Special", "Part 2"). */
    data class Label(val text: String) : EpisodeName

    /** "Episode 5", or "Season 2, Episode 5" beyond the first season. */
    data class Numbered(val season: Int?, val number: Int) : EpisodeName
}

/** The chip on a home tile. */
sealed interface TileBadge {
    data object New : TileBadge
    data object Continue : TileBadge
    data object WatchAgain : TileBadge
    data class Episode(val name: EpisodeName, val resume: Boolean) : TileBadge
}

object EpisodeNames {
    fun name(kind: String, season: Int?, number: Int?, label: String?, index: Int): EpisodeName {
        if (kind != "series") return EpisodeName.None
        if (!label.isNullOrBlank()) return EpisodeName.Label(label.trim())
        return EpisodeName.Numbered(season?.takeIf { it > 1 }, number ?: (index + 1))
    }

    /** Movies say New / Continue / Watch again; series name the episode OK plays, prefixed by Continue. */
    fun badge(kind: String, next: ContinueInfo): TileBadge {
        val resume = next.status == "watching" && PlaybackPlan.resumePositionMs(next.positionMs, next.durationMs) > 0
        if (kind != "series") {
            return when {
                resume -> TileBadge.Continue
                next.status == "finished" -> TileBadge.WatchAgain
                else -> TileBadge.New
            }
        }
        return TileBadge.Episode(name(kind, next.season, next.number, next.label, next.index), resume)
    }

    /** Fraction watched for the progress bar under a tile, or null when there is nothing to resume. */
    fun progressFraction(next: ContinueInfo): Float? {
        val duration = next.durationMs ?: return null
        if (next.status != "watching" || duration <= 0) return null
        if (PlaybackPlan.resumePositionMs(next.positionMs, duration) <= 0) return null
        return (next.positionMs.toFloat() / duration).coerceIn(0f, 1f)
    }
}
