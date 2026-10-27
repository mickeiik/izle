package io.github.mickeiik.izle.companion.ui

import android.os.Looper
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.test.core.app.ApplicationProvider
import io.github.mickeiik.izle.companion.CompanionApp
import io.github.mickeiik.izle.companion.connect.ConnectLink
import io.github.mickeiik.izle.companion.settings.CompanionSettings
import io.github.mickeiik.izle.data.api.ApiException
import io.github.mickeiik.izle.companion.finder.FoundLink
import io.github.mickeiik.izle.companion.finder.LinkFinderState
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
import java.time.Duration
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The real [CompanionViewModel], store and API client under Robolectric against an in-process server: pairing and its
 * errors, the TV picker, the TV page (tabs, Now, the remote, a message), Listen along's refresh, timing by ear, Save
 * timing, Apply to all, a channel, and Listen starting the session and the foreground service. The session's API
 * never answers unless a test says otherwise (the session's own tests cover it).
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
    @Volatile private var claimAnswer: () -> MockResponse = { json(201, CLAIM) }
    @Volatile private var phonesAnswer: () -> MockResponse = { json(200, PHONES) }
    @Volatile private var deletePhoneAnswer: () -> MockResponse = { MockResponse.Builder().code(204).build() }
    @Volatile private var commandAnswer: () -> MockResponse = { json(202, """{"id":7,"online":true}""") }
    @Volatile private var commandResult: String = commandInfo("next", null, null)

    @Before
    fun setUp() {
        app.graph.phoneName = { "Test phone" }
        app.graph.mediaEngine = { FakeMediaEngine() }
        app.graph.newSession = { _, scope -> ListenSession(NeverAnswers, FakeMediaEngine(), scope, { it }) }
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                val path = request.url.encodedPath
                return when {
                    path == "/api/v1/phones/claim" && request.method == "POST" -> claimAnswer()
                    path == "/api/v1/admin/phones" && request.method == "GET" -> phonesAnswer()
                    path.startsWith("/api/v1/admin/phones/") && request.method == "DELETE" -> deletePhoneAnswer()
                    path == "/api/v1/admin/devices" -> devicesAnswer()
                    path == "/api/v1/admin/devices/tv-1/companion" -> companionAnswer()
                    path == "/api/v1/admin/devices/tv-1/commands" && request.method == "POST" -> commandAnswer()
                    path == "/api/v1/admin/devices/tv-1/commands/7" -> json(200, commandResult)
                    path == "/api/v1/admin/catalog/items/show" ->
                        json(200, """{"item":{"id":"show","kind":"series","title":"Show","posterUrl":"/assets/show.jpg","episodes":[]}}""")
                    // For a session on this server: the TV at 60 s; a long-poll answers after a second.
                    path == "/api/v1/admin/devices/tv-1/now" -> nowAnswer().let { r ->
                        if (request.url.queryParameter("wait") == "0") r else r.newBuilder().headersDelay(1, TimeUnit.SECONDS).build()
                    }
                    path == "/api/v1/admin/devices/tv-1/companion/resolve" ->
                        json(200, """{"episodeId":"show.e1","sourceId":"dub","media":{"kind":"hls","url":"/p/tok/dub/master.m3u8"}}""")
                    // What the link finder confirms (a pasted link is fetched from this phone).
                    path == "/found/master.m3u8" -> MockResponse.Builder().code(200).body("#EXTM3U\n").build()
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

    // --- connecting by code ----------------------------------------------------------------------------------------

    @Test
    fun theCodeClaimsWithoutACredentialStoresTheSecretAndOpensTheInvitingTv() {
        val vm = startUnpaired()
        vm.connect(server.url("/").toString().trimEnd('/'), " 483 920 ")
        assertTrue((vm.ui.value as CompanionUi.Connect).busy)
        waitUntil("Listen along") { (vm.ui.value as? CompanionUi.Tv)?.let { it.loaded && it.tvName != null } == true }
        assertEquals("tv-1", (vm.ui.value as CompanionUi.Tv).tvId)
        assertEquals("Living room", (vm.ui.value as CompanionUi.Tv).tvName)
        val claim = requests.first()
        assertEquals("/api/v1/phones/claim", claim.url.encodedPath)
        assertNull(claim.headers["Authorization"])
        assertEquals("""{"code":"483920","name":"Test phone"}""", claim.body?.utf8())
        assertTrue("then the phone's secret", requests.drop(1).all { it.headers["Authorization"] == "Bearer izph_secret" })
        runBlocking {
            val stored = app.graph.store.current()
            assertEquals(server.url("/").toString(), stored.serverUrl)
            assertEquals("izph_secret", stored.token)
            assertEquals(THIS_PHONE, stored.phoneId)
            assertEquals("tv-1", stored.tvId)
        }
    }

    @Test
    fun aClaimWithoutItsTvListsTheTvs() {
        claimAnswer = { json(201, CLAIM.replace(""""deviceId":"tv-1"}""", """"deviceId":null}""")) }
        val vm = startUnpaired()
        vm.connect(server.url("/").toString(), "483920")
        waitUntil("the TV list") { (vm.ui.value as? CompanionUi.PickTv)?.loading == false }
        assertEquals(listOf("tv-1", "tv-2"), (vm.ui.value as CompanionUi.PickTv).devices.map { it.id })
        runBlocking { assertNull(app.graph.store.current().tvId) }
    }

    @Test
    fun aCodeThatIsNotSixDigitsAndAnInvalidAddressSendNothing() {
        val vm = startUnpaired()
        vm.connect(server.url("/").toString(), "12345")
        vm.connect(server.url("/").toString(), "1234567")
        vm.connect(server.url("/").toString(), "48392a")
        assertNull((vm.ui.value as CompanionUi.Connect).error)
        vm.connect("http://bad host", "483920")
        assertEquals(ConnectError.InvalidAddress, (vm.ui.value as CompanionUi.Connect).error)
        settle()
        assertEquals(0, requests.size)
        assertEquals("483920", CompanionViewModel.normalizeCode("483 920"))
        assertNull(CompanionViewModel.normalizeCode("４８３９２０")) // other scripts' digits are not the TV's
    }

    @Test
    fun claimErrors() {
        val vm = startUnpaired()
        claimAnswer = { json(404, """{"error":"not_found"}""") }
        vm.connect(server.url("/").toString(), "483920")
        waitUntil("not accepted") { (vm.ui.value as? CompanionUi.Connect)?.error == ConnectError.CodeNotAccepted }
        assertFalse((vm.ui.value as CompanionUi.Connect).busy)

        claimAnswer = { MockResponse.Builder().code(429).addHeader("Retry-After", "300").body("""{"error":"rate_limited"}""").build() }
        vm.connect(server.url("/").toString(), "483920")
        waitUntil("too many tries") { (vm.ui.value as? CompanionUi.Connect)?.error == ConnectError.TooManyTries }

        claimAnswer = { json(400, """{"error":"invalid_request"}""") }
        vm.connect(server.url("/").toString(), "483920")
        waitUntil("by its code") { (vm.ui.value as? CompanionUi.Connect)?.error == ConnectError.Server("invalid_request") }
        runBlocking { assertFalse(app.graph.store.current().isPaired) }
    }

    @Test
    fun anUnreachableServer() {
        val closed = MockWebServer().apply { start() }
        val url = closed.url("/").toString()
        closed.close()
        val vm = startUnpaired()
        vm.connect(url, "483920")
        waitUntil("the error") { (vm.ui.value as? CompanionUi.Connect)?.error == ConnectError.Unreachable }
        assertFalse((vm.ui.value as CompanionUi.Connect).busy)
        runBlocking { assertFalse(app.graph.store.current().isPaired) }
    }

    // --- connecting by the QR code's link --------------------------------------------------------------------------

    @Test
    fun theLinkClaimsItsInviteAtOnce() {
        val vm = startUnpaired()
        vm.connectWithLink(ConnectLink(server.url("/").toString(), "inv-abc_123"))
        waitUntil("Listen along") { (vm.ui.value as? CompanionUi.Tv)?.loaded == true }
        assertEquals("""{"invite":"inv-abc_123","name":"Test phone"}""", requests.first().body?.utf8())
        assertNull(requests.first().headers["Authorization"])
        runBlocking { assertEquals(THIS_PHONE, app.graph.store.current().phoneId) }
    }

    @Test
    fun aLinkThatFailsSaysSoOnTheConnectScreen() {
        claimAnswer = { json(404, """{"error":"not_found"}""") }
        val vm = startUnpaired()
        vm.connectWithLink(ConnectLink(server.url("/").toString(), "inv-used"))
        waitUntil("the error") { (vm.ui.value as? CompanionUi.Connect)?.error == ConnectError.CodeNotAccepted }
        val connect = vm.ui.value as CompanionUi.Connect
        assertFalse(connect.busy)
        assertEquals("the link's server fills the address", server.url("/").toString().trimEnd('/'), connect.initialUrl)
    }

    @Test
    fun aLinkThatFailsWhileConnectedKeepsTheTvAndSaysWhyInASnackbar() {
        val vm = startListening()
        claimAnswer = { json(404, """{"error":"not_found"}""") }
        vm.connectWithLink(ConnectLink(server.url("/").toString(), "inv-used"))
        waitUntil("the snackbar") { vm.snackbar.value == "That code is not valid any more. Open Connect a phone on the TV again." }
        waitUntil("Listen along again") { (vm.ui.value as? CompanionUi.Tv)?.loaded == true }
        runBlocking { assertEquals("izat_test", app.graph.store.current().token) }
    }

    @Test
    fun aLinkWhileConnectedReplacesThePairingAndDeletesThePreviousPhone() {
        val vm = startListening(phoneId = "ph-old000000")
        vm.connectWithLink(ConnectLink(server.url("/").toString(), "inv-abc_123"))
        waitUntil("the new pairing") { runBlocking { app.graph.store.current().phoneId } == THIS_PHONE }
        waitUntil("Listen along") { (vm.ui.value as? CompanionUi.Tv)?.loaded == true }
        runBlocking { assertEquals("izph_secret", app.graph.store.current().token) }
        waitUntil("the previous phone deleted") { requests.any { it.method == "DELETE" } }
        val delete = requests.single { it.method == "DELETE" }
        assertEquals("/api/v1/admin/phones/ph-old000000", delete.url.encodedPath)
        assertEquals("with its own secret", "Bearer izat_test", delete.headers["Authorization"])
    }

    @Test
    fun aLinkToAnotherServerWhileConnectedIsRefused() {
        val vm = startListening()
        val before = requests.size
        vm.connectWithLink(ConnectLink("https://elsewhere.example", "inv-abc_123"))
        val connectedTo = server.url("/").toString().trimEnd('/')
        waitUntil("the snackbar") {
            vm.snackbar.value == "This phone is connected to $connectedTo. To connect it to another server, disconnect this phone first."
        }
        settle()
        assertTrue("nothing claimed", requests.drop(before).none { it.url.encodedPath == "/api/v1/phones/claim" })
        assertTrue(vm.ui.value is CompanionUi.Tv)
        runBlocking { assertEquals(server.url("/").toString(), app.graph.store.current().serverUrl) }
    }

    // --- debug builds: a token instead of a code -------------------------------------------------------------------

    @Test
    fun aTokenTheServerDoesNotAccept() {
        devicesAnswer = { json(401, """{"error":"unauthorized"}""") }
        val vm = startUnpaired()
        vm.connectWithToken(server.url("/").toString(), "izat_wrong")
        waitUntil("the error") { (vm.ui.value as? CompanionUi.Connect)?.error == ConnectError.TokenNotAccepted }
    }

    @Test
    fun anotherErrorIsShownByItsCode() {
        devicesAnswer = { json(403, """{"error":"insufficient_scope","required":"owner"}""") }
        val vm = startUnpaired()
        vm.connectWithToken(server.url("/").toString(), "izat_read")
        waitUntil("the error") { (vm.ui.value as? CompanionUi.Connect)?.error == ConnectError.Server("insufficient_scope") }
    }

    @Test
    fun aTokenListsTheActiveTvsAndPickingOneOpensListenAlong() {
        val vm = startUnpaired()
        vm.connectWithToken(server.url("/").toString(), " izat_test ")
        waitUntil("the TV list") { vm.ui.value is CompanionUi.PickTv }
        val picker = vm.ui.value as CompanionUi.PickTv
        assertEquals(listOf("tv-1", "tv-2"), picker.devices.map { it.id })
        assertFalse(picker.loading)
        assertEquals("Bearer izat_test", requests.single().headers["Authorization"])
        runBlocking {
            val stored = app.graph.store.current()
            assertEquals(server.url("/").toString(), stored.serverUrl)
            assertEquals("izat_test", stored.token)
            assertNull(stored.phoneId)
            assertNull(stored.tvId)
        }
        vm.pickTv("tv-1")
        waitUntil("Listen along") { (vm.ui.value as? CompanionUi.Tv)?.loaded == true }
        assertEquals("Living room", (vm.ui.value as CompanionUi.Tv).tvName)
        runBlocking { assertEquals("tv-1", app.graph.store.current().tvId) }
    }

    @Test
    fun oneTvGoesStraightToListenAlong() {
        devicesAnswer = { json(200, """{"devices":[{"id":"tv-1","name":"Living room","status":"active","online":true}]}""") }
        val vm = startUnpaired()
        vm.connectWithToken(server.url("/").toString(), "izat_test")
        waitUntil("Listen along") { (vm.ui.value as? CompanionUi.Tv)?.loaded == true }
        assertEquals("tv-1", (vm.ui.value as CompanionUi.Tv).tvId)
        runBlocking { assertEquals("tv-1", app.graph.store.current().tvId) }
    }

    // --- disconnecting ---------------------------------------------------------------------------------------------

    @Test
    fun disconnectThisPhoneDeletesItThenForgetsThePairing() {
        val vm = startListening()
        vm.forgetPairing()
        waitUntil("the connect screen") { vm.ui.value is CompanionUi.Connect }
        val delete = requests.single { it.method == "DELETE" }
        assertEquals("/api/v1/admin/phones/$THIS_PHONE", delete.url.encodedPath)
        assertEquals("Bearer izat_test", delete.headers["Authorization"])
        assertEquals(server.url("/").toString().trimEnd('/'), (vm.ui.value as CompanionUi.Connect).initialUrl)
        assertNull((vm.ui.value as CompanionUi.Connect).error)
        runBlocking { assertEquals(CompanionSettings(), app.graph.store.current()) }
        assertNull(app.graph.currentSession)
    }

    @Test
    fun disconnectingIsBestEffortAndATypedTokenDeletesNothing() {
        deletePhoneAnswer = { json(503, """{"error":"busy"}""") }
        val vm = startListening()
        vm.forgetPairing()
        waitUntil("the connect screen") { vm.ui.value is CompanionUi.Connect }
        runBlocking { assertFalse(app.graph.store.current().isPaired) }

        requests.clear()
        viewModels.clear() // a new view model reads the store again
        val again = startListening(phoneId = null)
        again.forgetPairing()
        waitUntil("the connect screen") { again.ui.value is CompanionUi.Connect }
        assertTrue(requests.none { it.method == "DELETE" })
    }

    @Test
    fun aDisconnectedPhoneIsToldOnTheConnectScreen() {
        val vm = startListening()
        companionAnswer = { json(401, """{"error":"unauthorized"}""") }
        vm.refresh()
        waitUntil("the connect screen") { vm.ui.value is CompanionUi.Connect }
        assertEquals(ConnectError.Disconnected, (vm.ui.value as CompanionUi.Connect).error)
        assertNull("said once, on the screen", vm.snackbar.value)
        assertTrue("its secret is dead: nothing to delete", requests.none { it.method == "DELETE" })
        runBlocking { assertFalse(app.graph.store.current().isPaired) }
    }

    @Test
    fun anOlderInstallsCompanionTokenIsTreatedAsDisconnected() {
        companionAnswer = { json(403, """{"error":"insufficient_scope","required":"owner"}""") }
        runBlocking {
            app.graph.store.savePairing(server.url("/").toString(), "izat_companion")
            app.graph.store.setTv("tv-1")
        }
        val vm = viewModel()
        waitUntil("the connect screen") { (vm.ui.value as? CompanionUi.Connect)?.error == ConnectError.Disconnected }
    }

    // --- the phones ------------------------------------------------------------------------------------------------

    @Test
    fun thePhonesListMarksThisOneAndBackReturnsToTheTv() {
        val vm = startListening()
        vm.openPhones()
        waitUntil("the phones") { (vm.ui.value as? CompanionUi.Phones)?.loading == false }
        val phones = vm.ui.value as CompanionUi.Phones
        assertEquals(listOf(THIS_PHONE, OTHER_PHONE), phones.phones.map { it.id })
        assertEquals(THIS_PHONE, phones.thisPhoneId)
        assertNull(phones.error)
        assertEquals("Bearer izat_test", requests.last { it.url.encodedPath == "/api/v1/admin/phones" }.headers["Authorization"])

        val gets = count(COMPANION)
        vm.closePhones()
        assertEquals("tv-1", (vm.ui.value as CompanionUi.Tv).tvId)
        waitUntil("read again") { count(COMPANION) > gets && !(vm.ui.value as CompanionUi.Tv).refreshing }
    }

    @Test
    fun disconnectingAnotherPhoneReadsTheListAgain() {
        val vm = startListening()
        vm.openPhones()
        waitUntil("the phones") { (vm.ui.value as? CompanionUi.Phones)?.loading == false }
        val lists = count(PHONES_PATH)
        vm.disconnectPhone(OTHER_PHONE)
        waitUntil("the list again") { count(PHONES_PATH) > lists && (vm.ui.value as? CompanionUi.Phones)?.loading == false }
        assertEquals("/api/v1/admin/phones/$OTHER_PHONE", requests.single { it.method == "DELETE" }.url.encodedPath)
        runBlocking { assertTrue("still connected", app.graph.store.current().isPaired) }
    }

    @Test
    fun disconnectingThisPhoneFromTheListForgetsThePairing() {
        val vm = startListening()
        vm.openPhones()
        waitUntil("the phones") { (vm.ui.value as? CompanionUi.Phones)?.loading == false }
        vm.disconnectPhone(THIS_PHONE)
        waitUntil("the connect screen") { vm.ui.value is CompanionUi.Connect }
        assertEquals("/api/v1/admin/phones/$THIS_PHONE", requests.single { it.method == "DELETE" }.url.encodedPath)
        runBlocking { assertFalse(app.graph.store.current().isPaired) }
    }

    @Test
    fun thePhonesListErrorsAndA401() {
        phonesAnswer = { json(503, """{"error":"busy"}""") }
        val vm = startListening()
        vm.openPhones()
        waitUntil("the error") { (vm.ui.value as? CompanionUi.Phones)?.error == ConnectError.Server("busy") }
        phonesAnswer = { json(401, """{"error":"unauthorized"}""") }
        vm.reloadPhones()
        waitUntil("the connect screen") { (vm.ui.value as? CompanionUi.Connect)?.error == ConnectError.Disconnected }
    }

    @Test
    fun theCandidatesAndTheChosenTiming() {
        val vm = startListening()
        val listen = vm.ui.value as CompanionUi.Tv
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
        val main = vm.ui.value as CompanionUi.Tv
        assertEquals("0.000", main.offsetText)
        assertEquals("1", main.speedText)
    }

    @Test
    fun anUnchangedAnswerKeepsWhatTheOwnerTyped() {
        val vm = startListening()
        vm.setOffsetText("-2")
        val gets = count(COMPANION)
        vm.refresh()
        waitUntil("the second read") { count(COMPANION) > gets && !(vm.ui.value as CompanionUi.Tv).refreshing }
        assertEquals("-2", (vm.ui.value as CompanionUi.Tv).offsetText)
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
            assertTrue((vm.ui.value as CompanionUi.Tv).refreshing)
            vm.refresh()
            settle()
            assertEquals(gets + 1, count(COMPANION))
        } finally {
            gate.countDown()
        }
        waitUntil("the answer") { !(vm.ui.value as CompanionUi.Tv).refreshing }
    }

    @Test
    fun anInvalidTimingDisablesSave() {
        val vm = startListening()
        vm.setSpeedText("3")
        assertFalse((vm.ui.value as CompanionUi.Tv).timingValid)
        vm.saveTiming()
        settle()
        assertEquals(0, requests.count { it.method == "PUT" })
        vm.setSpeedText("1.0427")
        assertTrue((vm.ui.value as CompanionUi.Tv).timingValid)
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
        val listen = vm.ui.value as CompanionUi.Tv
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
        waitUntil("the session in the screen state") { (vm.ui.value as CompanionUi.Tv).listening }

        companionAnswer = { json(200, CHANNEL) }
        vm.refresh()
        waitUntil("the end") { vm.snackbar.value == "The TV switched to a channel; listening ended." }
        assertEquals(ListenPhase.Idle, session.state.value.phase)
        waitUntil("idle in the screen state") { !(vm.ui.value as CompanionUi.Tv).listening }
    }

    @Test
    fun theNudgeIsRememberedOnThePhone() {
        val vm = startListening()
        vm.nudge(50)
        vm.nudge(50)
        vm.nudge(-50)
        assertEquals(50L, (vm.ui.value as CompanionUi.Tv).nudgeMs)
        waitUntil("the stored nudge") { runBlocking { app.graph.store.current().nudgeMs } == 50L }
    }

    @Test
    fun aSessionRefusedWhileListeningEndsOnTheConnectScreen() {
        app.graph.newSession = { _, scope -> ListenSession(Refused, FakeMediaEngine(), scope, { it }) }
        val vm = startListening()
        vm.listen()
        waitUntil("the connect screen") { (vm.ui.value as? CompanionUi.Connect)?.error == ConnectError.Disconnected }
        assertNull("said once, on the screen", vm.snackbar.value)
        runBlocking { assertFalse(app.graph.store.current().isPaired) }
    }

    // --- a link found on this phone --------------------------------------------------------------------------------

    @Test
    fun thePastedOptionHasItsOwnTimingAndNeedsAFoundLink() {
        val vm = startListening()
        val pasted = (vm.ui.value as CompanionUi.Tv).options.last()
        assertEquals(CandidateOption("pasted", null, "a link found on this phone", null), pasted)
        vm.choose(pasted)
        val chosen = vm.ui.value as CompanionUi.Tv
        assertEquals("3.500", chosen.offsetText)
        assertEquals("1", chosen.speedText)
        assertNull(chosen.foundLink)
        assertFalse(chosen.canListen)

        vm.openFinder()
        assertTrue((vm.ui.value as CompanionUi.Tv).finderOpen)
        vm.closeFinder()
        assertFalse((vm.ui.value as CompanionUi.Tv).finderOpen)
        vm.openFinder()
        vm.useFoundLink(LINK)
        val ready = vm.ui.value as CompanionUi.Tv
        assertEquals(LINK, ready.foundLink)
        assertFalse(ready.finderOpen)
        assertTrue(ready.canListen)
        assertEquals("3.500", ready.offsetText)

        vm.refresh() // an unchanged answer keeps the link
        settle()
        assertEquals(LINK, (vm.ui.value as CompanionUi.Tv).foundLink)
    }

    @Test
    fun listeningToAFoundLinkPlaysItOnThePhoneAndNoRequestCarriesIt() {
        val engine = FakeMediaEngine()
        app.graph.newSession = { api, scope -> ListenSession(ApiClientCompanionApi(api), engine, scope, { it }) }
        val vm = startListening()
        vm.choose((vm.ui.value as CompanionUi.Tv).options.last())
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

        waitUntil("the link loaded") { engine.loads.isNotEmpty() && (vm.ui.value as CompanionUi.Tv).listening }
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
        vm.choose((vm.ui.value as CompanionUi.Tv).options.last())
        vm.useFoundLink(LINK)
        vm.setOffsetText("4.250")
        vm.listen()
        waitUntil("the link loaded") { engine.loads.isNotEmpty() && (vm.ui.value as CompanionUi.Tv).listening }
        findInFinder(vm)
        engine.durationMs = 5 * 60_000L // a decoy, against an episode of 20 min
        engine.ready()
        waitUntil("the snackbar") { vm.snackbar.value == endedText(EndReason.LinkExpired, null) }
        assertEquals("the finder forgets the expired link", LinkFinderState(), vm.linkFinder.state.value)
        assertEquals(EndReason.LinkExpired, app.graph.currentSession!!.state.value.ended)
        val listen = vm.ui.value as CompanionUi.Tv
        assertFalse(listen.listening)
        assertNull(listen.foundLink)
        assertEquals("4.250", listen.offsetText)
        assertEquals("pasted", listen.chosen?.sourceId)
        assertFalse(listen.canListen)
    }

    @Test
    fun anotherEpisodeDropsTheFoundLinkAndTheFinderForgetsIt() {
        val vm = startListening()
        vm.choose((vm.ui.value as CompanionUi.Tv).options.last())
        findInFinder(vm)
        vm.useFoundLink(vm.linkFinder.state.value.found!!)
        companionAnswer = { json(200, EPISODE.replace("show.e1", "show.e2").replace("Pilot", "Second")) }
        vm.refresh()
        waitUntil("the next episode") { (vm.ui.value as CompanionUi.Tv).nowPlaying?.episodeId == "show.e2" }
        assertNull((vm.ui.value as CompanionUi.Tv).foundLink)
        assertEquals(LinkFinderState(), vm.linkFinder.state.value)
    }

    @Test
    fun changingTheTvMakesTheFinderForgetItsLink() {
        val vm = startListening()
        findInFinder(vm)
        vm.changeTv()
        waitUntil("the TV list") { vm.ui.value is CompanionUi.PickTv }
        assertEquals(LinkFinderState(), vm.linkFinder.state.value)
    }

    @Test
    fun aPendingPastedChoiceSurvivesARefreshAndAFoundLinkThenSwitches() {
        val engine = FakeMediaEngine()
        app.graph.newSession = { api, scope -> ListenSession(ApiClientCompanionApi(api), engine, scope, { it }) }
        val vm = startListening()
        vm.listen()
        val session = app.graph.currentSession!!
        waitUntil("listening to the catalog source") { session.state.value.phase == ListenPhase.Listening }
        val pasted = (vm.ui.value as CompanionUi.Tv).options.last()
        vm.choose(pasted) // no link yet: the dub keeps playing
        assertEquals("dub", session.state.value.target?.sourceId)
        val gets = count(COMPANION)
        vm.saveTiming() // a forced read follows
        waitUntil("the read after the save") { count(COMPANION) > gets && !(vm.ui.value as CompanionUi.Tv).refreshing }
        assertEquals(pasted, (vm.ui.value as CompanionUi.Tv).chosen)

        vm.useFoundLink(LINK)
        val target = session.state.value.target!!
        assertEquals("pasted", target.sourceId)
        assertEquals(LINK, target.foundLink)
        assertEquals(LINK.url, engine.loads.last().media.url)
    }

    // --- the TV page: tabs, Now, the remote, a message -------------------------------------------------------------

    @Test
    fun theTvPageOpensOnNowAndKnowsWhetherThereAreOtherTvs() {
        val vm = startListening()
        val tv = vm.ui.value as CompanionUi.Tv
        assertEquals(TvTab.Now, tv.tab)
        assertFalse(tv.listenOpen)
        waitUntil("the list read") { (vm.ui.value as CompanionUi.Tv).device != null }
        assertTrue("two active TVs: Back goes to the list", (vm.ui.value as CompanionUi.Tv).severalTvs)

        vm.selectTab(TvTab.Home)
        assertEquals(TvTab.Home, (vm.ui.value as CompanionUi.Tv).tab)
        vm.selectTab(TvTab.Now)
        settle()
        val gets = count(COMPANION)
        vm.openListen()
        assertTrue((vm.ui.value as CompanionUi.Tv).listenOpen)
        waitUntil("Listen along read anew") { count(COMPANION) > gets }
        vm.closeListen()
        assertFalse((vm.ui.value as CompanionUi.Tv).listenOpen)

        viewModels.clear()
        devicesAnswer = { json(200, """{"devices":[{"id":"tv-1","name":"Living room","status":"active","online":true}]}""") }
        val one = startListening()
        waitUntil("the list read") { (one.ui.value as CompanionUi.Tv).device != null }
        assertFalse("one TV: Back leaves the app", (one.ui.value as CompanionUi.Tv).severalTvs)
    }

    @Test
    fun nowFollowsTheTvWithALongPollAndReadsThePoster() {
        val vm = startListening()
        vm.startFollowingNow()
        waitUntil("what the TV plays") { (vm.ui.value as CompanionUi.Tv).now != null }
        val tv = vm.ui.value as CompanionUi.Tv
        assertEquals("show.e1", tv.now?.nowPlaying?.episodeId)
        assertTrue(tv.online)
        assertEquals("0", requests.first { it.url.encodedPath == NOW_PATH }.url.queryParameter("wait"))
        waitUntil("the long-poll") { requests.any { it.url.encodedPath == NOW_PATH && it.url.queryParameter("wait") == "25" } }
        assertEquals("1", requests.last { it.url.encodedPath == NOW_PATH }.url.queryParameter("seq"))
        waitUntil("the poster") { (vm.ui.value as CompanionUi.Tv).posterUrl != null }
        assertEquals(server.url("/assets/show.jpg").toString(), (vm.ui.value as CompanionUi.Tv).posterUrl)

        vm.stopFollowingNow()
        settle()
        val reads = count(NOW_PATH)
        repeat(3) {
            mainLooper.idleFor(Duration.ofSeconds(1))
            Thread.sleep(50)
        }
        assertEquals("no read once stopped", reads, count(NOW_PATH))
    }

    @Test
    fun theRemoteSendsTheCommandThenSaysItsResultWhenWorthSaying() {
        val vm = startListening()
        commandResult = commandInfo("seek", "ignored", "not_in_player")
        vm.remote("seek", -30_000)
        waitUntilAdvancing("the snackbar") { vm.snackbar.value == "Nothing is playing on Living room." }
        val post = requests.single { it.method == "POST" && it.url.encodedPath.endsWith("/commands") }
        assertEquals("""{"type":"seek","deltaMs":-30000}""", post.body?.utf8())
        vm.dismissSnackbar()

        // Done: nothing to say.
        commandResult = commandInfo("next", "done", null)
        val reads = count(COMMAND_7)
        vm.remote("next")
        waitUntilAdvancing("the result read") { count(COMMAND_7) > reads }
        settle()
        assertNull(vm.snackbar.value)
        assertEquals("""{"type":"next"}""", requests.last { it.method == "POST" }.body?.utf8())
    }

    @Test
    fun anOfflineTvGetsTheCommandLaterAndSaysSo() {
        commandAnswer = { json(202, """{"id":7,"online":false}""") }
        val vm = startListening()
        vm.remote("stop")
        waitUntil("the snackbar") { vm.snackbar.value == "Living room is offline. It gets this if it connects in the next 2 minutes." }
        settle()
        assertEquals("no result read", 0, count(COMMAND_7))
    }

    @Test
    fun aCommandRefusedSaysWhy() {
        commandAnswer = { json(400, """{"error":"invalid_request"}""") }
        val vm = startListening()
        vm.remote("next")
        waitUntil("the snackbar") { vm.snackbar.value == "The server did not accept the request." }
    }

    @Test
    fun aMessageIsTrimmedAndSaysWhenItWasShown() {
        val vm = startListening()
        vm.sendMessage("   ", 60)
        vm.sendMessage("x".repeat(201), 60)
        settle()
        assertTrue("blank or too long: nothing sent", requests.none { it.method == "POST" })
        commandResult = commandInfo("message", "done", null)
        vm.sendMessage("  Dinner is ready  ", 15)
        waitUntilAdvancing("the snackbar") { vm.snackbar.value == "Shown on Living room" }
        assertEquals("""{"type":"message","text":"Dinner is ready","durationSec":15}""", requests.single { it.method == "POST" }.body?.utf8())
    }

    @Test
    fun backToTheListKeepsListeningAndAnotherTvStopsIt() {
        app.graph.newSession = { api, scope -> ListenSession(ApiClientCompanionApi(api), FakeMediaEngine(), scope, { it }) }
        val vm = startListening()
        vm.listen()
        val session = app.graph.currentSession!!
        waitUntil("listening") { session.state.value.phase == ListenPhase.Listening }
        vm.changeTv()
        waitUntil("the TV list") { (vm.ui.value as? CompanionUi.PickTv)?.loading == false }
        assertEquals(ListenPhase.Listening, session.state.value.phase)
        vm.pickTv("tv-2")
        assertEquals(ListenPhase.Idle, session.state.value.phase)
    }

    // --- timing by ear (#34) ---------------------------------------------------------------------------------------

    @Test
    fun offsetNudgesAndSpeedChoices() {
        val vm = startListening()
        vm.nudgeOffset(-500)
        assertEquals("-1.750", (vm.ui.value as CompanionUi.Tv).offsetText)
        vm.nudgeOffset(30_000)
        assertEquals("28.250", (vm.ui.value as CompanionUi.Tv).offsetText)
        vm.chooseSpeed(0.9591)
        assertEquals("0.9591", (vm.ui.value as CompanionUi.Tv).speedText)
        vm.chooseSpeed(null)
        val other = vm.ui.value as CompanionUi.Tv
        assertTrue("Other opens the field", other.otherSpeed)
        assertEquals("the speed is kept", "0.9591", other.speedText)
        vm.chooseSpeed(1.0)
        assertFalse((vm.ui.value as CompanionUi.Tv).otherSpeed)
        assertTrue((vm.ui.value as CompanionUi.Tv).timingValid)
        vm.saveTiming()
        waitUntil("the save") { requests.any { it.method == "PUT" } }
        assertEquals("""{"offsetMs":28250,"rate":1.0,"language":"fr"}""", requests.single { it.method == "PUT" }.body?.utf8())
    }

    @Test
    fun aMarkNeedsListening() {
        val vm = startListening()
        vm.mark(onTv = true)
        assertEquals("Listen first, then mark.", vm.snackbar.value)
        assertNull((vm.ui.value as CompanionUi.Tv).tvMarkMs)
    }

    @Test
    fun theTwoTapMarkSetsTheOffsetLiveAndClears() {
        val engine = FakeMediaEngine()
        app.graph.newSession = { api, scope -> ListenSession(ApiClientCompanionApi(api), engine, scope, { it }) }
        val vm = startListening()
        vm.listen()
        val session = app.graph.currentSession!!
        waitUntil("listening") { session.positionsNow() != null }

        engine.positionMs = 70_000
        vm.mark(onTv = false) // either order
        assertEquals(70_000.0, (vm.ui.value as CompanionUi.Tv).phoneMarkMs!!, 0.0)
        engine.positionMs = 71_000
        vm.mark(onTv = false) // a new tap of the same kind replaces that half
        assertEquals(71_000.0, (vm.ui.value as CompanionUi.Tv).phoneMarkMs!!, 0.0)
        assertNull((vm.ui.value as CompanionUi.Tv).tvMarkMs)

        val tvAt = session.positionsNow()!!.first
        vm.mark(onTv = true)
        val done = vm.ui.value as CompanionUi.Tv
        assertNull(done.tvMarkMs)
        assertNull(done.phoneMarkMs)
        val offsetMs = parseTiming(done.offsetText, "1")!!.offsetMs
        // rate · tv + offset = phone, at the dub's 1.0427; the TV moved on a few milliseconds between the two reads.
        assertEquals(71_000 - 1.0427 * tvAt, offsetMs.toDouble(), 100.0)
        assertEquals("applied live", offsetMs, session.state.value.timing.offsetMs)
    }

    /** The finder confirms a link pasted into it (served by the test server). */
    private fun findInFinder(vm: CompanionViewModel) {
        vm.linkFinder.paste(server.url("/found/master.m3u8").toString())
        waitUntil("the finder's link") { vm.linkFinder.state.value.found != null && !vm.linkFinder.state.value.checking }
    }

    private fun startUnpaired(): CompanionViewModel = viewModel().also { vm ->
        waitUntil("the connect screen") { vm.ui.value is CompanionUi.Connect }
    }

    /** Paired with a TV: the Listen along screen with its first answer. [phoneId] null: a typed token (or an older install). */
    private fun startListening(phoneId: String? = THIS_PHONE): CompanionViewModel {
        runBlocking {
            app.graph.store.savePairing(server.url("/").toString(), "izat_test", phoneId)
            app.graph.store.setTv("tv-1")
        }
        return viewModel().also { vm ->
            waitUntil("Listen along") { (vm.ui.value as? CompanionUi.Tv)?.let { it.loaded && it.tvName != null } == true }
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

    /** As [waitUntil], letting the main looper's clock run too (for the view model's own delays). */
    private fun waitUntilAdvancing(what: String, condition: () -> Boolean) {
        repeat(1_000) {
            mainLooper.idleFor(Duration.ofMillis(100))
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

    /** The session's server, after this phone was disconnected. */
    private object Refused : CompanionApi {
        override suspend fun now(deviceId: String, seq: Long?, waitSec: Int): NowResponse = throw ApiException(401, "unauthorized")
        override suspend fun resolve(deviceId: String, request: CompanionResolveRequest): CompanionResolveResponse =
            throw ApiException(401, "unauthorized")
        override suspend fun companion(deviceId: String): CompanionResponse = throw ApiException(401, "unauthorized")
    }

    private companion object {
        const val COMPANION = "/api/v1/admin/devices/tv-1/companion"
        const val PHONES_PATH = "/api/v1/admin/phones"
        const val NOW_PATH = "/api/v1/admin/devices/tv-1/now"
        const val COMMAND_7 = "/api/v1/admin/devices/tv-1/commands/7"

        /** `GET …/commands/7`'s answer. */
        fun commandInfo(type: String, result: String?, reason: String?): String {
            fun quoted(v: String?) = v?.let { "\"$it\"" } ?: "null"
            return """{"command":{"id":7,"type":"$type","payload":{},"createdAt":"2026-10-26T10:00:00.000Z","result":${quoted(result)},"reason":${quoted(reason)}}}"""
        }
        const val THIS_PHONE = "ph0123456789"
        const val OTHER_PHONE = "ph9876543210"

        val CLAIM = """{"phone":{"id":"$THIS_PHONE","name":"Test phone","createdAt":"2026-10-26T10:00:00.000Z","lastUsedAt":null,
            "deviceId":"tv-1"},"secret":"izph_secret","deviceId":"tv-1"}"""

        val PHONES = """{"phones":[
            {"id":"$THIS_PHONE","name":"Test phone","createdAt":"2026-10-26T10:00:00.000Z","lastUsedAt":"2026-10-26T10:01:00.000Z","deviceId":"tv-1"},
            {"id":"$OTHER_PHONE","name":"Tablet","createdAt":"2026-10-26T11:00:00.000Z","lastUsedAt":null,"deviceId":null}]}"""

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
