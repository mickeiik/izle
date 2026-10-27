package io.github.mickeiik.izle.companion.device

import androidx.activity.compose.setContent
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.hasScrollAction
import androidx.test.core.app.ActivityScenario
import io.github.mickeiik.izle.companion.MainActivity
import io.github.mickeiik.izle.companion.ui.design.IzleTheme
import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.json
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.robolectric.Shadows.shadowOf
import android.os.Looper
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The TV tab at a phone's 360 dp: problems and a problem's sheet, the app, the settings, Clear and Forget. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], qualifiers = "w360dp-h740dp")
class DeviceTabTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    private val server = MockWebServer()

    /** "METHOD path body" of every change the tab sent. */
    private val sent = CopyOnWriteArrayList<String>()

    @Before
    fun setUp() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.url.encodedPath
                if (request.method != "GET") sent += "${request.method} $path ${request.body?.utf8().orEmpty()}".trim()
                return when {
                    path == "/api/v1/admin/devices/tv-1" && request.method == "PATCH" -> json(200, """{"device":$PATCHED}""")
                    path == "/api/v1/admin/devices/tv-1" && request.method == "DELETE" -> MockResponse.Builder().code(204).build()
                    path == "/api/v1/admin/devices/tv-1" -> json(200, """{"device":$DEVICE,"home":[],"sections":[]}""")
                    path == "/api/v1/admin/devices/tv-1/problems" && request.method == "DELETE" -> MockResponse.Builder().code(204).build()
                    path == "/api/v1/admin/devices/tv-1/problems" -> json(200, """{"problems":$PROBLEMS}""")
                    path == "/api/v1/admin/devices/tv-1/commands" -> json(202, """{"id":1,"online":false}""")
                    path == "/api/v1/admin/diagnostics/resolve" -> json(200, REPORT)
                    path == "/api/v1/admin/events" ->
                        if (request.url.queryParameter("after") == null) json(200, """{"events":[],"last":1}""")
                        else json(200, """{"events":[],"last":1}""").newBuilder().headersDelay(2, TimeUnit.SECONDS).build()
                    else -> json(404, """{"error":"not_found"}""")
                }
            }
        }
        server.start()
    }

    @After
    fun tearDown() = server.close()

    @Test
    fun problemsAProblemsSheetAndTheApp() {
        val api = ApiClient(server.url("/"), "izph_test", OkHttpClient())
        val opened = CopyOnWriteArrayList<String>()
        val counts = CopyOnWriteArrayList<Int>()
        val messages = CopyOnWriteArrayList<String>()
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.setContent {
                    IzleTheme {
                        DeviceTab(
                            api, "tv-1", "Salon",
                            onOpenShow = { opened += it }, onOpenActivity = {}, onForgotten = {},
                            onProblemsChanged = { counts += it }, onMessage = { messages += it },
                        )
                    }
                }
            }
            waitFor { compose.onAllNodes(hasText("3 today")).fetchSemanticsNodes().isNotEmpty() }
            assertEquals(3, counts.last())
            compose.onNodeWithText("The source refused (403)").assertIsDisplayed()
            compose.onNodeWithText("Caminandes · S1 · E2 — Gran Dillama", substring = true).assertIsDisplayed()
            compose.onAllNodes(hasText("Proxy")).fetchSemanticsNodes().isNotEmpty().let(::assertTrue)
            compose.onNodeWithText("Player error: io bad http status").assertIsDisplayed()
            compose.onNodeWithText("All 7 problems").assertIsDisplayed()

            compose.onNodeWithText("The source refused (403)").performClick()
            compose.onNodeWithText("reported by the server", substring = true).assertIsDisplayed()
            compose.onNodeWithText("upstream_403").assertIsDisplayed()
            compose.onNodeWithText("tr-dub").assertIsDisplayed()
            compose.onNodeWithText("12:34").assertIsDisplayed()
            compose.onNodeWithText("segment").assertIsDisplayed()
            compose.onNodeWithText("Check this episode now").performClick()
            waitFor { compose.onAllNodes(hasText("tr-dub · HTTP 403 at segment")).fetchSemanticsNodes().isNotEmpty() }
            assertTrue(sent.contains("""POST /api/v1/admin/diagnostics/resolve {"episodeId":"caminandes.e2"}"""))
            compose.onNodeWithText("Open the show").performClick()
            waitFor { opened.isNotEmpty() }
            assertEquals(listOf("caminandes"), opened)

            val page = compose.onNode(hasScrollAction())
            page.performScrollToNode(hasText("izle 0.6.1 · Android 12"))
            compose.onNodeWithText("izle 0.6.1 · Android 12").assertIsDisplayed()
            compose.onNodeWithText("Update available").assertIsDisplayed()
            page.performScrollToNode(hasText("Update now"))
            compose.onNodeWithText("Installs updates by itself while nobody watches.").assertIsDisplayed()
            compose.onNodeWithText("Update now").performClick()
            waitFor { messages.isNotEmpty() }
            assertEquals("Salon is offline. It gets this if it connects in the next 2 minutes.", messages.last())
            assertTrue(sent.contains("""POST /api/v1/admin/devices/tv-1/commands {"type":"update"}"""))
        }
    }

    @Test
    fun settingsClearAndForget() {
        val api = ApiClient(server.url("/"), "izph_test", OkHttpClient())
        var forgotten = false
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.setContent {
                    IzleTheme {
                        DeviceTab(
                            api, "tv-1", "Salon",
                            onOpenShow = {}, onOpenActivity = {}, onForgotten = { forgotten = true },
                            onProblemsChanged = {}, onMessage = {},
                        )
                    }
                }
            }
            waitFor { compose.onAllNodes(hasText("3 today")).fetchSemanticsNodes().isNotEmpty() }
            val page = compose.onNode(hasScrollAction())

            page.performScrollToNode(hasText("Server default · Türkçe"))
            compose.onNodeWithText("Server default · Türkçe").performClick()
            compose.onNodeWithText("Deutsch").performClick()
            waitFor { sent.any { it.startsWith("PATCH") } }
            assertEquals("""PATCH /api/v1/admin/devices/tv-1 {"preferredAudioLanguage":"de"}""", sent.last())

            page.performScrollToNode(hasText("Subtitles"))
            compose.onNodeWithText("Subtitles").performClick()
            compose.onNodeWithText("Off").performClick()
            waitFor { sent.count { it.startsWith("PATCH") } == 2 }
            assertEquals("""PATCH /api/v1/admin/devices/tv-1 {"subtitlesLanguage":null}""", sent.last())

            page.performScrollToNode(hasText("Play on start"))
            compose.onNodeWithText("Play on start").performClick()
            waitFor { sent.count { it.startsWith("PATCH") } == 3 }
            assertEquals("""PATCH /api/v1/admin/devices/tv-1 {"autoplayOnStart":true}""", sent.last())

            page.performScrollToNode(hasText("Problems"))
            compose.onNodeWithText("Clear").performClick()
            compose.onNodeWithText("Forget this TV's problems?").assertIsDisplayed()
            compose.onAllNodes(hasText("Clear"))[1].performClick()
            waitFor { sent.any { it.startsWith("DELETE /api/v1/admin/devices/tv-1/problems") } }
            waitFor { compose.onAllNodes(hasText("No problems recorded.")).fetchSemanticsNodes().isNotEmpty() }

            page.performScrollToNode(hasText("Forget this TV"))
            compose.onNodeWithText("Forget this TV").performClick()
            compose.onNodeWithText("Forget Salon?").assertIsDisplayed()
            compose.onNodeWithText("It has to pair again to play. Its history stays.").assertIsDisplayed()
            compose.onNodeWithText("Forget").performClick()
            waitFor { forgotten }
            assertTrue(sent.contains("DELETE /api/v1/admin/devices/tv-1"))
        }
    }

    /**
     * Waits for [condition], running the main looper (the view model's coroutines) and compose's frames meanwhile: a
     * plain waitUntil does not run the looper.
     */
    private fun waitFor(condition: () -> Boolean) {
        repeat(500) {
            shadowOf(Looper.getMainLooper()).idle()
            compose.mainClock.advanceTimeByFrame()
            if (condition()) return
            Thread.sleep(10)
        }
        fail("Timed out; sent: $sent")
    }

    private companion object {
        val DEVICE = """{"id":"tv-1","name":"Salon","status":"active","online":true,
            "settings":{"uiLanguage":null,"preferredAudioLanguage":null,"subtitlesLanguage":"tr","autoplayOnStart":null},
            "effective":{"uiLanguage":"en","preferredAudioLanguage":"tr","subtitlesLanguage":"tr","autoplayOnStart":false},
            "problems":{"recent":3,"lastAt":"2026-10-27T13:00:00.000Z"},
            "app":{"version":"0.6.1","versionCode":601,"androidSdk":31,"capability":"silent","update":"pending"}}"""
        val PATCHED = DEVICE
        val PROBLEMS = (listOf(
            """{"id":7,"at":"2026-10-27T13:00:00.000Z","origin":"server","kind":"proxy","code":"upstream_403",
               "itemId":"caminandes","itemTitle":"Caminandes","itemKind":"series","episodeId":"caminandes.e2",
               "episodeTitle":"Gran Dillama","season":1,"number":2,"sourceId":"tr-dub","positionMs":754000,"httpStatus":403,
               "detail":"segment","missing":false}""",
            """{"id":6,"at":"2026-10-27T12:00:00.000Z","origin":"tv","kind":"playback","code":"ERROR_CODE_IO_BAD_HTTP_STATUS",
               "itemId":"sintel","itemTitle":"Sintel","itemKind":"movie","appVersion":"0.6.1"}""",
        ) + (1..5).map { """{"id":$it,"at":"2026-10-20T10:00:00.000Z","origin":"tv","kind":"network","code":"server_unreachable"}""" })
            .joinToString(",", "[", "]")
        const val REPORT = """{"itemId":"caminandes","episodeId":"caminandes.e2","playbackAllowed":true,"verdict":"fail",
            "sources":[{"sourceId":"tr-dub","type":"direct","ok":true,"verdict":"fail",
              "steps":[{"what":"playlist","ok":true,"status":200},{"what":"segment","ok":false,"status":403,"error":"http"}]}]}"""
    }
}
