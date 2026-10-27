package io.github.mickeiik.izle.companion.ui

import io.github.mickeiik.izle.companion.sync.ListenPhase
import io.github.mickeiik.izle.companion.sync.ListenState
import io.github.mickeiik.izle.data.api.Anchor
import io.github.mickeiik.izle.data.api.CommandInfo
import io.github.mickeiik.izle.data.api.NowPlaying
import io.github.mickeiik.izle.data.api.NowResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

/** The TV page's pure texts: command results, what plays, Listen along's line and the timing summary. */
class TvTextTest {
    private fun result(type: String, result: String?, reason: String? = null) = CommandInfo(id = 1, type = type, result = result, reason = reason)

    @Test
    fun commandResultsAreSaidOnlyWhenWorthSaying() {
        assertEquals("Salon is offline. It gets this if it connects in the next 2 minutes.", offlineText("Salon"))
        assertNull("done", commandResultText("Salon", result("next", "done")))
        assertNull("no result yet", commandResultText("Salon", result("next", null)))
        assertEquals("Shown on Salon", commandResultText("Salon", result("message", "done")))
        assertEquals("Nothing is playing on Salon.", commandResultText("Salon", result("pause", "ignored", "not_in_player")))
        assertEquals("No next episode.", commandResultText("Salon", result("next", "ignored", "no_episode")))
        assertEquals("No previous episode.", commandResultText("Salon", result("previous", "ignored", "no_episode")))
        assertEquals("No channel after this one on Home.", commandResultText("Salon", result("next", "ignored", "no_channel")))
        assertEquals("No channel before this one on Home.", commandResultText("Salon", result("previous", "ignored", "no_channel")))
        assertEquals("A channel can't be paused or skipped through.", commandResultText("Salon", result("seek", "ignored", "live")))
        assertEquals("Salon isn't ready (it shows its pairing screen).", commandResultText("Salon", result("stop", "ignored", "not_ready")))
        assertEquals("Salon couldn't do that (the player failed).", commandResultText("Salon", result("next", "failed", "playback_error")))
        assertEquals("unknown reasons in words", "Salon didn't do that (some new thing).", commandResultText("Salon", result("next", "ignored", "some_new_thing")))
        assertEquals("Salon couldn't do that.", commandResultText("Salon", result("next", "failed")))
    }

    @Test
    fun whatPlays() {
        val now = now()
        assertTrue(isPlayingNow(now))
        assertFalse("offline", isPlayingNow(now.copy(online = false)))
        assertFalse("stopped", isPlayingNow(now.copy(nowPlaying = now.nowPlaying!!.copy(state = "stopped"))))
        assertEquals("moves on from the anchor", 724_000L + 2_500, tvPositionAfter(now, 2_500))
        val paused = now.copy(anchor = now.anchor!!.copy(playing = false))
        assertEquals(724_000L, tvPositionAfter(paused, 2_500))
        assertEquals("without an anchor, the report", 700_000L, tvPositionAfter(now.copy(anchor = null), 2_500))

        assertEquals("12:04 / 30:10 · playing", progressText(724_000, 1_810_000, "playing"))
        assertEquals("1:02:03 · paused", progressText(3_723_000, null, "paused"))
        assertEquals(0.5f, progressFraction(500, 1_000)!!, 0f)
        assertEquals(1f, progressFraction(2_000, 1_000)!!, 0f)
        assertNull(progressFraction(500, null))

        assertEquals("Sintel · Pilot", playingTitle(now.nowPlaying!!))
        assertEquals("a film's own title once", "Sintel", playingTitle(now.nowPlaying!!.copy(episodeTitle = "Sintel")))
        assertEquals("Sintel · Pilot on Salon. Plug in earphones.", listenContext(now.nowPlaying, "Salon"))
    }

    @Test
    fun whyNothingToListenTo() {
        val now = now()
        assertNull(nothingToListenText(now, "Salon"))
        assertNull("before the first answer", nothingToListenText(null as NowResponse?, "Salon"))
        assertEquals("Nothing to listen to: Salon isn't playing anything.", nothingToListenText(now.copy(nowPlaying = null), "Salon"))
        assertEquals("Nothing to listen to: Salon isn't playing anything.", nothingToListenText(now.copy(online = false), "Salon"))
        val channel = now.copy(nowPlaying = NowPlaying("news", "live", state = "playing", updatedAt = iso(NOW)), anchor = null)
        assertEquals("Nothing to listen to: Salon is on a channel.", nothingToListenText(channel, "Salon"))
    }

    @Test
    fun theListeningBarAndTheTiming() {
        assertEquals("starting", listeningWord(ListenState(phase = ListenPhase.Starting)))
        assertEquals("in sync", listeningWord(ListenState(phase = ListenPhase.Listening, syncLabel = "synced")))
        assertEquals("catching up", listeningWord(ListenState(phase = ListenPhase.Listening, syncLabel = "holding back")))
        assertEquals("catching up", listeningWord(ListenState(phase = ListenPhase.Listening, syncLabel = "seeking")))
        assertEquals("waiting", listeningWord(ListenState(phase = ListenPhase.Listening, syncLabel = "waiting")))
        assertEquals("paused", listeningWord(ListenState(phase = ListenPhase.Listening, syncLabel = "paused")))

        assertEquals("offset −1.25 s · speed 1.0427", timingSummary(LinkTimingInput(-1_250, 1.0427)))
        assertEquals("offset +0 s · speed 1", timingSummary(LinkTimingInput(0, 1.0)))
        assertEquals("offset or speed is not a valid number", timingSummary(null))

        assertEquals("TV marked at 12:04.2, now tap when you hear it", markPendingText(724_250.0, null))
        assertEquals("Phone marked at 12:05.5, now tap when you see it on the TV", markPendingText(null, 725_500.0))
        assertNull(markPendingText(null, null))
    }

    private fun now() = NowResponse(
        online = true, serverNowMs = NOW, seq = 4,
        nowPlaying = NowPlaying(
            itemId = "sintel", itemKind = "series", episodeId = "sintel.e1", itemTitle = "Sintel", episodeTitle = "Pilot",
            positionMs = 700_000, durationMs = 1_810_000, state = "playing", updatedAt = iso(NOW - 5_000), playing = true,
        ),
        anchor = Anchor(positionMs = 724_000, atMs = NOW, playing = true),
    )

    private companion object {
        const val NOW = 1_800_000_000_000L
        fun iso(ms: Long) = Instant.ofEpochMilli(ms).toString()
    }
}
