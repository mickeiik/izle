package io.github.mickeiik.izle.data.api

import io.github.mickeiik.izle.json
import io.github.mickeiik.izle.update.AvailableUpdate
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
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

/** ApiClient and EventsClient against an in-process MockWebServer (no network). */
class ApiClientTest {
    private val server = MockWebServer()
    private val http = OkHttpClient()

    @Before
    fun setUp() = server.start()

    @After
    fun tearDown() = server.close()

    private fun client(token: String? = "device-token", path: String = "/") = ApiClient(server.url(path), token, http)

    private inline fun <reified T : Throwable> failsWith(noinline call: suspend () -> Unit): T =
        assertThrows(T::class.java) { runBlocking { call() } }

    /** The next request, checked to be [method] [path] with the device token. */
    private fun takeRequest(method: String, path: String): RecordedRequest = server.takeRequest().also {
        assertEquals(method, it.method)
        assertEquals(path, it.url.encodedPath)
        assertEquals("Bearer device-token", it.headers["Authorization"])
    }

    /** Every event of one connection to [server], and how the stream ended. */
    private suspend fun connect(token: String): Pair<List<ServerEvent>, Throwable?> {
        var failure: Throwable? = null
        val events = withTimeout(5_000) { EventsClient(http).events(client(token)).catch { failure = it }.toList() }
        return events to failure
    }

    @Test
    fun stateSendsTheDeviceTokenAndEveryCallSaysWhichAppAndHowItUpdates() = runBlocking {
        server.enqueue(json(200, STATE))
        server.enqueue(json(200, """{"code":"483920","pairToken":"pair-secret"}"""))
        var agent = "izle-tv/0.2.0 (Android 25; 200; guided)"
        val api = ApiClient(server.url("/"), "device-token", http, userAgent = { agent })
        assertEquals(3L, api.state().version)
        assertEquals(agent, takeRequest("GET", "/api/v1/tv/state").headers["User-Agent"])
        // Read anew for each request: the capability may change.
        agent = "izle-tv/0.2.0 (Android 31; 200; silent)"
        api.pairStart()
        assertEquals(agent, server.takeRequest().headers["User-Agent"])
    }

    @Test
    fun appIsTheOfferedVersionOrNothing() = runBlocking {
        val sha = "AB".repeat(32)
        server.enqueue(json(200, """{"versionName":"0.3.0","versionCode":300,"sha256":"$sha","size":12345678,"auto":false,"uploadedAt":"x"}"""))
        server.enqueue(MockResponse.Builder().code(204).build())
        server.enqueue(json(200, """{"versionName":"0.3.0","versionCode":300,"sha256":"nope","size":1}"""))
        assertEquals(AvailableUpdate("0.3.0", 300, sha.lowercase(), 12_345_678, auto = false), client().app())
        takeRequest("GET", "/api/v1/tv/app")
        assertNull("204: nothing stored", client().app())
        assertEquals("bad_response", failsWith<ApiException> { client().app() }.code)
    }

    @Test
    fun worksBelowAPathPrefix() = runBlocking {
        server.enqueue(json(200, """{"item":{"id":"caminandes","kind":"series","title":"C"},"cursorEpisodeId":null,"episodes":[]}"""))
        client(path = "/izle/").item("caminandes")
        assertEquals("/izle/api/v1/tv/items/caminandes", server.takeRequest().url.encodedPath)
    }

    @Test
    fun resolvePostsJson() = runBlocking {
        server.enqueue(json(200, RESOLVE))
        val api = client()
        val r = api.resolve(ResolveRequest("m.film", exclude = listOf("b"), trigger = Trigger.Command, commandId = 12))
        assertEquals("${server.url("/")}p/x/index.m3u8", api.resolve(r.media.url).toString())
        val request = takeRequest("POST", "/api/v1/tv/resolve")
        assertTrue(request.headers["Content-Type"]!!.startsWith("application/json"))
        assertEquals("""{"episodeId":"m.film","exclude":["b"],"trigger":"command","commandId":12}""", request.body?.utf8())
    }

    @Test
    fun reportsArePostedWithTheDeviceToken() = runBlocking {
        val problem = ProblemReport(kind = "playback", code = "gave_up", episodeId = "e", detail = "tried 2 sources", appVersion = "0.2.0")
        val progress = ProgressReport("s", episodeId = "e", positionMs = 1_000, durationMs = 2_000, status = ProgressStatus.Playing)
        val posts = listOf<Triple<suspend ApiClient.() -> Unit, String, String>>(
            Triple(
                { progress(progress) },
                "/api/v1/tv/progress",
                """{"sessionId":"s","episodeId":"e","positionMs":1000,"durationMs":2000,"status":"playing"}""",
            ),
            Triple({ ackCommand(12) }, "/api/v1/tv/commands/12/ack", ""),
            Triple(
                { reportCommandResult(12, CommandResult.ignored(CommandResult.NOT_IN_PLAYER)) },
                "/api/v1/tv/commands/12/result",
                """{"result":"ignored","reason":"not_in_player"}""",
            ),
            Triple(
                { reportProblem(problem) },
                "/api/v1/tv/problems",
                """{"kind":"playback","code":"gave_up","episodeId":"e","detail":"tried 2 sources","appVersion":"0.2.0"}""",
            ),
        )
        for ((call, path, body) in posts) {
            server.enqueue(json(200, """{"ok":true}"""))
            client().call()
            assertEquals(path, body, takeRequest("POST", path).body?.utf8().orEmpty())
        }
    }

    @Test
    fun resolveWaitsLongerThanOtherCalls() = runBlocking<Unit> {
        // The server may spend its whole resolver budget (30 s) before answering; other calls time out sooner.
        val short = OkHttpClient.Builder().readTimeout(200, TimeUnit.MILLISECONDS).build()
        val long = OkHttpClient.Builder().readTimeout(5, TimeUnit.SECONDS).build()
        val api = ApiClient(server.url("/"), "device-token", short, long)
        val slow = { body: String -> json(200, body).newBuilder().headersDelay(600, TimeUnit.MILLISECONDS).build() }
        server.enqueue(slow(RESOLVE))
        assertEquals("a", api.resolve(ResolveRequest("m.film")).sourceId)
        server.enqueue(slow(STATE))
        failsWith<IOException> { api.state() } // a read timeout
    }

    @Test
    fun errorAnswersBecomeApiExceptions() = runBlocking {
        server.enqueue(json(403, """{"error":"not_allowed","message":"playback of this episode is not allowed"}"""))
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
        server.enqueue(json(200, """{"code":"483920","pairToken":"pair-secret","expiresAt":"2026-10-10T10:10:00.000Z"}"""))
        server.enqueue(json(200, """{"status":"pending"}"""))
        server.enqueue(json(200, """{"status":"approved","deviceId":"abcdefabcdef","deviceToken":"tok"}"""))
        server.enqueue(json(410, """{"error":"expired","status":"expired"}"""))
        val api = client(token = null)
        val start = api.pairStart()
        assertNull(server.takeRequest().headers["Authorization"])
        assertEquals("pending", api.pairWait(start.code, start.pairToken, waitSec = 0).status)
        val waitRequest = server.takeRequest()
        assertEquals("Bearer pair-secret", waitRequest.headers["Authorization"])
        assertEquals("483920", waitRequest.url.queryParameter("code"))
        assertEquals("0", waitRequest.url.queryParameter("wait"))
        assertEquals("tok", api.pairWait(start.code, start.pairToken, waitSec = 0).deviceToken)
        assertEquals("expired", api.pairWait(start.code, start.pairToken, waitSec = 0).status)
    }

    @Test
    fun resolveCarriesTheServersClock() = runBlocking {
        val body = RESOLVE.dropLast(1) + ""","expiresAt":"2026-10-14T12:01:40.000Z"}"""
        server.enqueue(json(200, body).newBuilder().addHeader("Date", "Wed, 14 Oct 2026 12:00:00 GMT").build())
        server.enqueue(json(200, body))
        val r = client().resolve(ResolveRequest("m.film"))
        assertEquals("2026-10-14T12:01:40.000Z", r.expiresAt)
        assertEquals(1_791_979_200_000L, r.serverDateMs)
        assertNull("no Date header: the TV's own clock is used", client().resolve(ResolveRequest("m.film")).serverDateMs)
    }

    @Test
    fun anUnreachableServerIsAnIOExceptionAndOrNullOnFailureIgnoresOnlyTheServersFailures() = runBlocking<Unit> {
        server.enqueue(json(200, """{"ok":true}"""))
        server.enqueue(json(404, """{"error":"unknown_command"}"""))
        val api = client()
        assertEquals(Unit, orNullOnFailure { api.healthz() })
        assertNull("an error answer", orNullOnFailure { api.ackCommand(12) })
        server.close()
        failsWith<IOException> { api.healthz() }
        assertNull("an unreachable server", orNullOnFailure { api.healthz() })
        // Anything else goes on: a bug, or the coroutine's cancellation.
        failsWith<IllegalStateException> { orNullOnFailure { error("a bug") } }
    }

    @Test
    fun streamsStateAndCommandEvents() = runBlocking<Unit> {
        server.enqueue(
            MockResponse.Builder()
                .addHeader("Content-Type", "text/event-stream")
                .body(
                    "retry: 5000\nevent: state\nid: s4\ndata: {\"version\":4}\n\n" +
                        ": ping\n\n" +
                        "event: command\nid: c7\n" +
                        "data: {\"id\":7,\"type\":\"play\",\"payload\":{\"itemId\":\"show\",\"episodeId\":\"show.e1\"}}\n\n" +
                        "event: app\nid: a300\ndata: {\"versionCode\":300}\n\n" +
                        "event: command\nid: c8\ndata: {\"id\":8,\"type\":\"update\",\"payload\":{\"versionCode\":300}}\n\n" +
                        "event: future\ndata: {}\n\n",
                )
                .build(),
        )
        val (events, failure) = connect("device-token")
        val play = ServerEvent.Command(7, "play", "show", "show.e1")
        val update = ServerEvent.Command(8, "update", versionCode = 300)
        assertEquals(listOf(ServerEvent.Open, ServerEvent.State(4), play, ServerEvent.App(300), update), events)
        assertTrue("the end of the stream is a failure to reconnect from", failure is IOException)
        takeRequest("GET", "/api/v1/tv/events")
    }

    @Test
    fun aRemovedDeviceGets401FromTheEventStream() = runBlocking {
        server.enqueue(MockResponse.Builder().code(401).body("""{"error":"unauthorized"}""").build())
        assertEquals(401, (connect("old").second as ApiException).status)
    }

    private companion object {
        const val STATE = """{"version":3,"device":{"id":"d","name":"TV"},"catalog":{"id":"c","buildId":"b","name":"n"},"home":[]}"""
        const val RESOLVE = """{"sessionId":"s","sourceId":"a","media":{"kind":"hls","url":"/p/x/index.m3u8"},""" +
            """"item":{"id":"m","kind":"movie","title":"M"},"episode":{"id":"m.film"}}"""
    }
}
