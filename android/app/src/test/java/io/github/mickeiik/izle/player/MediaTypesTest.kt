package io.github.mickeiik.izle.player

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MediaTypesTest {
    @Test
    fun aLanguageAlsoAcceptsItsPrimarySubtag() {
        assertArrayEquals(arrayOf("pt-BR", "pt"), languagePreference("pt-BR"))
        assertArrayEquals(arrayOf("tr"), languagePreference("tr"))
        assertArrayEquals(arrayOf("EN", "en"), languagePreference("EN"))
        assertArrayEquals(arrayOf("zh-Hant-TW", "zh"), languagePreference("zh-Hant-TW"))
        // No language means no preference.
        assertArrayEquals(emptyArray<String>(), languagePreference(null))
        assertArrayEquals(emptyArray<String>(), languagePreference(""))
        assertArrayEquals(emptyArray<String>(), languagePreference("  "))
    }

    @Test
    fun mediaKindsAndSubtitleFormatsMapToTheirMimeTypes() {
        assertEquals("application/x-mpegURL", mediaMimeType("hls"))
        assertEquals("application/dash+xml", mediaMimeType("dash"))
        assertEquals("video/mp4", mediaMimeType("mp4"))
        assertEquals("video/mp2t", mediaMimeType("ts"))
        assertEquals("an unknown kind is played as MP4", "video/mp4", mediaMimeType("webm"))
        assertEquals("application/x-subrip", subtitleMimeType("srt"))
        assertEquals("application/ttml+xml", subtitleMimeType("ttml"))
        assertEquals("text/vtt", subtitleMimeType("vtt"))
        assertEquals("an unknown format is read as WebVTT", "text/vtt", subtitleMimeType("ass"))
    }

    @Test
    fun onlyAChannelsProgressiveStreamIsRestartedRatherThanResumed() {
        assertTrue(restartsInsteadOfResuming("ts", live = true))
        assertFalse("its segments are retried as usual", restartsInsteadOfResuming("hls", live = true))
        assertFalse(restartsInsteadOfResuming("mp4", live = true))
        assertFalse("a file has a byte position to go back to", restartsInsteadOfResuming("ts", live = false))
    }
}
