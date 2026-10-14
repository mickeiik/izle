package io.github.mickeiik.izle.domain

import io.github.mickeiik.izle.data.api.EpisodeDetails
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EpisodeStepsTest {
    private fun ep(n: Int, allowed: Boolean = true) = EpisodeDetails(id = "show.e$n", index = n - 1, number = n, playbackAllowed = allowed)

    private val episodes = listOf(ep(1), ep(2, allowed = false), ep(3), ep(4), ep(5, allowed = false))

    @Test
    fun nextAndPreviousSkipEpisodesThatMayNotBePlayed() {
        assertEquals("show.e3", EpisodeSteps.neighbour(episodes, "show.e1", 1)?.id)
        assertEquals("show.e1", EpisodeSteps.neighbour(episodes, "show.e3", -1)?.id)
        assertEquals("show.e4", EpisodeSteps.neighbour(episodes, "show.e3", 1)?.id)
        assertEquals("show.e3", EpisodeSteps.neighbour(episodes, "show.e4", -1)?.id)
    }

    @Test
    fun theEndsDoNotWrapAround() {
        assertNull(EpisodeSteps.neighbour(episodes, "show.e1", -1))
        // e5 is not allowed: e4 is the last playable episode.
        assertNull(EpisodeSteps.neighbour(episodes, "show.e4", 1))
    }

    @Test
    fun aNotAllowedCurrentEpisodeStillHasNeighbours() {
        // The owner may disallow the episode while it plays; its neighbours are still reachable.
        assertEquals("show.e3", EpisodeSteps.neighbour(episodes, "show.e2", 1)?.id)
        assertEquals("show.e1", EpisodeSteps.neighbour(episodes, "show.e2", -1)?.id)
    }

    @Test
    fun anUnknownEpisodeOrNoDirectionHasNone() {
        assertNull(EpisodeSteps.neighbour(episodes, "other.e1", 1))
        assertNull(EpisodeSteps.neighbour(emptyList(), "show.e1", 1))
        assertNull(EpisodeSteps.neighbour(episodes, "show.e1", 0))
    }

    @Test
    fun aMovieOrTheFirstAndLastEpisodesNeedNoList() {
        assertFalse(EpisodeSteps.mayHaveNeighbour(index = 0, count = 1, direction = 1))
        assertFalse(EpisodeSteps.mayHaveNeighbour(index = 0, count = 1, direction = -1))
        assertFalse(EpisodeSteps.mayHaveNeighbour(index = 0, count = 3, direction = -1))
        assertFalse(EpisodeSteps.mayHaveNeighbour(index = 2, count = 3, direction = 1))
        assertTrue(EpisodeSteps.mayHaveNeighbour(index = 0, count = 3, direction = 1))
        assertTrue(EpisodeSteps.mayHaveNeighbour(index = 2, count = 3, direction = -1))
    }
}
