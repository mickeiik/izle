package io.github.mickeiik.izle.companion.ui

import androidx.activity.compose.setContent
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ActivityScenario
import io.github.mickeiik.izle.companion.MainActivity
import io.github.mickeiik.izle.companion.ui.theme.CompanionTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The pairing screen: its two fields, the error in words, and Connect with what was typed. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class PairingScreenTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    @Test
    fun theFieldsTheErrorAndConnect() {
        var connected: Pair<String, String>? = null
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.setContent {
                    CompanionTheme {
                        PairingScreen(
                            CompanionUi.Pairing(initialUrl = "http://tv.local:8787", error = ConnectError.NeedsCompanionScope),
                            onConnect = { url, token -> connected = url to token },
                        )
                    }
                }
            }
            compose.onNodeWithText("Connect to your izle server").assertIsDisplayed()
            compose.onNodeWithText("Server address").assertIsDisplayed()
            compose.onNodeWithText("http://tv.local:8787").assertIsDisplayed()
            compose.onNodeWithText("That token cannot be used for Listen along: it needs the companion scope.").assertIsDisplayed()
            compose.onNodeWithText("Connect").assertIsNotEnabled()
            compose.onNodeWithText("Access token").performTextInput("izat_secret")
            compose.onNode(hasText("Access token") and SemanticsMatcher.keyIsDefined(SemanticsProperties.Password)).assertExists()
            compose.onNodeWithText("Connect").assertIsEnabled().performClick()
            assertEquals("http://tv.local:8787" to "izat_secret", connected)
        }
    }
}
