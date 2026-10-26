package io.github.mickeiik.izle.player

import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import okhttp3.Request
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Before
import org.junit.Test
import java.net.InetAddress
import java.util.concurrent.TimeUnit

/** Two in-process servers on two host names: `localhost` (the link's host) and `127.0.0.1` (another host). */
class HostBoundHeadersTest {
    private val linkHost = MockWebServer()
    private val otherHost = MockWebServer()
    private val http = OkHttpClient()
    private val headers = mapOf("Referer" to "https://page.test/", "Origin" to "https://page.test", "Cookie" to "a=b")

    @Before
    fun setUp() {
        linkHost.start()
        otherHost.start(InetAddress.getByName("127.0.0.1"), 0)
    }

    @After
    fun tearDown() {
        linkHost.close()
        otherHost.close()
        http.dispatcher.executorService.shutdown()
        http.connectionPool.evictAll()
    }

    @Test
    fun theLinksHostGetsTheHeadersOnEveryHopAndAnotherHostNone() {
        val start = linkHost.url("/start")
        assertNotEquals("two host names", "127.0.0.1", start.host)
        linkHost.enqueue(MockResponse.Builder().code(302).addHeader("Location", "/next").build())
        linkHost.enqueue(
            MockResponse.Builder().code(302).addHeader("Location", "http://127.0.0.1:${otherHost.port}/elsewhere").build(),
        )
        otherHost.enqueue(MockResponse.Builder().code(200).body("done").build())

        val client = http.withHostBoundHeaders(start.host.uppercase(), headers) // the host compares case-insensitively
        client.newCall(Request.Builder().url(start).build()).execute().use { assertEquals("done", it.body.string()) }

        for (path in listOf("/start", "/next")) {
            val request = linkHost.takeRequest(5, TimeUnit.SECONDS)!!
            assertEquals(path, request.url.encodedPath)
            for ((name, value) in headers) assertEquals("$path $name", value, request.headers[name])
        }
        val elsewhere = otherHost.takeRequest(5, TimeUnit.SECONDS)!!
        assertEquals("/elsewhere", elsewhere.url.encodedPath)
        for (name in headers.keys) assertNull(name, elsewhere.headers[name])
    }

    @Test
    fun aHeaderOkHttpCannotSendFailsUpFront() {
        assertThrows(IllegalArgumentException::class.java) { http.withHostBoundHeaders("cdn.test", mapOf("Cookie" to "a=\nb")) }
        assertThrows(IllegalArgumentException::class.java) { http.withHostBoundHeaders("cdn.test", mapOf("Bad Name" to "x")) }
    }
}
