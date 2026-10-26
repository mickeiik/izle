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
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/** The confirming fetch against an in-process server: a playlist without an extension, HTML, a refusal, a large body. */
class LinkConfirmerTest {
    private val server = MockWebServer()
    private val http = OkHttpClient()
    private val headers = mapOf("Referer" to "https://page.test/watch/1", "Origin" to "https://page.test", "Cookie" to "session=s1")

    @Before
    fun setUp() = server.start()

    @After
    fun tearDown() = server.close()

    @Test
    fun aPlaylistAtAUrlWithoutAnExtensionIsFoundWithTheHeadersSent() = runBlocking {
        server.enqueue(MockResponse.Builder().code(200).body("#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:4,\nseg0.ts\n").build())
        val url = server.url("/found/master?payload=abc").toString()

        val found = LinkConfirmer(http).confirm(url, headers)

        assertEquals(FoundLink(url, headers), found)
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
    fun htmlIsNotAPlaylist() = runBlocking {
        server.enqueue(MockResponse.Builder().code(200).body("<!doctype html><html><body>m3u8</body></html>").build())
        assertNull(LinkConfirmer(http).confirm(server.url("/page.m3u8").toString(), headers))
    }

    @Test
    fun aRefusalIsNotAPlaylist() = runBlocking {
        server.enqueue(MockResponse.Builder().code(403).body("#EXTM3U\n").build())
        assertNull(LinkConfirmer(http).confirm(server.url("/x.m3u8").toString(), headers))
    }

    @Test
    fun anUnreachableOrInvalidLinkIsNotAPlaylist() = runBlocking {
        val url = server.url("/x.m3u8").toString()
        server.close()
        assertNull(LinkConfirmer(http).confirm(url, headers))
        assertNull(LinkConfirmer(http).confirm("not a url", headers))
        assertNull(LinkConfirmer(http).confirm("https://cdn.test/x.m3u8", mapOf("Cookie" to "a=\nb")))
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
