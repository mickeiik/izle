package io.github.mickeiik.izle.ui.home

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Home's grid in the safe area of the 960×540 dp canvas (864×486 dp), titles at 32 dp a line. */
class HomeGridTest {
    private fun grid(columns: Int, rows: Int) = HomeGrid.compute(columns, rows, width = 864f, height = 486f, titleLine = 32f)

    @Test
    fun fourByTwoFillsTheWidthWithTwoTitleLines() {
        val g = grid(4, 2)
        assertEquals(194f, g.cardWidth, 0f)
        assertEquals(109.125f, g.cardHeight, 0.001f)
        assertEquals(2, g.titleLines)
        assertEquals(183.125f, g.cellHeight, 0.001f)
        // The whole safe width, and exactly two rows tall.
        assertEquals(864f, g.viewportWidth, 0.001f)
        assertEquals(2 * 183.125f + 20f + 2 * 14f, g.viewportHeight, 0.001f)
        assertEquals(203.125f, g.rowPitch, 0.001f)
        assertEquals(2, g.titleLinesInCard)
    }

    @Test
    fun fourByThreeTakesOneTitleLineToKeepTheCardsLarger() {
        val g = grid(4, 3)
        // Two lines would leave 116 dp wide cards.
        assertEquals(173f, g.cardWidth, 0f)
        assertEquals(1, g.titleLines)
        // Set by the height: three rows fill it (less what rounding the width down takes).
        assertTrue("three rows fit the height: ${g.viewportHeight}", g.viewportHeight <= 486f)
        assertEquals(486f, g.viewportHeight, 2f)
        assertEquals(3 * g.cellHeight + 2 * 20f + 2 * 14f, g.viewportHeight, 0.001f)
    }

    @Test
    fun sixByFourIsTheSmallest() {
        val g = grid(6, 4)
        assertEquals(102f, g.cardWidth, 0f)
        assertEquals(57.375f, g.cardHeight, 0.001f)
        assertEquals(1, g.titleLines)
        assertTrue(g.viewportHeight <= 486f)
        assertEquals(486f, g.viewportHeight, 3f)
        assertTrue(g.viewportWidth < 864f)
        assertEquals(1, g.titleLinesInCard)
    }

    @Test
    fun threeByOneHasLargeCards() {
        val g = grid(3, 1)
        assertEquals(265f, g.cardWidth, 0f)
        assertEquals(2, g.titleLines)
        // Set by the width: the cards fill it (less what rounding their width down takes).
        assertEquals(864f, g.viewportWidth, 3f)
        assertEquals(g.cellHeight + 2 * 14f, g.viewportHeight, 0.001f)
        // The focused card's growth stays inside the padding.
        assertTrue(g.cardWidth * 0.05f <= g.padding)
    }

    @Test
    fun outOfRangeSettingsAreClamped() {
        assertEquals(grid(6, 1), grid(9, 0))
        assertEquals(grid(3, 4), grid(1, 7))
        assertEquals(grid(3, 1), grid(-2, -5))
        assertEquals(6, grid(9, 0).columns)
        assertEquals(1, grid(9, 0).rows)
    }

    @Test
    fun countsRows() {
        val g = grid(4, 2)
        assertEquals(0, g.rowCount(0))
        assertEquals(1, g.rowCount(4))
        assertEquals(2, g.rowCount(5))
        assertEquals(50, g.rowCount(200))
    }

    @Test
    fun aRowAlreadyInViewKeepsTheGridWhereItIs() {
        val g = grid(4, 2)
        // A new grid (back from the player) at the top: rows 0 and 1 are in view.
        assertEquals(0, g.firstRowShowing(targetRow = 0, currentFirstRow = 0))
        assertEquals(0, g.firstRowShowing(targetRow = 1, currentFirstRow = 0))
        // Row 2 comes in at the bottom edge, not at the top.
        assertEquals(1, g.firstRowShowing(targetRow = 2, currentFirstRow = 0))
        assertEquals(4, g.firstRowShowing(targetRow = 5, currentFirstRow = 0))
        // Scrolled down: a row above comes in at the top edge; one on screen moves nothing.
        assertEquals(1, g.firstRowShowing(targetRow = 1, currentFirstRow = 3))
        assertEquals(3, g.firstRowShowing(targetRow = 4, currentFirstRow = 3))
        // One row a screen: the row itself.
        assertEquals(5, grid(4, 1).firstRowShowing(targetRow = 5, currentFirstRow = 0))
    }
}
