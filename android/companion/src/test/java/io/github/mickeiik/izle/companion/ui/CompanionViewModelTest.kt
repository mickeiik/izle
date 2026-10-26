package io.github.mickeiik.izle.companion.ui

import android.os.Looper
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.test.core.app.ApplicationProvider
import io.github.mickeiik.izle.companion.CompanionApp
import io.github.mickeiik.izle.companion.finder.FoundLink
import io.github.mickeiik.izle.companion.sync.ApiClientCompanionApi
import io.github.mickeiik.izle.companion.sync.CompanionApi
import io.github.mickeiik.izle.companion.sync.EndReason
import io.github.mickeiik.izle.companion.sync.ListenPhase
import io.github.mickeiik.izle.companion.sync.ListenService
import io.github.mickeiik.izle.companion.sync.ListenSession
import io.github.mickeiik.izle.data.api.CompanionResolveRequest
import io.github.mickeiik.izle.data.api.CompanionResolveResponse
import io.github.mickeiik.izle.data.api.CompanionResponse
import io.github.mickeiik.izle.data.api.NowResponse
import io.github.mickeiik.izle.json
import io.github.mickeiik.izle.player.FakeMediaEngine
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.runBlocking
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The real [CompanionViewModel], store and API client under Robolectric against an in-process server: pairing and its
 * errors, the TV picker, the Listen along screen's refresh, Save timing, Apply to all, a channel, and Listen starting
 * the session and the foreground service. The session's API never answers (the session's own tests cover it).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class CompanionViewModelTest {
    private val app: CompanionApp = ApplicationProvider.getApplicationContext()
    private val server = MockWebServer()
    private val requests = CopyOnWriteArrayList<RecordedRequest>()
    private val viewModels = ViewModelStore()

    @Volatile private var devicesAnswer: () -> MockResponse = { json(200, DEVICES) }
    @Volatile private var companionAnswer: () -> MockResponse = { json(200, EPISODE) }

    @Before
    fun setUp() {
        app.graph.mediaEngine = { FakeMediaEngine() }
        app.graph.newSession = { _, scope -> ListenSession(NeverAnswers, FakeMediaEngine(), scope, { it }) }
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                val path = request.url.encodedPath
                return when {
                    path == "/api/v1/admin/devices" -> devicesAnswer()
                    path == "/api/v1/admin/devices/tv-1/companion" -> companionAnswer()
                    // For a session on this server: the TV at 60 s; a long-poll answers after a second.
                    path == "/api/v1/admin/devices/tv-1/now" -> nowAnswer().let { r ->
                        if (request.url.queryParameter("wait") == "0") r else r.newBuilder().headersDelay(1, TimeUnit.SECONDS).build()
                    }
                    path.endsWith("/copy-to-item") -> json(200, """{"updated":3,"episodeIds":["show.e2","show.e3","show.e4"]}""")
                    path.startsWith("/api/v1/admin/companion/links/") && request.method == "PUT" ->
                        json(200, """{"link":{"episodeId":"show.e1","sourceId":"dub","offsetMs":-1300,"rate":1.0427,"language":"fr","updatedAt":"2026-10-26T10:00:00.000Z"}}""")
                    else -> json(404, """{"error":"not_found"}""")
                }
            }
        }
        server.start()
    }

    @After
    fun tearDown() {
        viewModels.clear()
        app.graph.releaseSession()
        server.close()
    }

    @Test
    fun anInvalidAddressIsSaidWithoutARequest() {
        val vm = startUnpaired()
        vm.connect("http://bad host", "izat_x")
        assertEquals(ConnectError.InvalidAddress, (vm.ui.value as CompanionUi.Pairing).error)
        assertEquals(0, requests.size)
    }

    @Test
    fun anUnreachableServer() {
        val closed = MockWebServer().apply { start() }
        val url = closed.url("/").toString()
        closed.close()
        val vm = startUnpaired()
        vm.connect(url, "izat_x")
        waitUntil("the error") { (vm.ui.value as? CompanionUi.Pairing)?.error == ConnectError.Unreachable }
        assertFalse((vm.ui.value as CompanionUi.Pairing).busy)
        runBlocking { assertFalse(app.graph.store.current().isPaired) }
    }

    @Test
    fun aTokenTheServerDoesNotAccept() {
        devicesAnswer = { json(401, """{"error":"unauthorized"}""") }
        val vm = startUnpaired()
        vm.connect(server.url("/").toString(), "izat_wrong")
        waitUntil("the error") { (vm.ui.value as? CompanionUi.Pairing)?.error == ConnectError.TokenNotAccepted }
    }

    @Test
    fun aTokenWithoutTheCompanionScope() {
        devicesAnswer = { json(403, """{"error":"insufficient_scope","required":"companion"}""") }
        val vm = startUnpaired()
        vm.connect(server.url("/").toString(), "izat_read")
        waitUntil("the error") { (vm.ui.value as? CompanionUi.Pairing)?.error == ConnectError.NeedsCompanionScope }
    }

    @Test
    fun anotherErrorIsShownByItsCode() {
        devicesAnswer = { json(503, """{"error":"busy"}""") }
        val vm = startUnpaired()
        vm.connect(server.url("/").toString(), "izat_x")
        waitUntil("the error") { (vm.ui.value as? CompanionUi.Pairing)?.error == ConnectError.Server("busy") }
    }

    @Test
    fun connectingListsTheActiveTvsAndPickingOneOpensListenAlong() {
        val vm = startUnpaired()
        vm.connect(server.url("/").toString(), " izat_test ")
        waitUntil("the TV list") { vm.ui.value is CompanionUi.PickTv }
        val picker = vm.ui.value as CompanionUi.PickTv
        assertEquals(listOf("tv-1", "tv-2"), picker.devices.map { it.id })
        assertFalse(picker.loading)
        assertEquals("Bearer izat_test", requests.single().headers["Authorization"])
        runBlocking {
            val stored = app.graph.store.current()
            assertEquals(server.url("/").toString(), stored.serverUrl)
            assertEquals("izat_test", stored.token)
            assertNull(stored.tvId)
        }
        vm.pickTv("tv-1")
        waitUntil("Listen along") { (vm.ui.value as? CompanionUi.Listen)?.loaded == true }
        assertEquals("Living room", (vm.ui.value as CompanionUi.Listen).tvName)
        runBlocking { assertEquals("tv-1", app.graph.store.current().tvId) }
    }

    @Test
    fun oneTvGoesStraightToListenAlong() {
        devicesAnswer = { json(200, """{"devices":[{"id":"tv-1","name":"Living room","status":"active","online":true}]}""") }
        val vm = startUnpaired()
        vm.connect(server.url("/").toString(), "izat_test")
        waitUntil("Listen along") { (vm.ui.value as? CompanionUi.Listen)?.loaded == true }
        assertEquals("tv-1", (vm.ui.value as CompanionUi.Listen).tvId)
        runBlocking { assertEquals("tv-1", app.graph.store.current().tvId) }
    }

    @Test
    fun changeServerForgetsThePairing() {
        val vm = startListening()
        vm.forgetPairing()
        waitUntil("the pairing screen") { vm.ui.value is CompanionUi.Pairing }
        assertEquals(server.url("/").toString().trimEnd('/'), (vm.ui.value as CompanionUi.Pairing).initialUrl)
        runBlocking { assertFalse(app.graph.store.current().isPaired) }
        assertNull(app.graph.currentSession)
    }

    @Test
    fun theCandidatesAndTheChosenTiming() {
        val vm = startListening()
        val listen = vm.ui.value as CompanionUi.Listen
        assertEquals("Pilot", listen.nowPlaying?.episodeTitle)
        assertEquals(
            listOf("main" to null, "dub" to "fr", "dub" to "de", "pasted" to null),
            listen.options.map { it.sourceId to it.language },
        )
        // Not the TV's own source by default.
        assertEquals("dub" to "fr", listen.chosen?.let { it.sourceId to it.language })
        assertEquals("dash", listen.chosen?.kind)
        assertEquals("-1.250", listen.offsetText)
        assertEquals("1.0427", listen.speedText)
        assertTrue(listen.timingValid)
        assertTrue(listen.applyAllVisible)
        assertTrue(listen.canListen)
        assertEquals("Living room", listen.tvName)

        vm.choose(listen.options[0])
        val main = vm.ui.value as CompanionUi.Listen
        assertEquals("0.000", main.offsetText)
        assertEquals("1", main.speedText)
    }

    @Test
    fun anUnchangedAnswerKeepsWhatTheOwnerTyped() {
        val vm = startListening()
        vm.setOffsetText("-2")
        val gets = count(COMPANION)
        vm.refresh()
        waitUntil("the second read") { count(COMPANION) > gets && !(vm.ui.value as CompanionUi.Listen).refreshing }
        assertEquals("-2", (vm.ui.value as CompanionUi.Listen).offsetText)
    }

    @Test
    fun aRefreshWhileOneIsInFlightSendsNoSecondRequest() {
        val vm = startListening()
        val gate = CountDownLatch(1)
        companionAnswer = { gate.await(5, TimeUnit.SECONDS); json(200, EPISODE) }
        try {
            val gets = count(COMPANION)
            vm.refresh()
            waitUntil("the first read") { count(COMPANION) > gets }
            assertTrue((vm.ui.value as CompanionUi.Listen).refreshing)
            vm.refresh()
            settle()
            assertEquals(gets + 1, count(COMPANION))
        } finally {
            gate.countDown()
        }
        waitUntil("the answer") { !(vm.ui.value as CompanionUi.Listen).refreshing }
    }

    @Test
    fun anInvalidTimingDisablesSave() {
        val vm = startListening()
        vm.setSpeedText("3")
        assertFalse((vm.ui.value as CompanionUi.Listen).timingValid)
        vm.saveTiming()
        settle()
        assertEquals(0, requests.count { it.method == "PUT" })
        vm.setSpeedText("1.0427")
        assertTrue((vm.ui.value as CompanionUi.Listen).timingValid)
    }

    @Test
    fun saveTimingStoresItAndReadsAgain() {
        val vm = startListening()
        vm.setOffsetText("-1.300")
        val gets = count(COMPANION)
        vm.saveTiming()
        waitUntil("the snackbar") { vm.snackbar.value == "Timing saved for this episode." }
        val put = requests.single { it.method == "PUT" }
        assertEquals("/api/v1/admin/companion/links/show.e1/dub", put.url.encodedPath)
        assertEquals("""{"offsetMs":-1300,"rate":1.0427,"language":"fr"}""", put.body?.utf8())
        assertEquals("Bearer izat_test", put.headers["Authorization"])
        waitUntil("the refresh after the save") { count(COMPANION) > gets }
        vm.dismissSnackbar()
        assertNull(vm.snackbar.value)
    }

    @Test
    fun applyToAllEpisodes() {
        val vm = startListening()
        vm.applyToAll()
        waitUntil("the snackbar") { vm.snackbar.value == "Timing copied to 3 other episodes." }
        val post = requests.single { it.url.encodedPath.endsWith("/copy-to-item") }
        assertEquals("/api/v1/admin/companion/links/show.e1/dub/copy-to-item", post.url.encodedPath)
        assertEquals("POST", post.method)
    }

    @Test
    fun aChannelHasNothingToListenTo() {
        companionAnswer = { json(200, CHANNEL) }
        val vm = startListening()
        val listen = vm.ui.value as CompanionUi.Listen
        assertTrue(listen.isChannel)
        assertTrue(listen.options.isEmpty())
        assertFalse(listen.canListen)
        assertFalse(listen.applyAllVisible)
    }

    @Test
    fun listenStartsTheSessionAndTheServiceAndAChannelEndsIt() {
        val vm = startListening()
        vm.listen()
        val session = app.graph.currentSession!!
        val state = session.state.value
        assertTrue(state.phase == ListenPhase.Starting || state.phase == ListenPhase.Listening)
        assertEquals("dub", state.target?.sourceId)
        assertEquals("fr", state.target?.language)
        assertEquals("show.e1", state.target?.episodeId)
        assertEquals(-1250L, state.timing.offsetMs)
        assertEquals(1.0427, state.timing.rate, 0.0)
        val started = shadowOf(app).nextStartedService
        assertEquals(ListenService::class.java.name, started.component?.className)
        waitUntil("the session in the screen state") { (vm.ui.value as CompanionUi.Listen).listening }

        companionAnswer = { json(200, CHANNEL) }
        vm.refresh()
        waitUntil("the end") { vm.snackbar.value == "The TV switched to a channel; listening ended." }
        assertEquals(ListenPhase.Idle, session.state.value.phase)
        waitUntil("idle in the screen state") { !(vm.ui.value as CompanionUi.Listen).listening }
    }

    @Test
    fun theNudgeIsRememberedOnThePhone() {
        val vm = startListening()
        vm.nudge(50)
        vm.nudge(50)
        vm.nudge(-50)
        assertEquals(50L, (vm.ui.value as CompanionUi.Listen).nudgeMs)
        waitUntil("the stored nudge") { runBlocking { app.graph.store.current().nudgeMs } == 50L }
    }

    @Test
    fun aRevokedTokenForgetsThePairing() {
        val vm = startListening()
        companionAnswer = { json(401, """{"error":"unauthorized"}""") }
        vm.refresh()
        waitUntil("the pairing screen") { vm.ui.value is CompanionUi.Pairing }
        assertEquals("The token was not accepted; pair again.", vm.snackbar.value)
        runBlocking { assertFalse(app.graph.store.current().isPaired) }
    }

    // --- a link found on this phone --------------------------------------------------------------------------------

    @Test
    fun thePastedOptionHasItsOwnTimingAndNeedsAFoundLink() {
        val vm = startListening()
        val pasted = (vm.ui.value as CompanionUi.Listen).options.last()
        assertEquals(CandidateOption("pasted", null, "a link found on this phone", null), pasted)
        vm.choose(pasted)
        val chosen = vm.ui.value as CompanionUi.Listen
        assertEquals("3.500", chosen.offsetText)
        assertEquals("1", chosen.speedText)
        assertNull(chosen.foundLink)
        assertFalse(chosen.canListen)

        vm.openFinder()
        assertTrue((vm.ui.value as CompanionUi.Listen).finderOpen)
        vm.closeFinder()
        assertFalse((vm.ui.value as CompanionUi.Listen).finderOpen)
        vm.openFinder()
        vm.useFoundLink(LINK)
        val ready = vm.ui.value as CompanionUi.Listen
        assertEquals(LINK, ready.foundLink)
        assertFalse(ready.finderOpen)
        assertTrue(ready.canListen)
        assertEquals("3.500", ready.offsetText)

        vm.refresh() // an unchanged answer keeps the link
        settle()
        assertEquals(LINK, (vm.ui.value as CompanionUi.Listen).foundLink)
    }

    @Test
    fun listeningToAFoundLinkPlaysItOnThePhoneAndNoRequestCarriesIt() {
        val engine = FakeMediaEngine()
        app.graph.newSession = { api, scope -> ListenSession(ApiClientCompanionApi(api), engine, scope, { it }) }
        val vm = startListening()
        vm.choose((vm.ui.value as CompanionUi.Listen).options.last())
        vm.openFinder()
        vm.useFoundLink(LINK)
        vm.listen()
        val session = app.graph.currentSession!!
        val target = session.state.value.target!!
        assertEquals("pasted", target.sourceId)
        assertNull(target.language)
        assertEquals(LINK, target.foundLink)
        assertEquals(1_200_000L, target.episodeDurationMs)
        assertEquals(3_500L, session.state.value.timing.offsetMs)

        waitUntil("the link loaded") { engine.loads.isNotEmpty() && (vm.ui.value as CompanionUi.Listen).listening }
        val media = engine.loads.single().media
        assertEquals(LINK.url, media.url)
        assertEquals(LINK.headers, media.headers)
        assertEquals("hls", media.kind)
        waitUntil("the long-poll") { requests.any { it.url.queryParameter("wait") == "25" } }
        vm.saveTiming() // the pasted link's timing is stored on the server, the link itself is not
        waitUntil("the snackbar") { vm.snackbar.value == "Timing saved for this episode." }
        val put = requests.single { it.method == "PUT" }
        assertEquals("/api/v1/admin/companion/links/show.e1/pasted", put.url.encodedPath)
        assertEquals("""{"offsetMs":3500,"rate":1.0}""", put.body?.utf8())

        assertTrue(requests.none { it.url.encodedPath.endsWith("/resolve") })
        for (r in requests) {
            val seen = listOf(r.url.toString(), r.headers.joinToString("\n") { (name, value) -> "$name: $value" }, r.body?.utf8().orEmpty())
            for (text in seen) {
                for (secret in SECRETS) assertFalse("${r.method} ${r.url.encodedPath} carries part of the link", text.contains(secret))
            }
        }
    }

    @Test
    fun anExpiredLinkEndsListeningForgetsTheLinkAndKeepsTheTiming() {
        val engine = FakeMediaEngine()
        app.graph.newSession = { api, scope -> ListenSession(ApiClientCompanionApi(api), engine, scope, { it }) }
        val vm = startListening()
        vm.choose((vm.ui.value as CompanionUi.Listen).options.last())
        vm.useFoundLink(LINK)
        vm.setOffsetText("4.250")
        vm.listen()
        waitUntil("the link loaded") { engine.loads.isNotEmpty() && (vm.ui.value as CompanionUi.Listen).listening }
        engine.durationMs = 5 * 60_000L // a decoy, against an episode of 20 min
        engine.ready()
        waitUntil("the snackbar") { vm.snackbar.value == endedText(EndReason.LinkExpired, null) }
        assertEquals(EndReason.LinkExpired, app.graph.currentSession!!.state.value.ended)
        val listen = vm.ui.value as CompanionUi.Listen
        assertFalse(listen.listening)
        assertNull(listen.foundLink)
        assertEquals("4.250", listen.offsetText)
        assertEquals("pasted", listen.chosen?.sourceId)
        assertFalse(listen.canListen)
    }

    private fun startUnpaired(): CompanionViewModel = viewModel().also { vm ->
        waitUntil("the pairing screen") { vm.ui.value is CompanionUi.Pairing }
    }

    /** Paired with a TV: the Listen along screen with its first answer. */
    private fun startListening(): CompanionViewModel {
        runBlocking {
            app.graph.store.savePairing(server.url("/").toString(), "izat_test")
            app.graph.store.setTv("tv-1")
        }
        return viewModel().also { vm ->
            waitUntil("Listen along") { (vm.ui.value as? CompanionUi.Listen)?.let { it.loaded && it.tvName != null } == true }
        }
    }

    /** A new factory: `AndroidViewModelFactory.getInstance` would keep the first test's application. */
    private fun viewModel(): CompanionViewModel =
        ViewModelProvider(viewModels, ViewModelProvider.AndroidViewModelFactory(app))[CompanionViewModel::class.java]

    private fun count(path: String) = requests.count { it.url.encodedPath == path }

    private val mainLooper get() = shadowOf(Looper.getMainLooper())

    /** Server answers arrive on OkHttp's threads, then run on the main looper: idle it until [condition] holds. */
    private fun waitUntil(what: String, condition: () -> Boolean) {
        repeat(1_000) {
            mainLooper.idle()
            if (condition()) return
            Thread.sleep(10)
        }
        fail("Timed out waiting for $what; requests: ${requests.map { "${it.method} ${it.url.encodedPath}" }}")
    }

    private fun settle() = repeat(20) {
        mainLooper.idle()
        Thread.sleep(10)
    }

    /** The session's server: never answers. */
    private object NeverAnswers : CompanionApi {
        override suspend fun now(deviceId: String, seq: Long?, waitSec: Int): NowResponse = awaitCancellation()
        override suspend fun resolve(deviceId: String, request: CompanionResolveRequest): CompanionResolveResponse = awaitCancellation()
        override suspend fun companion(deviceId: String): CompanionResponse = awaitCancellation()
    }

    private companion object {
        const val COMPANION = "/api/v1/admin/devices/tv-1/companion"

        val DEVICES = """{"devices":[
            {"id":"tv-1","name":"Living room","status":"active","online":true,"lastSeenAt":"2026-10-26T09:00:00.000Z","homeCount":3},
            {"id":"tv-2","name":"Kitchen","status":"active","online":false,"lastSeenAt":null},
            {"id":"tv-3","name":"New TV","status":"pending","online":false}]}"""

        val EPISODE = """{"nowPlaying":{"itemId":"show","itemKind":"series","episodeId":"show.e1","sourceId":"main","itemTitle":"Show",
            "episodeTitle":"Pilot","durationMs":1200000,"state":"playing"},"candidates":[
            {"sourceId":"main","type":"direct","kind":"hls","label":null,"languages":{"audio":["en"],"subtitles":null},"current":true,
             "supported":true,"reason":null,"link":{"offsetMs":0,"rate":1,"language":null,"updatedAt":null}},
            {"sourceId":"dub","type":"direct","kind":"dash","label":"Dub","languages":{"audio":["fr","de"],"subtitles":null},"current":false,
             "supported":false,"reason":"dash","link":{"offsetMs":-1250,"rate":1.0427,"language":"fr","updatedAt":"2026-10-20T10:00:00.000Z"}},
            {"sourceId":"pasted","type":"pasted","kind":null,"label":null,"languages":{"audio":null,"subtitles":null},"current":false,
             "supported":true,"reason":null,"link":{"offsetMs":3500,"rate":1,"language":null,"updatedAt":"2026-10-21T10:00:00.000Z"}}]}"""

        /** Found on a page: neither the URL nor a header value may reach the server. */
        val LINK = FoundLink(
            "http://media.test/found/master?payload=abc123",
            mapOf("Referer" to "http://page.test/watch/42", "Origin" to "http://page.test", "Cookie" to "visit=cookie-value-789"),
        )
        val SECRETS = listOf("media.test", "payload", "abc123", "page.test", "watch/42", "cookie-value-789")

        /** `/now`: the TV playing show.e1 at 60 s, now. */
        fun nowAnswer(): MockResponse {
            val now = System.currentTimeMillis()
            return json(
                200,
                """{"online":true,"serverNowMs":$now,"seq":1,"nowPlaying":{"itemId":"show","itemKind":"series","episodeId":"show.e1",
                "sourceId":"main","durationMs":1200000,"state":"playing","updatedAt":"${Instant.ofEpochMilli(now)}","playing":true},
                "anchor":{"positionMs":60000,"atMs":$now,"playing":true,"rate":1}}""",
            )
        }

        val CHANNEL = """{"nowPlaying":{"itemId":"news","itemKind":"live","itemTitle":"News","state":"playing"},"candidates":[]}"""
    }
}
