package io.github.mickeiik.izle.companion.activity

import androidx.activity.compose.setContent
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
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
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.TimeUnit

/** The Activity at a phone's 360 dp: the filters, today's band, events in words, and a filter with nothing in it. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], qualifiers = "w360dp-h800dp")
class ActivityScreenTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    private val server = MockWebServer()

    @Before
    fun setUp() {
        val now = iso(System.currentTimeMillis() - 60_000)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.url.encodedPath != "/api/v1/admin/events") return json(404, """{"error":"not_found"}""")
                if (request.url.queryParameter("wait") == "25") {
                    return json(200, """{"events":[],"last":3}""").newBuilder().headersDelay(2, TimeUnit.SECONDS).build()
                }
                val remote = request.url.queryParameter("types") == "command.sent,command.result"
                return json(200, if (remote) """{"events":[],"last":3,"gap":false}""" else events(now))
            }
        }
        server.start()
    }

    @After
    fun tearDown() = server.close()

    @Test
    fun eventsInWordsAndAnEmptyFilter() {
        val api = ApiClient(server.url("/"), "izph_test", OkHttpClient())
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity -> activity.setContent { IzleTheme { ActivityScreen(api, "tv-1", "Salon") } } }
            compose.waitUntil(5_000) { compose.onAllNodes(hasText("Started Caminandes · S1 · E2")).fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText("Everything").assertIsDisplayed()
            compose.onNodeWithText("Today").assertIsDisplayed()
            compose.onNodeWithText("from 4:10 · OK on Home").assertIsDisplayed()
            compose.onNodeWithText("Stopped at 12:04").assertIsDisplayed()
            compose.onNodeWithText("Caminandes · S1 · E2 · the TV").assertIsDisplayed()
            compose.onNodeWithText("Online").assertIsDisplayed()

            compose.onNodeWithText("Remote").performClick()
            compose.waitUntil(5_000) { compose.onAllNodes(hasText("Nothing yet.")).fetchSemanticsNodes().isNotEmpty() }
        }
    }

    private fun iso(ms: Long) = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date(ms))

    private fun events(at: String) = """{"events":[
        {"id":1,"at":"$at","type":"device.online","deviceId":"tv-1","actor":{"type":"tv"},"data":{}},
        {"id":2,"at":"$at","type":"playback.started","deviceId":"tv-1","actor":{"type":"tv"},
         "data":{"viewingId":7,"itemId":"cam","itemKind":"series","itemTitle":"Caminandes","episodeId":"cam.e2","season":1,"number":2,"positionMs":250000,"trigger":"viewer"}},
        {"id":3,"at":"$at","type":"playback.ended","deviceId":"tv-1","actor":{"type":"tv"},
         "data":{"viewingId":7,"endReason":"stopped","seen":false,"positionMs":724000,"watchedMs":474000,"dropped":false}}],
        "last":3,"gap":false}"""
}
