package io.github.mickeiik.izle.domain

import io.github.mickeiik.izle.data.api.ProgressStatus
import io.github.mickeiik.izle.domain.PlaybackPlan.Recovery
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
        assertEquals(0L, PlaybackPlan.reportAgeMs(sampledAtMs = 6_000, nowMs = 5_000)) // clocks never run backwards, but never negative
        assertEquals(PlaybackPlan.MAX_REPORT_AGE_MS, PlaybackPlan.reportAgeMs(sampledAtMs = 0, nowMs = 70_000))
    }

    @Test
    fun liveStatusFollowsWhatTheViewerWants() {
        assertEquals(ProgressStatus.Playing, PlaybackPlan.liveStatus(playWhenReady = true))
        assertEquals(ProgressStatus.Paused, PlaybackPlan.liveStatus(playWhenReady = false))
    }

    @Test
    fun endThresholdIsTwoMinutesOrFivePercentCappedAtTenPercent() {
        assertEquals(360_000L, PlaybackPlan.endThresholdMs(twoHours)) // 5 % > 2 min
        assertEquals(120_000L, PlaybackPlan.endThresholdMs(twentyFiveMinutes)) // 2 min > 5 %, < 10 %
        assertEquals(9_000L, PlaybackPlan.endThresholdMs(ninetySeconds)) // capped at 10 % for short episodes
        assertEquals(0L, PlaybackPlan.endThresholdMs(0))
    }

    @Test
    fun finishedWithinTheEndThreshold() {
        assertTrue(PlaybackPlan.isFinished(twoHours - 300_000, twoHours))
        assertFalse(PlaybackPlan.isFinished(twoHours - 400_000, twoHours))
        assertTrue(PlaybackPlan.isFinished(85_000, ninetySeconds))
        assertFalse(PlaybackPlan.isFinished(40_000, ninetySeconds))
        assertFalse(PlaybackPlan.isFinished(10_000_000, null))
    }

    @Test
    fun resumesFromFiveSecondsBeforeTheSavedPosition() {
        assertEquals(595_000L, PlaybackPlan.resumePositionMs(600_000, twentyFiveMinutes))
        assertEquals(595_000L, PlaybackPlan.resumePositionMs(600_000, null))
        assertEquals(35_000L, PlaybackPlan.resumePositionMs(40_000, ninetySeconds))
    }

    @Test
    fun startsOverWhenBarelyStartedOrAlmostDone() {
        assertEquals(0L, PlaybackPlan.resumePositionMs(null, twentyFiveMinutes))
        assertEquals(0L, PlaybackPlan.resumePositionMs(29_999, twentyFiveMinutes))
        assertEquals(25_000L, PlaybackPlan.resumePositionMs(30_000, twentyFiveMinutes))
        assertEquals(0L, PlaybackPlan.resumePositionMs(twentyFiveMinutes - 60_000, twentyFiveMinutes))
    }

    @Test
    fun stopStatusReportsFinishedNearTheEnd() {
        assertEquals(ProgressStatus.Finished, PlaybackPlan.stopStatus(twoHours - 60_000, twoHours))
        assertEquals(ProgressStatus.Stopped, PlaybackPlan.stopStatus(60_000, twoHours))
        assertEquals(ProgressStatus.Stopped, PlaybackPlan.stopStatus(60_000, null))
    }

    @Test
    fun expiredUrlIsRetriedOnceOnTheSameSource() {
        val long = PlaybackPlan.EXPIRED_URL_MIN_PLAYED_MS + 1
        assertEquals(Recovery.RetrySameSource, PlaybackPlan.recovery(403, long, retriedSameSource = false, alternativesLeft = false))
        assertEquals(Recovery.RetrySameSource, PlaybackPlan.recovery(410, long, retriedSameSource = false, alternativesLeft = true))
        assertEquals(Recovery.GiveUp, PlaybackPlan.recovery(403, long, retriedSameSource = true, alternativesLeft = false))
        assertEquals(Recovery.NextSource, PlaybackPlan.recovery(403, long, retriedSameSource = true, alternativesLeft = true))
    }

    @Test
    fun earlyErrorsFallBackToTheNextSource() {
        assertEquals(Recovery.NextSource, PlaybackPlan.recovery(403, 10_000, retriedSameSource = false, alternativesLeft = true))
        assertEquals(Recovery.NextSource, PlaybackPlan.recovery(null, 10 * 60_000, retriedSameSource = false, alternativesLeft = true))
        assertEquals(Recovery.GiveUp, PlaybackPlan.recovery(500, 10_000, retriedSameSource = false, alternativesLeft = false))
    }
}

class SeekAccumulatorTest {
    @Test
    fun aPressMovesTenSecondsAndSeeksOnRelease() {
        val seek = SeekAccumulator()
        assertEquals(70_000L, seek.onKeyDown(1, eventTimeMs = 1_000, downTimeMs = 1_000, repeatCount = 0, positionMs = 60_000, durationMs = 600_000))
        assertEquals(70_000L, seek.pendingTargetMs)
        assertEquals(70_000L, seek.commit())
        assertNull(seek.commit())
    }

    @Test
    fun pressesAccumulateUntilRelease() {
        val seek = SeekAccumulator()
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
