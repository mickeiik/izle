package io.github.mickeiik.izle

import android.content.Context
import android.os.SystemClock
import android.view.KeyEvent
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.printToString
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import io.github.mickeiik.izle.ui.AppViewModel
import io.github.mickeiik.izle.ui.Screen
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.CopyOnWriteArrayList

/**
 * The senior viewer's rules (docs/ux/senior-tv.md) on the real [MainActivity], under Robolectric on a 960×540 dp TV.
 * The app is paired with an in-process server through its own settings store before it starts; remote keys go
 * through `MainActivity.dispatchKeyEvent` as the system delivers them. Nothing here needs ExoPlayer: the server has
 * nothing playable, so a play attempt ends on the player's error screen.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], qualifiers = "w960dp-h540dp-land-television")
class SeniorInvariantsTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    private val app: IzleApp = ApplicationProvider.getApplicationContext()
    private val server = MockWebServer()
    private val requests = CopyOnWriteArrayList<RecordedRequest>()

    /** The home list the server hands out (show ids) and its state version. */
    @Volatile
    private var home = listOf("a", "b", "c")

    @Volatile
    private var version = 1L

    @Before
    fun setUp() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                return when (request.url.encodedPath) {
                    "/api/v1/tv/state" -> json(200, stateJson())
                    // No live events: the TV retries the stream after a backoff (which Robolectric's paused clock
                    // never reaches) and keeps the state it fetched.
                    "/api/v1/tv/events" -> json(404, """{"error":"not_found"}""")
                    // resolve included: nothing is playable.
                    else -> json(404, """{"error":"not_found"}""")
                }
            }
        }
        server.start()
        runBlocking {
            app.graph.deviceStore.setServer(server.url("/").toString())
            app.graph.deviceStore.savePairing("tv-1", "device-token")
        }
    }

    @After
    fun tearDown() {
        app.graph.appScope.cancel()
        server.close()
    }

    @Test
    fun backOnHomeDoesNothing() = onTv { tv ->
        awaitTiles("Show A", "Show B", "Show C")
        // Up to Android 15 the remote's Back reaches the activity as a key event…
        tv.press(KeyEvent.KEYCODE_BACK)
        tv.assertOnHome()
        // …on Android 16 (predictive back, targetSdk 36) the system calls the activity's back callback instead,
        // which runs its OnBackPressedDispatcher. Unhandled there, Back would finish the activity.
        tv.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        compose.waitForIdle()
        tv.assertOnHome()
        assertFocusedTile("Show A")
    }

    @Test
    fun theFirstTileHasTheFocusAndKeepsTheShowWhenTheListIsReordered() = onTv { tv ->
        awaitTiles("Show A", "Show B", "Show C")
        assertFocusedTile("Show A")
        tv.press(KeyEvent.KEYCODE_DPAD_RIGHT)
        assertFocusedTile("Show B")

        // The owner moves B to the end: the focus stays on the show, not on its old place (where A is now).
        home = listOf("c", "a", "b")
        version = 2
        tv.onActivity { app.graph.repository.refreshSoon() }
        awaitTiles("Show C", "Show A", "Show B")
        assertFocusedTile("Show B")
    }

    @Test
    fun anOkReleaseWithoutAPressDoesNotPlayButAShortPressDoes() = onTv { tv ->
        awaitTiles("Show A", "Show B", "Show C")
        // The TV launcher starts the app on the OK press; the app only gets the release.
        val now = SystemClock.uptimeMillis()
        tv.key(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_DPAD_CENTER, downTime = now - 100, eventTime = now)
        settle()
        tv.assertOnHome()
        assertFocusedTile("Show A")
        assertEquals(emptyList<String>(), resolveRequests())

        tv.press(KeyEvent.KEYCODE_DPAD_CENTER)
        assertEquals(Screen.Player, tv.vm.screen.value)
        waitUntil("the resolve request") { resolveRequests().isNotEmpty() }
        assertEquals(listOf("""{"episodeId":"a.film"}"""), resolveRequests())
        // Nothing is playable on this server: the player shows its own error screen.
        waitUntil("the player's error screen") { exists(string(R.string.cannot_play)) }
    }

    @Test
    fun theMenuKeyOpensTheHiddenMenuAndBackReturnsToTheTiles() = onTv { tv ->
        awaitTiles("Show A", "Show B", "Show C")
        tv.press(KeyEvent.KEYCODE_MENU)
        compose.onNodeWithText(string(R.string.menu_start_over)).assertIsDisplayed().assertIsFocused()
        // The focus cannot leave the menu for the tiles behind it.
        tv.press(KeyEvent.KEYCODE_DPAD_LEFT)
        compose.onNodeWithText(string(R.string.menu_start_over)).assertIsFocused()

        tv.press(KeyEvent.KEYCODE_BACK)
        compose.onAllNodesWithText(string(R.string.menu_start_over)).assertCountEquals(0)
        tv.assertOnHome()
        waitUntil("the focus back on the tiles") { focusedTitle() == "Show A" }
        tv.press(KeyEvent.KEYCODE_DPAD_RIGHT)
        assertFocusedTile("Show B")
    }

    @Test
    fun holdingOkOpensTheHiddenMenuAndTheReleaseDoesNotChooseAnything() = onTv { tv ->
        awaitTiles("Show A", "Show B", "Show C")
        val down = SystemClock.uptimeMillis()
        tv.key(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_CENTER, down)
        // The remote repeats the key while it is held; past 0.6 s the menu opens.
        tv.key(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_CENTER, down, eventTime = down + 650, repeat = 1)
        compose.onNodeWithText(string(R.string.menu_start_over)).assertIsFocused()
        tv.key(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_DPAD_CENTER, down, eventTime = down + 700)
        settle()
        compose.onNodeWithText(string(R.string.menu_start_over)).assertIsFocused()
        assertEquals(Screen.Home, tv.vm.screen.value)
        assertEquals(emptyList<String>(), resolveRequests())
    }

    @Test
    fun anEmptyHomeSaysNothingHereYet() {
        home = emptyList()
        onTv { tv ->
            waitUntil("the empty home message") { exists(string(R.string.home_empty)) }
            compose.onNodeWithText(string(R.string.home_empty)).assertIsDisplayed()
            tv.press(KeyEvent.KEYCODE_BACK)
            tv.assertOnHome()
        }
    }

    @Test
    @Config(qualifiers = "fr-rFR-w960dp-h540dp-land-television")
    fun theClockFollowsTheTvsLocaleNotTheMenuLanguage() = onTv { tv ->
        awaitTiles("Show A", "Show B", "Show C")
        // The owner chose an English menu (the state says `uiLanguage: en`) on a French TV that has no 12/24-hour
        // setting: the clock is the TV's 24-hour one ("14:54"), not the menu language's "2:54 PM".
        val clock = allTexts().firstOrNull { Regex("""^\d{1,2}:\d{2}( [AP]M)?$""").matches(it) }
        assertNotNull("a clock on Home", clock)
        assertTrue("a 24-hour clock, got $clock", Regex("""^\d{2}:\d{2}$""").matches(clock!!))
        assertTrue("the menu language stays English", exists(string(R.string.home_hint)))
        tv.assertOnHome()
    }

    /** Starts the app as the launcher does and closes it after [block], before the server goes away. */
    private fun onTv(block: (ActivityScenario<MainActivity>) -> Unit) {
        ActivityScenario.launch(MainActivity::class.java).use(block)
    }

    /** A remote key as the system hands it to the activity. */
    private fun ActivityScenario<MainActivity>.key(action: Int, code: Int, downTime: Long, eventTime: Long = downTime, repeat: Int = 0) {
        onActivity { it.dispatchKeyEvent(KeyEvent(downTime, eventTime, action, code, repeat)) }
        compose.waitForIdle()
    }

    /** A short press: down, then up 100 ms later. */
    private fun ActivityScenario<MainActivity>.press(code: Int) {
        val down = SystemClock.uptimeMillis()
        key(KeyEvent.ACTION_DOWN, code, down)
        key(KeyEvent.ACTION_UP, code, down, eventTime = down + 100)
    }

    private val ActivityScenario<MainActivity>.vm: AppViewModel
        get() {
            lateinit var vm: AppViewModel
            onActivity { vm = ViewModelProvider(it)[AppViewModel::class.java] }
            return vm
        }

    private fun ActivityScenario<MainActivity>.assertOnHome() {
        onActivity { assertFalse("the app must not be left", it.isFinishing) }
        assertEquals(Lifecycle.State.RESUMED, state)
        assertEquals(Screen.Home, vm.screen.value)
    }

    /** Waits until Home shows exactly these tiles, in this order. */
    private fun awaitTiles(vararg titles: String) {
        waitUntil("the tiles ${titles.toList()}") { tileTitles() == titles.toList() }
    }

    /** The titles of the clickable tiles in reading order (the menu's rows are clickable too, but no show). */
    private fun tileTitles(): List<String> =
        compose.onAllNodes(hasClickAction()).fetchSemanticsNodes()
            .sortedWith(compareBy<SemanticsNode>({ it.boundsInRoot.top }, { it.boundsInRoot.left }))
            .mapNotNull { node -> node.texts().firstOrNull { it.startsWith("Show ") } }

    private fun assertFocusedTile(title: String) {
        compose.onNode(isFocused() and hasClickAction()).assert(hasText(title))
    }

    /** The first text of the focused element, if any. */
    private fun focusedTitle(): String? =
        compose.onAllNodes(isFocused()).fetchSemanticsNodes().singleOrNull()?.texts()?.firstOrNull()

    /** Every text shown anywhere on the screen. */
    private fun allTexts(): List<String> {
        fun collect(node: SemanticsNode): List<String> = node.texts() + node.children.flatMap(::collect)
        return collect(compose.onRoot().fetchSemanticsNode())
    }

    private fun SemanticsNode.texts(): List<String> = config.getOrNull(SemanticsProperties.Text).orEmpty().map { it.text }

    private fun exists(text: String) = compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty()

    private fun resolveRequests(): List<String> =
        requests.filter { it.url.encodedPath == "/api/v1/tv/resolve" }.map { it.body?.utf8().orEmpty() }

    /** Server responses arrive on OkHttp's threads, then run on the main looper: idle it until [condition] holds. */
    private fun waitUntil(what: String, condition: () -> Boolean) {
        repeat(500) {
            compose.waitForIdle()
            if (condition()) return
            Thread.sleep(10)
        }
        fail("Timed out waiting for $what. Screen:\n${compose.onRoot().printToString()}")
    }

    /** Gives a request the app should not send the time to arrive anyway. */
    private fun settle() {
        repeat(20) {
            compose.waitForIdle()
            Thread.sleep(10)
        }
    }

    private fun json(code: Int, body: String) =
        MockResponse.Builder().code(code).addHeader("Content-Type", "application/json").body(body).build()

    private fun stateJson(): String {
        val entries = home.joinToString(",") { id ->
            """{"item":{"id":"$id","kind":"movie","title":"Show ${id.uppercase()}"},"continue":{"episodeId":"$id.film","status":"new"}}"""
        }
        return """{"version":$version,"device":{"id":"tv-1","name":"Living room","uiLanguage":"en"},""" +
            """"catalog":{"id":"sample","buildId":"b1","name":"Sample"},"home":[$entries]}"""
    }

    private fun string(id: Int): String = ApplicationProvider.getApplicationContext<Context>().getString(id)
}
