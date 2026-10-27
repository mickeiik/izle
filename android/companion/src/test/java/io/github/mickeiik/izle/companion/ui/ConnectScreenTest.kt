package io.github.mickeiik.izle.companion.ui

import androidx.activity.compose.setContent
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ActivityScenario
import io.github.mickeiik.izle.companion.MainActivity
import io.github.mickeiik.izle.companion.ui.design.IzleTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The connect screen: the address and the code, the errors in words, and the debug builds' token instead. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class ConnectScreenTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    private var connected: Pair<String, String>? = null
    private var withToken: Pair<String, String>? = null

    private fun show(state: CompanionUi.Connect, allowToken: Boolean, check: () -> Unit) {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.setContent {
                    IzleTheme {
                        ConnectScreen(
                            state,
                            onConnect = { url, code -> connected = url to code },
                            onConnectWithToken = { url, token -> withToken = url to token },
                            allowToken = allowToken,
                        )
                    }
                }
            }
            check()
        }
    }

    @Test
    fun theAddressAndTheCode() = show(CompanionUi.Connect(initialUrl = "http://tv.local:8787"), allowToken = false) {
        compose.onNodeWithText("Connect to your TV").assertIsDisplayed()
        compose.onNodeWithText(
            "On the TV, hold OK, then Settings → Connect a phone. Scan the code on the TV with this phone's camera, " +
                "or enter the server address and the 6-digit code here.",
        ).assertIsDisplayed()
        compose.onNodeWithText("http://tv.local:8787").assertIsDisplayed()
        compose.onNodeWithText("Connect").assertIsNotEnabled()
        val code = hasText("6-digit code") and hasSetTextAction()
        compose.onNode(code).performTextInput("483 92")
        compose.onNodeWithText("Connect").assertIsNotEnabled()
        compose.onNode(code).performTextInput("0x7")
        compose.onNode(code).assertTextEquals("6-digit code", "483920")
        compose.onNodeWithText("Connect").assertIsEnabled().performClick()
        assertEquals("http://tv.local:8787" to "483920", connected)
        compose.onNodeWithText("Use a token instead").assertDoesNotExist()
        compose.onNodeWithText("Access token").assertDoesNotExist()
    }

    @Test
    fun theErrorsInWords() {
        val errors = mapOf(
            ConnectError.CodeNotAccepted to "That code is not valid any more. Open Connect a phone on the TV again.",
            ConnectError.TooManyTries to "Too many tries. Wait a few minutes and try again.",
            ConnectError.Disconnected to "This phone was disconnected. Connect it again from the TV.",
            ConnectError.Server("busy") to "The server answered: busy.",
        )
        for ((error, text) in errors) {
            show(CompanionUi.Connect(initialUrl = "", error = error), allowToken = false) {
                compose.onNodeWithText(text).assertIsDisplayed()
            }
        }
    }

    @Test
    fun busyWhileALinkIsClaimed() = show(CompanionUi.Connect(initialUrl = "http://tv.local:8787", busy = true), allowToken = true) {
        compose.onNodeWithText("Connect").assertDoesNotExist() // the button shows progress
        compose.onNodeWithText("Use a token instead").assertIsNotEnabled()
    }

    @Test
    fun debugBuildsMayUseATokenInstead() = show(CompanionUi.Connect(initialUrl = "http://tv.local:8787"), allowToken = true) {
        compose.onNodeWithText("Access token").assertDoesNotExist()
        compose.onNodeWithText("Use a token instead").performClick()
        compose.onNodeWithText("6-digit code").assertDoesNotExist()
        compose.onNodeWithText("Access token").performTextInput("izat_secret")
        compose.onNode(hasText("Access token") and SemanticsMatcher.keyIsDefined(SemanticsProperties.Password)).assertExists()
        compose.onNodeWithText("Connect").assertIsEnabled().performClick()
        assertEquals("http://tv.local:8787" to "izat_secret", withToken)
        assertNull(connected)
        compose.onNodeWithText("Use the code instead").performClick()
        compose.onNodeWithText("6-digit code").assertIsDisplayed()
    }
}
