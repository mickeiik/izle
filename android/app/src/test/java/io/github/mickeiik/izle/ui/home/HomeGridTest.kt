package io.github.mickeiik.izle.ui.home

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Home's grid in the safe area of the 960×540 dp canvas (864×486 dp), titles at 32 dp a line. */
class HomeGridTest {
    private fun grid(columns: Int, rows: Int) = HomeGrid.compute(columns, rows, width = 864f, height = 486f, titleLine = 32f)

    @Test
    fun theCardsAreAsLargeAsFitWithTwoTitleLinesUnlessOneKeepsThemLarger() {
        // Columns × rows: card width, title lines (under it, and inside a card without a picture), viewport width × height.
        // 4 × 2 fills the width with two title lines; with two lines 4 × 3 would leave 116 dp wide cards; 6 × 4 is the
        // smallest; 3 × 1 has large cards, set by the width (less what rounding their width down takes).
        val cases = listOf(
            Expected(4, 2, 194f, 2, 2, 864f, 414.25f),
            Expected(4, 3, 173f, 1, 2, 780f, 485.9375f),
            Expected(6, 4, 102f, 1, 1, 740f, 485.5f),
            Expected(3, 1, 265f, 2, 4, 863f, 251.0625f),
        )
        for (e in cases) {
            val g = grid(e.columns, e.rows)
            val name = "${e.columns} × ${e.rows}"
            val actual = Expected(g.columns, g.rows, g.cardWidth, g.titleLines, g.titleLinesInCard, g.viewportWidth, g.viewportHeight)
            assertEquals(name, e, actual)
            // Exactly [rows] rows tall, inside the safe area, and the focused card's growth stays inside the padding.
            assertEquals(name, g.cardWidth * 9f / 16f, g.cardHeight, 0.001f)
            assertEquals(name, g.cardHeight + 10f + 32f * g.titleLines, g.cellHeight, 0.001f)
            assertEquals(name, g.cellHeight + 20f, g.rowPitch, 0.001f)
            assertEquals(name, e.rows * g.cellHeight + (e.rows - 1) * 20f + 2 * 14f, g.viewportHeight, 0.001f)
            assertTrue(name, g.viewportWidth <= 864f && g.viewportHeight <= 486f && g.cardWidth * 0.05f <= g.padding)
        }
    }

    private data class Expected(
        val columns: Int,
        val rows: Int,
        val cardWidth: Float,
        val titleLines: Int,
        val linesInCard: Int,
        val width: Float,
        val height: Float,
    )

    @Test
    fun outOfRangeSettingsAreClampedAndRowsCounted() {
        assertEquals(grid(6, 1), grid(9, 0))
        assertEquals(grid(3, 4), grid(1, 7))
        assertEquals(grid(3, 1), grid(-2, -5))
        assertEquals(6, grid(9, 0).columns)
        assertEquals(1, grid(9, 0).rows)
        assertEquals(listOf(0, 1, 2, 50), listOf(0, 4, 5, 200).map { grid(4, 2).rowCount(it) })
    }
}
