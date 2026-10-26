package io.github.mickeiik.izle.companion

import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.assertIsDisplayed
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The app starts: manifest, application class, theme and Compose content, under Robolectric on a phone. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class MainActivityTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    @Test
    fun launches() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            assertEquals(Lifecycle.State.RESUMED, scenario.state)
            scenario.onActivity { activity -> assertEquals(CompanionApp::class.java, activity.application::class.java) }
            compose.onNodeWithText("izle companion").assertIsDisplayed()
        }
    }
}
