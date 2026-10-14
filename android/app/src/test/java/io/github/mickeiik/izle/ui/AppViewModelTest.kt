package io.github.mickeiik.izle.ui

import android.os.Looper
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.test.core.app.ApplicationProvider
import io.github.mickeiik.izle.IzleApp
import io.github.mickeiik.izle.data.api.ContinueInfo
import io.github.mickeiik.izle.data.api.HomeEntry
import io.github.mickeiik.izle.data.api.ItemCard
import io.github.mickeiik.izle.player.PlayerPhase
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockResponseBody
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import mockwebserver3.SocketEffect
import okio.BufferedSink
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * The view model's flows end to end, on the real [AppViewModel] and app graph under Robolectric, against an
 * in-process server: pairing, the owner's commands (over a live event stream), the timed messages, the countdowns
 * and the hidden menu's stack. Time is Robolectric's paused main-looper clock, advanced by the test; server answers
 * arrive on OkHttp's threads and are waited for. Nothing here needs ExoPlayer: nothing on this server is playable,
 * so playing ends on the player's error screen.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], qualifiers = "w960dp-h540dp-land-television")
class AppViewModelTest {
    private val app: IzleApp = ApplicationProvider.getApplicationContext()
    private val server = MockWebServer()
    private val requests = CopyOnWriteArrayList<RecordedRequest>()
    private val viewModels = ViewModelStore()

    /** Server-sent events for the open `/tv/events` stream. */
    private val events = LinkedBlockingQueue<String>()

    @Volatile
    private var closing = false

    @Volatile
    private var home = listOf("a", "b", "c")

    @Volatile
    private var version = 1L

    @Volatile
    private var autoplayOnStart = false

    /** `/tv/state` (and `/tv/events`) answer this status when it is not 200. */
    @Volatile
    private var stateCode = 200

    /** Scripted answers to `pair/start` and `pair/wait`; when empty, a fresh code and `pending`. */
    private val pairStarts = ConcurrentLinkedQueue<MockResponse>()
    private val pairWaits = ConcurrentLinkedQueue<MockResponse>()

    /** `pair/start` drops the connection (an unreachable server) while set. */
    @Volatile
    private var pairStartDown = false

    private var commandId = 0L

    @Before
    fun setUp() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                val path = request.url.encodedPath
                return when {
                    path == "/api/v1/tv/state" -> if (stateCode == 200) json(200, stateJson()) else json(stateCode, """{"error":"down"}""")
                    path == "/api/v1/tv/events" -> if (stateCode == 200) eventStream() else json(stateCode, """{"error":"down"}""")
                    path == "/api/v1/pair/start" -> when {
                        pairStartDown -> dropped()
                        else -> pairStarts.poll() ?: json(200, """{"code":"999999","pairToken":"pt-9"}""")
                    }
                    path == "/api/v1/pair/wait" -> pairWaits.poll() ?: run {
                        Thread.sleep(20) // a long poll, shortened
                        json(200, """{"status":"pending"}""")
                    }
                    path.endsWith("/ack") -> json(200, """{"ok":true}""")
                    // resolve, items and problem reports: nothing is playable here.
                    else -> json(404, """{"error":"not_found"}""")
                }
            }
        }
        server.start()
    }

    @After
    fun tearDown() {
        closing = true
        viewModels.clear()
        app.graph.appScope.cancel()
        server.close()
    }

    @Test
    fun pairingShowsACodeAndGoesHomeOnceApproved() {
        unpaired()
        pairStarts += json(200, """{"code":"111111","pairToken":"pt-1"}""")
        pairWaits += json(200, """{"status":"pending"}""")
        pairWaits += json(200, """{"status":"approved","deviceId":"tv-9","deviceToken":"tok-9"}""")
        val vm = startTv()
        waitUntil("the pairing screen") { vm.screen.value == Screen.Pairing }
        waitUntil("Home after the approval") { vm.screen.value == Screen.Home }
        assertEquals("111111", vm.pairing.value.code)
        assertTrue(vm.pairing.value.adminUrl.endsWith("/admin"))
        assertEquals(listOf("code=111111&wait=25", "code=111111&wait=25"), requests.filter { it.url.encodedPath == "/api/v1/pair/wait" }.map { it.url.encodedQuery })
        assertEquals("Bearer pt-1", requests.last { it.url.encodedPath == "/api/v1/pair/wait" }.headers["Authorization"])
        runBlocking { assertEquals("tok-9", app.graph.deviceStore.current().deviceToken) }
        waitUntil("the state with the new token") { requests.any { it.url.encodedPath == "/api/v1/tv/state" } }
        assertEquals("Bearer tok-9", requests.first { it.url.encodedPath == "/api/v1/tv/state" }.headers["Authorization"])
        assertNull(vm.homeFocusItemId)
    }

    @Test
    fun backOnThePairingScreenGoesToTheAddressScreenAndStopsPairing() {
        unpaired()
        pairStartDown = true
        val vm = startTv()
        waitUntil("the unreachable problem") { vm.pairing.value.problem == PairingProblem.Unreachable }
        vm.onBack()
        assertEquals(Screen.Setup(canGoBack = false), vm.screen.value)
        settle()
        val attempts = count("/api/v1/pair/start")
        pairStartDown = false
        advance(60_000)
        settle()
        assertEquals(attempts, count("/api/v1/pair/start"))
    }

    @Test
    fun aRemovedTvShowsANewPairingCode() {
        paired()
        stateCode = 401
        val vm = startTv()
        waitUntil("the pairing code") { vm.screen.value == Screen.Pairing && vm.pairing.value.code == "999999" }
        runBlocking {
            val settings = app.graph.deviceStore.current()
            assertNull(settings.deviceToken)
            assertEquals(server.url("/").toString(), settings.serverUrl)
        }
    }

    @Test
    fun pairAgainClosesTheMenuForgetsTheTokenAndShowsACode() {
        paired()
        val vm = startTvOnHome()
        vm.openMenu()
        vm.onRootEntry(RootEntry.Settings)
        vm.onSettingsEntry(SettingsEntry.PairAgain)
        waitUntil("the pairing code") { vm.screen.value == Screen.Pairing && vm.pairing.value.code == "999999" }
        assertNull(vm.menu.value)
        runBlocking { assertNull(app.graph.deviceStore.current().deviceToken) }
    }

    @Test
    fun okWhileOfflineSaysNoConnectionForFiveSeconds() {
        paired()
        stateCode = 503
        val vm = startTv()
        waitUntil("offline") { vm.screen.value == Screen.Home && !vm.online.value }
        val states = count("/api/v1/tv/state")
        vm.onTileClicked(entry("a"))
        assertEquals(HomeMessage.NoConnection, vm.homeMessage.value)
        assertEquals(Screen.Home, vm.screen.value)
        waitUntil("a refresh") { count("/api/v1/tv/state") > states }
        advance(3_000)
        vm.onTileClicked(entry("a")) // again: the five seconds start over
        advance(4_999)
        assertEquals(HomeMessage.NoConnection, vm.homeMessage.value)
        advance(1)
        assertNull(vm.homeMessage.value)
        assertEquals(0, count("/api/v1/tv/resolve"))
    }

    @Test
    fun theOwnersMessageShowsForItsDurationAndANewOneReplacesIt() {
        paired()
        val vm = startTvOnHome()
        val first = command("message", """{"text":"Hello","durationSec":3}""")
        waitUntil("the banner") { vm.banner.value == "Hello" }
        awaitAck(first)
        advance(2_000)
        command("message", """{"text":"Dinner is ready","durationSec":4}""")
        waitUntil("the new banner") { vm.banner.value == "Dinner is ready" }
        advance(3_999)
        assertEquals("Dinner is ready", vm.banner.value)
        advance(1)
        assertNull(vm.banner.value)
        // A command replayed under the same id (not acknowledged in time) is acknowledged again, not shown again.
        events += commandEvent(first, "message", """{"text":"Hello","durationSec":3}""")
        waitUntil("the second ack") { requests.count { it.url.encodedPath == "/api/v1/tv/commands/$first/ack" } == 2 }
        settle()
        assertNull(vm.banner.value)
    }

    @Test
    fun aPlayCommandOnHomePlaysThatEpisodeWithTheShowAsTheHint() {
        paired()
        val vm = startTvOnHome()
        vm.openMenu()
        command("play", """{"itemId":"b","episodeId":"b.e2"}""")
        waitUntil("the player") { vm.screen.value == Screen.Player }
        assertNull("playing closes the menu", vm.menu.value)
        assertEquals("b", vm.homeFocusItemId)
        assertEquals("Show B", vm.player.ui.value.item?.title)
        waitUntil("the resolve request") { count("/api/v1/tv/resolve") == 1 }
        assertEquals("""{"episodeId":"b.e2"}""", resolveBodies().single())
        waitUntil("the error screen") { vm.player.ui.value.phase is PlayerPhase.Failed }
        assertEquals("Show B", vm.player.ui.value.item?.title)
    }

    @Test
    fun onTheErrorScreenOnlyStopAndPlayAct() {
        paired()
        val vm = startTvOnHome()
        vm.onTileClicked(vm.state.value!!.home.first())
        waitUntil("the error screen") { vm.player.ui.value.phase is PlayerPhase.Failed }
        for ((type, payload) in listOf("pause" to "{}", "resume" to "{}", "seek" to """{"positionMs":0}""", "next" to "{}", "previous" to "{}")) {
            awaitAck(command(type, payload))
            assertTrue(type, vm.player.ui.value.phase is PlayerPhase.Failed)
            assertEquals(type, Screen.Player, vm.screen.value)
        }
        settle()
        assertEquals(1, count("/api/v1/tv/resolve"))
        command("play", """{"itemId":"c","episodeId":"c.e2"}""")
        waitUntil("the second resolve") { count("/api/v1/tv/resolve") == 2 }
        assertEquals("""{"episodeId":"c.e2"}""", resolveBodies().last())
        waitUntil("the error screen") { vm.player.ui.value.phase is PlayerPhase.Failed }
        command("stop")
        waitUntil("Home") { vm.screen.value == Screen.Home }
        assertEquals(PlayerPhase.Idle, vm.player.ui.value.phase)
    }

    @Test
    fun commandsAreIgnoredOnTheAddressScreen() {
        paired()
        val vm = startTvOnHome()
        vm.openMenu()
        vm.onRootEntry(RootEntry.Settings)
        vm.onSettingsEntry(SettingsEntry.ServerAddress)
        assertEquals(Screen.Setup(canGoBack = true), vm.screen.value)
        assertNull(vm.menu.value)
        awaitAck(command("play", """{"itemId":"b","episodeId":"b.e2"}"""))
        awaitAck(command("message", """{"text":"Hello"}"""))
        settle()
        assertEquals(Screen.Setup(canGoBack = true), vm.screen.value)
        assertNull(vm.banner.value)
        assertEquals(0, count("/api/v1/tv/resolve"))
    }

    @Test
    fun theErrorScreenCountsDownThirtySecondsThenGoesHome() {
        paired()
        val vm = startTvOnHome()
        vm.onTileClicked(vm.state.value!!.home.first())
        assertEquals(Screen.Player, vm.screen.value)
        assertEquals(PlayerPhase.Loading, vm.player.ui.value.phase)
        waitUntil("the error screen") { vm.player.ui.value.phase is PlayerPhase.Failed }
        assertEquals(PlayerPhase.Failed(30), vm.player.ui.value.phase)
        for (left in 29 downTo 1) {
            advance(1_000)
            assertEquals(PlayerPhase.Failed(left), vm.player.ui.value.phase)
        }
        advance(999)
        assertEquals(Screen.Player, vm.screen.value)
        advance(1)
        assertEquals(Screen.Home, vm.screen.value)
        assertEquals(PlayerPhase.Idle, vm.player.ui.value.phase)
    }

    @Test
    fun autoplayCountsDownTenSecondsThenPlaysTheShow() {
        paired()
        autoplayOnStart = true
        val vm = startTv()
        waitUntil("the autoplay countdown") { vm.autoplay.value != null }
        assertEquals("a", vm.autoplay.value?.entry?.item?.id)
        assertEquals(10, vm.autoplay.value?.secondsLeft)
        assertEquals("a", vm.homeFocusItemId)
        for (left in 9 downTo 1) {
            advance(1_000)
            assertEquals(left, vm.autoplay.value?.secondsLeft)
        }
        advance(999)
        assertEquals(Screen.Home, vm.screen.value)
        advance(1)
        assertNull(vm.autoplay.value)
        assertEquals(Screen.Player, vm.screen.value)
        waitUntil("the resolve request") { count("/api/v1/tv/resolve") == 1 }
        assertEquals("""{"episodeId":"a.film"}""", resolveBodies().single())
    }

    @Test
    fun autoplayEndsWhenTheShowLeavesHome() {
        paired()
        autoplayOnStart = true
        val vm = startTv()
        waitUntil("the autoplay countdown") { vm.autoplay.value?.secondsLeft == 10 }
        advance(1_000)
        assertEquals(9, vm.autoplay.value?.secondsLeft)
        home = listOf("b", "c")
        version = 2
        app.graph.repository.refreshSoon()
        waitUntil("the new state") { vm.state.value?.version == 2L }
        assertEquals(9, vm.autoplay.value?.secondsLeft)
        advance(1_000)
        assertNull(vm.autoplay.value)
        advance(30_000)
        settle()
        assertEquals(Screen.Home, vm.screen.value)
        assertEquals(0, count("/api/v1/tv/resolve"))
    }

    @Test
    fun theMenuListsWhatTheFocusedShowAllowsAndBackPopsItsPagesOneByOne() {
        paired()
        val vm = startTvOnHome()
        vm.openMenu()
        val home = vm.state.value!!.home
        val movie = listOf(RootEntry.StartOver, RootEntry.Settings, RootEntry.About)
        assertEquals(MenuUi(listOf(MenuPage.Root(movie)), home[0].item, fromPlayer = false), vm.menu.value)
        vm.onBack()
        assertNull(vm.menu.value)
        vm.onTileFocused("c")
        vm.openMenu()
        val entries = listOf(RootEntry.Episodes, RootEntry.StartOver, RootEntry.Settings, RootEntry.About)
        assertEquals(MenuUi(listOf(MenuPage.Root(entries)), home[2].item, fromPlayer = false), vm.menu.value)
        vm.onRootEntry(RootEntry.Settings)
        assertEquals(listOf(MenuPage.Root(entries, focused = 2), MenuPage.Settings), vm.menu.value?.pages)
        vm.onBack()
        assertEquals(listOf(MenuPage.Root(entries, focused = 2)), vm.menu.value?.pages)
        vm.onRootEntry(RootEntry.Episodes)
        assertEquals(listOf(MenuPage.Root(entries, focused = 0), MenuPage.Episodes(details = null)), vm.menu.value?.pages)
        // The episode list cannot be read here: the loading page is replaced by the failed one.
        waitUntil("the failed episode list") { (vm.menu.value?.page as? MenuPage.Episodes)?.failed == true }
        assertEquals(listOf(MenuPage.Root(entries, focused = 0), MenuPage.Episodes(details = null, failed = true)), vm.menu.value?.pages)
        assertEquals("/api/v1/tv/items/c", requests.last { it.url.encodedPath.startsWith("/api/v1/tv/items/") }.url.encodedPath)
        vm.onBack()
        vm.onRootEntry(RootEntry.About)
        assertEquals(listOf(MenuPage.Root(entries, focused = 3), MenuPage.About), vm.menu.value?.pages)
        vm.onBack()
        vm.onBack()
        assertNull(vm.menu.value)
        assertEquals(Screen.Home, vm.screen.value)
    }

    @Test
    fun theLanguageEntryCyclesAutomaticTurkishEnglish() {
        paired()
        val vm = startTvOnHome()
        assertNull(vm.uiLanguageOverride.value)
        assertEquals("en", vm.uiLanguage.value)
        for (expected in listOf("tr", "en", null)) {
            vm.onSettingsEntry(SettingsEntry.Language)
            waitUntil("the override $expected") { vm.uiLanguageOverride.value == expected }
            assertEquals(expected ?: "en", vm.uiLanguage.value)
        }
    }

    private fun unpaired() = runBlocking { app.graph.deviceStore.setServer(server.url("/").toString()) }

    private fun paired() = runBlocking {
        app.graph.deviceStore.setServer(server.url("/").toString())
        app.graph.deviceStore.savePairing("tv-1", "device-token")
    }

    /** The view model as the activity creates it, with the app in front. */
    private fun startTv(): AppViewModel {
        val factory = viewModelFactory { initializer { AppViewModel(app.graph) } }
        val vm = ViewModelProvider(viewModels, factory)[AppViewModel::class.java]
        vm.onForeground()
        return vm
    }

    private fun startTvOnHome(): AppViewModel = startTv().also { vm ->
        waitUntil("Home with its tiles") { vm.screen.value == Screen.Home && vm.state.value?.home?.size == home.size }
        waitUntil("the event stream") { requests.any { it.url.encodedPath == "/api/v1/tv/events" } }
        settle()
    }

    private fun entry(id: String) = HomeEntry(ItemCard(id, "movie", "Show ${id.uppercase()}"), ContinueInfo("$id.film"))

    /** Sends an owner command on the event stream; returns its id. */
    private fun command(type: String, payload: String = "{}"): Long {
        val id = ++commandId
        events += commandEvent(id, type, payload)
        return id
    }

    private fun commandEvent(id: Long, type: String, payload: String) =
        "event: command\ndata: {\"id\":$id,\"type\":\"$type\",\"payload\":$payload}\n\n"

    /**
     * The TV acknowledges a command right after handing it to the view model, which acts on it at once: once the ack
     * arrives, the command's immediate effects are there (what it sends to the server may still be on its way).
     */
    private fun awaitAck(id: Long) {
        waitUntil("the ack of command $id") { requests.any { it.url.encodedPath == "/api/v1/tv/commands/$id/ack" } }
    }

    private fun count(path: String) = requests.count { it.url.encodedPath == path }

    private fun resolveBodies() = requests.filter { it.url.encodedPath == "/api/v1/tv/resolve" }.map { it.body?.utf8().orEmpty() }

    private val mainLooper get() = shadowOf(Looper.getMainLooper())

    /** Moves the clock on and runs what was due meanwhile (timers, countdowns, backoffs). */
    private fun advance(ms: Long) = mainLooper.idleFor(ms, TimeUnit.MILLISECONDS)

    /** Server answers arrive on OkHttp's threads, then run on the main looper: idle it until [condition] holds. */
    private fun waitUntil(what: String, condition: () -> Boolean) {
        repeat(1_500) { // up to 15 s: generous for a loaded machine
            mainLooper.idle()
            if (condition()) return
            Thread.sleep(10)
        }
        val vm = viewModels.keys().singleOrNull()?.let { viewModels[it] as? AppViewModel }
        fail(
            "Timed out waiting for $what; requests: ${requests.groupingBy { it.url.encodedPath }.eachCount()}; " +
                "screen ${vm?.screen?.value}, pairing ${vm?.pairing?.value}",
        )
    }

    /** Gives a request the app should not send the time to arrive anyway. */
    private fun settle() = repeat(20) {
        mainLooper.idle()
        Thread.sleep(10)
    }

    /** `/tv/events` as a live stream: [events] are written as they come, until the test ends. */
    private fun eventStream(): MockResponse = MockResponse.Builder()
        .addHeader("Content-Type", "text/event-stream")
        .body(object : MockResponseBody {
            override val contentLength: Long = -1

            override fun writeTo(sink: BufferedSink) {
                sink.writeUtf8(": open\n\n").flush()
                while (!closing) {
                    val event = events.poll(20, TimeUnit.MILLISECONDS) ?: continue
                    sink.writeUtf8(event).flush()
                }
            }
        })
        .build()

    /** The connection closes before an answer: an unreachable server, as the TV sees it. */
    private fun dropped(): MockResponse = MockResponse.Builder().onResponseStart(SocketEffect.CloseSocket()).build()

    private fun json(code: Int, body: String) =
        MockResponse.Builder().code(code).addHeader("Content-Type", "application/json").body(body).build()

    private fun stateJson(): String {
        val list = home.joinToString(",") { id ->
            if (id == "c") {
                """{"item":{"id":"c","kind":"series","title":"Show C"},"continue":{"episodeId":"c.e1","index":0,"count":3,"status":"new"}}"""
            } else {
                """{"item":{"id":"$id","kind":"movie","title":"Show ${id.uppercase()}"},"continue":{"episodeId":"$id.film","status":"new"}}"""
            }
        }
        return """{"version":$version,"device":{"id":"tv-1","name":"Living room","uiLanguage":"en","autoplayOnStart":$autoplayOnStart},""" +
            """"catalog":{"id":"sample","buildId":"b1","name":"Sample"},"home":[$list]}"""
    }
}
