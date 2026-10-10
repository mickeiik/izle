package io.github.mickeiik.izle.domain

import io.github.mickeiik.izle.data.api.ContinueInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class EpisodeNamesTest {
    @Test
    fun moviesHaveNoEpisodeName() {
        assertEquals(EpisodeName.None, EpisodeNames.name("movie", null, null, null, 0))
    }

    @Test
    fun seriesUseLabelThenNumberThenPosition() {
        assertEquals(EpisodeName.Label("Christmas special"), EpisodeNames.name("series", 1, 9, " Christmas special ", 8))
        assertEquals(EpisodeName.Numbered(null, 5), EpisodeNames.name("series", 1, 5, null, 4))
        assertEquals(EpisodeName.Numbered(null, 3), EpisodeNames.name("series", null, null, "", 2))
        assertEquals(EpisodeName.Numbered(2, 5), EpisodeNames.name("series", 2, 5, null, 14))
    }

    @Test
    fun movieBadges() {
        assertEquals(TileBadge.New, EpisodeNames.badge("movie", cont(status = "new")))
        assertEquals(TileBadge.Continue, EpisodeNames.badge("movie", cont(status = "watching", positionMs = 600_000, durationMs = 5_400_000)))
        assertEquals(TileBadge.WatchAgain, EpisodeNames.badge("movie", cont(status = "finished")))
        // Watched only a few seconds: OK starts from the beginning, so the tile does not say Continue.
        assertEquals(TileBadge.New, EpisodeNames.badge("movie", cont(status = "watching", positionMs = 5_000, durationMs = 5_400_000)))
    }

    @Test
    fun seriesBadgesNameTheEpisode() {
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
        ContinueInfo(episodeId = "e", number = number, index = index, count = 3, positionMs = positionMs, durationMs = durationMs, status = status)
}
