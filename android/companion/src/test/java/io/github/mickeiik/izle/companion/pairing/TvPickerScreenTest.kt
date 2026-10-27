package io.github.mickeiik.izle.companion.pairing

import androidx.activity.compose.setContent
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ActivityScenario
import io.github.mickeiik.izle.companion.MainActivity
import io.github.mickeiik.izle.companion.ui.CompanionUi
import io.github.mickeiik.izle.companion.ui.TvPickerScreen
import io.github.mickeiik.izle.companion.ui.design.IzleTheme
import io.github.mickeiik.izle.data.api.AdminDevice
import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.data.api.DeviceProblems
import io.github.mickeiik.izle.json
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

/** The TV list with pairing: each TV's state, the waiting code's card, the approve sheet, Not mine, Pair by code. */
@RunWith(RobolectricTestRunner::class)
// No screen-size qualifier: with one, a dialog's text field never lets Compose get idle under Robolectric.
@Config(sdk = [36])
class TvPickerScreenTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    private val server = MockWebServer()
    private val requests = CopyOnWriteArrayList<RecordedRequest>()
    @Volatile private var approveAnswer: MockResponse = json(409, """{"error":"already_approved"}""")

    @Before
    fun setUp() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                return when ("${request.method} ${request.url.encodedPath}") {
                    "GET /api/v1/admin/status" -> json(200, STATUS)
                    "GET /api/v1/admin/pair/pending" -> json(200, PENDING)
                    "POST /api/v1/admin/pair/approve" -> approveAnswer
                    "DELETE /api/v1/admin/pair/pending/483920" -> MockResponse.Builder().code(204).build()
                    else -> json(404, """{"error":"not_found"}""")
                }
            }
        }
        server.start()
    }

    @After
    fun tearDown() = server.close()

    private fun show(paired: AtomicInteger = AtomicInteger()): ActivityScenario<MainActivity> {
        val api = ApiClient(server.url("/"), "izph_test", OkHttpClient())
        val state = CompanionUi.PickTv(
            "izle.home",
            listOf(
                AdminDevice("tv-1", "Salon", online = true, problems = DeviceProblems(recent = 1)),
                AdminDevice("tv-2", "Kitchen", online = false, lastSeenAt = "2026-10-27T09:05:00.000Z"),
            ),
            loading = false,
        )
        val scenario = ActivityScenario.launch(MainActivity::class.java).onActivity { activity ->
            activity.setContent {
                IzleTheme { TvPickerScreen(state, api, onPick = {}, onRetry = {}, onPaired = { paired.incrementAndGet() }) }
            }
        }
        compose.waitUntil(5_000) { compose.onAllNodes(hasText("483 920")).fetchSemanticsNodes().isNotEmpty() }
        return scenario
    }

    @Test
    fun theStateLinesTheCardAndARefusedApproval() {
        show().use {
            compose.onNodeWithText("Online · playing Caminandes").assertIsDisplayed()
            compose.onNodeWithText("1 problem").assertIsDisplayed()
            compose.onNodeWithText("A TV is waiting to pair").assertIsDisplayed()
            compose.onNodeWithText("8 min left").assertIsDisplayed()
            compose.onNode(hasScrollAction()).performScrollToNode(hasText("Pair a new TV by its code"))
            compose.onNodeWithText("Pair a new TV by its code").assertIsDisplayed()

            compose.onNodeWithText("Approve…").performClick()
            compose.onNodeWithText("Code 483 920").assertIsDisplayed()
            compose.onNodeWithText("A new TV").assertIsDisplayed()
            compose.onNodeWithText("Replaces Salon").assertIsDisplayed()
            compose.onNodeWithText("TV").assertIsDisplayed() // the name the server would give it
            compose.onNodeWithText("Approve").performClick()
            compose.waitUntil(5_000) { compose.onAllNodes(hasText("This code was approved already.")).fetchSemanticsNodes().isNotEmpty() }
        }
    }

    @Test
    fun approvingInPlaceOfATvAndNotMine() {
        approveAnswer = json(200, """{"deviceId":"tv-1","name":"Salon"}""")
        val paired = AtomicInteger()
        show(paired).use {
            compose.onNodeWithText("Approve…").performClick()
            compose.onNodeWithText("Replaces Salon").performClick()
            compose.onNodeWithText("Approve").performClick()
            compose.waitUntil(5_000) { paired.get() == 1 }
            val approve = requests.single { it.method == "POST" }
            assertEquals("""{"code":"483920","replaces":"tv-1"}""", approve.body?.utf8())

            compose.onNodeWithText("Not mine").performClick()
            compose.onNodeWithText("Clear code 483 920?").assertIsDisplayed()
            compose.onNodeWithText("Clear").performClick()
            compose.waitUntil(5_000) { requests.any { it.method == "DELETE" } }
        }
    }

    @Test
    fun pairingByItsCode() {
        show().use {
            compose.onNode(hasScrollAction()).performScrollToNode(hasText("Pair a new TV by its code"))
            compose.onNodeWithText("Pair a new TV by its code").performClick()
            compose.onNodeWithText("Type the 6 digits the TV shows.").assertIsDisplayed()
            compose.onNode(hasSetTextAction()).performTextInput("123 45")
            compose.onNodeWithText("Next").assertIsNotEnabled()
            compose.onNode(hasSetTextAction()).performTextInput("6")
            compose.onNodeWithText("Next").performClick()
            compose.onNodeWithText("Code 123 456").assertIsDisplayed()
        }
    }

    private companion object {
        // 2026-10-27T11:05:00Z; the code expires in 7.5 minutes.
        const val STATUS = """{"serverNowMs":1793099100000,"server":{"version":"0.6.1"},"pairing":{"pending":1},"lastEventId":40,
            "devices":[{"id":"tv-1","name":"Salon","online":true,"nowPlaying":{"itemId":"cam","itemKind":"series","itemTitle":"Caminandes","state":"playing"}},
              {"id":"tv-2","name":"Kitchen","online":false,"lastSeenAt":"2026-10-27T09:05:00.000Z"}]}"""
        const val PENDING = """{"codes":[{"code":"483920","createdAt":"2026-10-27T11:02:30.000Z","expiresAt":"2026-10-27T11:12:30.000Z","approved":false}]}"""
    }
}
