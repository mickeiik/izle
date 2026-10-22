package io.github.mickeiik.izle.ui

import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Looper
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.test.core.app.ApplicationProvider
import io.github.mickeiik.izle.BuildConfig
import io.github.mickeiik.izle.IzleApp
import io.github.mickeiik.izle.data.api.ContinueInfo
import io.github.mickeiik.izle.data.api.EpisodeDetails
import io.github.mickeiik.izle.data.api.HomeEntry
import io.github.mickeiik.izle.data.api.ItemCard
import io.github.mickeiik.izle.domain.AutoplayPlan
import io.github.mickeiik.izle.installStatus
import io.github.mickeiik.izle.json
import io.github.mickeiik.izle.player.FakeMediaEngine
import io.github.mickeiik.izle.player.PlayerPhase
import io.github.mickeiik.izle.sha256
import io.github.mickeiik.izle.update.AppInstaller
import io.github.mickeiik.izle.update.UpdateCapability
import io.github.mickeiik.izle.update.UpdatePlan
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockResponseBody
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import mockwebserver3.SocketEffect
import okio.Buffer
import okio.BufferedSink
import org.junit.After
import org.junit.Assert.assertArrayEquals
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
import java.io.File
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * The real [AppViewModel] and app graph under Robolectric against an in-process server: pairing, the owner's commands
 * (over a live event stream), the timed messages, the countdowns and the hidden menu. Time is the paused main-looper
 * clock, advanced by the test; server answers arrive on OkHttp's threads and are waited for. Most resolves fail.
 * Home entries named `tv…` are channels, whose resolve takes a while so that the TV is still loading one meanwhile.
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

    @Volatile private var closing = false
    @Volatile private var home = listOf("a", "b", "c")
    @Volatile private var version = 1L
    @Volatile private var autoplayOnStart = false

    /** `/tv/state` (and `/tv/events`) answer this status when it is not 200. */
    @Volatile private var stateCode = 200

    /** Scripted answers to `pair/start`, `pair/wait` and `tv/resolve`; when empty, a fresh code and `pending`. */
    private val pairStarts = ConcurrentLinkedQueue<MockResponse>()
    private val pairWaits = ConcurrentLinkedQueue<MockResponse>()
    private val resolveAnswers = ConcurrentLinkedQueue<MockResponse>()

    /** `pair/start` drops the connection (an unreachable server) while set. */
    @Volatile private var pairStartDown = false

    private var commandId = 0L

    /** The APK the server stores (`/tv/app`, `/tv/app/apk`), or none (204, 404). */
    @Volatile private var apk: ByteArray? = null
    private val installer = FakeInstaller()

    @Before
    fun setUp() {
        app.graph.installer = installer
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                val path = request.url.encodedPath
                return when {
                    path == "/api/v1/tv/state" -> if (stateCode == 200) json(200, stateJson()) else json(stateCode, """{"error":"down"}""")
                    path == "/api/v1/tv/events" -> if (stateCode == 200) eventStream() else json(stateCode, """{"error":"down"}""")
                    path == "/api/v1/pair/start" ->
                        if (pairStartDown) dropped() else pairStarts.poll() ?: json(200, """{"code":"999999","pairToken":"pt-9"}""")
                    path == "/api/v1/pair/wait" -> pairWaits.poll() ?: run {
                        Thread.sleep(20) // a long poll, shortened
                        json(200, """{"status":"pending"}""")
                    }
                    path == "/api/v1/tv/resolve" && resolveAnswers.isNotEmpty() -> resolveAnswers.remove()
                    path == "/api/v1/tv/progress" -> json(200, """{"ok":true}""")
                    path.endsWith("/ack") || path.endsWith("/result") -> json(200, """{"ok":true}""")
                    path == "/api/v1/tv/app" -> apk?.let { bytes ->
                        json(200, """{"versionName":"99.0.0","versionCode":990000,"sha256":"${sha256(bytes)}","size":${bytes.size},"auto":true}""")
                    } ?: MockResponse.Builder().code(204).build()
                    path == "/api/v1/tv/app/apk" -> apk?.let { bytes ->
                        MockResponse.Builder().addHeader("Content-Type", "application/vnd.android.package-archive").body(Buffer().write(bytes)).build()
                    } ?: json(404, """{"error":"no_apk"}""")
                    // A channel, still loading while the test zaps or sends commands.
                    path == "/api/v1/tv/resolve" && request.body?.utf8().orEmpty().contains("\"itemId\":") -> {
                        Thread.sleep(CHANNEL_RESOLVE_MS)
                        json(404, """{"error":"unknown_item"}""")
                    }
                    // An episode whose resolve takes a while, so something else can happen meanwhile.
                    path == "/api/v1/tv/resolve" && request.body?.utf8().orEmpty().contains("\"slow.") -> {
                        Thread.sleep(2_000)
                        json(404, """{"error":"not_found"}""")
                    }
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
        pairStarts += json(200, """{"code":"111111","pairToken":"pt-1"}""")
        pairWaits += json(200, """{"status":"pending"}""")
        pairWaits += json(200, """{"status":"approved","deviceId":"tv-9","deviceToken":"tok-9"}""")
        val vm = startTv(paired = false)
        waitUntil("the pairing screen") { vm.screen.value == Screen.Pairing }
        waitUntil("Home after the approval") { vm.screen.value == Screen.Home }
        assertEquals("111111", vm.pairing.value.code)
        assertTrue(vm.pairing.value.adminUrl.endsWith("/admin"))
        assertEquals(listOf("code=111111&wait=25", "code=111111&wait=25"), requests.filter { it.url.encodedPath == "/api/v1/pair/wait" }.map { it.url.encodedQuery })
        assertEquals("Bearer pt-1", requests.last { it.url.encodedPath == "/api/v1/pair/wait" }.headers["Authorization"])
        runBlocking { assertEquals("tok-9", app.graph.deviceStore.current().deviceToken) }
        waitUntil("the state with the new token") { count("/api/v1/tv/state") > 0 }
        assertEquals("Bearer tok-9", requests.first { it.url.encodedPath == "/api/v1/tv/state" }.headers["Authorization"])
        assertNull(vm.homeFocusItemId)
    }

    @Test
    fun backOnThePairingScreenGoesToTheAddressScreenAndStopsPairing() {
        pairStartDown = true
        val vm = startTv(paired = false)
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
    fun pairAgainClosesTheMenuForgetsTheTokenAndShowsACode() {
        val vm = startTvOnHome()
        vm.openMenu()
        vm.onRootEntry(RootEntry.Settings)
        vm.onSettingsEntry(SettingsEntry.PairAgain)
        awaitPairingCode(vm)
        assertNull(vm.menu.value)
        runBlocking { assertNull(app.graph.deviceStore.current().deviceToken) }
    }

    @Test
    fun okWhileOfflineSaysNoConnectionForFiveSeconds() {
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
        assertEquals(0, count(RESOLVE))
    }

    @Test
    fun theOwnersMessageShowsForItsDurationAndANewOneReplacesIt() {
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
        waitUntil("the second ack") { count("/api/v1/tv/commands/$first/ack") == 2 }
        settle()
        assertNull(vm.banner.value)
    }

    @Test
    fun aPlayCommandOnHomePlaysThatEpisodeWithTheShowAsTheHint() {
        val vm = startTvOnHome()
        vm.openMenu()
        command("play", """{"itemId":"b","episodeId":"b.e2"}""")
        waitUntil("the player") { vm.screen.value == Screen.Player }
        assertNull("playing closes the menu", vm.menu.value)
        assertEquals("b", vm.homeFocusItemId)
        assertEquals("Show B", vm.player.ui.value.item?.title)
        awaitResolves(1)
        assertEquals("""{"episodeId":"b.e2","trigger":"command","commandId":1}""", resolveBodies().single())
        awaitErrorScreen(vm)
        assertEquals("Show B", vm.player.ui.value.item?.title)
        assertEquals(failed("no_playable_source"), awaitResult(1))
        // Try again continues that playback: the same trigger and command, and no second result.
        vm.player.retry()
        awaitResolves(2)
        assertEquals("""{"episodeId":"b.e2","trigger":"command","commandId":1}""", resolveBodies().last())
        awaitErrorScreen(vm)
        settle()
        assertEquals(1, results(1).size)
    }

    @Test
    fun aSuccessfulPlayUsesTheGraphEngineAndRemembersTheShowAtItsFirstFrame() {
        val engine = FakeMediaEngine()
        app.graph.mediaEngine = { engine }
        resolveAnswers += json(200, """{"sessionId":"session-1","sourceId":"first","media":{"kind":"mp4","url":"/media/one"},"item":{"id":"b","kind":"movie","title":"Show B"},"episode":{"id":"b.film","durationMs":1200000}}""")
        val vm = startTvOnHome()
        command("play", """{"itemId":"b","episodeId":"b.film"}""")
        waitUntil("the fake engine's load") { engine.loads.size == 1 }
        assertEquals(Screen.Player, vm.screen.value)
        assertEquals(PlayerPhase.Loading, vm.player.ui.value.phase)
        assertTrue(results(1).isEmpty())
        engine.ready()
        assertEquals(DONE, awaitResult(1))
        assertEquals(PlayerPhase.Playing, vm.player.ui.value.phase)
        waitUntil("the remembered show") { runBlocking { app.graph.deviceStore.current().lastPlayedItemId == "b" } }
        vm.onBack()
        waitUntil("the stopped report") { requests.any { it.url.encodedPath == "/api/v1/tv/progress" && it.body?.utf8()?.contains("\"stopped\"") == true } }
        assertEquals(Screen.Home, vm.screen.value)
        assertEquals(1, engine.calls.count { it == "release" })
        assertEquals(1, results(1).size)
    }

    @Test
    fun aPlayCommandThatDidNotRunYetIsIgnoredWhenReplacedOrLeft() {
        val vm = startTvOnHome()
        command("play", """{"itemId":"b","episodeId":"slow.e1"}""")
        awaitResolves(1)
        command("play", """{"itemId":"c","episodeId":"c.e2"}""")
        assertEquals(ignored("superseded"), awaitResult(1))
        assertEquals(failed("no_playable_source"), awaitResult(2))

        command("play", """{"itemId":"b","episodeId":"slow.e2"}""")
        awaitResolves(3)
        vm.onBack()
        assertEquals(Screen.Home, vm.screen.value)
        assertEquals(ignored("stopped"), awaitResult(3))
        settle()
        assertEquals(listOf(1, 1, 1), (1L..3L).map { results(it).size })
    }

    @Test
    fun eachViewerEntryPointResolvesAsTheViewer() {
        val vm = startTvOnHome()
        vm.onTileClicked(vm.state.value!!.home.first())
        awaitResolves(1)
        vm.onBack()
        vm.onTileFocused("c")
        vm.openMenu()
        vm.onRootEntry(RootEntry.StartOver)
        awaitResolves(2)
        vm.onBack()
        vm.openMenu()
        vm.onEpisodeChosen(EpisodeDetails("c.e3", index = 2, playbackAllowed = true))
        awaitResolves(3)
        assertEquals(
            listOf("""{"episodeId":"a.film","trigger":"viewer"}""", """{"episodeId":"c.e1","trigger":"viewer"}""", """{"episodeId":"c.e3","trigger":"viewer"}"""),
            resolveBodies(),
        )
    }

    @Test
    fun onTheErrorScreenOnlyStopAndPlayAct() {
        val vm = startTvOnHome()
        vm.onTileClicked(vm.state.value!!.home.first())
        awaitErrorScreen(vm)
        for ((type, payload) in listOf("pause" to "{}", "resume" to "{}", "seek" to """{"positionMs":0}""", "next" to "{}", "previous" to "{}")) {
            val id = command(type, payload)
            awaitAck(id)
            assertTrue(type, vm.player.ui.value.phase is PlayerPhase.Failed)
            assertEquals(type, Screen.Player, vm.screen.value)
            assertEquals(type, ignored("not_in_player"), awaitResult(id))
        }
        settle()
        assertEquals(listOf("""{"episodeId":"a.film","trigger":"viewer"}"""), resolveBodies())
        val play = command("play", """{"itemId":"c","episodeId":"c.e2"}""")
        awaitResolves(2)
        assertEquals("""{"episodeId":"c.e2","trigger":"command","commandId":$play}""", resolveBodies().last())
        awaitErrorScreen(vm)
        assertEquals(failed("no_playable_source"), awaitResult(play))
        val stop = command("stop")
        waitUntil("Home") { vm.screen.value == Screen.Home }
        assertEquals(PlayerPhase.Idle, vm.player.ui.value.phase)
        assertEquals(DONE, awaitResult(stop))
        assertEquals("on Home a transport command has no video", ignored("not_in_player"), awaitResult(command("pause")))
    }

    @Test
    fun theErrorScreenCountsDownThirtySecondsThenGoesHome() {
        val vm = startTvOnHome()
        vm.onTileClicked(vm.state.value!!.home.first())
        assertEquals(Screen.Player, vm.screen.value)
        assertEquals(PlayerPhase.Loading, vm.player.ui.value.phase)
        awaitErrorScreen(vm)
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
        awaitResolves(1)
        assertEquals("""{"episodeId":"a.film","trigger":"autoplay"}""", resolveBodies().single())
    }

    @Test
    fun autoplayEndsWhenTheShowLeavesHome() {
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
        assertEquals(0, count(RESOLVE))
    }

    @Test
    fun autoplayOffersAChannelAsLiveAndPlaysItAtItsLiveEdge() {
        autoplayOnStart = true
        home = listOf("tv1", "a")
        val vm = startTv()
        waitUntil("the autoplay countdown") { vm.autoplay.value != null }
        assertEquals("tv1", vm.autoplay.value?.entry?.item?.id)
        advance(AutoplayPlan.COUNTDOWN_SEC * 1_000L)
        assertEquals(Screen.Player, vm.screen.value)
        assertTrue(vm.player.ui.value.live)
        awaitResolves(1)
        assertEquals("""{"itemId":"tv1","trigger":"autoplay"}""", resolveBodies().single())
    }

    @Test
    fun theMenuListsWhatTheFocusedShowAllowsAndBackPopsItsPagesOneByOne() {
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

        // Settings' server address: the address screen, which takes no command and which Back leaves for Home.
        vm.openMenu()
        vm.onRootEntry(RootEntry.Settings)
        vm.onSettingsEntry(SettingsEntry.ServerAddress)
        assertEquals(Screen.Setup(canGoBack = true), vm.screen.value)
        assertNull(vm.menu.value)
        assertEquals(ignored("not_ready"), awaitResult(command("play", """{"itemId":"b","episodeId":"b.e2"}""")))
        assertEquals(0, count(RESOLVE))
        vm.onBack()
        assertEquals(Screen.Home, vm.screen.value)
    }

    @Test
    fun theLanguageEntryCyclesAutomaticTurkishEnglish() {
        val vm = startTvOnHome()
        assertNull(vm.uiLanguageOverride.value)
        assertEquals("en", vm.uiLanguage.value)
        for (expected in listOf("tr", "en", null)) {
            vm.onSettingsEntry(SettingsEntry.Language)
            waitUntil("the override $expected") { vm.uiLanguageOverride.value == expected }
            assertEquals(expected ?: "en", vm.uiLanguage.value)
        }
    }

    @Test
    fun aGuidedUpdateAsksForOkBackIsDeclinedAndAMinuteIsATimeout() {
        offerUpdate(silent = false)
        val vm = startTvOnHome()
        assertEquals(UpdateCapability.Guided, app.graph.updater.capability.value)
        assertEquals(userAgent("guided"), requests.last { it.url.encodedPath == "/api/v1/tv/state" }.headers["User-Agent"])
        vm.openMenu()
        val id = command("update", """{"versionCode":990000}""")
        waitUntil("the press OK screen") { vm.screen.value == Screen.Update(UpdateUi("99.0.0", UpdatePhase.Prompt(UpdatePlan.GUIDED_TIMEOUT_SEC))) }
        assertNull("the menu closed", vm.menu.value)
        advance(1_000)
        assertEquals(Screen.Update(UpdateUi("99.0.0", UpdatePhase.Prompt(59))), vm.screen.value)
        vm.onBack()
        assertEquals(Screen.Home, vm.screen.value)
        assertEquals(ignored("declined"), awaitResult(id))

        val again = promptUpdate(vm, versionCode = null)
        advance(59_999)
        assertTrue(vm.screen.value is Screen.Update)
        advance(1)
        assertEquals(Screen.Home, vm.screen.value)
        assertEquals(ignored("timeout"), awaitResult(again))
        assertEquals(0, count("/api/v1/tv/app/apk"))
        assertTrue(installer.installs.isEmpty())
    }

    @Test
    fun okOnThePressOkScreenDownloadsReportsAndOpensTheSystemDialog() {
        val bytes = ByteArray(70_000) { (it % 7).toByte() }
        offerUpdate(silent = false, bytes)
        val vm = startTvOnHome()
        val id = promptUpdate(vm)
        vm.onUpdateInstall()
        assertEquals(INSTALLING, vm.screen.value)
        waitUntil("the install") { installer.installs.isNotEmpty() }
        val install = installer.installs.single()
        assertFalse(install.silent)
        assertTrue("the result went out before the install", install.resultSentBefore)
        assertArrayEquals(bytes, install.bytes)
        assertEquals(listOf(990_000L), installer.verified)
        assertEquals("""{"result":"done","reason":"prompted"}""", awaitResult(id))
        assertEquals("Bearer device-token", requests.last { it.url.encodedPath == "/api/v1/tv/app/apk" }.headers["Authorization"])

        // The system wants its dialog shown: the activity starts it. Cancel in that dialog: Home, nothing else.
        vm.answerInstall(PackageInstaller.STATUS_PENDING_USER_ACTION, Intent("android.content.pm.action.CONFIRM_INSTALL"))
        assertEquals("android.content.pm.action.CONFIRM_INSTALL", vm.launchIntent().action)
        vm.answerInstall(PackageInstaller.STATUS_FAILURE_ABORTED)
        assertEquals(Screen.Home, vm.screen.value)
    }

    @Test
    fun withTheGrantTheUpdateInstallsSilentlyAfterReportingIt() {
        offerUpdate(silent = true, ByteArray(70_000) { (it % 5).toByte() })
        val vm = startTvOnHome()
        assertEquals(UpdateCapability.Silent, app.graph.updater.capability.value)
        val id = command("update", """{"versionCode":990000}""")
        waitUntil("the install") { installer.installs.isNotEmpty() }
        val install = installer.installs.single()
        assertTrue(install.silent)
        assertTrue("the result went out before the install", install.resultSentBefore)
        assertEquals("""{"result":"done","reason":"installing"}""", awaitResult(id))
        assertEquals(INSTALLING, vm.screen.value)
        assertEquals(userAgent("silent"), requests.last { it.url.encodedPath == "/api/v1/tv/app/apk" }.headers["User-Agent"])

        // The system wants it confirmed after all: abandoned, guided from now on, the owner told, back Home.
        vm.answerInstall(PackageInstaller.STATUS_PENDING_USER_ACTION, Intent("x"))
        assertEquals(listOf(7), installer.abandoned)
        assertEquals(Screen.Home, vm.screen.value)
        assertEquals(UpdateCapability.Guided, app.graph.updater.capability.value)
        assertEquals("what the next requests say", userAgent("guided"), app.graph.updater.userAgent)
        waitUntil("the problem report") { count("/api/v1/tv/problems") == 1 }
        assertTrue(problemBodies().last().contains("\"code\":\"update_needs_user_action\""))
        waitUntil("the stored refusal") { runBlocking { app.graph.deviceStore.current().updateSilentRefused } }
    }

    @Test
    fun anUpdateDuringPlaybackIsBusyAndInstallUpdateLeavesThePlaybackAlone() {
        offerUpdate(silent = true)
        val vm = startTvOnHome()
        waitUntil("the offered version") { app.graph.updater.available.value?.versionCode == 990_000L }
        vm.onTileClicked(vm.state.value!!.home.first())
        assertEquals(Screen.Player, vm.screen.value)
        val checks = count("/api/v1/tv/app")
        vm.onSettingsEntry(SettingsEntry.InstallUpdate)
        settle()
        assertEquals(Screen.Player, vm.screen.value)
        assertEquals(checks, count("/api/v1/tv/app"))
        val id = command("update", """{"versionCode":990000}""")
        assertEquals(ignored("busy"), awaitResult(id))
        assertEquals(Screen.Player, vm.screen.value)
        assertEquals(0, count("/api/v1/tv/app/apk"))
        assertTrue(installer.installs.isEmpty())
    }

    @Test
    fun aSilentTvUpdatesByItselfAfterThreeIdleMinutesOnHome() {
        offerUpdate(silent = true)
        val vm = startTvOnHome()
        waitUntil("the offered version") { app.graph.updater.available.value?.versionCode == 990_000L }
        assertEquals("99.0.0", vm.aboutInfo().updateVersion)
        advance(150_000)
        vm.onKeyDown() // someone is there: the three minutes start over
        advance(150_000)
        settle()
        assertTrue(installer.installs.isEmpty())
        assertEquals(0, count("/api/v1/tv/app/apk"))
        advance(60_000)
        waitUntil("the install") { installer.installs.isNotEmpty() }
        assertTrue(installer.installs.single().silent)
        assertEquals(INSTALLING, vm.screen.value)
        assertEquals(0, requests.count { it.url.encodedPath.endsWith("/result") })
    }

    @Test
    fun theSystemDialogOverTheAppKeepsUpdatingAndBringsNoAutoplay() {
        autoplayOnStart = true
        offerUpdate(silent = false)
        val vm = startTv()
        waitUntil("the autoplay countdown") { vm.autoplay.value != null }
        vm.cancelAutoplay()
        val id = promptUpdate(vm)
        vm.onUpdateInstall()
        waitUntil("the install") { installer.installs.isNotEmpty() }
        assertEquals("""{"result":"done","reason":"prompted"}""", awaitResult(id))
        vm.answerInstall(PackageInstaller.STATUS_PENDING_USER_ACTION, Intent("x"))
        assertEquals("x", vm.launchIntent().action)

        // The system's dialog covers the app: it stops and comes back, still "Updating…".
        vm.onBackground()
        assertEquals(INSTALLING, vm.screen.value)
        val states = count("/api/v1/tv/state")
        vm.onForeground()
        waitUntil("a fresh state") { count("/api/v1/tv/state") > states }
        settle()
        assertEquals(INSTALLING, vm.screen.value)
        assertNull("no autoplay over the dialog's answer", vm.autoplay.value)

        // Cancel in the dialog: Home, and still no autoplay.
        vm.answerInstall(PackageInstaller.STATUS_FAILURE_ABORTED)
        assertEquals(Screen.Home, vm.screen.value)
        advance(15_000)
        settle()
        assertNull(vm.autoplay.value)
        assertEquals(Screen.Home, vm.screen.value)
    }

    @Test
    fun aRemovedTvShowsANewPairingCodeEvenOverThePressOkScreen() {
        offerUpdate(silent = false)
        val vm = startTvOnHome()
        val id = promptUpdate(vm)
        advance(1_000)
        // The server forgot this TV meanwhile: the token goes, the server stays.
        stateCode = 401
        app.graph.repository.refreshSoon()
        awaitPairingCode(vm)
        runBlocking {
            assertNull(app.graph.deviceStore.current().deviceToken)
            assertEquals(server.url("/").toString(), app.graph.deviceStore.current().serverUrl)
        }
        assertEquals(ignored("declined"), awaitResult(id))
        advance(UpdatePlan.GUIDED_TIMEOUT_SEC * 1_000L)
        settle()
        assertEquals(Screen.Pairing, vm.screen.value)
        assertEquals(1, results(id).size)
    }

    @Test
    fun aFailedInstallAfterThePromptedResultIsAProblemReportAndCouldNotUpdate() {
        offerUpdate(silent = false)
        installer.installFailure = RuntimeException("installation services unavailable")
        val vm = startTvOnHome()
        val id = promptUpdate(vm)
        vm.onUpdateInstall()
        waitUntil("Could not update") { vm.screen.value == Screen.Update(UpdateUi("99.0.0", UpdatePhase.Failed(UpdatePlan.FAILED_HOME_SEC))) }
        assertEquals("""{"result":"done","reason":"prompted"}""", awaitResult(id))
        waitUntil("the problem report") { problemBodies().any { it.contains("\"code\":\"update_internal\"") } }
        settle()
        assertEquals("one result per command", 1, results(id).size)
        advance(UpdatePlan.FAILED_HOME_SEC * 1_000L)
        assertEquals(Screen.Home, vm.screen.value)
    }

    @Test
    fun okOnAChannelResolvesItByItsItemIdAndTheOwnerHearsOfItByItsItem() {
        home = listOf("a", "tv1", "c", "tv2")
        val vm = startTvOnHome()
        val channel = vm.state.value!!.home[1]
        assertTrue(channel.item.isLive)
        assertNull(channel.playNext)
        vm.onTileClicked(channel)
        assertEquals(Screen.Player, vm.screen.value)
        assertEquals(PlayerPhase.Loading, vm.player.ui.value.phase)
        assertTrue("its name and Live while it loads", vm.player.ui.value.live)
        assertEquals("Channel 1", vm.player.ui.value.item?.title)
        assertEquals("tv1", vm.homeFocusItemId)
        awaitResolves(1)
        assertEquals("""{"itemId":"tv1","trigger":"viewer"}""", resolveBodies().single())
        awaitErrorScreen(vm)
        waitUntil("the problem reports") { problemBodies().size == 2 }
        // The failed resolve and "Can't play right now", by the channel's item id, without an episode or position.
        assertEquals(
            setOf("resolve" to "unknown_item", "playback" to "gave_up"),
            problemBodies().map { it.substringAfter("\"kind\":\"").substringBefore('"') to it.substringAfter("\"code\":\"").substringBefore('"') }.toSet(),
        )
        for (body in problemBodies()) {
            assertTrue(body, body.contains("\"itemId\":\"tv1\""))
            assertFalse(body, body.contains("episodeId") || body.contains("positionMs"))
        }
        // Try again: the channel once more, at its live edge.
        vm.player.retry()
        awaitResolves(2)
        assertEquals("""{"itemId":"tv1","trigger":"viewer"}""", resolveBodies().last())
        assertTrue(vm.player.ui.value.live)
    }

    @Test
    fun channelKeysZapAmongHomesChannelsInHomeOrderWithoutWrappingAround() {
        home = listOf("tv1", "c", "tv2", "a", "tv3")
        val vm = startTvOnHome()
        vm.onTileClicked(vm.state.value!!.home[0])
        awaitResolves(1)
        // CH+ while it loads: past show C, to channel 2, whose name shows while it loads.
        vm.onChannelKey(1)
        assertEquals(PlayerPhase.Loading, vm.player.ui.value.phase)
        assertEquals("Channel 2", vm.player.ui.value.item?.title)
        assertTrue(vm.player.ui.value.live)
        assertEquals("tv2", vm.homeFocusItemId)
        awaitResolves(2)
        vm.onChannelKey(1)
        awaitResolves(3)
        assertEquals("Channel 3", vm.player.ui.value.item?.title)
        // The last channel: nothing after it.
        vm.onChannelKey(1)
        settle()
        assertEquals(3, count(RESOLVE))
        assertEquals("Channel 3", vm.player.ui.value.item?.title)
        vm.onChannelKey(-1)
        awaitResolves(4)
        assertEquals("tv2", vm.homeFocusItemId)
        assertEquals(listOf("tv1" to "viewer", "tv2" to "next", "tv3" to "next", "tv2" to "next").map(::channelResolve), resolveBodies())

        // Nothing plays here: channel 2 ends on "Can't play right now", from where the owner's next zaps as CH+ does.
        awaitErrorScreen(vm)
        assertTrue(vm.player.ui.value.live)
        val next = command("next")
        assertEquals(DONE, awaitResult(next))
        assertEquals(PlayerPhase.Loading, vm.player.ui.value.phase)
        awaitResolves(5)
        assertEquals("""{"itemId":"tv3","trigger":"command","commandId":$next}""", resolveBodies().last())
        // The last channel's error screen: CH+ only shows the information, CH− goes back.
        awaitErrorScreen(vm)
        vm.onChannelKey(1)
        settle()
        assertEquals(5, count(RESOLVE))
        assertTrue(vm.player.ui.value.phase is PlayerPhase.Failed)
        vm.onChannelKey(-1)
        awaitResolves(6)
        assertEquals("Channel 2", vm.player.ui.value.item?.title)
        // Back: Home, the channel played last focused.
        vm.onBack()
        assertEquals(Screen.Home, vm.screen.value)
        assertEquals("tv2", vm.homeFocusItemId)
    }

    @Test
    fun aPlayCommandWithoutAnEpisodePlaysTheChannelWhichIsNeverPaused() {
        home = listOf("a", "tv1", "c", "tv2")
        val vm = startTvOnHome()
        val play = command("play", """{"itemId":"tv1","episodeId":null}""")
        awaitResolves(1)
        assertEquals("""{"itemId":"tv1","trigger":"command","commandId":$play}""", resolveBodies().single())
        assertTrue(vm.player.ui.value.live)
        assertEquals("Channel 1", vm.player.ui.value.item?.title)
        assertEquals("tv1", vm.homeFocusItemId)
        // No pause on a channel: pause, resume and seek do nothing.
        for ((type, payload) in listOf("pause" to "{}", "resume" to "{}", "seek" to """{"deltaMs":30000}""")) {
            assertEquals(type, ignored("live"), awaitResult(command(type, payload)))
        }
        assertEquals(PlayerPhase.Loading, vm.player.ui.value.phase)
        assertTrue(vm.player.ui.value.playWhenReady)
        // Previous: channel 1 is Home's first. Next: channel 2, as CH+ would.
        assertEquals(ignored("no_channel"), awaitResult(command("previous")))
        val next = command("next")
        assertEquals(DONE, awaitResult(next))
        assertEquals("the play command was replaced", ignored("superseded"), awaitResult(play))
        awaitResolves(2)
        assertEquals("""{"itemId":"tv2","trigger":"command","commandId":$next}""", resolveBodies().last())
        assertEquals("tv2", vm.homeFocusItemId)

        // A channel that is not on Home has no neighbours there.
        val elsewhere = command("play", """{"itemId":"tv9","episodeId":null}""")
        awaitResolves(3)
        assertNull("no name before the answer", vm.player.ui.value.item)
        assertTrue(vm.player.ui.value.live)
        assertEquals(ignored("no_channel"), awaitResult(command("next")))
        assertEquals(3, count(RESOLVE))
        awaitErrorScreen(vm)
        assertEquals(failed("no_playable_source"), awaitResult(elsewhere))
        // On its error screen the transport commands find no video, as for a show.
        assertEquals(ignored("not_in_player"), awaitResult(command("pause")))
    }

    /** Checks and installs nothing; remembers what it was asked. */
    private inner class FakeInstaller : AppInstaller {
        inner class Install(val silent: Boolean, val bytes: ByteArray, val resultSentBefore: Boolean)

        val verified = CopyOnWriteArrayList<Long>()
        val installs = CopyOnWriteArrayList<Install>()
        val abandoned = CopyOnWriteArrayList<Int>()

        @Volatile var installFailure: Exception? = null

        override suspend fun verifyArchive(file: File, expectedVersionCode: Long) {
            verified += expectedVersionCode
        }

        override suspend fun install(file: File, silent: Boolean): Int {
            installFailure?.let { throw it }
            installs += Install(silent, file.readBytes(), resultSentBefore = requests.any { it.url.encodedPath.endsWith("/result") })
            return 7
        }

        override fun ownsSession(sessionId: Int) = true

        override fun isSystemConfirmation(intent: Intent) = true

        override fun abandon(sessionId: Int) {
            abandoned += sessionId
        }
    }

    /** The server offers version 99.0.0; [silent]: this TV may install it without asking (Android 8+, with the grant). */
    private fun offerUpdate(silent: Boolean, bytes: ByteArray = ByteArray(5_000) { it.toByte() }) {
        apk = bytes
        shadowOf(app.packageManager).setCanRequestPackageInstalls(silent)
    }

    /** The owner's `update`, waited for until the guided "press OK" shows; returns the command's id. */
    private fun promptUpdate(vm: AppViewModel, versionCode: Long? = 990_000): Long {
        val id = command("update", if (versionCode == null) "{}" else """{"versionCode":$versionCode}""")
        waitUntil("the press OK screen") { vm.screen.value is Screen.Update }
        return id
    }

    /** The system's answer about the install session, as the activity hands it over. */
    private fun AppViewModel.answerInstall(status: Int, confirm: Intent? = null) {
        onInstallStatus(installStatus(status).apply { if (confirm != null) putExtra(Intent.EXTRA_INTENT, confirm) })
        mainLooper.idle()
    }

    private fun AppViewModel.launchIntent(): Intent = runBlocking { withTimeout(5_000) { launchIntents.first() } }

    private fun userAgent(capability: String) = "izle-tv/${BuildConfig.VERSION_NAME} (Android 36; ${BuildConfig.VERSION_CODE}; $capability)"

    /** The view model as the activity creates it, with the app in front ([paired]: with this server's device token). */
    private fun startTv(paired: Boolean = true): AppViewModel {
        runBlocking {
            app.graph.deviceStore.setServer(server.url("/").toString())
            if (paired) app.graph.deviceStore.savePairing("tv-1", "device-token")
        }
        val factory = viewModelFactory { initializer { AppViewModel(app.graph) } }
        return ViewModelProvider(viewModels, factory)[AppViewModel::class.java].also { it.onForeground() }
    }

    private fun startTvOnHome(): AppViewModel = startTv().also { vm ->
        waitUntil("Home with its tiles") { vm.screen.value == Screen.Home && vm.state.value?.home?.size == home.size }
        waitUntil("the event stream") { count("/api/v1/tv/events") > 0 }
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

    /** Once a command's ack arrives, its immediate effects are there (what it sends the server may be on its way). */
    private fun awaitAck(id: Long) = waitUntil("the ack of command $id") { count("/api/v1/tv/commands/$id/ack") > 0 }

    private fun awaitResolves(n: Int) = waitUntil("resolve request $n") { count(RESOLVE) == n }

    private fun awaitErrorScreen(vm: AppViewModel) = waitUntil("the error screen") { vm.player.ui.value.phase is PlayerPhase.Failed }

    private fun awaitPairingCode(vm: AppViewModel) =
        waitUntil("the pairing code") { vm.screen.value == Screen.Pairing && vm.pairing.value.code == "999999" }

    private fun count(path: String) = requests.count { it.url.encodedPath == path }

    private fun bodies(path: String) = requests.filter { it.url.encodedPath == path }.map { it.body?.utf8().orEmpty() }

    /** The results the TV sent for command [id]; [awaitResult]: the single one, once it arrived. */
    private fun results(id: Long) = bodies("/api/v1/tv/commands/$id/result")

    private fun awaitResult(id: Long): String {
        waitUntil("the result of command $id") { results(id).isNotEmpty() }
        return results(id).single()
    }

    private fun ignored(reason: String) = """{"result":"ignored","reason":"$reason"}"""

    private fun failed(reason: String) = """{"result":"failed","reason":"$reason"}"""

    private fun channelResolve(resolve: Pair<String, String>) = """{"itemId":"${resolve.first}","trigger":"${resolve.second}"}"""

    private fun resolveBodies() = bodies(RESOLVE)

    private fun problemBodies() = bodies("/api/v1/tv/problems")

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

    private fun stateJson(): String {
        val list = home.joinToString(",") { id ->
            if (id.startsWith("tv")) {
                """{"item":{"id":"$id","kind":"live","title":"Channel ${id.removePrefix("tv")}"},"continue":null,"newEpisodes":0}"""
            } else if (id == "c") {
                """{"item":{"id":"c","kind":"series","title":"Show C"},"continue":{"episodeId":"c.e1","index":0,"count":3,"status":"new"}}"""
            } else {
                """{"item":{"id":"$id","kind":"movie","title":"Show ${id.uppercase()}"},"continue":{"episodeId":"$id.film","status":"new"}}"""
            }
        }
        return """{"version":$version,"device":{"id":"tv-1","name":"Living room","uiLanguage":"en","autoplayOnStart":$autoplayOnStart},""" +
            """"catalog":{"id":"sample","buildId":"b1","name":"Sample"},"home":[$list]}"""
    }

    private companion object {
        const val RESOLVE = "/api/v1/tv/resolve"

        /** How long a channel's resolve takes here (real time): the TV is still loading it meanwhile. */
        const val CHANNEL_RESOLVE_MS = 2_500L

        const val DONE = """{"result":"done"}"""
        val INSTALLING = Screen.Update(UpdateUi("99.0.0", UpdatePhase.Installing))
    }
}
