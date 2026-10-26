package io.github.mickeiik.izle.companion.finder

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The link finder's pure rules: candidates, the playlist's start, the headers kept, the address row. */
class LinkCandidatesTest {
    @Test
    fun aCandidateHasM3u8InItsPathOrQuery() {
        assertTrue(isCandidate("https://cdn.test/x.m3u8"))
        assertTrue(isCandidate("http://cdn.test/live/x.m3u8?token=1"))
        assertTrue(isCandidate("https://cdn.test/m3u8/abc?payload=xyz"))
        assertTrue(isCandidate("https://cdn.test/play?file=a.M3U8"))
        assertTrue(isCandidate("HTTPS://cdn.test/A.M3U8"))
    }

    @Test
    fun anythingElseIsNot() {
        assertFalse(isCandidate("https://cdn.test/video.mp4"))
        assertFalse(isCandidate("https://m3u8.test/index.html")) // in the host only
        assertFalse(isCandidate("data:application/vnd.apple.mpegurl;base64,I0VYVE0zVQ== m3u8"))
        assertFalse(isCandidate("blob:https://page.test/m3u8-1234"))
        assertFalse(isCandidate("about:blank#m3u8"))
        assertFalse(isCandidate("file:///sdcard/x.m3u8"))
        assertFalse(isCandidate("https:///x.m3u8"))
        assertFalse(isCandidate(""))
    }

    @Test
    fun aPlaylistStartsWithExtm3u() {
        assertTrue(looksLikePlaylist("#EXTM3U\n#EXT-X-VERSION:3\n".toByteArray()))
        assertTrue(looksLikePlaylist("#EXTM3U".toByteArray()))
        assertTrue(looksLikePlaylist(byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte()) + "#EXTM3U\n".toByteArray()))
        assertTrue(looksLikePlaylist(" \r\n\t#EXTM3U\n".toByteArray()))
        assertTrue(looksLikePlaylist(byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte()) + "\n#EXTM3U".toByteArray()))
    }

    @Test
    fun anythingElseIsNotAPlaylist() {
        assertFalse(looksLikePlaylist("<!doctype html><html>".toByteArray()))
        assertFalse(looksLikePlaylist("#EXTM3".toByteArray()))
        assertFalse(looksLikePlaylist("#extm3u\n".toByteArray()))
        assertFalse(looksLikePlaylist("x#EXTM3U".toByteArray()))
        assertFalse(looksLikePlaylist("{\"error\":\"forbidden\"}".toByteArray()))
        assertFalse(looksLikePlaylist(ByteArray(0)))
        assertFalse(looksLikePlaylist(byteArrayOf(0x47, 0x40, 0x11, 0x10))) // an MPEG-TS packet
    }

    @Test
    fun headersKeepRefererOriginAndTheCookiesOnly() {
        val page = mapOf(
            "referer" to "https://page.test/watch/1",
            "ORIGIN" to "https://page.test",
            "User-Agent" to "Mozilla/5.0",
            "Authorization" to "Bearer abc",
            "Accept" to "*/*",
        )
        val headers = headersFor(page, "session=s1; consent=yes")
        assertEquals(
            mapOf("Referer" to "https://page.test/watch/1", "Origin" to "https://page.test", "Cookie" to "session=s1; consent=yes"),
            headers,
        )
        assertEquals(listOf("Referer", "Origin", "Cookie"), headers.keys.toList())
    }

    @Test
    fun onlyTheHeadersPresent() {
        assertEquals(mapOf("Referer" to "https://page.test/"), headersFor(mapOf("Referer" to "https://page.test/"), null))
        assertEquals(emptyMap<String, String>(), headersFor(mapOf("Origin" to " "), "  "))
        assertEquals(mapOf("Cookie" to "a=b"), headersFor(emptyMap(), "a=b"))
    }

    @Test
    fun theAddressRowAddsHttpsWhenNoSchemeIsGiven() {
        assertEquals("https://page.test/watch", addressUrl("  page.test/watch "))
        assertEquals("http://page.test", addressUrl("http://page.test"))
        assertEquals("https://page.test/a?b=c", addressUrl("https://page.test/a?b=c"))
        assertNull(addressUrl(""))
        assertNull(addressUrl("   "))
        assertNull(addressUrl("file:///sdcard/a.html"))
        assertNull(addressUrl("two words"))
    }

    @Test
    fun aFoundLinkPrintsItsHeaderNamesOnly() {
        val link = FoundLink("https://cdn.test/secret.m3u8?token=t0k3n", mapOf("Referer" to "https://page.test/", "Cookie" to "session=s3cr3t"))
        val text = link.toString()
        assertEquals("FoundLink(headers=[Referer, Cookie])", text)
        assertFalse(text.contains("cdn.test") || text.contains("t0k3n") || text.contains("s3cr3t") || text.contains("page.test"))
    }
}
