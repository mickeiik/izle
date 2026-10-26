package io.github.mickeiik.izle.companion.ui

import io.github.mickeiik.izle.companion.sync.EndReason
import io.github.mickeiik.izle.companion.sync.ListenPhase
import io.github.mickeiik.izle.companion.sync.ListenState
import io.github.mickeiik.izle.data.api.ApiException
import io.github.mickeiik.izle.data.api.CandidateLanguages
import io.github.mickeiik.izle.data.api.CompanionCandidate
import io.github.mickeiik.izle.data.api.LinkTiming
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.IOException

/** The pure Listen along texts, against the cases of the admin page's ("listen along helpers" in admin-ui.test.ts). */
class ListenTextTest {
    private fun source(sourceId: String, audio: List<String>?, type: String = "direct", label: String? = null, current: Boolean = false, kind: String? = null) =
        CompanionCandidate(sourceId = sourceId, type = type, kind = kind, label = label, languages = CandidateLanguages(audio), current = current)

    @Test
    fun candidateOptionsAsTheAdminPageButDashAndTsArePlayable() {
        val options = candidateOptions(
            listOf(
                source("hls-multi-audio", listOf("en", "it"), label = "Unified", current = true, kind = "hls"),
                source("fr-dub", listOf("fr"), kind = "mp4"),
                source("silent", emptyList(), kind = "hls"),
                source("mystery", null, type = "adapter"),
                CompanionCandidate("dash", kind = "dash", languages = CandidateLanguages(listOf("de")), supported = false, reason = "dash"),
                source("pasted", null, type = "pasted"),
                source("future", listOf("en"), type = "other"),
            ),
        )
        assertEquals(
            listOf(
                CandidateOption("hls-multi-audio", "en", "hls-multi-audio — Unified · English (en) · the TV's source", "hls"),
                CandidateOption("hls-multi-audio", "it", "hls-multi-audio — Unified · Italiano (it) · the TV's source", "hls"),
                CandidateOption("fr-dub", null, "fr-dub · Français (fr)", "mp4"),
                CandidateOption("silent", null, "silent · no dialogue", "hls"),
                CandidateOption("mystery", null, "mystery", null),
                CandidateOption("dash", null, "dash · Deutsch (de)", "dash"),
            ),
            options,
        )
        assertEquals("hls-multi-audio\u0000it", options[1].key)
        assertEquals("fr-dub\u0000", options[2].key)
    }

    @Test
    fun languageAndKindLabels() {
        assertEquals("Türkçe (tr)", languageLabel("tr"))
        assertEquals("Português (pt-BR)", languageLabel("pt-BR"))
        assertEquals("qaa", languageLabel("qaa"))
        assertEquals("MPEG-TS", mediaKindLabel("ts"))
        assertEquals("DASH", mediaKindLabel("dash"))
        assertEquals("HLS", mediaKindLabel("hls"))
        assertEquals("MP4", mediaKindLabel("mp4"))
    }

    @Test
    fun timingFieldsParseAsTheAdminPageDoes() {
        assertEquals(LinkTimingInput(-1250, 1.0427), parseTiming("-1.250", "1.0427"))
        assertEquals(LinkTimingInput(2346, 1.0), parseTiming(" 2,3456 ", "1"))
        assertEquals(LinkTimingInput(-500, 0.5), parseTiming("−0.5", "0.5"))
        assertEquals(LinkTimingInput(0, 2.0), parseTiming("0", "2"))
        assertNull(parseTiming("", "1"))
        assertNull(parseTiming("abc", "1"))
        assertNull(parseTiming("1", ""))
        assertNull(parseTiming("1", "0.49"))
        assertNull(parseTiming("1", "2.01"))
        assertNull(parseTiming("1", "NaN"))
        assertNull("beyond ±6 h", parseTiming("21601", "1"))
        assertEquals("-1.250", offsetText(LinkTiming(offsetMs = -1250)))
        assertEquals("0.000", offsetText(LinkTiming()))
        assertEquals("1", speedText(LinkTiming(rate = 1.0)))
        assertEquals("1.0427", speedText(LinkTiming(rate = 1.0427)))
    }

    @Test
    fun theStatusLineHasWhatIsKnown() {
        assertNull(statusLine(ListenState()))
        assertEquals("Starting…", statusLine(ListenState(phase = ListenPhase.Starting)))
        assertEquals(
            "TV 1:02:05.4 · phone 1:02:05.3 · drift +60 ms · synced · HLS · clock ±20 ms",
            statusLine(
                ListenState(
                    phase = ListenPhase.Listening, tvPositionMs = 3_725_450.0, phonePositionMs = 3_725_390.0, driftMs = 60.0,
                    syncLabel = "synced", mediaKind = "hls", clockRttMs = 40,
                ),
            ),
        )
        assertEquals(
            "TV 1:05.0 · drift −1.5 s · seeking · MPEG-TS",
            statusLine(ListenState(phase = ListenPhase.Listening, tvPositionMs = 65_000.0, driftMs = -1_540.0, syncLabel = "seeking", mediaKind = "ts")),
        )
        assertEquals("nudge +0 ms", nudgeText(0))
        assertEquals("nudge −50 ms", nudgeText(-50))
    }

    @Test
    fun snackbarTexts() {
        assertNull(endedText(null, null))
        assertNull(endedText(EndReason.Stopped, null))
        assertEquals("The TV stopped; listening ended.", endedText(EndReason.TvIdle, null))
        assertEquals("The TV switched to a channel; listening ended.", endedText(EndReason.TvSwitchedToChannel, null))
        assertEquals("The next episode has no such source; listening ended.", endedText(EndReason.NoSuchSourceOnNextEpisode, null))
        assertEquals("The companion stream keeps failing; listening ended.", endedText(EndReason.StreamKeepsFailing, null))
        assertEquals("The token was not accepted; pair again.", endedText(EndReason.Unauthorized, null))
        assertEquals(
            "The phone's audio was interrupted (earphones unplugged, or another app took over); listening ended.",
            endedText(EndReason.Interrupted, null),
        )
        assertEquals("Could not start: The source could not be resolved right now.", endedText(EndReason.Failed, "no_playable_source"))
        assertEquals("Could not start: SocketTimeoutException", endedText(EndReason.Failed, "SocketTimeoutException"))
        assertEquals("No other episode has that source.", copiedText(0))
        assertEquals("Timing copied to 1 other episode.", copiedText(1))
        assertEquals("Timing copied to 7 other episodes.", copiedText(7))
        assertEquals("The server cannot be reached.", errorText(IOException("down")))
        assertEquals("Save the timing for this episode first.", errorText(ApiException(404, "no_link")))
        assertEquals("The server answered: teapot.", errorText(ApiException(418, "teapot")))
    }


    @Test
    fun theSignFlips() {
        assertEquals("-1.250", flipSign("1.250"))
        assertEquals("1.250", flipSign("-1.250"))
        assertEquals("-", flipSign(""))
    }
}
