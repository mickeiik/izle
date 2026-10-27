package io.github.mickeiik.izle.companion

import android.content.Intent
import android.net.Uri
import android.os.Looper
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.lifecycle.ViewModelProvider
import io.github.mickeiik.izle.companion.sync.CompanionApi
import io.github.mickeiik.izle.companion.ui.CompanionUi
import io.github.mickeiik.izle.companion.ui.CompanionViewModel
import io.github.mickeiik.izle.companion.sync.ListenSession
import io.github.mickeiik.izle.data.api.CompanionResolveRequest
import io.github.mickeiik.izle.data.api.CompanionResolveResponse
import io.github.mickeiik.izle.data.api.CompanionResponse
import io.github.mickeiik.izle.data.api.NowResponse
import io.github.mickeiik.izle.json
import io.github.mickeiik.izle.player.FakeMediaEngine
import kotlinx.coroutines.awaitCancellation
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.net.URLEncoder
import java.util.concurrent.CopyOnWriteArrayList

/** The app starts: manifest, application class, theme and Compose content, under Robolectric on a phone; and the connect link. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class MainActivityTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    private val app: CompanionApp get() = ApplicationProvider.getApplicationContext()

    @Test
    fun launches() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            assertEquals(Lifecycle.State.RESUMED, scenario.state)
            scenario.onActivity { activity -> assertEquals(CompanionApp::class.java, activity.application::class.java) }
            compose.onNodeWithText("izle companion").assertIsDisplayed()
        }
    }

    @Test
    fun theConnectLinkOpensTheApp() {
        val link = Intent(Intent.ACTION_VIEW, Uri.parse("izle-companion://connect?server=http%3A%2F%2Ftv&invite=abc"))
            .addCategory(Intent.CATEGORY_BROWSABLE)
        val found = app.packageManager.queryIntentActivities(link, 0).map { it.activityInfo.name }
        assertEquals(listOf(MainActivity::class.java.name), found)
        val otherHost = Intent(Intent.ACTION_VIEW, Uri.parse("izle-companion://pair?x=1")).addCategory(Intent.CATEGORY_BROWSABLE)
        assertEquals(emptyList<Any>(), app.packageManager.queryIntentActivities(otherHost, 0))
    }

    @Test
    fun theConnectLinkClaimsItsInviteOnceAcrossARecreation() {
        val requests = CopyOnWriteArrayList<RecordedRequest>()
        val server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                return when (request.url.encodedPath) {
                    "/api/v1/phones/claim" -> json(201, CLAIM)
                    "/api/v1/admin/devices" -> json(200, """{"devices":[{"id":"tv-1","name":"Living room","status":"active","online":true}]}""")
                    else -> json(404, """{"error":"not_found"}""")
                }
            }
        }
        server.start()
        app.graph.newSession = { _, scope -> ListenSession(NeverAnswers, FakeMediaEngine(), scope, { it }) }
        try {
            val base = URLEncoder.encode(server.url("/").toString(), "UTF-8")
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse("izle-companion://connect?server=$base&invite=inv-abc"))
                .setClass(app, MainActivity::class.java)
            ActivityScenario.launch<MainActivity>(intent).use { scenario ->
                // The activity's view model, through its own factory (whose application may be an earlier test's, as
                // AndroidViewModelFactory keeps the first one: so this test reads the screen, not the store).
                var vm: CompanionViewModel? = null
                scenario.onActivity { vm = ViewModelProvider(it)[CompanionViewModel::class.java] }
                waitUntil({ "the TV: ${requests.map { it.url.encodedPath }}" }) {
                    (vm!!.ui.value as? CompanionUi.Tv)?.tvId == "tv-1"
                }
                val claim = requests.first()
                assertEquals("/api/v1/phones/claim", claim.url.encodedPath)
                assertTrue(claim.body!!.utf8().startsWith("""{"invite":"inv-abc","name":"""))
                assertNull(claim.headers["Authorization"])
                scenario.recreate()
                repeat(20) {
                    shadowOf(Looper.getMainLooper()).idle()
                    Thread.sleep(10)
                }
                assertEquals("claimed once", 1, requests.count { it.url.encodedPath == "/api/v1/phones/claim" })
            }
        } finally {
            app.graph.releaseSession()
            server.close()
        }
    }

    private fun waitUntil(what: () -> String, condition: () -> Boolean) {
        repeat(1_000) {
            shadowOf(Looper.getMainLooper()).idle()
            if (condition()) return
            Thread.sleep(10)
        }
        fail("Timed out waiting for ${what()}")
    }

    private object NeverAnswers : CompanionApi {
        override suspend fun now(deviceId: String, seq: Long?, waitSec: Int): NowResponse = awaitCancellation()
        override suspend fun resolve(deviceId: String, request: CompanionResolveRequest): CompanionResolveResponse = awaitCancellation()
        override suspend fun companion(deviceId: String): CompanionResponse = awaitCancellation()
    }

    private companion object {
        const val CLAIM = """{"phone":{"id":"ph0123456789","name":"Test phone","createdAt":"2026-10-26T10:00:00.000Z",
            "lastUsedAt":null,"deviceId":"tv-1"},"secret":"izph_secret","deviceId":"tv-1"}"""
    }
}
