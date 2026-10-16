package io.github.mickeiik.izle.data.api

import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.IOException
import java.util.concurrent.TimeUnit

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

    private inline fun <reified T : Throwable> failsWith(noinline call: suspend () -> Unit): T =
        assertThrows(T::class.java) { runBlocking { call() } }

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
        val r = api.resolve(ResolveRequest("m.film", exclude = listOf("b"), trigger = Trigger.Command, commandId = 12))
        assertEquals("${server.url("/")}p/x/file.mp4", api.resolve(r.media.url).toString())
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertTrue(request.headers["Content-Type"]!!.startsWith("application/json"))
        assertEquals("""{"episodeId":"m.film","exclude":["b"],"trigger":"command","commandId":12}""", request.body?.utf8())
    }

    @Test
    fun commandResultsArePostedToTheCommandsRoute() = runBlocking {
        server.enqueue(json("""{"ok":true}"""))
        server.enqueue(json("""{"error":"already_reported"}""", code = 409))
        client().reportCommandResult(12, CommandResult.ignored(CommandResult.NOT_IN_PLAYER))
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/v1/tv/commands/12/result", request.url.encodedPath)
        assertEquals("Bearer device-token", request.headers["Authorization"])
        assertEquals("""{"result":"ignored","reason":"not_in_player"}""", request.body?.utf8())
        val refused = failsWith<ApiException> { client().reportCommandResult(12, CommandResult.Done) }
        assertEquals("already_reported", refused.code)
        assertEquals("""{"result":"done"}""", server.takeRequest().body?.utf8())
    }

    @Test
    fun resolveWaitsLongerThanOtherCalls() = runBlocking<Unit> {
        // The server may spend its whole resolver budget (30 s) before answering; other calls time out sooner.
        val short = OkHttpClient.Builder().readTimeout(200, TimeUnit.MILLISECONDS).build()
        val long = OkHttpClient.Builder().readTimeout(5, TimeUnit.SECONDS).build()
        val api = ApiClient(server.url("/"), "device-token", short, long)
        val slow = { body: String -> json(body).newBuilder().headersDelay(600, TimeUnit.MILLISECONDS).build() }
        server.enqueue(slow("""{"sessionId":"s","sourceId":"a","media":{"kind":"hls","url":"/p/x/index.m3u8"},"item":{"id":"m","kind":"movie","title":"M"},"episode":{"id":"m.film"}}"""))
        assertEquals("a", api.resolve(ResolveRequest("m.film")).sourceId)
        server.enqueue(slow("""{"version":1,"device":{"id":"d","name":"TV"},"catalog":{"id":"c","buildId":"b","name":"n"},"home":[]}"""))
        failsWith<IOException> { api.state() } // a read timeout
    }

    @Test
    fun errorAnswersBecomeApiExceptions() = runBlocking {
        server.enqueue(json("""{"error":"not_allowed","message":"playback of this episode is not allowed"}""", code = 403))
        server.enqueue(MockResponse.Builder().code(429).addHeader("Retry-After", "42").body("""{"error":"rate_limited"}""").build())
        server.enqueue(MockResponse.Builder().code(502).body("<html>bad gateway</html>").build())
        val notAllowed = failsWith<ApiException> { client().resolve(ResolveRequest("e")) }
        assertEquals(403, notAllowed.status)
        assertEquals("not_allowed", notAllowed.code)
        val limited = failsWith<ApiException> { client(token = null).pairStart() }
        assertEquals("rate_limited", limited.code)
        assertEquals(42L, limited.retryAfterSec)
        assertEquals("http_502", failsWith<ApiException> { client().state() }.code)
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
        assertEquals(9L, client().progress(ProgressReport("s", "e", 1_000, 2_000, ProgressStatus.Playing)).version)
        assertEquals(
            """{"sessionId":"s","episodeId":"e","positionMs":1000,"durationMs":2000,"status":"playing"}""",
            server.takeRequest().body?.utf8(),
        )
        client().ackCommand(12)
        assertEquals("/api/v1/tv/commands/12/ack", server.takeRequest().url.encodedPath)
    }

    @Test
    fun resolveCarriesTheServersClock() = runBlocking {
        val body = """{"sessionId":"s","sourceId":"a","media":{"kind":"hls","url":"/p/x/index.m3u8"},"item":{"id":"m","kind":"movie","title":"M"},
                      "episode":{"id":"m.film"},"expiresAt":"2026-10-14T12:01:40.000Z"}"""
        server.enqueue(json(body).newBuilder().addHeader("Date", "Wed, 14 Oct 2026 12:00:00 GMT").build())
        server.enqueue(json(body))
        val r = client().resolve(ResolveRequest("m.film"))
        assertEquals("2026-10-14T12:01:40.000Z", r.expiresAt)
        assertEquals(1_791_979_200_000L, r.serverDateMs)
        assertNull("no Date header: the TV's own clock is used", client().resolve(ResolveRequest("m.film")).serverDateMs)
    }

    @Test
    fun problemReportsArePostedWithTheDeviceToken() = runBlocking {
        server.enqueue(json("""{"ok":true}""", code = 202))
        server.enqueue(json("""{"error":"invalid_request"}""", code = 400))
        val report = ProblemReport(kind = "playback", code = "gave_up", episodeId = "e", detail = "tried 2 sources", appVersion = "0.2.0")
        client().reportProblem(report)
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/v1/tv/problems", request.url.encodedPath)
        assertEquals("Bearer device-token", request.headers["Authorization"])
        assertEquals("""{"kind":"playback","code":"gave_up","episodeId":"e","detail":"tried 2 sources","appVersion":"0.2.0"}""", request.body?.utf8())
        val refused = failsWith<ApiException> { client().reportProblem(report) }
        assertEquals("an older server: the reporter ignores it", 400, refused.status)
    }

    @Test
    fun anUnreachableServerIsAnIOExceptionAndOrNullOnFailureIgnoresOnlyTheServersFailures() = runBlocking<Unit> {
        server.enqueue(json("""{"ok":true}"""))
        server.enqueue(json("""{"error":"unknown_command"}""", code = 404))
        val api = client()
        assertEquals(Unit, orNullOnFailure { api.healthz() })
        assertNull("an error answer", orNullOnFailure { api.ackCommand(12) })
        server.close()
        failsWith<IOException> { api.healthz() }
        assertNull("an unreachable server", orNullOnFailure { api.healthz() })
        // Anything else goes on: a bug, or the coroutine's cancellation.
        failsWith<IllegalStateException> { orNullOnFailure { error("a bug") } }
    }
}
