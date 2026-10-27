package io.github.mickeiik.izle.companion.home

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.width
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ActivityScenario
import io.github.mickeiik.izle.companion.MainActivity
import io.github.mickeiik.izle.companion.ui.design.IzleTheme
import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.json
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.performTouchInput
import org.junit.Assert.assertEquals
import java.util.concurrent.CopyOnWriteArrayList
import org.robolectric.annotation.GraphicsMode
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.TimeUnit

/** The Home tab at a phone's 360 dp: sections, shows, a hidden one, a show's sheet and a section's delete confirmation. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], qualifiers = "w360dp-h740dp")
class HomeTabTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    private val server = MockWebServer()
    private val moves = CopyOnWriteArrayList<String>()

    @Before
    fun setUp() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.url.encodedPath) {
                "/api/v1/admin/devices/tv-1/home/items/sintel" -> {
                    moves += request.body?.utf8().orEmpty()
                    json(200, """{"version":2,"home":[],"sections":$MOVED}""")
                }
                "/api/v1/admin/devices/tv-1" -> json(200, DEVICE)
                "/api/v1/admin/events" ->
                    if (request.url.queryParameter("after") == null) json(200, """{"events":[],"last":1}""")
                    else json(200, """{"events":[],"last":1}""").newBuilder().headersDelay(2, TimeUnit.SECONDS).build()
                else -> json(404, """{"error":"not_found"}""")
            }
        }
        server.start()
    }

    @After
    fun tearDown() = server.close()

    @Test
    fun theListTheSheetAndADeleteConfirmation() {
        val api = ApiClient(server.url("/"), "izph_test", OkHttpClient())
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.setContent {
                    IzleTheme { HomeTab(api, "tv-1", "Salon", onMessage = {}, modifier = Modifier.width(360.dp)) }
                }
            }
            compose.waitUntil(5_000) { compose.onAllNodes(hasText("Grid 5 × 2 · 3 shows")).fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText("No title").assertIsDisplayed()
            compose.onNodeWithText("Films").assertIsDisplayed()
            compose.onNodeWithText("row · 1").assertIsDisplayed()
            compose.onNodeWithText("Empty: not shown on the TV").assertIsDisplayed()
            compose.onNodeWithText("Hidden: not in the catalog").assertIsDisplayed()
            compose.onNodeWithText("S1 · E5 · continues at 12:04 of 30:10 · 2 new").assertIsDisplayed()
            compose.onNodeWithText("Add show").assertIsDisplayed()

            compose.onNodeWithText("Sintel").performClick()
            compose.onNodeWithText("Films · card 1 of 1", substring = true).assertIsDisplayed()
            compose.onNodeWithText("Play on Salon now").assertIsDisplayed()
            compose.onNodeWithText("Continue from episode…").assertIsDisplayed()
            compose.onNodeWithText("Remove from Home").assertIsDisplayed()
            compose.onNodeWithText("Move to section…").performClick()
            compose.onNodeWithText("Films · here now").assertIsDisplayed()
            compose.onNodeWithText("Cancel").performClick()

            compose.onNodeWithContentDescription("Options of Films").performClick()
            compose.onNodeWithText("One scrolling line").assertIsDisplayed()
            compose.onNodeWithText("Delete").performClick()
            compose.onNodeWithText("Delete Films?").assertIsDisplayed()
            compose.onNodeWithText("Its 1 show moves to No title.").assertIsDisplayed()
            compose.onNodeWithText("Keep").performClick()

            compose.onNodeWithContentDescription("Home options").performClick()
            compose.onNodeWithText("Grid size").performClick()
            compose.onNodeWithText("Columns").assertIsDisplayed()
            compose.onNodeWithContentDescription("More columns").performClick()
            compose.onNodeWithText("6").assertIsDisplayed()
            compose.onNodeWithText("Cancel").performClick()
        }
    }

    @Test
    // Real text measurement, so the rows have their real heights.
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun draggingAShowByItsHandleIsOneMove() {
        val api = ApiClient(server.url("/"), "izph_test", OkHttpClient())
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.setContent { IzleTheme { HomeTab(api, "tv-1", "Salon", onMessage = {}) } }
            }
            compose.waitUntil(5_000) { compose.onAllNodes(hasText("Sintel")).fetchSemanticsNodes().isNotEmpty() }
            // Up from Films, over its header (to the end of No title), then over "gone" (its place).
            val handle = compose.onNodeWithContentDescription("Drag Sintel to move it", useUnmergedTree = true)
            handle.performTouchInput { down(center) }
            repeat(30) {
                handle.performTouchInput { moveBy(Offset(0f, -5f)) }
                compose.waitForIdle()
            }
            handle.performTouchInput { up() }
            compose.waitUntil(5_000) { moves.isNotEmpty() }
            assertEquals(listOf("""{"sectionId":"untitled","position":1}"""), moves)
        }
    }

    private companion object {
        const val MOVED = """[{"id":"untitled","title":null,"layout":"grid","itemIds":["bunny","sintel","gone"]},
            {"id":"films01","title":"Films","layout":"row","itemIds":[]},{"id":"kids01","title":"Kids","layout":"grid","itemIds":[]}]"""
        val DEVICE = """{"device":{"id":"tv-1","name":"Salon","online":true,"effective":{"homeColumns":5,"homeRows":2}},
            "home":[
              {"itemId":"bunny","title":"Big Buck Bunny","kind":"movie","playable":true,"continue":{"episodeId":"bunny.m","status":"new"}},
              {"itemId":"gone","missing":true,"playable":false},
              {"itemId":"sintel","title":"Sintel","kind":"series","playable":true,
               "continue":{"episodeId":"sintel.e5","season":1,"number":5,"positionMs":724000,"durationMs":1810000,"status":"watching"},
               "newEpisodes":2,"check":{"verdict":"ok","checkedAt":"2026-10-26T10:00:00.000Z","working":1,"total":1}}],
            "sections":[{"id":"untitled","title":null,"layout":"grid","itemIds":["bunny","gone"]},
              {"id":"films01","title":"Films","layout":"row","itemIds":["sintel"]},
              {"id":"kids01","title":"Kids","layout":"grid","itemIds":[]}]}"""
    }
}
