package io.github.mickeiik.izle.data.api

import io.github.mickeiik.izle.json
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.TimeUnit

/** The check routes in [ApiClient] (start a Home's or a show's run, follow it, stop it) against MockWebServer. */
class CheckApiTest {
    private val server = MockWebServer()
    private val http = OkHttpClient()

    @Before
    fun setUp() = server.start()

    @After
    fun tearDown() = server.close()

    private fun client() = ApiClient(server.url("/izle/"), "izph_secret", http)

    private fun takeRequest(method: String, path: String): RecordedRequest = server.takeRequest().also {
        assertEquals(method, it.method)
        assertEquals(path, it.url.encodedPath)
        assertEquals("Bearer izph_secret", it.headers["Authorization"])
    }

    @Test
    fun aHomeCheckSendsTheDeviceAndModeAndDecodesTheRun() = runBlocking {
        server.enqueue(json(202, """{"run":$RUNNING}"""))
        val run = client().startHomeCheck("tv-1", CheckRun.MODE_QUICK)
        assertEquals("""{"deviceId":"tv-1","mode":"quick"}""", takeRequest("POST", "/izle/api/v1/admin/checks").body?.utf8())
        assertEquals("r1", run.id)
        assertEquals(CheckTarget(deviceId = "tv-1", mode = "quick"), run.target)
        assertEquals("Salon", run.title)
        assertTrue(run.running)
        assertEquals(7L, run.seq)
        assertEquals(40, run.total)
        assertEquals(12, run.done)
        assertEquals(1, run.failed)
        assertEquals(2, run.warned)
        assertNull(run.finishedAt)
        assertEquals(listOf(CheckSkipped("gone", null, "missing"), CheckSkipped("tears", "Tears", "not_playable")), run.skipped)
        assertEquals(CheckResult("sintel.e1", "sintel", "sintel.e1", "Sintel", "S1 E1 · Pilot", "fail"), run.results.single())
    }

    @Test
    fun aShowCheckSendsTheItem() = runBlocking {
        server.enqueue(json(202, """{"run":{"id":"r2","target":{"itemId":"sintel"},"title":"Sintel","state":"running","seq":1,"total":8,"done":0,"failed":0,"warned":0,"startedAt":"2026-10-27T10:00:00.000Z","finishedAt":null,"skipped":[],"results":[]}}"""))
        val run = client().startShowCheck("sintel")
        assertEquals("""{"itemId":"sintel"}""", takeRequest("POST", "/izle/api/v1/admin/checks").body?.utf8())
        assertEquals(CheckTarget(itemId = "sintel"), run.target)
        assertEquals(8, run.total)
    }

    @Test
    fun aRunAlreadyGoingIsNamedInTheRefusal() {
        server.enqueue(json(409, """{"error":"check_running","message":"a check is running","runId":"r1"}"""))
        server.enqueue(json(400, """{"error":"nothing_to_check"}"""))
        val running = assertThrows(ApiException::class.java) { runBlocking { client().startShowCheck("sintel") } }
        assertEquals(409, running.status)
        assertEquals("check_running", running.code)
        assertEquals("r1", running.runId)
        val nothing = assertThrows(ApiException::class.java) { runBlocking { client().startHomeCheck("tv-1", CheckRun.MODE_FULL) } }
        assertEquals("nothing_to_check", nothing.code)
        assertNull(nothing.runId)
    }

    @Test
    fun aRunIsReadAtOnceOrWaitedForOnTheLongPollClient() = runBlocking {
        // The short client would give up at once; the long-poll one waits.
        val impatient = OkHttpClient.Builder().readTimeout(1, TimeUnit.MILLISECONDS).build()
        server.enqueue(json(200, """{"run":$RUNNING}""").newBuilder().headersDelay(200, TimeUnit.MILLISECONDS).build())
        server.enqueue(json(200, """{"run":$RUNNING}"""))
        val api = ApiClient(server.url("/izle/"), "izph_secret", impatient, http)

        assertEquals(7L, api.checkRun("r1", seq = 6, waitMs = 25_000).seq)
        val waited = takeRequest("GET", "/izle/api/v1/admin/checks/r1").url
        assertEquals("6", waited.queryParameter("seq"))
        assertEquals("25000", waited.queryParameter("wait"))

        client().checkRun("r1")
        val now = takeRequest("GET", "/izle/api/v1/admin/checks/r1").url
        assertNull(now.queryParameter("seq"))
        assertNull(now.queryParameter("wait"))
    }

    @Test
    fun theCurrentRunMayBeNone() = runBlocking {
        server.enqueue(json(200, """{"run":null}"""))
        server.enqueue(json(200, """{"run":$RUNNING}"""))
        val api = client()
        assertNull(api.currentCheck())
        takeRequest("GET", "/izle/api/v1/admin/checks/current")
        assertEquals("r1", api.currentCheck()?.id)
    }

    @Test
    fun stoppingARunAnswersItCancelled() = runBlocking {
        server.enqueue(json(200, """{"run":{"id":"r 1","target":{"deviceId":"tv-1","mode":"full"},"title":"Salon","state":"cancelled","seq":9,"total":40,"done":13,"failed":1,"warned":0,"startedAt":"2026-10-27T10:00:00.000Z","finishedAt":"2026-10-27T10:01:00.000Z"}}"""))
        val run = client().cancelCheck("r 1")
        takeRequest("DELETE", "/izle/api/v1/admin/checks/r%201")
        assertEquals(CheckRun.STATE_CANCELLED, run.state)
        assertFalse(run.running)
        assertEquals("2026-10-27T10:01:00.000Z", run.finishedAt)
        assertTrue(run.results.isEmpty())
    }

    private companion object {
        const val RUNNING = """{"id":"r1","target":{"deviceId":"tv-1","mode":"quick"},"title":"Salon","state":"running","seq":7,"total":40,"done":12,"failed":1,"warned":2,"startedAt":"2026-10-27T10:00:00.000Z","finishedAt":null,"skipped":[{"itemId":"gone","title":null,"reason":"missing"},{"itemId":"tears","title":"Tears","reason":"not_playable"}],"results":[{"playableId":"sintel.e1","itemId":"sintel","episodeId":"sintel.e1","title":"Sintel","label":"S1 E1 · Pilot","verdict":"fail"}]}"""
    }
}
