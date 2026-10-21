package io.github.mickeiik.izle.domain

import io.github.mickeiik.izle.data.api.ContinueInfo
import io.github.mickeiik.izle.data.api.EpisodeDetails
import io.github.mickeiik.izle.data.api.HomeEntry
import io.github.mickeiik.izle.data.api.ItemCard

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

    /** A channel: red, short like "New", so it stays on the smallest cards. */
    data object Live : TileBadge
}

object EpisodeNames {
    fun name(kind: String, season: Int?, number: Int?, label: String?, index: Int): EpisodeName {
        if (kind != "series") return EpisodeName.None
        if (!label.isNullOrBlank()) return EpisodeName.Label(label.trim())
        return EpisodeName.Numbered(season?.takeIf { it > 1 }, number ?: (index + 1))
    }

    /**
     * Channels say Live; movies New / Continue / Watch again; series name the episode OK plays, prefixed by Continue.
     * [next] is the tile's `continue` (null for a channel; a show without one says New).
     */
    fun badge(kind: String, next: ContinueInfo?): TileBadge {
        if (kind == ItemCard.KIND_LIVE) return TileBadge.Live
        if (next == null) return TileBadge.New
        val resume = next.status == "watching" && PlaybackPlan.resumePositionMs(next.positionMs, next.durationMs) > 0
        return when {
            kind == "series" -> TileBadge.Episode(name(kind, next.season, next.number, next.label, next.index), resume)
            resume -> TileBadge.Continue
            next.status == "finished" -> TileBadge.WatchAgain
            else -> TileBadge.New
        }
    }

    /** Fraction watched for the progress bar under a tile, or null when there is nothing to resume (a channel never). */
    fun progressFraction(next: ContinueInfo?): Float? {
        if (next == null) return null
        val duration = next.durationMs ?: return null
        if (next.status != "watching" || duration <= 0) return null
        if (PlaybackPlan.resumePositionMs(next.positionMs, duration) <= 0) return null
        return (next.positionMs.toFloat() / duration).coerceIn(0f, 1f)
    }

    /** The "2 new" count at a card's top right: the server's `newEpisodes`, never on a channel (0: no chip). */
    fun newEpisodes(entry: HomeEntry): Int = if (entry.item.isLive) 0 else entry.newEpisodes.coerceAtLeast(0)
}

/** CH+/CH− (and the remote's |◀◀ ▶▶| keys, and the owner's next/previous commands) while an episode is playing. */
object EpisodeSteps {
    /**
     * The nearest episode after ([direction] > 0) or before ([direction] < 0) [currentEpisodeId] in play order that
     * may be played; null at either end (no wrap-around) or when the current episode is not in the list.
     */
    fun neighbour(episodes: List<EpisodeDetails>, currentEpisodeId: String, direction: Int): EpisodeDetails? {
        val at = episodes.indexOfFirst { it.id == currentEpisodeId }
        if (at < 0 || direction == 0) return null
        val candidates = if (direction > 0) (at + 1 until episodes.size) else (at - 1 downTo 0)
        return candidates.asSequence().map { episodes[it] }.firstOrNull { it.playbackAllowed }
    }

    /** Whether the playing episode ([index] of [count]) can have one in that direction: movies and the ends cannot. */
    fun mayHaveNeighbour(index: Int, count: Int, direction: Int): Boolean = when {
        direction > 0 -> index < count - 1
        direction < 0 -> index > 0
        else -> false
    }
}
