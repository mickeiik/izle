package io.github.mickeiik.izle.companion.ui

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ActivityScenario
import io.github.mickeiik.izle.companion.MainActivity
import io.github.mickeiik.izle.companion.ui.theme.CompanionTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import kotlin.math.abs

/**
 * Timing for this source on a 360 dp wide phone: every button's label fits on one line, centred in its button (the
 * owner asked for it after a mockup pushed "PAL vs film" against its button's edge), and the controls call back.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], qualifiers = "w360dp-h800dp")
class TimingControlsTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    @Test
    fun everyLabelFitsCentredAt360dp() {
        val marks = mutableListOf<Boolean>()
        val nudges = mutableListOf<Long>()
        val speeds = mutableListOf<Double?>()
        val state = CompanionUi.Tv(
            tvId = "tv-1", offsetText = "-1.250", speedText = "1.0427", timingValid = true, applyAllVisible = true,
            chosen = CandidateOption("dub", "fr", "dub", "hls"), tvMarkMs = 724_250.0,
        )
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.setContent {
                    CompanionTheme {
                        Column(Modifier.padding(16.dp)) {
                            TimingControls(
                                state,
                                onMark = { marks += it }, onNudge = { nudges += it }, onOffsetText = {}, onSpeed = { speeds += it },
                                onSpeedText = {}, onSave = {}, onApplyAll = {},
                            )
                        }
                    }
                }
            }
            val labels = listOf(
                "Mark on TV", "Mark on phone", "−30 s", "−5 s", "−0.5 s", "+0.5 s", "+5 s", "+30 s",
                "Same speed", "PAL vs film", "Film vs PAL", "Other", "Save timing", "Apply to all episodes",
            )
            for (label in labels) assertFitsCentred(label)

            compose.onNodeWithText("−0:01.3").assertExists()
            compose.onNodeWithText("TV marked at 12:04.2, now tap when you hear it").assertExists()
            compose.onNodeWithText("PAL vs film").assertIsSelected()
            compose.onNodeWithText("Mark on phone").performClick()
            compose.onNodeWithText("−0.5 s").performClick()
            compose.onNodeWithText("Film vs PAL").performClick()
            compose.onNodeWithText("Other").performClick()
            assertEquals(listOf(false), marks)
            assertEquals(listOf(-500L), nudges)
            assertEquals(listOf(0.9591, null), speeds)
        }
    }

    /** One line, nothing cut, and as much room left as right of the text. */
    private fun assertFitsCentred(label: String) {
        val node = compose.onNodeWithText(label).fetchSemanticsNode()
        val layouts = mutableListOf<TextLayoutResult>()
        node.config.getOrNull(SemanticsActions.GetTextLayoutResult)?.action?.invoke(layouts)
        val layout = layouts.single()
        assertEquals("$label: one line", 1, layout.lineCount)
        assertFalse("$label: not cut", layout.hasVisualOverflow)
        val left = layout.getLineLeft(0)
        val right = layout.size.width - layout.getLineRight(0)
        assertTrue("$label: centred ($left vs $right)", abs(left - right) <= 1f)
        assertTrue("$label: a button", node.config.getOrNull(SemanticsProperties.Role) != null || node.parent?.config?.getOrNull(SemanticsProperties.Role) != null)
    }
}
