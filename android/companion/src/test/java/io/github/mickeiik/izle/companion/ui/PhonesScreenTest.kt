package io.github.mickeiik.izle.companion.ui

import androidx.activity.compose.setContent
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ActivityScenario
import io.github.mickeiik.izle.companion.MainActivity
import io.github.mickeiik.izle.companion.ui.theme.CompanionTheme
import io.github.mickeiik.izle.data.api.Phone
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The phones: this one marked, when each was last used, and Disconnect after a confirmation. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class PhonesScreenTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    @Test
    fun theListAndDisconnectAfterAConfirmation() {
        val disconnected = mutableListOf<String>()
        val state = CompanionUi.Phones(
            phones = listOf(
                Phone("ph-this", "Pixel 8", lastUsedAt = "2020-01-01T00:00:00.000Z"),
                Phone("ph-other", "Tablet"),
            ),
            thisPhoneId = "ph-this",
            loading = false,
        )
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.setContent {
                    CompanionTheme { PhonesScreen(state, onDisconnect = { disconnected += it }, onRetry = {}, onBack = {}) }
                }
            }
            compose.onNodeWithText("This phone").assertIsDisplayed()
            compose.onNodeWithText("Pixel 8").assertIsDisplayed()
            compose.onNodeWithText("Not used yet").assertIsDisplayed()
            assertTrue(compose.onAllNodesWithText("Last used", substring = true).fetchSemanticsNodes().size == 1)

            compose.onAllNodesWithText("Disconnect")[1].performClick()
            compose.onNodeWithText("Disconnect Tablet?").assertIsDisplayed()
            compose.onNodeWithText("It will need to be connected again from a TV.").assertIsDisplayed()
            compose.onNodeWithText("Cancel").performClick()
            assertEquals(emptyList<String>(), disconnected)

            compose.onAllNodesWithText("Disconnect")[0].performClick()
            compose.onNodeWithText("This phone will need to be connected again from a TV.").assertIsDisplayed()
            // The dialog's button is the last one.
            val buttons = compose.onAllNodesWithText("Disconnect")
            buttons[buttons.fetchSemanticsNodes().size - 1].performClick()
            assertEquals(listOf("ph-this"), disconnected)
        }
    }
}
