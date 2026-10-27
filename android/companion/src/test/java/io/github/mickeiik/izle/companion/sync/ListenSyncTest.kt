package io.github.mickeiik.izle.companion.sync

import io.github.mickeiik.izle.companion.sync.ListenSync.Action
import io.github.mickeiik.izle.companion.sync.ListenSync.ClockSample
import io.github.mickeiik.izle.companion.sync.ListenSync.Decision
import io.github.mickeiik.izle.companion.sync.ListenSync.SyncState
import io.github.mickeiik.izle.data.api.Anchor
import io.github.mickeiik.izle.data.api.LinkTiming
import io.github.mickeiik.izle.data.api.NowPlaying
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

/** The cases of admin-ui.test.ts "listen along helpers", in the same order (candidate options are the screen's). */
class ListenSyncTest {
    private val anchor = Anchor(positionMs = 42_000, atMs = NOW, playing = true, rate = 1.0)

    private fun decide(errorMs: Double, nominalRate: Double = 1.0, tvPlaying: Boolean = true) =
        ListenSync.syncDecision(targetMs = 100_000.0, actualMs = 100_000.0 - errorMs, tvPlaying = tvPlaying, nominalRate = nominalRate)

    @Test
    fun tvPosition() {
        assertEquals(44_500.0, ListenSync.tvPositionAt(anchor, NOW + 2_500)!!, 0.0)
        assertEquals(42_000.0, ListenSync.tvPositionAt(anchor.copy(playing = false), NOW + 2_500)!!, 0.0)
        assertEquals("never before the anchor", 42_000.0, ListenSync.tvPositionAt(anchor, NOW - 100)!!, 0.0)
        assertNull(ListenSync.tvPositionAt(null, NOW))
    }

    @Test
    fun companionTarget() {
        assertEquals(600_000 * 1.0427 - 1_250 + 80, ListenSync.companionTarget(600_000.0, LinkTiming(rate = 1.0427, offsetMs = -1_250), 80), 0.0)
        assertEquals(0.0, ListenSync.companionTarget(0.0, LinkTiming(rate = 1.0, offsetMs = 0)), 0.0)
    }

    @Test
    fun syncDecisions() {
        assertEquals(Decision(Action.Seek, 1.0, SyncState.Seeking, 2_000.0, toMs = 100_000.0), decide(2_000.0))
        assertEquals(Action.Seek, decide(-2_000.0).action)
        assertEquals(Decision(Action.Play, 1.05, SyncState.CatchingUp, 500.0), decide(500.0))
        assertEquals(Decision(Action.Play, 1.02, SyncState.CatchingUp, 100.0), decide(100.0))
        assertEquals(Decision(Action.Play, 1.0, SyncState.Synced, 20.0), decide(20.0))
        assertEquals(Decision(Action.Play, 0.95, SyncState.HoldingBack, -500.0), decide(-500.0))
        assertEquals("clamped", 1.1, decide(500.0, 1.08).rate, 0.0)
        assertEquals("clamped", 0.9, decide(-500.0, 0.92).rate, 0.0)
        assertEquals("the nominal rate within tolerance", 1.0427, decide(20.0, 1.0427).rate, 0.0)
        assertEquals(Decision(Action.Pause, 1.0, SyncState.Paused, 500.0), decide(500.0, 1.0, false))
        assertEquals(SyncState.Waiting, ListenSync.syncDecision(targetMs = -3_000.0, actualMs = 0.0, tvPlaying = true, nominalRate = 1.0).state)
        assertEquals("catching up", SyncState.CatchingUp.label)
        assertEquals("holding back", SyncState.HoldingBack.label)
    }

    @Test
    fun clockOffset() {
        val quick = ClockSample(sentAt = 1_000, receivedAt = 1_040, serverNowMs = 6_020)
        val slow = ClockSample(sentAt = 2_000, receivedAt = 2_400, serverNowMs = 7_250)
        val longPoll = ClockSample(sentAt = 3_000, receivedAt = 23_000, serverNowMs = 99_000)
        assertEquals(6_020L - 1_020, ListenSync.clockOffset(listOf(slow, quick, longPoll)))
        assertNull(ListenSync.clockOffset(listOf(longPoll)))
        assertNull(ListenSync.clockOffset(emptyList()))
    }

    @Test
    fun formatting() {
        assertEquals("+600 ms", ListenSync.formatDrift(600.0))
        assertEquals("−12 ms", ListenSync.formatDrift(-12.4))
        assertEquals("+1.5 s", ListenSync.formatDrift(1_540.0))
        assertEquals("–", ListenSync.formatDrift(null))
        assertEquals("1:02:05.4", ListenSync.formatPosition(3_725_450.0))
        assertEquals("1:05.0", ListenSync.formatPosition(65_000.0))
        assertEquals("–", ListenSync.formatPosition(-1.0))
    }

    @Test
    fun isActive() {
        fun playing(state: String = "playing", updatedAt: String? = iso(NOW - 10_000)) =
            NowPlaying(itemId = "show", itemKind = "series", episodeId = "s1e1", state = state, updatedAt = updatedAt)
        assertTrue("recent playing", ListenSync.isActive(playing(), NOW))
        assertTrue("recent paused", ListenSync.isActive(playing(state = "paused"), NOW))
        assertFalse("stopped", ListenSync.isActive(playing(state = "stopped"), NOW))
        assertFalse("5 min old", ListenSync.isActive(playing(updatedAt = iso(NOW - 5 * 60_000)), NOW))
        assertFalse("null", ListenSync.isActive(null, NOW))
        assertFalse("unparsable updatedAt", ListenSync.isActive(playing(updatedAt = "yesterday"), NOW))
        assertFalse("no updatedAt", ListenSync.isActive(playing(updatedAt = null), NOW))
    }

    /** admin-ui.test.ts "listen along timing by ear", case for case. */
    @Test
    fun timingByEar() {
        assertEquals("+0:00.0", ListenTiming.formatOffset(0))
        assertEquals("+1:23.5", ListenTiming.formatOffset(83_500))
        assertEquals("−0:04.0", ListenTiming.formatOffset(-4_000))
        assertEquals("rounds first; zero has no minus", "+0:00.0", ListenTiming.formatOffset(-49))
        assertEquals("half away from zero", "−0:01.3", ListenTiming.formatOffset(-1_250))
        assertEquals("+60:00.0", ListenTiming.formatOffset(3_600_000))

        assertEquals(1_500L, ListenTiming.markOffset(100_000.0, 101_500.0, 1.0))
        assertEquals(Math.round(500_000 - 625_620.0), ListenTiming.markOffset(600_000.0, 500_000.0, 1.0427))
        assertEquals(4_000L, ListenTiming.markOffset(0.0, 4_000.0, 0.9591))
        assertEquals(-1_000L, ListenTiming.markOffset(1_000.0, 0.0, 1.0))

        assertEquals("same", ListenTiming.speedPreset(1.0))
        assertEquals("pal-film", ListenTiming.speedPreset(1.0427))
        assertEquals("film-pal", ListenTiming.speedPreset(0.9591))
        assertEquals("within 0.00005", "pal-film", ListenTiming.speedPreset(1.04274))
        assertEquals("other", ListenTiming.speedPreset(1.0428))
        assertEquals("other", ListenTiming.speedPreset(1.5))

        assertEquals(listOf(-30_000L, -5_000L, -500L, 500L, 5_000L, 30_000L), ListenTiming.OFFSET_NUDGES_MS)
        assertEquals(listOf(1.0, 1.0427, 0.9591), ListenTiming.SPEED_PRESETS.map { it.rate })
        assertEquals(listOf("Same speed", "PAL vs film", "Film vs PAL"), ListenTiming.SPEED_PRESETS.map { it.label })
        assertEquals(listOf("−30 s", "−5 s", "−0.5 s", "+0.5 s", "+5 s", "+30 s"), ListenTiming.OFFSET_NUDGES_MS.map(ListenTiming::nudgeLabel))
        // A mark puts the companion at the marked moment: rate · tv + offset = phone.
        val offset = ListenTiming.markOffset(724_200.0, 725_500.0, 1.0427)
        assertEquals(725_500.0, ListenSync.companionTarget(724_200.0, LinkTiming(offsetMs = offset, rate = 1.0427)), 0.5)
    }

    private companion object {
        const val NOW = 1_800_000_000_000L
        fun iso(ms: Long) = Instant.ofEpochMilli(ms).toString()
    }
}
