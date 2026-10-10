package io.github.mickeiik.izle.data.api

import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.io.IOException

/** ApiClient against an in-process MockWebServer (no network). */
class ApiClientTest {
    private val server = MockWebServer()
    private val http = OkHttpClient()

    @Before
    fun setUp() = server.start()

    @After
    fun tearDown() = server.close()

    private fun client(token: String? = "device-token", path: String = "/") = ApiClient(server.url(path), token, http)

    private fun json(body: String, code: Int = 200) =
        MockResponse.Builder().code(code).addHeader("Content-Type", "application/json").body(body).build()

    @Test
    fun stateSendsTheDeviceToken() = runBlocking {
        server.enqueue(json("""{"version":3,"device":{"id":"d","name":"TV"},"catalog":{"id":"c","buildId":"b","name":"n"},"home":[]}"""))
        val state = client().state()
        assertEquals(3L, state.version)
        val request = server.takeRequest()
        assertEquals("GET", request.method)
        assertEquals("/api/v1/tv/state", request.url.encodedPath)
        assertEquals("Bearer device-token", request.headers["Authorization"])
    }

    @Test
    fun worksBelowAPathPrefix() = runBlocking {
        server.enqueue(json("""{"item":{"id":"caminandes","kind":"series","title":"C"},"cursorEpisodeId":null,"episodes":[]}"""))
        client(path = "/izle/").item("caminandes")
        assertEquals("/izle/api/v1/tv/items/caminandes", server.takeRequest().url.encodedPath)
    }

    @Test
    fun resolvePostsJson() = runBlocking {
        server.enqueue(
            json(
                """{"sessionId":"s","sourceId":"a","media":{"kind":"mp4","url":"/p/x/file.mp4"},"item":{"id":"m","kind":"movie","title":"M"},
                   "episode":{"id":"m.film"}}""",
            ),
        )
        val api = client()
        val r = api.resolve(ResolveRequest("m.film", exclude = listOf("b")))
        assertEquals("${server.url("/")}p/x/file.mp4", api.resolve(r.media.url).toString())
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertTrue(request.headers["Content-Type"]!!.startsWith("application/json"))
        assertEquals("""{"episodeId":"m.film","exclude":["b"]}""", request.body?.utf8())
    }

    @Test
    fun errorAnswersBecomeApiExceptions() = runBlocking {
        server.enqueue(json("""{"error":"not_allowed","message":"playback of this episode is not allowed"}""", code = 403))
        server.enqueue(MockResponse.Builder().code(429).addHeader("Retry-After", "42").body("""{"error":"rate_limited"}""").build())
        server.enqueue(MockResponse.Builder().code(502).body("<html>bad gateway</html>").build())
        try {
            client().resolve(ResolveRequest("e"))
            fail("expected ApiException")
        } catch (e: ApiException) {
            assertEquals(403, e.status)
            assertEquals("not_allowed", e.code)
        }
        try {
            client(token = null).pairStart()
            fail("expected ApiException")
        } catch (e: ApiException) {
            assertEquals("rate_limited", e.code)
            assertEquals(42L, e.retryAfterSec)
        }
        try {
            client().state()
            fail("expected ApiException")
        } catch (e: ApiException) {
            assertEquals("http_502", e.code)
        }
    }

    @Test
    fun pairingFlow() = runBlocking {
        server.enqueue(json("""{"code":"483920","pairToken":"pair-secret","expiresAt":"2026-10-10T10:10:00.000Z"}"""))
        server.enqueue(json("""{"status":"pending"}"""))
        server.enqueue(json("""{"status":"approved","deviceId":"abcdefabcdef","deviceToken":"tok"}"""))
        server.enqueue(json("""{"error":"expired","status":"expired"}""", code = 410))
        val api = client(token = null)
        val start = api.pairStart()
        assertNull(server.takeRequest().headers["Authorization"])
        assertEquals("pending", api.pairWait(start.code, start.pairToken, waitSec = 0).status)
        val waitRequest = server.takeRequest()
        assertEquals("Bearer pair-secret", waitRequest.headers["Authorization"])
        assertEquals("483920", waitRequest.url.queryParameter("code"))
        assertEquals("0", waitRequest.url.queryParameter("wait"))
        val approved = api.pairWait(start.code, start.pairToken, waitSec = 0)
        assertEquals("tok", approved.deviceToken)
        assertEquals("expired", api.pairWait(start.code, start.pairToken, waitSec = 0).status)
    }

    @Test
    fun progressAndAck() = runBlocking {
        server.enqueue(json("""{"ok":true,"version":9}"""))
        server.enqueue(json("""{"ok":true}"""))
        assertEquals(9L, client().progress(ProgressReport("s", "e", 1_000, 2_000, "playing")).version)
        assertEquals(
            """{"sessionId":"s","episodeId":"e","positionMs":1000,"durationMs":2000,"status":"playing"}""",
            server.takeRequest().body?.utf8(),
        )
        client().ackCommand(12)
        assertEquals("/api/v1/tv/commands/12/ack", server.takeRequest().url.encodedPath)
    }

    @Test
    fun unreachableServerIsAnIOException() = runBlocking {
        val api = client()
        server.close()
        try {
            api.healthz()
            fail("expected IOException")
        } catch (e: IOException) {
            // expected
        }
    }
}
