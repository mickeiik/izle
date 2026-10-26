package io.github.mickeiik.izle.companion.finder

import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import okhttp3.ResponseBody.Companion.asResponseBody
import okio.Buffer
import okio.ForwardingSource
import okio.buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.net.InetAddress
import java.util.Collections
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/** The confirming fetch against an in-process server: a playlist without an extension, HTML, a refusal, a large body. */
class LinkConfirmerTest {
    private val server = MockWebServer()
    private val http = OkHttpClient()
    private val headers = mapOf("Referer" to "https://page.test/watch/1", "Origin" to "https://page.test", "Cookie" to "session=s1")

    // android.util.Log is a stub here: the diagnostics are recorded instead.
    private val logged = Collections.synchronizedList(mutableListOf<String>())
    private lateinit var logSink: (String) -> Unit

    @Before
    fun setUp() {
        logSink = FinderLog.sink
        FinderLog.sink = { logged += it }
        server.start()
    }

    @After
    fun tearDown() {
        server.close()
        FinderLog.sink = logSink
        // Whatever a test did, no line holds a path, a query or a header value.
        for (line in logged) {
            assertFalse(line, listOf("://", "?", "m3u8", "master", "payload", "page.test", "session").any { line.contains(it) })
        }
    }

    private val host get() = server.url("/").host

    @Test
    fun aPlaylistAtAUrlWithoutAnExtensionIsFoundWithTheHeadersSent() = runBlocking {
        server.enqueue(MockResponse.Builder().code(200).body("#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:4,\nseg0.ts\n").build())
        val url = server.url("/found/master?payload=abc").toString()

        val found = LinkConfirmer(http).confirm(url, headers)

        assertEquals(FoundLink(url, headers), found)
        assertEquals(listOf("confirm: ok, host $host"), logged.toList())
        val request = server.takeRequest()
        assertEquals("GET", request.method)
        assertEquals("/found/master", request.url.encodedPath)
        assertEquals("payload=abc", request.url.encodedQuery)
        assertEquals("https://page.test/watch/1", request.headers["Referer"])
        assertEquals("https://page.test", request.headers["Origin"])
        assertEquals("session=s1", request.headers["Cookie"])
        assertNull(request.headers["Authorization"])
    }

    @Test
    fun noHeadersAreAddedToAPastedLink() = runBlocking {
        server.enqueue(MockResponse.Builder().code(200).body("﻿#EXTM3U\n").build())
        val url = server.url("/pasted").toString()

        assertEquals(FoundLink(url, emptyMap()), LinkConfirmer(http).confirm(url, emptyMap()))
        val request = server.takeRequest()
        assertNull(request.headers["Referer"])
        assertNull(request.headers["Origin"])
        assertNull(request.headers["Cookie"])
    }

    @Test
    fun aRedirectToAnotherHostIsFollowedWithoutTheHeaders() = runBlocking {
        val otherHost = MockWebServer()
        otherHost.start(InetAddress.getByName("127.0.0.1"), 0)
        try {
            val url = server.url("/found/master").toString()
            assertNotEquals("two host names", "127.0.0.1", server.url("/").host)
            server.enqueue(
                MockResponse.Builder().code(302).addHeader("Location", "http://127.0.0.1:${otherHost.port}/cdn/master").build(),
            )
            otherHost.enqueue(MockResponse.Builder().code(200).body("#EXTM3U\n#EXTINF:4,\nseg0.ts\n").build())

            assertEquals(FoundLink(url, headers), LinkConfirmer(http).confirm(url, headers))
            assertEquals(listOf("confirm: http 302 (redirect), host $host to 127.0.0.1", "confirm: ok, host 127.0.0.1"), logged.toList())
            val first = server.takeRequest()
            for ((name, value) in headers) assertEquals(name, value, first.headers[name])
            val redirected = otherHost.takeRequest()
            assertEquals("/cdn/master", redirected.url.encodedPath)
            assertNull(redirected.headers["Referer"])
            assertNull(redirected.headers["Origin"])
            assertNull(redirected.headers["Cookie"])
        } finally {
            otherHost.close()
        }
    }

    @Test
    fun aRedirectOnTheSameHostKeepsTheHeaders() = runBlocking {
        server.enqueue(MockResponse.Builder().code(302).addHeader("Location", "/real/master").build())
        server.enqueue(MockResponse.Builder().code(200).body("#EXTM3U\n").build())
        val url = server.url("/found/master").toString()

        assertEquals(FoundLink(url, headers), LinkConfirmer(http).confirm(url, headers))
        for (path in listOf("/found/master", "/real/master")) {
            val request = server.takeRequest()
            assertEquals(path, request.url.encodedPath)
            for ((name, value) in headers) assertEquals("$path $name", value, request.headers[name])
        }
    }

    @Test
    fun htmlIsNotAPlaylist() = runBlocking {
        server.enqueue(
            MockResponse.Builder().code(200).addHeader("Content-Type", "text/html; charset=utf-8")
                .body("<!doctype html><html><body>m3u8</body></html>").build(),
        )
        assertNull(LinkConfirmer(http).confirm(server.url("/page.m3u8").toString(), headers))
        assertEquals(listOf("confirm: not a playlist (content-type text/html), host $host"), logged.toList())
    }

    @Test
    fun aBodyWithoutAContentTypeSaysNone() = runBlocking {
        server.enqueue(MockResponse.Builder().code(200).removeHeader("Content-Type").body("nothing here").build())
        assertNull(LinkConfirmer(http).confirm(server.url("/x.m3u8").toString(), headers))
        assertEquals(listOf("confirm: not a playlist (content-type none), host $host"), logged.toList())
    }

    @Test
    fun aRefusalIsNotAPlaylist() = runBlocking {
        server.enqueue(MockResponse.Builder().code(403).body("#EXTM3U\n").build())
        assertNull(LinkConfirmer(http).confirm(server.url("/x.m3u8").toString(), headers))
        assertEquals(listOf("confirm: http 403, host $host"), logged.toList())
    }

    @Test
    fun aRedirectToAPageIsReportedAsTheRedirectThenNotAPlaylist() = runBlocking {
        server.enqueue(MockResponse.Builder().code(302).addHeader("Location", "/login?next=payload").build())
        server.enqueue(MockResponse.Builder().code(200).addHeader("Content-Type", "text/html").body("<html></html>").build())

        assertNull(LinkConfirmer(http).confirm(server.url("/x.m3u8?payload=abc").toString(), headers))
        assertEquals(
            listOf("confirm: http 302 (redirect), host $host to $host", "confirm: not a playlist (content-type text/html), host $host"),
            logged.toList(),
        )
    }

    @Test
    fun aRedirectThatIsNotFollowedIsReportedAsItsStatus() = runBlocking {
        server.enqueue(MockResponse.Builder().code(301).addHeader("Location", "/elsewhere").build())
        val noRedirects = http.newBuilder().followRedirects(false).build()

        assertNull(LinkConfirmer(noRedirects).confirm(server.url("/x.m3u8").toString(), headers))
        assertEquals(listOf("confirm: http 301, host $host"), logged.toList())
    }

    @Test
    fun anUnreachableOrInvalidLinkIsNotAPlaylist() = runBlocking {
        val url = server.url("/x.m3u8").toString()
        val host = host
        server.close()
        assertNull(LinkConfirmer(http).confirm(url, headers))
        assertNull(LinkConfirmer(http).confirm("not a url", headers))
        assertNull(LinkConfirmer(http).confirm("https://cdn.test/x.m3u8", mapOf("Cookie" to "a=\nb")))
        assertEquals(
            listOf(
                "confirm: failed (ConnectException), host $host",
                "confirm: failed (not an http(s) URL)",
                "confirm: failed (IllegalArgumentException), host cdn.test",
            ),
            logged.toList(),
        )
    }

    @Test
    fun aLargeBodyIsReadOnlyAtItsStart() = runBlocking {
        val big = Buffer().writeUtf8("#EXTM3U\n").write(ByteArray(1024 * 1024) { 'x'.code.toByte() })
        server.enqueue(MockResponse.Builder().code(200).body(big).build())
        val read = AtomicLong()
        val counting = http.newBuilder().addInterceptor { chain ->
            val response = chain.proceed(chain.request())
            val body = response.body
            val source = object : ForwardingSource(body.source()) {
                override fun read(sink: Buffer, byteCount: Long): Long = super.read(sink, byteCount).also { if (it > 0) read.addAndGet(it) }
            }
            response.newBuilder().body(source.buffer().asResponseBody(body.contentType(), body.contentLength())).build()
        }.readTimeout(5, TimeUnit.SECONDS).build()

        val url = server.url("/big").toString()
        assertEquals(FoundLink(url, headers), LinkConfirmer(counting).confirm(url, headers))
        assertTrue("read ${read.get()} bytes", read.get() < 64 * 1024)
    }
}
