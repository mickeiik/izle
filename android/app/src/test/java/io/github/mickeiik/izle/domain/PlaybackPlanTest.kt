package io.github.mickeiik.izle.domain

import io.github.mickeiik.izle.data.api.CatalogInfo
import io.github.mickeiik.izle.data.api.ContinueInfo
import io.github.mickeiik.izle.data.api.DeviceInfo
import io.github.mickeiik.izle.data.api.HomeEntry
import io.github.mickeiik.izle.data.api.ItemCard
import io.github.mickeiik.izle.data.api.ProgressStatus
import io.github.mickeiik.izle.data.api.TvState
import io.github.mickeiik.izle.domain.PlaybackPlan.Recovery
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PlaybackPlanTest {
    private val twoHours = 7_200_000L
    private val twentyFiveMinutes = 1_500_000L
    private val ninetySeconds = 90_000L

    @Test
    fun reportAgeIsClampedToWhatTheServerAccepts() {
        assertEquals(0L, PlaybackPlan.reportAgeMs(sampledAtMs = 5_000, nowMs = 5_000))
        assertEquals(700L, PlaybackPlan.reportAgeMs(sampledAtMs = 5_000, nowMs = 5_700))
        assertEquals(0L, PlaybackPlan.reportAgeMs(sampledAtMs = 6_000, nowMs = 5_000)) // never negative
        assertEquals(PlaybackPlan.MAX_REPORT_AGE_MS, PlaybackPlan.reportAgeMs(sampledAtMs = 0, nowMs = 70_000))
    }

    @Test
    fun statusesFollowWhatTheViewerWantsAndFinishNearTheEnd() {
        assertEquals(ProgressStatus.Playing, PlaybackPlan.liveStatus(playWhenReady = true))
        assertEquals(ProgressStatus.Paused, PlaybackPlan.liveStatus(playWhenReady = false))
        assertEquals("a channel is never paused", ProgressStatus.Playing, PlaybackPlan.liveStatus(playWhenReady = false, channel = true))
        assertEquals(ProgressStatus.Finished, PlaybackPlan.stopStatus(twoHours - 60_000, twoHours))
        assertEquals(ProgressStatus.Stopped, PlaybackPlan.stopStatus(60_000, twoHours))
        assertEquals(ProgressStatus.Stopped, PlaybackPlan.stopStatus(60_000, null))
    }

    @Test
    fun finishedWithinTwoMinutesOrFivePercentCappedAtTenPercent() {
        assertEquals(360_000L, PlaybackPlan.endThresholdMs(twoHours)) // 5 % > 2 min
        assertEquals(120_000L, PlaybackPlan.endThresholdMs(twentyFiveMinutes)) // 2 min > 5 %, < 10 %
        assertEquals(9_000L, PlaybackPlan.endThresholdMs(ninetySeconds)) // capped at 10 % for short episodes
        assertEquals(0L, PlaybackPlan.endThresholdMs(0))
        assertTrue(PlaybackPlan.isFinished(twoHours - 300_000, twoHours))
        assertFalse(PlaybackPlan.isFinished(twoHours - 400_000, twoHours))
        assertTrue(PlaybackPlan.isFinished(85_000, ninetySeconds))
        assertFalse(PlaybackPlan.isFinished(40_000, ninetySeconds))
        assertFalse(PlaybackPlan.isFinished(10_000_000, null))
    }

    @Test
    fun resumesFiveSecondsBeforeTheSavedPositionUnlessBarelyStartedOrAlmostDone() {
        assertEquals(595_000L, PlaybackPlan.resumePositionMs(600_000, twentyFiveMinutes))
        assertEquals(595_000L, PlaybackPlan.resumePositionMs(600_000, null))
        assertEquals(35_000L, PlaybackPlan.resumePositionMs(40_000, ninetySeconds))
        assertEquals(0L, PlaybackPlan.resumePositionMs(null, twentyFiveMinutes))
        assertEquals(0L, PlaybackPlan.resumePositionMs(29_999, twentyFiveMinutes))
        assertEquals(25_000L, PlaybackPlan.resumePositionMs(30_000, twentyFiveMinutes))
        assertEquals(0L, PlaybackPlan.resumePositionMs(twentyFiveMinutes - 60_000, twentyFiveMinutes))
    }

    @Test
    fun anExpiredUrlIsRetriedOnceOnTheSameSourceAndEarlyErrorsFallBack() {
        val long = PlaybackPlan.EXPIRED_URL_MIN_PLAYED_MS + 1
        assertEquals(Recovery.RetrySameSource, PlaybackPlan.recovery(403, long, retriedSameSource = false, alternativesLeft = false))
        assertEquals(Recovery.RetrySameSource, PlaybackPlan.recovery(410, long, retriedSameSource = false, alternativesLeft = true))
        assertEquals(Recovery.GiveUp, PlaybackPlan.recovery(403, long, retriedSameSource = true, alternativesLeft = false))
        assertEquals(Recovery.NextSource, PlaybackPlan.recovery(403, long, retriedSameSource = true, alternativesLeft = true))
        assertEquals(Recovery.NextSource, PlaybackPlan.recovery(403, 10_000, retriedSameSource = false, alternativesLeft = true))
        assertEquals(Recovery.NextSource, PlaybackPlan.recovery(null, 10 * 60_000, retriedSameSource = false, alternativesLeft = true))
        assertEquals(Recovery.GiveUp, PlaybackPlan.recovery(500, 10_000, retriedSameSource = false, alternativesLeft = false))
    }

    @Test
    fun aChannelIsResolvedAgainOnceWhateverTheErrorThenFallsBackUnlessItPlayedAWhile() {
        val stable = PlaybackPlan.LIVE_STABLE_PLAYED_MS
        assertEquals(Recovery.RetrySameSource, PlaybackPlan.liveRecovery(0, retriedSameSource = false, alternativesLeft = false))
        assertEquals(Recovery.RetrySameSource, PlaybackPlan.liveRecovery(0, retriedSameSource = false, alternativesLeft = true))
        assertEquals(Recovery.NextSource, PlaybackPlan.liveRecovery(5_000, retriedSameSource = true, alternativesLeft = true))
        assertEquals(Recovery.GiveUp, PlaybackPlan.liveRecovery(stable - 1, retriedSameSource = true, alternativesLeft = false))
        assertEquals("it was working", Recovery.RetrySameSource, PlaybackPlan.liveRecovery(stable, retriedSameSource = true, alternativesLeft = false))
    }
}

class AutoplayPlanTest {
    private fun state(autoplay: Boolean, vararg ids: String) = TvState(
        1, DeviceInfo("abcdefabcdef", "TV", autoplayOnStart = autoplay), CatalogInfo("c", "b", "n"),
        ids.map { HomeEntry(ItemCard(it, "series", it), ContinueInfo(episodeId = "$it.e1")) },
    )

    @Test
    fun offersTheShowPlayedLastWhenItIsStillOnHomeElseTheFirstTile() {
        val home = state(autoplay = true, "caminandes", "sintel", "tears")
        assertEquals("sintel", AutoplayPlan.offer(home, "sintel")?.item?.id)
        assertEquals("tears", AutoplayPlan.offer(home, "tears")?.item?.id)
        assertEquals("caminandes", AutoplayPlan.offer(home, null)?.item?.id)
        assertEquals("caminandes", AutoplayPlan.offer(home, "removed-by-the-owner")?.item?.id)
    }

    @Test
    fun onlyWhenTheOwnerTurnedItOnAndHomeIsNotEmpty() {
        assertNull(AutoplayPlan.offer(state(autoplay = false, "sintel"), "sintel"))
        assertNull(AutoplayPlan.offer(state(autoplay = true), "sintel"))
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class CountdownTest {
    @Test
    fun ticksOnceASecondEndsASecondAfterTheLastAndATickCanEndItEarly() = runTest {
        val ticks = mutableListOf<Pair<Long, Int>>()
        var endedAt = -1L
        launch {
            countDown(3) { ticks += testScheduler.currentTime to it }
            endedAt = testScheduler.currentTime
        }
        advanceUntilIdle()
        assertEquals(listOf(0L to 3, 1_000L to 2, 2_000L to 1), ticks)
        assertEquals(3_000L, endedAt)

        ticks.clear()
        var announced = false
        launch {
            countDown(10) {
                if (it == 7) return@launch
                ticks += testScheduler.currentTime to it
            }
            announced = true
        }
        advanceUntilIdle()
        assertEquals(listOf(3_000L to 10, 4_000L to 9, 5_000L to 8), ticks)
        assertFalse(announced)
        assertEquals("ended at the tick, without waiting", 6_000L, testScheduler.currentTime)
    }

    @Test
    fun cancellingStopsTheTicks() = runTest {
        val ticks = mutableListOf<Int>()
        var announced = false
        val job = launch {
            countDown(30) { ticks += it }
            announced = true
        }
        runCurrent()
        advanceTimeBy(1_500)
        job.cancel()
        advanceUntilIdle()
        assertEquals(listOf(30, 29), ticks)
        assertFalse(announced)
    }
}

class SeekAccumulatorTest {
    @Test
    fun pressesMoveTenSecondsFromThePendingTargetAndSeekOnRelease() {
        val seek = SeekAccumulator()
        assertEquals(70_000L, seek.onKeyDown(1, eventTimeMs = 1_000, downTimeMs = 1_000, repeatCount = 0, positionMs = 60_000, durationMs = 600_000))
        assertEquals(70_000L, seek.pendingTargetMs)
        assertEquals(70_000L, seek.commit())
        assertNull(seek.commit())
        assertEquals(50_000L, seek.onKeyDown(-1, 0, 0, 0, 60_000, 600_000))
        // Another press before the release continues from the pending target, not from the player position.
        assertEquals(40_000L, seek.onKeyDown(-1, 500, 500, 0, 60_000, 600_000))
        assertEquals(40_000L, seek.commit())
    }

    @Test
    fun clampsToTheMedia() {
        val seek = SeekAccumulator()
        assertEquals(0L, seek.onKeyDown(-1, 0, 0, 0, 4_000, 600_000))
        seek.cancel()
        assertEquals(599_000L, seek.onKeyDown(1, 0, 0, 0, 595_000, 600_000))
        seek.cancel()
        assertEquals(10_010_000L, seek.onKeyDown(1, 0, 0, 0, 10_000_000, null))
    }

    @Test
    fun holdingAccelerates() {
        val seek = SeekAccumulator()
        val duration = 10_000_000L
        seek.onKeyDown(1, 0, 0, 0, 0, duration) // 10 s
        assertNull("repeats closer than 250 ms are ignored", seek.onKeyDown(1, 100, 0, 1, 0, duration))
        assertEquals(20_000L, seek.onKeyDown(1, 300, 0, 2, 0, duration)) // +10 s
        assertEquals(50_000L, seek.onKeyDown(1, 2_100, 0, 30, 0, duration)) // held 2.1 s: +30 s
        assertEquals(110_000L, seek.onKeyDown(1, 4_200, 0, 60, 0, duration)) // held 4.2 s: +60 s
        assertEquals(110_000L, seek.commit())
    }
}

class SourceAttemptsTest {
    private val early = 10_000L
    private val late = PlaybackPlan.EXPIRED_URL_MIN_PLAYED_MS + 1

    @Test
    fun aFailingSourceIsExcludedAndTheNextOneTried() {
        val attempts = SourceAttempts()
        assertNull("the first resolve excludes nothing", attempts.excludeFor(null))
        assertNull(attempts.lastTried)
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
        assertFalse("the playing source is never its own alternative", attempts.alternativesLeft("signed"))
        assertTrue(attempts.alternativesLeft("other"))
        assertEquals(Recovery.RetrySameSource, attempts.afterPlaybackError("signed", httpStatus = 403, playedMs = late))
        attempts.onResolved("signed", emptyList())
        attempts.onPlaying()
        assertEquals(Recovery.RetrySameSource, attempts.afterPlaybackError("signed", httpStatus = 403, playedMs = late))
        attempts.onResolved("signed", emptyList())
        // Not played since the last re-resolve, no alternatives: nothing left.
        assertEquals(Recovery.GiveUp, attempts.afterPlaybackError("signed", httpStatus = 403, playedMs = late))
        assertEquals(1, attempts.triedCount)

        attempts.reset() // a new episode starts afresh
        assertNull(attempts.excludeFor(null))
        assertFalse(attempts.retriedSameSource)
        assertFalse(attempts.alternativesLeft("other"))
        assertEquals(0, attempts.triedCount)
    }

    @Test
    fun aChannelsStreamIsRestartedOnTheSameSourceThenTheLadder() {
        val attempts = SourceAttempts()
        attempts.reset(live = true)
        attempts.onResolved(null, listOf("main", "backup"))
        // It ended (or fell behind the live window, or failed): the same source again, pinned, at the live edge.
        assertEquals(Recovery.RetrySameSource, attempts.afterPlaybackError("main", httpStatus = null, playedMs = 0))
        assertNull(attempts.excludeFor("main"))
        attempts.onResolved("main", emptyList())
        // Its first frame proves little: failing again soon after moves on to the next source.
        attempts.onPlaying()
        assertEquals(Recovery.NextSource, attempts.afterPlaybackError("main", httpStatus = 404, playedMs = 3_000))
        assertEquals(listOf("main"), attempts.excludeFor(null))
        attempts.onResolved(null, listOf("backup"))
        attempts.onPlaying()
        // The backup plays for hours, then its stream ends: the same source again, and again after it played a while.
        assertEquals(Recovery.RetrySameSource, attempts.afterPlaybackError("backup", httpStatus = null, playedMs = 3 * 3_600_000L))
        attempts.onResolved("backup", emptyList())
        attempts.onPlaying()
        assertEquals(Recovery.RetrySameSource, attempts.afterPlaybackError("backup", httpStatus = 410, playedMs = PlaybackPlan.LIVE_STABLE_PLAYED_MS))
        attempts.onResolved("backup", emptyList())
        assertEquals(Recovery.GiveUp, attempts.afterPlaybackError("backup", httpStatus = null, playedMs = 1_000))
        assertEquals(2, attempts.triedCount)

        // A show afterwards: its own rules (no re-resolve without an expired URL).
        attempts.reset()
        attempts.onResolved(null, listOf("x"))
        assertEquals(Recovery.GiveUp, attempts.afterPlaybackError("x", httpStatus = null, playedMs = 0))
    }
}
