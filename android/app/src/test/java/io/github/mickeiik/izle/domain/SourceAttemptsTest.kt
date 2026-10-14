package io.github.mickeiik.izle.domain

import io.github.mickeiik.izle.domain.PlaybackPlan.Recovery
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SourceAttemptsTest {
    private val early = 10_000L
    private val late = PlaybackPlan.EXPIRED_URL_MIN_PLAYED_MS + 1

    @Test
    fun theFirstResolveExcludesNothing() {
        val attempts = SourceAttempts()
        assertNull(attempts.excludeFor(null))
        assertEquals(0, attempts.triedCount)
        assertNull(attempts.lastTried)
    }

    @Test
    fun aFailingSourceIsExcludedAndTheNextOneTried() {
        val attempts = SourceAttempts()
        attempts.onResolved(null, listOf("hls", "mp4", "dash"))
        assertEquals(Recovery.NextSource, attempts.afterPlaybackError("hls", httpStatus = null, playedMs = early))
        assertEquals(listOf("hls"), attempts.excludeFor(null))
        attempts.onResolved(null, listOf("mp4", "dash"))
        assertEquals(Recovery.NextSource, attempts.afterPlaybackError("mp4", httpStatus = 404, playedMs = early))
        assertEquals(listOf("hls", "mp4"), attempts.excludeFor(null))
        attempts.onResolved(null, listOf("dash"))
        assertEquals(Recovery.GiveUp, attempts.afterPlaybackError("dash", httpStatus = 500, playedMs = early))
        assertEquals(3, attempts.triedCount)
        assertEquals("dash", attempts.lastTried)
    }

    @Test
    fun aPinnedResolveExcludesNothingAndKeepsTheFallbackOrder() {
        val attempts = SourceAttempts()
        attempts.onResolved(null, listOf("signed", "backup"))
        // An expired URL after a while: the same source is resolved again, pinned.
        assertEquals(Recovery.RetrySameSource, attempts.afterPlaybackError("signed", httpStatus = 403, playedMs = late))
        assertTrue(attempts.retriedSameSource)
        assertNull(attempts.excludeFor("signed"))
        attempts.onResolved("signed", emptyList()) // a pinned answer has no alternatives
        // It fails again before playing: the last unpinned resolve's order still offers the backup.
        assertTrue(attempts.alternativesLeft("signed"))
        assertEquals(Recovery.NextSource, attempts.afterPlaybackError("signed", httpStatus = 403, playedMs = late))
        assertFalse(attempts.retriedSameSource)
        assertEquals(listOf("signed"), attempts.excludeFor(null))
    }

    @Test
    fun aFailedPinnedResolveContinuesUnpinnedWhileAlternativesAreLeft() {
        val attempts = SourceAttempts()
        attempts.onResolved(null, listOf("signed", "backup"))
        attempts.afterPlaybackError("signed", httpStatus = 410, playedMs = late)
        assertTrue(attempts.continueAfterFailedResolve("signed"))
        assertEquals(listOf("signed"), attempts.excludeFor(null))

        // An unpinned resolve that fails has nothing left to fall back to.
        assertFalse(attempts.continueAfterFailedResolve(null))
        // Nor does a pinned one when the fallback order is used up.
        val alone = SourceAttempts()
        alone.onResolved(null, listOf("signed"))
        assertFalse(alone.continueAfterFailedResolve("signed"))
        assertEquals(0, alone.triedCount)
    }

    @Test
    fun anExpiredUrlIsReResolvedAgainOnlyAfterTheSourcePlayedAgain() {
        val attempts = SourceAttempts()
        attempts.onResolved(null, listOf("signed"))
        assertEquals(Recovery.RetrySameSource, attempts.afterPlaybackError("signed", httpStatus = 403, playedMs = late))
        attempts.onResolved("signed", emptyList())
        attempts.onPlaying()
        assertEquals(Recovery.RetrySameSource, attempts.afterPlaybackError("signed", httpStatus = 403, playedMs = late))
        attempts.onResolved("signed", emptyList())
        // Not played since the last re-resolve, no alternatives: nothing left.
        assertEquals(Recovery.GiveUp, attempts.afterPlaybackError("signed", httpStatus = 403, playedMs = late))
        assertEquals(1, attempts.triedCount)
    }

    @Test
    fun theSourceThatIsPlayingIsNeverItsOwnAlternative() {
        val attempts = SourceAttempts()
        attempts.onResolved(null, listOf("hls"))
        assertFalse(attempts.alternativesLeft("hls"))
        assertTrue(attempts.alternativesLeft("mp4"))
    }

    @Test
    fun aNewEpisodeStartsAfresh() {
        val attempts = SourceAttempts()
        attempts.onResolved(null, listOf("signed", "backup"))
        attempts.afterPlaybackError("signed", httpStatus = 403, playedMs = late)
        attempts.afterPlaybackError("signed", httpStatus = 403, playedMs = late)
        attempts.reset()
        assertNull(attempts.excludeFor(null))
        assertFalse(attempts.retriedSameSource)
        assertFalse(attempts.alternativesLeft("other"))
        assertEquals(0, attempts.triedCount)
    }
}
