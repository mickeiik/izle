package io.github.mickeiik.izle.companion.home

import android.content.Context
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.data.api.CheckRun
import io.github.mickeiik.izle.data.api.CheckSkipped
import io.github.mickeiik.izle.data.api.CheckTarget
import io.github.mickeiik.izle.json
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

/**
 * The Home tab's checks against an in-process server: a Home check followed to its end, a start refused while another
 * run goes (that one is followed and named), Stop, a run found going when the tab opens, and the strip's words.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class CheckRunsTest {
    private val server = MockWebServer()
    private val requests = CopyOnWriteArrayList<RecordedRequest>()
    private val scope = MainScope()
    private val notices = CopyOnWriteArrayList<HomeNotice>()
    private val res = ApplicationProvider.getApplicationContext<Context>().resources

    /** The answer of `POST admin/checks`, then the run's states one long-poll after another. */
    @Volatile private var startAnswer: () -> MockResponse = { json(202, """{"run":${run("r1", 1, 0)}}""") }
    private val states = CopyOnWriteArrayList<String>()
    @Volatile private var current: String = "null"

    @Before
    fun setUp() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                val path = request.url.encodedPath
                return when {
                    path == "/api/v1/admin/checks" && request.method == "POST" -> startAnswer()
                    path == "/api/v1/admin/checks/current" -> json(200, """{"run":$current}""")
                    path == "/api/v1/admin/checks/r1" && request.method == "DELETE" -> json(200, """{"run":${run("r1", 9, 3, state = "cancelled")}}""")
                    // The run's states in turn; the last one again after a pause, as a long-poll that saw no change.
                    path.startsWith("/api/v1/admin/checks/") ->
                        if (states.size > 1) json(200, """{"run":${states.removeAt(0)}}""")
                        else json(200, """{"run":${states.firstOrNull() ?: run("r1", 1, 0)}}""").newBuilder().headersDelay(100, TimeUnit.MILLISECONDS).build()
                    path == "/api/v1/admin/devices/tv-1" -> json(200, DEVICE)
                    path == "/api/v1/admin/events" -> json(200, """{"events":[],"last":10,"gap":false}""")
                    else -> json(404, """{"error":"not_found"}""")
                }
            }
        }
        server.start()
    }

    @After
    fun tearDown() {
        scope.cancel()
        server.close()
    }

    @Test
    fun aHomeCheckIsFollowedUntilItEnds() {
        states += run("r1", 2, 12, failed = 1)
        states += run("r1", 3, 40, failed = 1, state = "done")
        val checks = checks()
        checks.startHome("tv-1", CheckRun.MODE_QUICK)
        waitUntil("the end") { checks.run.value?.state == CheckRun.STATE_DONE }
        assertEquals("""{"deviceId":"tv-1","mode":"quick"}""", requests.first { it.method == "POST" }.body?.utf8())
        val polls = requests.filter { it.url.encodedPath == "/api/v1/admin/checks/r1" }
        assertEquals(listOf("1", "2"), polls.map { it.url.queryParameter("seq") })
        assertEquals("25000", polls.first().url.queryParameter("wait"))
        assertEquals(40, checks.run.value?.done)
        // The result stays until dismissed (or a few seconds pass).
        checks.dismiss()
        assertNull(checks.run.value)
        assertTrue(notices.isEmpty())
    }

    @Test
    fun startingWhileAnotherRunGoesFollowsThatOneAndSaysSo() {
        startAnswer = { json(409, """{"error":"check_running","runId":"r1"}""") }
        states += run("r1", 4, 5, target = """{"itemId":"sintel"}""", title = "Sintel")
        val checks = checks()
        checks.startShow("bunny")
        waitUntil("the notice") { notices.isNotEmpty() }
        val notice = notices.single() as HomeNotice.CheckRunning
        assertEquals("Sintel", notice.run.title)
        assertEquals("A check is already running: Sintel", noticeText(res, notice, "Salon"))
        assertEquals("""{"itemId":"bunny"}""", requests.first { it.method == "POST" }.body?.utf8())
        waitUntil("followed") { checks.run.value?.id == "r1" }
    }

    @Test
    fun aRefusalIsSaid() {
        startAnswer = { json(400, """{"error":"nothing_to_check"}""") }
        checks().startHome("tv-1", CheckRun.MODE_FULL)
        waitUntil("the notice") { notices.isNotEmpty() }
        assertEquals("Nothing to check: no episode or channel there may be played.", noticeText(res, notices.single(), "Salon"))
    }

    @Test
    fun stopCancelsTheRunShown() {
        val checks = checks()
        checks.startHome("tv-1", CheckRun.MODE_QUICK)
        waitUntil("running") { checks.run.value?.running == true }
        checks.stop()
        waitUntil("stopped") { checks.run.value?.state == CheckRun.STATE_CANCELLED }
        assertEquals(1, requests.count { it.method == "DELETE" && it.url.encodedPath == "/api/v1/admin/checks/r1" })
    }

    @Test
    fun theTabFollowsARunAlreadyGoingForThisHome() {
        current = run("r1", 3, 2, target = """{"itemId":"bunny"}""", title = "Big Buck Bunny")
        val vm = HomeViewModel(ApiClient(server.url("/"), "izph_test", OkHttpClient()), "tv-1")
        val follow = scope.launch { vm.follow() }
        waitUntil("followed") { vm.checks.run.value?.id == "r1" }
        follow.cancel()

        // A run about a show this Home does not have is not this tab's.
        current = run("r2", 3, 2, target = """{"itemId":"elsewhere"}""")
        val other = HomeViewModel(ApiClient(server.url("/"), "izph_test", OkHttpClient()), "tv-1")
        val again = scope.launch { other.follow() }
        waitUntil("loaded") { other.state.value.loaded && requests.count { it.url.encodedPath == "/api/v1/admin/checks/current" } == 2 }
        settle()
        assertNull(other.checks.run.value)
        again.cancel()
    }

    @Test
    fun theStripsWords() {
        val home = CheckRun("r1", CheckTarget(deviceId = "tv-1", mode = "quick"), "Salon", total = 40, done = 12, failed = 1)
        assertEquals("Home of Salon, quick", runTitle(res, home))
        assertEquals("Home of Salon, full", runTitle(res, home.copy(target = CheckTarget(deviceId = "tv-1", mode = "full"))))
        assertEquals("Sintel", runTitle(res, home.copy(target = CheckTarget(itemId = "sintel"), title = "Sintel")))
        assertEquals("12 of 40 checked · 1 failing", runProgressText(res, home))
        val skipped = home.copy(warned = 2, skipped = listOf(CheckSkipped("gone", null, "missing"), CheckSkipped("tears", "Tears", "not_playable")))
        assertEquals("12 of 40 checked · 1 failing · 2 with warnings · 2 skipped", runProgressText(res, skipped))
        assertEquals("Stopped: 12 of 40 checked · 1 failing", runProgressText(res, home.copy(state = "cancelled")))
        assertEquals("Done: 40 checked · all work", runProgressText(res, home.copy(state = "done", done = 40, failed = 0)))
        assertEquals("Done: 40 checked · 1 failing", runProgressText(res, skipped.copy(state = "done", done = 40, warned = 0), countSkipped = false))
        assertEquals("Skipped: gone (missing from the catalog), Tears (not playable).", skippedText(res, skipped))
        assertNull(skippedText(res, home))
        assertEquals(Verdict.Fails, runVerdict(home))
        assertEquals(Verdict.Works, runVerdict(home.copy(state = "done", failed = 0)))
        assertEquals(Verdict.NotChecked, runVerdict(home.copy(state = "cancelled", failed = 0)))
    }

    private fun checks(): CheckRuns = CheckRuns(ApiClient(server.url("/"), "izph_test", OkHttpClient()), scope) { notices += it }

    private val mainLooper get() = shadowOf(Looper.getMainLooper())

    private fun waitUntil(what: String, condition: () -> Boolean) {
        repeat(500) {
            mainLooper.idle()
            if (condition()) return
            Thread.sleep(10)
        }
        fail("Timed out waiting for $what; requests: ${requests.map { "${it.method} ${it.url}" }}")
    }

    private fun settle() = repeat(20) {
        mainLooper.idle()
        Thread.sleep(10)
    }

    private companion object {
        fun run(id: String, seq: Int, done: Int, failed: Int = 0, state: String = "running", target: String = """{"deviceId":"tv-1","mode":"quick"}""", title: String = "Salon") =
            """{"id":"$id","target":$target,"title":"$title","state":"$state","seq":$seq,"total":40,"done":$done,"failed":$failed,"warned":0,"skipped":[],"results":[]}"""

        const val DEVICE = """{"device":{"id":"tv-1","name":"Salon","status":"active","online":true},
            "home":[{"itemId":"bunny","title":"Big Buck Bunny","kind":"movie","missing":false,"playable":true}],
            "sections":[{"id":"untitled","title":null,"layout":"grid","itemIds":["bunny"]}]}"""
    }
}
