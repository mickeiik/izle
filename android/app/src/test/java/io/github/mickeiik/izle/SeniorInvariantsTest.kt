package io.github.mickeiik.izle

import android.content.Intent
import android.os.SystemClock
import android.view.KeyEvent
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isFocusable
import androidx.compose.ui.test.isDisplayed
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.printToString
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.toSize
import androidx.activity.compose.setContent
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import io.github.mickeiik.izle.data.api.ItemCard
import io.github.mickeiik.izle.player.PlayerPhase
import io.github.mickeiik.izle.player.PlayerUi
import io.github.mickeiik.izle.ui.AppViewModel
import io.github.mickeiik.izle.ui.Screen
import io.github.mickeiik.izle.ui.SettingsEntry
import io.github.mickeiik.izle.ui.UpdatePhase
import io.github.mickeiik.izle.ui.player.PlayerScreen
import io.github.mickeiik.izle.ui.theme.IzleTheme
import io.github.mickeiik.izle.update.AppInstaller
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import okio.Buffer
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowLooper
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

/**
 * The senior viewer's rules (docs/ux/senior-tv.md) on the real [MainActivity], under Robolectric on a 960×540 dp TV.
 * The app is paired with an in-process server through its own settings store before it starts; remote keys go
 * through `MainActivity.dispatchKeyEvent` as the system delivers them. Nothing here needs ExoPlayer: the server has
 * nothing playable, so a play attempt ends on the player's error screen (a channel's after a while, so that its
 * loading screen can be looked at).
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
    @Volatile private var home = listOf("a", "b", "c")
    @Volatile private var version = 1L

    /** Home entries that are not the default unstarted film ("Show X" playing `x.film`), by show id: the whole object. */
    @Volatile private var entries = emptyMap<String, String>()

    /** The owner's grid for this TV (`homeColumns` × `homeRows`); null: not sent, as by an older server. */
    @Volatile private var columns: Int? = null
    @Volatile private var rows: Int? = null

    /** An owner's message (shown for 5 s) that the event stream hands out once, on the TV's next connection. */
    @Volatile private var message: String? = null

    /** The APK the server offers as version 99.0.0. */
    private val apk = ByteArray(4_000) { it.toByte() }
    private val installs = CopyOnWriteArrayList<Boolean>()

    @Before
    fun setUp() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                // Every picture is the same tiny PNG.
                if (request.url.encodedPath.startsWith("/assets/")) {
                    return MockResponse.Builder().addHeader("Content-Type", "image/png").body(Buffer().write(PNG)).build()
                }
                return when (request.url.encodedPath) {
                    "/api/v1/tv/state" -> json(200, stateJson())
                    // No live events: the TV retries the stream after a backoff (which Robolectric's paused clock
                    // never reaches unless a test advances it) and keeps the state it fetched.
                    "/api/v1/tv/events" -> message?.let { text ->
                        message = null
                        val command = """{"id":1,"type":"message","payload":{"text":"$text","durationSec":5}}"""
                        MockResponse.Builder().code(200).addHeader("Content-Type", "text/event-stream")
                            .body("event: command\ndata: $command\n\n").build()
                    } ?: json(404, """{"error":"not_found"}""")
                    "/api/v1/tv/app" -> json(200, """{"versionName":"99.0.0","versionCode":990000,"sha256":"${sha256(apk)}","size":${apk.size},"auto":false}""")
                    "/api/v1/tv/app/apk" -> MockResponse.Builder().body(Buffer().write(apk)).build()
                    "/api/v1/tv/resolve" -> {
                        // A channel loads for a while before it fails too.
                        if (request.body?.utf8().orEmpty().contains("\"itemId\":")) Thread.sleep(3_000)
                        json(404, """{"error":"not_found"}""")
                    }
                    // Nothing else either.
                    else -> json(404, """{"error":"not_found"}""")
                }
            }
        }
        server.start()
        // Installs nothing: the update screen is what is tested here.
        app.graph.installer = object : AppInstaller {
            override suspend fun verifyArchive(file: File, expectedVersionCode: Long) = Unit
            override suspend fun install(file: File, silent: Boolean, commandId: Long?): Int = 1.also { installs += silent }
            override fun ownsSession(sessionId: Int) = true
            override fun isSystemConfirmation(intent: Intent) = true
            override fun abandon(sessionId: Int) = Unit
        }
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
        assertEquals(listOf("""{"episodeId":"a.film","trigger":"viewer"}"""), resolveRequests())
        // Nothing is playable on this server: the player shows its own error screen.
        waitUntil("the player's error screen") { exists(string(R.string.cannot_play)) }
    }

    @Test
    fun aNewEpisodeChipNeverChangesWhatOkPlays() {
        // B is a series that gained two episodes since it was last watched; OK on it plays its cursor, b.e7. A's entry
        // carries no count (an older server), C's says 0.
        entries = mapOf(
            "b" to """{"item":{"id":"b","kind":"series","title":"Show B"},"newEpisodes":2,""" +
                """"continue":{"episodeId":"b.e7","season":1,"number":7,"index":6,"count":8,"status":"new"}}""",
            "c" to """{"item":{"id":"c","kind":"movie","title":"Show C"},"newEpisodes":0,"continue":{"episodeId":"c.film","status":"new"}}""",
        )
        onTv { tv ->
            awaitTiles("Show A", "Show B", "Show C")
            // The poster says "2 new"; the tile reads the count out in full.
            val chip = quantity(R.plurals.badge_new_episodes, 2)
            compose.onNode(hasClickAction() and hasContentDescription(chip)).assertIsDisplayed().assert(hasText("Show B"))
            // Added to B's tile next to the chip saying what OK does, which is unchanged; no chip where the count is 0.
            assertEquals(setOf("Show B", string(R.string.episode_number, 7)), tileTexts("Show B"))
            assertEquals(listOf(chip), tileDescriptions("Show B"))
            assertEquals(setOf("Show A", string(R.string.badge_new)), tileTexts("Show A"))
            assertEquals(emptyList<String>(), tileDescriptions("Show A"))
            assertEquals(setOf("Show C", string(R.string.badge_new)), tileTexts("Show C"))
            assertEquals(emptyList<String>(), tileDescriptions("Show C"))

            // It never takes the focus: the only focusable element holding it is B's tile, and the remote moves from
            // tile to tile as before.
            compose.onAllNodes(isFocusable() and hasAnyDescendant(hasContentDescription(chip)), useUnmergedTree = true).assertCountEquals(1)
            tv.press(KeyEvent.KEYCODE_DPAD_RIGHT)
            assertFocusedTile("Show B")
            tv.press(KeyEvent.KEYCODE_DPAD_RIGHT)
            assertFocusedTile("Show C")
            tv.press(KeyEvent.KEYCODE_DPAD_LEFT)
            assertFocusedTile("Show B")

            tv.press(KeyEvent.KEYCODE_DPAD_CENTER)
            assertEquals(Screen.Player, tv.vm.screen.value)
            waitUntil("the resolve request") { resolveRequests().isNotEmpty() }
            assertEquals(listOf("""{"episodeId":"b.e7","trigger":"viewer"}"""), resolveRequests())
        }
    }

    @Test
    fun aChannelsCardSaysLiveAndItLoadsWithItsNameAndLive() {
        // B is a channel; even with a count (never from a correct server) its card has no "2 new".
        entries = mapOf("b" to """{"item":{"id":"b","kind":"live","title":"Show B"},"continue":null,"newEpisodes":2}""")
        onTv { tv ->
            awaitTiles("Show A", "Show B", "Show C")
            val live = string(R.string.badge_live)
            assertEquals(setOf("Show B", live), tileTexts("Show B"))
            assertEquals(emptyList<String>(), tileDescriptions("Show B"))
            // The chips at 20 sp, the names at 24.
            assertTextSizes(chips = setOf(string(R.string.badge_new), live))
            assertEquals(20f, drawnTexts().first { it.first == live }.second.value, 0.01f)

            tv.press(KeyEvent.KEYCODE_DPAD_RIGHT)
            assertFocusedTile("Show B")
            tv.press(KeyEvent.KEYCODE_DPAD_CENTER)
            assertEquals(Screen.Player, tv.vm.screen.value)
            waitUntil("the resolve request") { resolveRequests().isNotEmpty() }
            assertEquals(listOf("""{"itemId":"b","trigger":"viewer"}"""), resolveRequests())
            // While it loads: its name and "Live", large, nothing about time.
            assertEquals(setOf("Show B", live), allTexts().toSet())
            assertAllTextAtLeast24Sp()
            // Its keys: ← / → and Pause do nothing, channel keys neither (no other channel on Home): still loading B.
            for (key in listOf(KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_MEDIA_PAUSE, KeyEvent.KEYCODE_CHANNEL_UP, KeyEvent.KEYCODE_CHANNEL_DOWN)) {
                tv.press(key)
            }
            assertEquals(Screen.Player, tv.vm.screen.value)
            assertEquals(PlayerPhase.Loading, tv.vm.player.ui.value.phase)
            assertEquals(1, resolveRequests().size)
            waitUntil("the player's error screen") { exists(string(R.string.cannot_play)) }
        }
    }

    @Test
    fun aChannelsInformationIsItsNameAndLiveWithoutTimes() = onTv { tv ->
        awaitTiles("Show A", "Show B", "Show C")
        fun show(ui: PlayerUi) {
            tv.onActivity { it.setContent { IzleTheme { PlayerScreen(ui, player = null, onPlayNext = {}, onHome = {}, onRetry = {}) } } }
            compose.waitForIdle()
        }
        // A show's information has its times: what this test would notice on a channel.
        show(PlayerUi(PlayerPhase.Playing, ItemCard("m", "movie", "Film"), playWhenReady = true, showInfo = true, positionMs = 65_000, durationMs = 600_000))
        assertEquals(listOf("1:05", "10:00"), allTexts().filter { CLOCK.matches(it) })

        show(PlayerUi(PlayerPhase.Playing, ItemCard("news", "live", "News 24"), playWhenReady = true, showInfo = true, positionMs = 65_000, live = true))
        assertEquals(listOf("News 24", string(R.string.badge_live)), allTexts())
        assertAllTextAtLeast24Sp()
        // Paused by the system, a channel still says nothing of a pause.
        show(PlayerUi(PlayerPhase.Playing, ItemCard("news", "live", "News 24"), playWhenReady = false, showInfo = true, live = true))
        assertEquals(listOf("News 24", string(R.string.badge_live)), allTexts())
    }

    @Test
    fun theErrorScreenSaysWhenItGoesHomeWithTryAgainFocused() = onTv { tv ->
        awaitTiles("Show A", "Show B", "Show C")
        tv.press(KeyEvent.KEYCODE_DPAD_CENTER)
        waitUntil("the player's error screen") { exists(string(R.string.cannot_play)) }
        // Robolectric's clock stands still, so the countdown shows its first second; Home comes after 30 s.
        compose.onNodeWithText(string(R.string.auto_home_countdown, 30)).assertIsDisplayed()
        // The first button has the focus: OK tries again.
        compose.onNode(isFocused()).assert(hasText(string(R.string.try_again)))
        compose.onNodeWithText(string(R.string.go_home)).assertIsDisplayed()
    }

    @Test
    fun nothingIsAboveTheGrid() = onTv { tv ->
        awaitTiles("Show A", "Show B", "Show C")
        // No clock, no hint: every text on Home belongs to a tile.
        assertEquals(emptyList<String>(), allTexts().filter { CLOCK.matches(it) })
        assertEquals(emptySet<String>(), allTexts().toSet() - setOf("Show A", "Show B", "Show C", string(R.string.badge_new)))
        tv.assertOnHome()
    }

    @Test
    // Real text measurement (the default "legacy" graphics measure a character as about a pixel), so the banner has
    // its real size.
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun theOwnersMessageOnHomeIsDrawnOverTheTopAndMovesNoTile() = onTv { tv ->
        awaitTiles("Show A", "Show B", "Show C")
        val tileBefore = focusedTileBounds()
        // The longest message the server allows. The event stream hands it out on the TV's next connection, which
        // the TV makes 1 s after the first one failed.
        val text = "Dinner is ready! Please come to the kitchen when you have finished watching this episode, the " +
            "soup is hot and your grandchildren have arrived to see you. They brought a cake and fresh flowers for you."
        assertEquals(200, text.length)
        message = text
        advanceClock(1_500)
        waitUntil("the owner's message") { exists(text) }

        val banner = compose.onNodeWithText(text).fetchSemanticsNode().boundsInRoot
        // Several lines of large type (it has its real size), across the top, over the grid.
        assertTrue("a banner of several lines: $banner", banner.height > 60f && banner.width > 500f)
        assertTrue("the banner at the top: $banner, the first row at $tileBefore", banner.top < tileBefore.top)
        // The tiles stay where they were.
        assertSameBounds(tileBefore, focusedTileBounds())
        // It takes no focus, and the remote moves from tile to tile as before.
        compose.onAllNodes(isFocusable() and hasText(text)).assertCountEquals(0)
        assertFocusedTile("Show A")
        tv.press(KeyEvent.KEYCODE_DPAD_RIGHT)
        assertFocusedTile("Show B")
        tv.press(KeyEvent.KEYCODE_DPAD_LEFT)
        assertFocusedTile("Show A")

        // It goes away by itself after the owner's 5 s; nothing moves.
        advanceClock(5_500)
        waitUntil("the message gone") { !exists(text) }
        assertFocusedTile("Show A")
        assertSameBounds(tileBefore, focusedTileBounds())
        tv.assertOnHome()
    }

    @Test
    fun theTilesFollowTheOwnersColumns() {
        columns = 3
        home = listOf("a", "b", "c", "d")
        onTv { tv ->
            awaitTiles("Show A", "Show B", "Show C", "Show D")
            // Three to a row: D starts the second row, under A.
            val a = tileBounds("Show A")
            val d = tileBounds("Show D")
            assertEquals(a.left, d.left, 0.5f)
            assertTrue("D under A: $a, $d", d.top > a.bottom)
            tv.press(KeyEvent.KEYCODE_DPAD_DOWN)
            assertFocusedTile("Show D")
        }
    }

    @Test
    fun withOneRowTheNextRowScrollsInOnDown() {
        columns = 4
        rows = 1
        home = listOf("a", "b", "c", "d", "e", "f", "g", "h")
        onTv { tv ->
            val first = listOf("Show A", "Show B", "Show C", "Show D")
            val second = listOf("Show E", "Show F", "Show G", "Show H")
            waitUntil("the first row") { first.all(::shown) }
            assertFalse("the second row is out of view", second.any(::shown))
            assertFocusedTile("Show A")
            val slot = laidOut(compose.onNode(hasClickAction() and hasText("Show A")).fetchSemanticsNode())

            // Down scrolls exactly one row: the second row in full, the first one gone.
            tv.press(KeyEvent.KEYCODE_DPAD_DOWN)
            assertFocusedTile("Show E")
            assertTrue(second.all(::shown))
            assertFalse(first.any(::shown))
            val grid = compose.onNode(SemanticsMatcher.keyIsDefined(SemanticsProperties.VerticalScrollAxisRange)).fetchSemanticsNode().boundsInRoot
            // The card and the name under it, in full.
            val e = compose.onAllNodesWithText("Show E").fetchSemanticsNodes()
            assertEquals(2, e.size)
            e.forEach {
                val b = laidOut(it)
                assertTrue("Show E inside the grid: $b, $grid", b.top >= grid.top && b.bottom <= grid.bottom && b.left >= grid.left && b.right <= grid.right)
            }

            // Exactly one row: E's card is where A's was.
            assertSameBounds(slot, laidOut(compose.onNode(hasClickAction() and hasText("Show E")).fetchSemanticsNode()))

            // Up brings the first row back, exactly where it was.
            tv.press(KeyEvent.KEYCODE_DPAD_UP)
            assertFocusedTile("Show A")
            assertSameBounds(slot, laidOut(compose.onNode(hasClickAction() and hasText("Show A")).fetchSemanticsNode()))
            assertTrue(first.all(::shown))
            assertFalse(second.any(::shown))
        }
    }

    @Test
    fun aBackdropAndAPosterBothFillTheirCards() {
        entries = mapOf(
            "b" to """{"item":{"id":"b","kind":"movie","title":"Show B","posterUrl":"/assets/b-poster.png",""" +
                """"backdropUrl":"/assets/b-backdrop.png"},"continue":{"episodeId":"b.film","status":"new"}}""",
            "c" to """{"item":{"id":"c","kind":"movie","title":"Show C","posterUrl":"/assets/c-poster.png"},""" +
                """"continue":{"episodeId":"c.film","status":"new"}}""",
        )
        onTv { tv ->
            // The picture takes the title's place in the card and describes it; A, without one, keeps its title there.
            waitUntil("the cards") {
                exists(hasClickAction() and hasContentDescription("Show B")) && exists(hasClickAction() and hasContentDescription("Show C")) &&
                    exists(hasClickAction() and hasText("Show A"))
            }
            compose.onNode(hasClickAction() and hasContentDescription("Show B")).assertIsDisplayed().assert(hasText(string(R.string.badge_new)))
            compose.onNode(hasClickAction() and hasContentDescription("Show C")).assertIsDisplayed()
            assertFalse(exists(hasClickAction() and hasText("Show B")))
            // The names are under the cards.
            compose.onNode(hasText("Show B") and !hasClickAction()).assertIsDisplayed()
            compose.onNode(hasText("Show C") and !hasClickAction()).assertIsDisplayed()
            // B's backdrop is loaded (not its poster), C's poster.
            waitUntil("the pictures") { "/assets/b-backdrop.png" in assetRequests() && "/assets/c-poster.png" in assetRequests() }
            assertFalse("B's poster: ${assetRequests()}", "/assets/b-poster.png" in assetRequests())

            assertFocusedTile("Show A")
            tv.press(KeyEvent.KEYCODE_DPAD_RIGHT)
            compose.onNode(isFocused() and hasClickAction()).assert(hasContentDescription("Show B"))
        }
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
    fun theUpdateScreenIsLargeOkInstallsAndBackGoesHome() = onTv { tv ->
        awaitTiles("Show A", "Show B", "Show C")
        // An Android 7 TV (or one without the "install unknown apps" grant): guided.
        shadowOf(app.packageManager).setCanRequestPackageInstalls(false)
        tv.onActivity { vm(it).onSettingsEntry(SettingsEntry.InstallUpdate) }
        waitUntil("the press OK screen") { exists(string(R.string.update_press_ok)) }
        compose.onNodeWithText(string(R.string.update_overline)).assertIsDisplayed()
        compose.onNodeWithText("99.0.0").assertIsDisplayed()
        compose.onNodeWithText(string(R.string.auto_home_countdown, 60)).assertIsDisplayed()
        compose.onNodeWithText(string(R.string.not_now)).assertIsDisplayed()
        assertAllTextAtLeast24Sp()
        // The first button has the focus; channel keys and the Menu key do nothing here.
        compose.onNode(isFocused()).assert(hasText(string(R.string.update_install)))
        tv.press(KeyEvent.KEYCODE_MENU)
        tv.press(KeyEvent.KEYCODE_CHANNEL_UP)
        compose.onNode(isFocused()).assert(hasText(string(R.string.update_install)))

        // Back: Home, the focus back on the tiles.
        tv.press(KeyEvent.KEYCODE_BACK)
        tv.assertOnHome()
        waitUntil("the focus back on the tiles") { focusedTitle() == "Show A" }

        // Again, and OK this time: it installs.
        tv.onActivity { vm(it).onSettingsEntry(SettingsEntry.InstallUpdate) }
        waitUntil("the press OK screen") { exists(string(R.string.update_press_ok)) }
        tv.press(KeyEvent.KEYCODE_DPAD_CENTER)
        waitUntil("Updating…") { exists(string(R.string.update_installing)) }
        assertTrue((tv.vm.screen.value as Screen.Update).ui.phase == UpdatePhase.Installing)
        assertAllTextAtLeast24Sp()
        waitUntil("the install") { installs.isNotEmpty() }
        assertEquals(listOf(false), installs.toList())
        tv.press(KeyEvent.KEYCODE_BACK)
        tv.assertOnHome()
    }

    /** Every text on the screen is drawn at 24 sp or more. */
    private fun assertAllTextAtLeast24Sp() = assertTextSizes(chips = emptySet())

    /** Every text on the screen is drawn at 24 sp or more, except the Home cards' [chips], at 20 sp or more. */
    private fun assertTextSizes(chips: Set<String>) {
        val texts = drawnTexts()
        assertTrue("texts on screen", texts.isNotEmpty())
        for ((text, size) in texts) {
            val min = if (text in chips) 20f else 24f
            assertTrue("\"$text\" at $size", size.isSp && size.value >= min)
        }
    }

    /** Every text drawn on the screen, with its size. */
    private fun drawnTexts(): List<Pair<String, androidx.compose.ui.unit.TextUnit>> {
        fun collect(node: SemanticsNode): List<SemanticsNode> = listOf(node) + node.children.flatMap(::collect)
        return collect(compose.onRoot(useUnmergedTree = true).fetchSemanticsNode()).flatMap { node ->
            val layouts = mutableListOf<TextLayoutResult>()
            node.config.getOrNull(SemanticsActions.GetTextLayoutResult)?.action?.invoke(layouts)
            layouts.map { it.layoutInput.text.text to it.layoutInput.style.fontSize }
        }
    }

    private fun vm(activity: MainActivity): AppViewModel = ViewModelProvider(activity)[AppViewModel::class.java]

    private fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

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

    /** Every text on the tile of this show (its chips included). */
    private fun tileTexts(title: String): Set<String> =
        compose.onNode(hasClickAction() and hasText(title)).fetchSemanticsNode().texts().toSet()

    /** What the tile of this show reads out beyond its texts. */
    private fun tileDescriptions(title: String): List<String> =
        compose.onNode(hasClickAction() and hasText(title)).fetchSemanticsNode().config.getOrNull(SemanticsProperties.ContentDescription).orEmpty()

    private fun assertFocusedTile(title: String) {
        compose.onNode(isFocused() and hasClickAction()).assert(hasText(title))
    }

    /** Where the focused tile is drawn. */
    private fun focusedTileBounds() = compose.onNode(isFocused() and hasClickAction()).fetchSemanticsNode().boundsInRoot

    private fun tileBounds(title: String) = compose.onNode(hasClickAction() and hasText(title)).fetchSemanticsNode().boundsInRoot

    private fun assertSameBounds(expected: Rect, actual: Rect) {
        listOf(expected.left to actual.left, expected.top to actual.top, expected.right to actual.right, expected.bottom to actual.bottom)
            .forEach { (e, a) -> assertEquals("$expected vs $actual", e, a, 0.5f) }
    }

    /** Where a node is laid out, unclipped (semantics bounds are clipped by the grid). */
    private fun laidOut(node: SemanticsNode): Rect = node.layoutInfo.coordinates.let { Rect(it.positionInRoot(), it.size.toSize()) }

    /** The tile with this title (in the card: one without a picture) is on screen, not clipped away by the grid. */
    private fun shown(title: String): Boolean {
        val all = compose.onAllNodes(hasClickAction() and hasText(title))
        return (0 until all.fetchSemanticsNodes().size).any { all[it].isDisplayed() }
    }

    /** Every node of the (merged) tree for which [predicate] holds. */
    private fun nodes(predicate: (SemanticsNode) -> Boolean): List<SemanticsNode> {
        fun collect(node: SemanticsNode): List<SemanticsNode> = listOf(node).filter(predicate) + node.children.flatMap(::collect)
        return collect(compose.onRoot().fetchSemanticsNode())
    }

    /** Lets [ms] of the paused main-looper clock pass, running what was due in that time (backoffs, banner expiry). */
    private fun advanceClock(ms: Long) {
        ShadowLooper.idleMainLooper(ms, TimeUnit.MILLISECONDS)
        compose.waitForIdle()
    }

    /** The first text of the focused element, if any. */
    private fun focusedTitle(): String? =
        compose.onAllNodes(isFocused()).fetchSemanticsNodes().singleOrNull()?.texts()?.firstOrNull()

    /** Every text shown anywhere on the screen. */
    private fun allTexts(): List<String> = nodes { true }.flatMap { it.texts() }

    private fun SemanticsNode.texts(): List<String> = config.getOrNull(SemanticsProperties.Text).orEmpty().map { it.text }

    private fun exists(text: String) = compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty()

    private fun exists(matcher: SemanticsMatcher) = compose.onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty()

    private fun assetRequests(): List<String> = requests.map { it.url.encodedPath }.filter { it.startsWith("/assets/") }

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
    private fun settle() = repeat(20) {
        compose.waitForIdle()
        Thread.sleep(10)
    }

    private fun json(code: Int, body: String) =
        MockResponse.Builder().code(code).addHeader("Content-Type", "application/json").body(body).build()

    private fun stateJson(): String {
        val list = home.joinToString(",") { id ->
            entries[id] ?: """{"item":{"id":"$id","kind":"movie","title":"Show ${id.uppercase()}"},"continue":{"episodeId":"$id.film","status":"new"}}"""
        }
        val grid = listOfNotNull(columns?.let { ""","homeColumns":$it""" }, rows?.let { ""","homeRows":$it""" }).joinToString("")
        return """{"version":$version,"device":{"id":"tv-1","name":"Living room","uiLanguage":"en"$grid},""" +
            """"catalog":{"id":"sample","buildId":"b1","name":"Sample"},"home":[$list]}"""
    }

    private fun string(id: Int, vararg args: Any): String = app.getString(id, *args)

    private fun quantity(id: Int, count: Int): String = app.resources.getQuantityString(id, count, count)

    private companion object {
        /** A clock: "14:54" or "2:54 PM". */
        val CLOCK = Regex("""^\d{1,2}:\d{2}( [AP]M)?$""")

        /** A 1x1 PNG. */
        val PNG: ByteArray = java.util.Base64.getDecoder()
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=")
    }
}
