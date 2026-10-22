package io.github.mickeiik.izle.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MediaTypesTest {
    @Test
    fun aLanguageAlsoAcceptsItsPrimarySubtag() {
        val cases = mapOf(
            "pt-BR" to listOf("pt-BR", "pt"), "tr" to listOf("tr"), "EN" to listOf("EN", "en"), "zh-Hant-TW" to listOf("zh-Hant-TW", "zh"),
        )
        assertEquals(cases, cases.mapValues { (language, _) -> languagePreference(language).toList() })
        // No language means no preference.
        assertEquals(listOf(0, 0, 0), listOf(null, "", "  ").map { languagePreference(it).size })
    }

    @Test
    fun mediaKindsAndSubtitleFormatsMapToTheirMimeTypes() {
        // An unknown kind (webm) is played as MP4, an unknown format (ass) read as WebVTT.
        val kinds = mapOf(
            "hls" to "application/x-mpegURL", "dash" to "application/dash+xml", "mp4" to "video/mp4", "ts" to "video/mp2t",
            "webm" to "video/mp4",
        )
        assertEquals(kinds, kinds.mapValues { mediaMimeType(it.key) })
        val formats = mapOf("srt" to "application/x-subrip", "ttml" to "application/ttml+xml", "vtt" to "text/vtt", "ass" to "text/vtt")
        assertEquals(formats, formats.mapValues { subtitleMimeType(it.key) })
    }

    @Test
    fun onlyAChannelsProgressiveStreamIsRestartedRatherThanResumed() {
        assertTrue(restartsInsteadOfResuming("ts", live = true))
        assertFalse("its segments are retried as usual", restartsInsteadOfResuming("hls", live = true))
        assertFalse(restartsInsteadOfResuming("mp4", live = true))
        assertFalse("a file has a byte position to go back to", restartsInsteadOfResuming("ts", live = false))
    }
}
