package io.github.mickeiik.izle.player

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class MediaTypesTest {
    @Test
    fun aLanguageAlsoAcceptsItsPrimarySubtag() {
        assertArrayEquals(arrayOf("pt-BR", "pt"), PlaybackController.languagePreference("pt-BR"))
        assertArrayEquals(arrayOf("tr"), PlaybackController.languagePreference("tr"))
        assertArrayEquals(arrayOf("EN", "en"), PlaybackController.languagePreference("EN"))
        assertArrayEquals(arrayOf("zh-Hant-TW", "zh"), PlaybackController.languagePreference("zh-Hant-TW"))
    }

    @Test
    fun noLanguageMeansNoPreference() {
        assertArrayEquals(emptyArray<String>(), PlaybackController.languagePreference(null))
        assertArrayEquals(emptyArray<String>(), PlaybackController.languagePreference(""))
        assertArrayEquals(emptyArray<String>(), PlaybackController.languagePreference("  "))
    }

    @Test
    fun mediaKindsMapToTheirMimeTypes() {
        assertEquals("application/x-mpegURL", PlaybackController.mediaMimeType("hls"))
        assertEquals("application/dash+xml", PlaybackController.mediaMimeType("dash"))
        assertEquals("video/mp4", PlaybackController.mediaMimeType("mp4"))
        assertEquals("an unknown kind is played as MP4", "video/mp4", PlaybackController.mediaMimeType("webm"))
    }

    @Test
    fun subtitleFormatsMapToTheirMimeTypes() {
        assertEquals("application/x-subrip", PlaybackController.subtitleMimeType("srt"))
        assertEquals("application/ttml+xml", PlaybackController.subtitleMimeType("ttml"))
        assertEquals("text/vtt", PlaybackController.subtitleMimeType("vtt"))
        assertEquals("an unknown format is read as WebVTT", "text/vtt", PlaybackController.subtitleMimeType("ass"))
    }
}
