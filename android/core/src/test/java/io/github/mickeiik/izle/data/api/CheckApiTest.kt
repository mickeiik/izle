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

    @Test
    fun storedReportsDecodeStepsCodecsAndWarnings() = runBlocking {
        server.enqueue(json(200, """{"itemId":"show-1","episodeId":"s1e1","check":{"verdict":"warn","checkedAt":"2026-10-27T09:00:00.000Z","working":2,"total":2,"stale":true},"sources":[$HLS_REPORT,$FAILED_REPORT]}"""))
        server.enqueue(json(200, """{"itemId":"news","episodeId":null,"check":null,"sources":[]}"""))
        val api = client()

        val checks = api.checkPlayable("s1 e1")
        assertNull(takeRequest("GET", "/izle/api/v1/admin/checks/playables/s1%20e1").url.queryParameter("itemId"))
        assertEquals("s1e1", checks.episodeId)
        assertEquals(true, checks.check?.stale)
        val (hls, failed) = checks.sources
        assertEquals("main", hls.sourceId)
        assertTrue(hls.ok)
        assertEquals("warn", hls.verdict)
        assertEquals(CheckedStream("hls", "proxy", CandidateLanguages(listOf("en", "tr"), listOf("en")), null), hls.stream)
        assertEquals(listOf("no_range"), hls.warnings)
        assertEquals(VariantCodecs("avc1.64001f,mp4a.40.2", "1920x1080", 5_000_000), hls.codecs.single())
        assertEquals(CheckStep("segment", 0, "variant", "cdn.test", false, 504, 10_000, "timeout", null, null), hls.steps.last())
        assertEquals("2026-10-27T09:00:00.000Z", hls.checkedAt)
        assertTrue(hls.stale)
        // A source that did not resolve: no steps, why in code and name.
        assertFalse(failed.ok)
        assertEquals("error", failed.code)
        assertEquals("InvalidResult", failed.name)
        assertEquals("example", failed.adapterId)
        assertTrue(failed.steps.isEmpty())
        assertFalse(failed.stale)

        // A channel whose id an episode shares: by its item id.
        val channel = api.checkPlayable("news", itemId = "news")
        assertEquals("news", takeRequest("GET", "/izle/api/v1/admin/checks/playables/news").url.queryParameter("itemId"))
        assertNull(channel.episodeId)
        assertNull(channel.check)
    }

    @Test
    fun checkingNowSendsOneOfEpisodeAndItemOnTheLongPollClient() = runBlocking {
        val impatient = OkHttpClient.Builder().readTimeout(1, TimeUnit.MILLISECONDS).build()
        val answer = """{"itemId":"show-1","episodeId":"s1e1","playbackAllowed":true,"verdict":"fail","checkedAt":"2026-10-27T10:00:00.000Z","sources":[$FAILED_REPORT]}"""
        server.enqueue(json(200, answer).newBuilder().headersDelay(200, TimeUnit.MILLISECONDS).build())
        server.enqueue(json(200, """{"itemId":"news","episodeId":null,"playbackAllowed":false,"verdict":"ok","checkedAt":"2026-10-27T10:00:00.000Z","sources":[]}"""))
        val api = ApiClient(server.url("/izle/"), "izph_secret", impatient, http)

        val report = api.checkNow(episodeId = "s1e1")
        assertEquals("""{"episodeId":"s1e1"}""", takeRequest("POST", "/izle/api/v1/admin/diagnostics/resolve").body?.utf8())
        assertEquals("fail", report.verdict)
        assertTrue(report.playbackAllowed)
        assertEquals("missing", report.sources.single().sourceId)

        val channel = api.checkNow(itemId = "news")
        assertEquals("""{"itemId":"news"}""", takeRequest("POST", "/izle/api/v1/admin/diagnostics/resolve").body?.utf8())
        assertNull(channel.episodeId)
        assertFalse(channel.playbackAllowed)

        assertThrows(IllegalArgumentException::class.java) { runBlocking { api.checkNow() } }
        assertThrows(IllegalArgumentException::class.java) { runBlocking { api.checkNow("s1e1", "news") } }
        Unit
    }

    private companion object {
        const val HLS_REPORT = """{"sourceId":"main","type":"direct","ok":true,"ms":3,"results":[{"kind":"hls"}],
            "stream":{"kind":"hls","inline":false,"host":"cdn.test","headerNames":["Referer"],"delivery":"proxy","languages":{"audio":["en","tr"],"subtitles":["en"]},"subtitleTracks":0,"label":null,"expiresAt":null},
            "verdict":"warn","checkMs":9,"warnings":["no_range"],"codecs":[{"codecs":"avc1.64001f,mp4a.40.2","resolution":"1920x1080","bandwidth":5000000}],
            "steps":[{"what":"playlist","host":"cdn.test","ok":true,"status":200,"ms":2,"container":"m3u8"},
                     {"what":"segment","index":0,"of":"variant","host":"cdn.test","ok":false,"status":504,"ms":10000,"error":"timeout"}],
            "checkedAt":"2026-10-27T09:00:00.000Z","stale":true}"""
        const val FAILED_REPORT = """{"sourceId":"missing","type":"adapter","adapterId":"example","ok":false,"ms":1,"code":"error","name":"InvalidResult","verdict":"fail","steps":[],"codecs":[],"warnings":[],"checkMs":0}"""
        const val RUNNING = """{"id":"r1","target":{"deviceId":"tv-1","mode":"quick"},"title":"Salon","state":"running","seq":7,"total":40,"done":12,"failed":1,"warned":2,"startedAt":"2026-10-27T10:00:00.000Z","finishedAt":null,"skipped":[{"itemId":"gone","title":null,"reason":"missing"},{"itemId":"tears","title":"Tears","reason":"not_playable"}],"results":[{"playableId":"sintel.e1","itemId":"sintel","episodeId":"sintel.e1","title":"Sintel","label":"S1 E1 · Pilot","verdict":"fail"}]}"""
    }
}
