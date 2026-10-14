package io.github.mickeiik.izle.domain

import io.github.mickeiik.izle.data.api.EpisodeDetails

/** CH+/CH− (and the remote's |◀◀ ▶▶| keys, and the owner's next/previous commands) while an episode is playing. */
object EpisodeSteps {
    /**
     * The nearest episode after ([direction] > 0) or before ([direction] < 0) [currentEpisodeId] in play order (the
     * item's episode array) that may be played; null at either end (there is no wrap-around) or when the current
     * episode is not in the list.
     */
    fun neighbour(episodes: List<EpisodeDetails>, currentEpisodeId: String, direction: Int): EpisodeDetails? {
        val at = episodes.indexOfFirst { it.id == currentEpisodeId }
        if (at < 0 || direction == 0) return null
        val candidates = if (direction > 0) (at + 1 until episodes.size) else (at - 1 downTo 0)
        return candidates.asSequence().map { episodes[it] }.firstOrNull { it.playbackAllowed }
    }

    /**
     * Whether there can be an episode in that direction at all, from the playing episode's place in the play order
     * ([index] of [count]): the first and last episodes, and movies, need no episode list to know there is none.
     */
    fun mayHaveNeighbour(index: Int, count: Int, direction: Int): Boolean = when {
        direction > 0 -> index < count - 1
        direction < 0 -> index > 0
        else -> false
    }
}
