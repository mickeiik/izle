package io.github.mickeiik.izle.data.api

import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ServerUrlsTest {
    @Test
    fun parsesWhatTheOwnerTypes() {
        assertEquals("http://10.0.2.2:8787/", ServerUrls.parse("10.0.2.2:8787").toString())
        assertEquals("http://192.168.1.10:8787/", ServerUrls.parse("  http://192.168.1.10:8787  ").toString())
        assertEquals("https://izle.example.org/tv/", ServerUrls.parse("https://izle.example.org/tv").toString())
        assertEquals("http://host:8787/", ServerUrls.parse("http://user:pw@host:8787/?x=1#frag").toString())
    }

    @Test
    fun rejectsGarbage() {
        assertNull(ServerUrls.parse(""))
        assertNull(ServerUrls.parse("not an address"))
        assertNull(ServerUrls.parse("ftp://host"))
        assertNull(ServerUrls.parse("http://"))
    }

    @Test
    fun serverRelativeUrlsStayBelowTheBasePath() {
        val root = "http://10.0.2.2:8787/".toHttpUrl()
        val prefixed = "https://example.org/izle/".toHttpUrl()
        assertEquals("http://10.0.2.2:8787/assets/ab.jpg", ServerUrls.resolve(root, "/assets/ab.jpg").toString())
        assertEquals("https://example.org/izle/assets/ab.jpg", ServerUrls.resolve(prefixed, "/assets/ab.jpg").toString())
        assertEquals("https://example.org/izle/p/tok/index.m3u8", ServerUrls.resolve(prefixed, "p/tok/index.m3u8").toString())
        // Absolute URLs are kept.
        assertEquals("https://cdn.example.net/a/master.m3u8", ServerUrls.resolve(prefixed, "https://cdn.example.net/a/master.m3u8").toString())
        assertEquals("https://cdn.example.net/x.vtt", ServerUrls.resolve(prefixed, "//cdn.example.net/x.vtt").toString())
        assertNull(ServerUrls.resolve(prefixed, " "))
    }

    @Test
    fun displayIsShortAndTheAdminPageIsBelowTheBasePath() {
        assertEquals("http://10.0.2.2:8787", ServerUrls.display("http://10.0.2.2:8787/".toHttpUrl()))
        assertEquals("https://example.org/izle", ServerUrls.display("https://example.org:443/izle/".toHttpUrl()))
        assertEquals("http://192.168.1.54:8787/admin", ServerUrls.adminPage("http://192.168.1.54:8787/".toHttpUrl()))
        assertEquals("https://example.org/izle/admin", ServerUrls.adminPage("https://example.org/izle/".toHttpUrl()))
    }
}
