package io.github.mickeiik.izle.domain

import io.github.mickeiik.izle.data.api.ContinueInfo
import io.github.mickeiik.izle.data.api.EpisodeDetails
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EpisodeNamesTest {
    @Test
    fun moviesHaveNoEpisodeNameAndSeriesUseLabelThenNumberThenPosition() {
        assertEquals(EpisodeName.None, EpisodeNames.name("movie", null, null, null, 0))
        assertEquals(EpisodeName.Label("Christmas special"), EpisodeNames.name("series", 1, 9, " Christmas special ", 8))
        assertEquals(EpisodeName.Numbered(null, 5), EpisodeNames.name("series", 1, 5, null, 4))
        assertEquals(EpisodeName.Numbered(null, 3), EpisodeNames.name("series", null, null, "", 2))
        assertEquals(EpisodeName.Numbered(2, 5), EpisodeNames.name("series", 2, 5, null, 14))
    }

    @Test
    fun badgesSayWhatOkDoes() {
        assertEquals(TileBadge.New, EpisodeNames.badge("movie", cont(status = "new")))
        assertEquals(TileBadge.Continue, EpisodeNames.badge("movie", cont(status = "watching", positionMs = 600_000, durationMs = 5_400_000)))
        assertEquals(TileBadge.WatchAgain, EpisodeNames.badge("movie", cont(status = "finished")))
        // Watched only a few seconds: OK starts from the beginning, so the tile does not say Continue.
        assertEquals(TileBadge.New, EpisodeNames.badge("movie", cont(status = "watching", positionMs = 5_000, durationMs = 5_400_000)))
        assertEquals(
            TileBadge.Episode(EpisodeName.Numbered(null, 1), resume = true),
            EpisodeNames.badge("series", cont(status = "watching", number = 1, positionMs = 40_000, durationMs = 90_000)),
        )
        assertEquals(
            TileBadge.Episode(EpisodeName.Numbered(null, 2), resume = false),
            EpisodeNames.badge("series", cont(status = "new", number = 2, index = 1)),
        )
    }

    @Test
    fun progressOnlyWhenResuming() {
        assertEquals(0.5f, EpisodeNames.progressFraction(cont(status = "watching", positionMs = 45_000, durationMs = 90_000)) ?: -1f, 0.001f)
        assertNull(EpisodeNames.progressFraction(cont(status = "watching", positionMs = 10_000, durationMs = 90_000)))
        assertNull(EpisodeNames.progressFraction(cont(status = "finished", positionMs = 0, durationMs = 90_000)))
        assertNull(EpisodeNames.progressFraction(cont(status = "watching", positionMs = 45_000, durationMs = null)))
    }

    private fun cont(status: String, number: Int? = null, index: Int = 0, positionMs: Long = 0, durationMs: Long? = null) =
        ContinueInfo(episodeId = "e", number = number, index = index, positionMs = positionMs, durationMs = durationMs, status = status)
}

class EpisodeStepsTest {
    private fun ep(n: Int, allowed: Boolean = true) = EpisodeDetails(id = "show.e$n", index = n - 1, number = n, playbackAllowed = allowed)

    private val episodes = listOf(ep(1), ep(2, allowed = false), ep(3), ep(4), ep(5, allowed = false))

    @Test
    fun nextAndPreviousSkipEpisodesThatMayNotBePlayedAndDoNotWrapAround() {
        assertEquals("show.e3", EpisodeSteps.neighbour(episodes, "show.e1", 1)?.id)
        assertEquals("show.e1", EpisodeSteps.neighbour(episodes, "show.e3", -1)?.id)
        assertEquals("show.e4", EpisodeSteps.neighbour(episodes, "show.e3", 1)?.id)
        assertEquals("show.e3", EpisodeSteps.neighbour(episodes, "show.e4", -1)?.id)
        assertNull(EpisodeSteps.neighbour(episodes, "show.e1", -1))
        assertNull("e5 may not be played: e4 is the last", EpisodeSteps.neighbour(episodes, "show.e4", 1))
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
