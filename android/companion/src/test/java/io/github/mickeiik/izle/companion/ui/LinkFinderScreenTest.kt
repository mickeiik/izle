package io.github.mickeiik.izle.companion.ui

import android.app.Activity
import android.net.Uri
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ActivityScenario
import io.github.mickeiik.izle.companion.MainActivity
import io.github.mickeiik.izle.companion.finder.FoundLink
import io.github.mickeiik.izle.companion.finder.LinkFinder
import io.github.mickeiik.izle.companion.ui.theme.CompanionTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * The link finder screen with a real [LinkFinder] (its confirmer answers "a playlist" for every URL): the page loads,
 * a request it makes becomes **Listen to this** without its URL ever shown, a pasted link too, Back closes.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class LinkFinderScreenTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    private val checked = mutableListOf<String>()
    private val confirmed = mutableListOf<String>()
    private val finder = LinkFinder(
        { url, headers ->
            checked += url
            if (url.contains("expired")) null else FoundLink(url, headers).also { confirmed += url }
        },
        CoroutineScope(SupervisorJob() + Dispatchers.Unconfined),
    )
    private var listened: FoundLink? = null
    private var closed = false

    private fun show(activity: ComponentActivity) = activity.setContent {
        CompanionTheme {
            LinkFinderScreen(finder, initialUrl = "page.test/watch/1", onListenToThis = { listened = it }, onClose = { closed = true })
        }
    }

    @Test
    fun aRequestOfThePageBecomesAStreamToListenTo() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            lateinit var web: WebView
            scenario.onActivity { activity ->
                show(activity)
            }
            compose.waitForIdle()
            scenario.onActivity { activity -> web = findWebView(activity) }
            compose.onNodeWithText("https://page.test/watch/1").assertIsDisplayed()
            assertEquals("https://page.test/watch/1", shadowOf(web).lastLoadedUrl)
            assertTrue(web.settings.javaScriptEnabled)
            assertTrue(web.settings.domStorageEnabled)
            compose.onNodeWithText("Listen to this").assertDoesNotExist()

            val stream = "https://cdn.test/m3u8/abc?payload=x"
            CookieManager.getInstance().setCookie("https://cdn.test/", "session=s1")
            scenario.onActivity {
                val client = web.webViewClient
                assertNull(client.shouldInterceptRequest(web, request("https://cdn.test/app.js")))
                assertNull(client.shouldInterceptRequest(web, request(stream)))
            }

            compose.onNodeWithText("A stream was found on this page").assertIsDisplayed()
            compose.onNodeWithText("cdn.test", substring = true).assertDoesNotExist()
            compose.onNodeWithText("Listen to this").performClick()
            assertEquals(listOf(stream), confirmed)
            val link = listened!!
            assertEquals(stream, link.url)
            assertEquals("https://page.test/watch/1", link.headers["Referer"])
            assertEquals("https://page.test", link.headers["Origin"])
            assertEquals(setOf("Referer", "Origin", "Cookie"), link.headers.keys)
            assertTrue(link.headers.getValue("Cookie").contains("session=s1"))
        }
    }

    @Test
    fun inPageNavigationMovesTheAddressAndGivesTheRefererARequestLacks() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            lateinit var web: WebView
            scenario.onActivity { activity -> show(activity) }
            compose.waitForIdle()
            scenario.onActivity { activity -> web = findWebView(activity) }

            // A single-page app's pushState(): no page load, only the visited history.
            scenario.onActivity { web.webViewClient.doUpdateVisitedHistory(web, "https://page.test/watch/2?ep=3", false) }
            compose.onNodeWithText("https://page.test/watch/2?ep=3").assertIsDisplayed()
            scenario.onActivity { web.webViewClient.doUpdateVisitedHistory(web, "about:blank", false) }
            compose.onNodeWithText("https://page.test/watch/2?ep=3").assertIsDisplayed()
            scenario.onActivity { web.webViewClient.doUpdateVisitedHistory(web, "https://page.test/watch/2?ep=4", false) }
            compose.onNodeWithText("https://page.test/watch/2?ep=4").assertIsDisplayed()

            val stream = "https://cdn.test/m3u8/nav?payload=y"
            scenario.onActivity {
                assertNull(web.webViewClient.shouldInterceptRequest(web, request(stream, mapOf("User-Agent" to "Mozilla/5.0"))))
            }
            compose.onNodeWithText("Listen to this").performClick()
            val link = listened!!
            assertEquals(stream, link.url)
            assertEquals("https://page.test/watch/2?ep=4", link.headers["Referer"])
            assertEquals("https://page.test", link.headers["Origin"])
        }
    }

    @Test
    fun anotherPageMakesTheFinderCheckAUrlSeenBeforeAgain() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            lateinit var web: WebView
            scenario.onActivity { activity -> show(activity) }
            compose.waitForIdle()
            scenario.onActivity { activity -> web = findWebView(activity) }

            val stale = "https://cdn.test/m3u8/expired?payload=z"
            scenario.onActivity {
                web.webViewClient.doUpdateVisitedHistory(web, "https://page.test/watch/1", false)
                assertNull(web.webViewClient.shouldInterceptRequest(web, request(stale)))
                assertNull(web.webViewClient.shouldInterceptRequest(web, request(stale)))
            }
            assertEquals(listOf(stale), checked)

            // The same page again (a reload's history entry): nothing is forgotten.
            scenario.onActivity {
                web.webViewClient.doUpdateVisitedHistory(web, "https://page.test/watch/1", true)
                assertNull(web.webViewClient.shouldInterceptRequest(web, request(stale)))
            }
            assertEquals(listOf(stale), checked)

            scenario.onActivity {
                web.webViewClient.doUpdateVisitedHistory(web, "https://page.test/watch/2", false)
                assertNull(web.webViewClient.shouldInterceptRequest(web, request(stale)))
            }
            assertEquals(listOf(stale, stale), checked)
        }
    }

    @Test
    fun aPastedLinkAndBackClosing() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity -> show(activity) }

            compose.onNodeWithText("Paste a link").performClick()
            compose.onNodeWithText("Link to a playlist").performTextInput("https://cdn.test/expired/abc")
            compose.onNodeWithText("Use").performClick()
            compose.onNodeWithText("That link did not open as a playlist on this phone.").assertIsDisplayed()
            compose.onNodeWithText("Listen to this").assertDoesNotExist()

            compose.onNodeWithText("Link to a playlist").performTextInput("https://cdn.test/signed/abc?sig=1")
            compose.onNodeWithText("Use").performClick()
            compose.onNodeWithText("A stream was found on this page").assertIsDisplayed()
            compose.onNodeWithText("That link did not open as a playlist on this phone.").assertDoesNotExist()
            // Found: the bar offers the stream alone, the paste field and its toggle are gone.
            compose.onNodeWithText("Link to a playlist").assertDoesNotExist()
            compose.onNodeWithText("Paste a link").assertDoesNotExist()
            // The pasted link left the field: its URL is not on screen.
            compose.onNodeWithText("cdn.test", substring = true).assertDoesNotExist()
            compose.onNodeWithText("Listen to this").performClick()
            assertEquals(FoundLink("https://cdn.test/signed/abc?sig=1", emptyMap()), listened)

            assertFalse(closed)
            scenario.onActivity { activity -> activity.onBackPressedDispatcher.onBackPressed() }
            compose.waitForIdle()
            assertTrue(closed)
        }
    }

    @Test
    fun thePasteFieldOpensOnlyFromItsToggleAndHidingItClearsTheError() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity -> show(activity) }

            compose.onNodeWithText("Start the video on the page; its stream shows up here.").assertIsDisplayed()
            compose.onNodeWithText("Link to a playlist").assertDoesNotExist()
            compose.onNodeWithText("Use").assertDoesNotExist()

            compose.onNodeWithText("Paste a link").performClick()
            compose.onNodeWithText("Link to a playlist").assertIsDisplayed()
            compose.onNodeWithText("Link to a playlist").performTextInput("not a link")
            compose.onNodeWithText("Use").performClick()
            compose.onNodeWithText("That link did not open as a playlist on this phone.").assertIsDisplayed()

            compose.onNodeWithText("Hide").performClick()
            compose.onNodeWithText("Link to a playlist").assertDoesNotExist()
            compose.onNodeWithText("That link did not open as a playlist on this phone.").assertDoesNotExist()
            assertFalse(finder.state.value.pasteError)

            compose.onNodeWithText("Paste a link").performClick()
            compose.onNodeWithText("Link to a playlist").assertIsDisplayed()
            compose.onNodeWithText("That link did not open as a playlist on this phone.").assertDoesNotExist()
        }
    }

    @Test
    fun withoutAnAddressTheBrowserStartsOnABlankPageAndBackCloses() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            lateinit var web: WebView
            scenario.onActivity { activity ->
                activity.setContent {
                    CompanionTheme {
                        LinkFinderScreen(finder, initialUrl = null, onListenToThis = { listened = it }, onClose = { closed = true })
                    }
                }
            }
            compose.waitForIdle()
            scenario.onActivity { activity -> web = findWebView(activity) }
            assertEquals("about:blank", shadowOf(web).lastLoadedUrl)
            compose.onNodeWithText("Web address").assertIsDisplayed()

            scenario.onActivity { activity -> activity.onBackPressedDispatcher.onBackPressed() }
            compose.waitForIdle()
            assertTrue(closed)
        }
    }

    private fun request(
        url: String,
        headers: Map<String, String> = mapOf("Referer" to "https://page.test/watch/1", "Origin" to "https://page.test", "User-Agent" to "Mozilla/5.0"),
    ): WebResourceRequest = object : WebResourceRequest {
        override fun getUrl(): Uri = Uri.parse(url)
        override fun isForMainFrame(): Boolean = false
        override fun isRedirect(): Boolean = false
        override fun hasGesture(): Boolean = false
        override fun getMethod(): String = "GET"
        override fun getRequestHeaders(): Map<String, String> = headers
    }

    private fun findWebView(activity: Activity): WebView = checkNotNull(find(activity.window.decorView)) { "no WebView on screen" }

    private fun find(view: View): WebView? = when (view) {
        is WebView -> view
        is ViewGroup -> (0 until view.childCount).firstNotNullOfOrNull { find(view.getChildAt(it)) }
        else -> null
    }
}
