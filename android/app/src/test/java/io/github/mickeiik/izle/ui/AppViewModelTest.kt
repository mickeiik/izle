package io.github.mickeiik.izle.ui

import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Looper
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.test.core.app.ApplicationProvider
import io.github.mickeiik.izle.IzleApp
import io.github.mickeiik.izle.data.api.ContinueInfo
import io.github.mickeiik.izle.data.api.EpisodeDetails
import io.github.mickeiik.izle.data.api.HomeEntry
import io.github.mickeiik.izle.data.api.ItemCard
import io.github.mickeiik.izle.player.PlayerPhase
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
import java.io.File
import java.security.MessageDigest
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

    @Volatile private var closing = false
    @Volatile private var home = listOf("a", "b", "c")
    @Volatile private var version = 1L
    @Volatile private var autoplayOnStart = false

    /** `/tv/state` (and `/tv/events`) answer this status when it is not 200. */
    @Volatile private var stateCode = 200

    /** Scripted answers to `pair/start` and `pair/wait`; when empty, a fresh code and `pending`. */
    private val pairStarts = ConcurrentLinkedQueue<MockResponse>()
    private val pairWaits = ConcurrentLinkedQueue<MockResponse>()

    /** `pair/start` drops the connection (an unreachable server) while set. */
    @Volatile private var pairStartDown = false

    private var commandId = 0L

    /** The APK the server stores (`/tv/app`, `/tv/app/apk`), or none (204, 404). */
    @Volatile private var apk: ByteArray? = null
    @Volatile private var apkAuto = true
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
                    path.endsWith("/ack") || path.endsWith("/result") -> json(200, """{"ok":true}""")
                    path == "/api/v1/tv/app" -> apk?.let { bytes ->
                        json(200, """{"versionName":"0.3.0","versionCode":300,"sha256":"${sha256(bytes)}","size":${bytes.size},"auto":$apkAuto}""")
                    } ?: MockResponse.Builder().code(204).build()
                    path == "/api/v1/tv/app/apk" -> apk?.let { bytes ->
                        MockResponse.Builder().addHeader("Content-Type", "application/vnd.android.package-archive").body(Buffer().write(bytes)).build()
                    } ?: json(404, """{"error":"no_apk"}""")
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
        assertEquals("""{"episodeId":"b.e2","trigger":"command","commandId":1}""", resolveBodies().single())
        waitUntil("the error screen") { vm.player.ui.value.phase is PlayerPhase.Failed }
        assertEquals("Show B", vm.player.ui.value.item?.title)
        assertEquals("""{"result":"failed","reason":"no_playable_source"}""", awaitResult(1))
        // Try again continues that playback: the same trigger and command, and no second result.
        vm.player.retry()
        waitUntil("the second resolve") { count("/api/v1/tv/resolve") == 2 }
        assertEquals("""{"episodeId":"b.e2","trigger":"command","commandId":1}""", resolveBodies().last())
        waitUntil("the error screen again") { vm.player.ui.value.phase is PlayerPhase.Failed }
        settle()
        assertEquals(1, results(1).size)
    }

    @Test
    fun aPlayCommandThatDidNotRunYetIsIgnoredWhenReplacedOrLeft() {
        paired()
        val vm = startTvOnHome()
        command("play", """{"itemId":"b","episodeId":"slow.e1"}""")
        waitUntil("the first resolve") { count("/api/v1/tv/resolve") == 1 }
        command("play", """{"itemId":"c","episodeId":"c.e2"}""")
        assertEquals("""{"result":"ignored","reason":"superseded"}""", awaitResult(1))
        assertEquals("""{"result":"failed","reason":"no_playable_source"}""", awaitResult(2))

        command("play", """{"itemId":"b","episodeId":"slow.e2"}""")
        waitUntil("the third resolve") { count("/api/v1/tv/resolve") == 3 }
        vm.onBack()
        assertEquals(Screen.Home, vm.screen.value)
        assertEquals("""{"result":"ignored","reason":"stopped"}""", awaitResult(3))
        settle()
        assertEquals(listOf(1, 1, 1), (1L..3L).map { results(it).size })
    }

    @Test
    fun eachViewerEntryPointResolvesAsTheViewer() {
        paired()
        val vm = startTvOnHome()
        vm.onTileClicked(vm.state.value!!.home.first())
        waitUntil("the first resolve") { count("/api/v1/tv/resolve") == 1 }
        vm.onBack()
        vm.onTileFocused("c")
        vm.openMenu()
        vm.onRootEntry(RootEntry.StartOver)
        waitUntil("the second resolve") { count("/api/v1/tv/resolve") == 2 }
        vm.onBack()
        vm.openMenu()
        vm.onEpisodeChosen(EpisodeDetails("c.e3", index = 2, playbackAllowed = true))
        waitUntil("the third resolve") { count("/api/v1/tv/resolve") == 3 }
        assertEquals(
            listOf("""{"episodeId":"a.film","trigger":"viewer"}""", """{"episodeId":"c.e1","trigger":"viewer"}""", """{"episodeId":"c.e3","trigger":"viewer"}"""),
            resolveBodies(),
        )
    }

    @Test
    fun commandsThatActAtOnceReportAtOnce() {
        paired()
        val vm = startTvOnHome()
        command("message", """{"text":"Hello"}""")
        command("dance", """{"style":"tango"}""")
        command("seek", """{"positionMs":"soon"}""")
        assertEquals("""{"result":"done"}""", awaitResult(1))
        assertEquals("""{"result":"ignored","reason":"unknown_type"}""", awaitResult(2))
        assertEquals("an unusable payload", """{"result":"ignored","reason":"unknown_type"}""", awaitResult(3))
        assertEquals("Hello", vm.banner.value)
    }

    @Test
    fun onTheErrorScreenOnlyStopAndPlayAct() {
        paired()
        val vm = startTvOnHome()
        vm.onTileClicked(vm.state.value!!.home.first())
        waitUntil("the error screen") { vm.player.ui.value.phase is PlayerPhase.Failed }
        for ((type, payload) in listOf("pause" to "{}", "resume" to "{}", "seek" to """{"positionMs":0}""", "next" to "{}", "previous" to "{}")) {
            val id = command(type, payload)
            awaitAck(id)
            assertTrue(type, vm.player.ui.value.phase is PlayerPhase.Failed)
            assertEquals(type, Screen.Player, vm.screen.value)
            assertEquals(type, """{"result":"ignored","reason":"not_in_player"}""", awaitResult(id))
        }
        settle()
        assertEquals(1, count("/api/v1/tv/resolve"))
        assertEquals("""{"episodeId":"a.film","trigger":"viewer"}""", resolveBodies().single())
        val play = command("play", """{"itemId":"c","episodeId":"c.e2"}""")
        waitUntil("the second resolve") { count("/api/v1/tv/resolve") == 2 }
        assertEquals("""{"episodeId":"c.e2","trigger":"command","commandId":$play}""", resolveBodies().last())
        waitUntil("the error screen") { vm.player.ui.value.phase is PlayerPhase.Failed }
        assertEquals("""{"result":"failed","reason":"no_playable_source"}""", awaitResult(play))
        val stop = command("stop")
        waitUntil("Home") { vm.screen.value == Screen.Home }
        assertEquals(PlayerPhase.Idle, vm.player.ui.value.phase)
        assertEquals("""{"result":"done"}""", awaitResult(stop))
        assertEquals("on Home a transport command has no video", """{"result":"ignored","reason":"not_in_player"}""", awaitResult(command("pause")))
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
        val play = command("play", """{"itemId":"b","episodeId":"b.e2"}""")
        val message = command("message", """{"text":"Hello"}""")
        awaitAck(play)
        awaitAck(message)
        settle()
        assertEquals(Screen.Setup(canGoBack = true), vm.screen.value)
        assertNull(vm.banner.value)
        assertEquals(0, count("/api/v1/tv/resolve"))
        assertEquals("""{"result":"ignored","reason":"not_ready"}""", awaitResult(play))
        assertEquals("""{"result":"ignored","reason":"not_ready"}""", awaitResult(message))
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
        assertEquals("""{"episodeId":"a.film","trigger":"autoplay"}""", resolveBodies().single())
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

    @Test
    fun aGuidedUpdateAsksForOkAndBackIsDeclined() {
        paired()
        apk = ByteArray(5_000) { it.toByte() }
        grantInstalls(false)
        val vm = startTvOnHome()
        assertEquals(UpdateCapability.Guided, app.graph.updater.capability.value)
        assertEquals("izle-tv/0.2.0 (Android 36; 200; guided)", requests.last { it.url.encodedPath == "/api/v1/tv/state" }.headers["User-Agent"])
        vm.openMenu()
        val id = command("update", """{"versionCode":300}""")
        waitUntil("the press OK screen") { vm.screen.value == Screen.Update(UpdateUi("0.3.0", UpdatePhase.Prompt(UpdatePlan.GUIDED_TIMEOUT_SEC))) }
        assertNull("the menu closed", vm.menu.value)
        advance(1_000)
        assertEquals(Screen.Update(UpdateUi("0.3.0", UpdatePhase.Prompt(59))), vm.screen.value)
        vm.onBack()
        assertEquals(Screen.Home, vm.screen.value)
        assertEquals("""{"result":"ignored","reason":"declined"}""", awaitResult(id))
        assertEquals(0, count("/api/v1/tv/app/apk"))
        assertTrue(installer.installs.isEmpty())
    }

    @Test
    fun thePressOkScreenGoesHomeAfterAMinute() {
        paired()
        apk = ByteArray(5_000) { it.toByte() }
        grantInstalls(false)
        val vm = startTvOnHome()
        val id = command("update")
        waitUntil("the press OK screen") { vm.screen.value is Screen.Update }
        advance(59_999)
        assertTrue(vm.screen.value is Screen.Update)
        advance(1)
        assertEquals(Screen.Home, vm.screen.value)
        assertEquals("""{"result":"ignored","reason":"timeout"}""", awaitResult(id))
    }

    @Test
    fun okOnThePressOkScreenDownloadsReportsAndOpensTheSystemDialog() {
        paired()
        val bytes = ByteArray(70_000) { (it % 7).toByte() }
        apk = bytes
        grantInstalls(false)
        val vm = startTvOnHome()
        val id = command("update", """{"versionCode":300}""")
        waitUntil("the press OK screen") { vm.screen.value is Screen.Update }
        vm.onUpdateInstall()
        assertEquals(Screen.Update(UpdateUi("0.3.0", UpdatePhase.Installing)), vm.screen.value)
        waitUntil("the install") { installer.installs.isNotEmpty() }
        val install = installer.installs.single()
        assertFalse(install.silent)
        assertTrue("the result went out before the install", install.resultSentBefore)
        assertArrayEquals(bytes, install.bytes)
        assertEquals(listOf(300L), installer.verified)
        assertEquals("""{"result":"done","reason":"prompted"}""", awaitResult(id))
        assertEquals("Bearer device-token", requests.last { it.url.encodedPath == "/api/v1/tv/app/apk" }.headers["Authorization"])

        // The system wants its dialog shown: the activity starts it.
        val confirm = Intent("android.content.pm.action.CONFIRM_INSTALL")
        vm.onInstallStatus(status(PackageInstaller.STATUS_PENDING_USER_ACTION).putExtra(Intent.EXTRA_INTENT, confirm))
        mainLooper.idle()
        assertEquals("android.content.pm.action.CONFIRM_INSTALL", runBlocking { withTimeout(5_000) { vm.launchIntents.first() } }.action)
        // Cancel in that dialog: Home, nothing else.
        vm.onInstallStatus(status(PackageInstaller.STATUS_FAILURE_ABORTED))
        mainLooper.idle()
        assertEquals(Screen.Home, vm.screen.value)
    }

    @Test
    fun withTheGrantTheUpdateInstallsSilentlyAfterReportingIt() {
        paired()
        apk = ByteArray(70_000) { (it % 5).toByte() }
        grantInstalls(true)
        val vm = startTvOnHome()
        assertEquals(UpdateCapability.Silent, app.graph.updater.capability.value)
        val id = command("update", """{"versionCode":300}""")
        waitUntil("the install") { installer.installs.isNotEmpty() }
        val install = installer.installs.single()
        assertTrue(install.silent)
        assertTrue("the result went out before the install", install.resultSentBefore)
        assertEquals("""{"result":"done","reason":"installing"}""", awaitResult(id))
        assertEquals(Screen.Update(UpdateUi("0.3.0", UpdatePhase.Installing)), vm.screen.value)
        assertEquals("izle-tv/0.2.0 (Android 36; 200; silent)", requests.last { it.url.encodedPath == "/api/v1/tv/app/apk" }.headers["User-Agent"])

        // The system wants it confirmed after all: abandoned, guided from now on, the owner told, back Home.
        vm.onInstallStatus(status(PackageInstaller.STATUS_PENDING_USER_ACTION).putExtra(Intent.EXTRA_INTENT, Intent("x")))
        mainLooper.idle()
        assertEquals(listOf(7), installer.abandoned)
        assertEquals(Screen.Home, vm.screen.value)
        assertEquals(UpdateCapability.Guided, app.graph.updater.capability.value)
        waitUntil("the problem report") { count("/api/v1/tv/problems") == 1 }
        assertTrue(requests.last { it.url.encodedPath == "/api/v1/tv/problems" }.body?.utf8().orEmpty().contains("\"code\":\"update_needs_user_action\""))
        waitUntil("the stored refusal") { runBlocking { app.graph.deviceStore.current().updateSilentRefused } }
        app.graph.repository.refreshSoon()
        waitUntil("a guided state request") {
            requests.lastOrNull { it.url.encodedPath == "/api/v1/tv/state" }?.headers?.get("User-Agent") == "izle-tv/0.2.0 (Android 36; 200; guided)"
        }
    }

    @Test
    fun anUpdateDuringPlaybackIsBusy() {
        paired()
        apk = ByteArray(5_000) { it.toByte() }
        grantInstalls(true)
        val vm = startTvOnHome()
        vm.onTileClicked(vm.state.value!!.home.first())
        assertEquals(Screen.Player, vm.screen.value)
        val id = command("update", """{"versionCode":300}""")
        assertEquals("""{"result":"ignored","reason":"busy"}""", awaitResult(id))
        assertEquals(Screen.Player, vm.screen.value)
        assertEquals(0, count("/api/v1/tv/app/apk"))
    }

    @Test
    fun nothingNewerIsUpToDate() {
        paired()
        grantInstalls(true)
        startTvOnHome()
        assertEquals("""{"result":"ignored","reason":"up_to_date"}""", awaitResult(command("update", """{"versionCode":300}""")))
    }

    @Test
    fun aSilentTvUpdatesByItselfAfterThreeIdleMinutesOnHome() {
        paired()
        apk = ByteArray(5_000) { it.toByte() }
        grantInstalls(true)
        val vm = startTvOnHome()
        waitUntil("the offered version") { app.graph.updater.available.value?.versionCode == 300L }
        assertEquals("0.3.0", vm.aboutInfo().updateVersion)
        advance(150_000)
        vm.onKeyDown() // someone is there: the three minutes start over
        advance(150_000)
        settle()
        assertTrue(installer.installs.isEmpty())
        assertEquals(0, count("/api/v1/tv/app/apk"))
        advance(60_000)
        waitUntil("the install") { installer.installs.isNotEmpty() }
        assertTrue(installer.installs.single().silent)
        assertEquals(Screen.Update(UpdateUi("0.3.0", UpdatePhase.Installing)), vm.screen.value)
        assertEquals(0, requests.count { it.url.encodedPath.endsWith("/result") })
    }

    @Test
    fun theOwnerCanKeepTvsFromUpdatingByThemselves() {
        paired()
        apk = ByteArray(5_000) { it.toByte() }
        apkAuto = false
        grantInstalls(true)
        startTvOnHome()
        waitUntil("the offered version") { app.graph.updater.available.value?.versionCode == 300L }
        advance(10 * 60_000)
        settle()
        assertTrue(installer.installs.isEmpty())
    }

    private fun grantInstalls(granted: Boolean) = shadowOf(app.packageManager).setCanRequestPackageInstalls(granted)

    /** What the system sends back for session 7. */
    private fun status(status: Int) = Intent(AppInstaller.ACTION_INSTALL_STATUS)
        .putExtra(PackageInstaller.EXTRA_STATUS, status)
        .putExtra(PackageInstaller.EXTRA_SESSION_ID, 7)

    private fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    /** Checks and installs nothing; remembers what it was asked. */
    private inner class FakeInstaller : AppInstaller {
        inner class Install(val silent: Boolean, val bytes: ByteArray, val resultSentBefore: Boolean)

        val verified = CopyOnWriteArrayList<Long>()
        val installs = CopyOnWriteArrayList<Install>()
        val abandoned = CopyOnWriteArrayList<Int>()

        override suspend fun verifyArchive(file: File, expectedVersionCode: Long) {
            verified += expectedVersionCode
        }

        override suspend fun install(file: File, silent: Boolean, commandId: Long?): Int {
            val sent = commandId != null && results(commandId).isNotEmpty()
            installs += Install(silent, file.readBytes(), sent)
            return 7
        }

        override fun ownsSession(sessionId: Int) = true

        override fun isSystemConfirmation(intent: Intent) = true

        override fun abandon(sessionId: Int) {
            abandoned += sessionId
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

    /** The bodies of the results the TV sent for command [id]. */
    private fun results(id: Long) = requests.filter { it.url.encodedPath == "/api/v1/tv/commands/$id/result" }.map { it.body?.utf8().orEmpty() }

    /** The single result of command [id], once it arrived. */
    private fun awaitResult(id: Long): String {
        waitUntil("the result of command $id") { results(id).isNotEmpty() }
        return results(id).single()
    }

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
