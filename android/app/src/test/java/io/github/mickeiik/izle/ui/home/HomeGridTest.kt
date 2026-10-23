package io.github.mickeiik.izle.ui.home

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Home's grid in the safe area of the 960×540 dp canvas (864×486 dp), names in cards at 32 dp a line. */
class HomeGridTest {
    private fun grid(columns: Int, rows: Int, height: Float = 486f) = HomeGrid.compute(columns, rows, width = 864f, height = height, titleLine = 32f)

    @Test
    fun theCardsAreAsLargeAsFitWithOneCardOfARowOpen() {
        // Columns × rows (and the height: less a title's 44 dp with a titled section): the card's width and height and
        // the open card's width, as docs/ux/senior-tv.md and the admin page's mirror have them.
        val cases = listOf(
            Expected(4, 2, 486f, 136f, 204f, 362f),
            Expected(4, 2, 442f, 131f, 196.5f, 349f),
            Expected(3, 1, 486f, 170f, 255f, 453f),
            Expected(6, 2, 486f, 96f, 144f, 256f),
            Expected(6, 4, 486f, 66f, 99f, 176f),
            Expected(5, 3, 486f, 92f, 138f, 245f),
        )
        for (e in cases) {
            val g = grid(e.columns, e.rows, e.height)
            val name = "${e.columns} × ${e.rows} in ${e.height}"
            assertEquals(name, e, Expected(g.columns, g.rows, e.height, g.cardWidth, g.cardHeight, g.openWidth))
            // A row with one card open, and exactly [rows] rows, inside the safe area.
            assertEquals(name, (e.columns - 1) * (g.cardWidth + 20f) + g.openWidth, g.rowWidth, 0f)
            assertEquals(name, g.rowWidth + 2 * 14f, g.viewportWidth, 0f)
            assertEquals(name, e.rows * g.cardHeight + (e.rows - 1) * 20f + 2 * 14f, g.viewportHeight, 0.001f)
            assertEquals(name, g.cardHeight + 20f, g.rowPitch, 0f)
            assertTrue(name, g.viewportWidth <= 864f && g.viewportHeight <= e.height)
            // A card one dp wider would not fit: its row (with an open card 16:9 at its height) or its column.
            val wider = g.cardWidth + 1
            assertTrue(
                name,
                (e.columns - 1) * (wider + 20f) + 8 * wider / 3 + 28f > 864f || e.rows * 1.5f * wider + (e.rows - 1) * 20f + 28f > e.height,
            )
        }
        // As many lines of a name as fit inside a card without a picture, 8 dp from its edges.
        assertEquals(5, grid(4, 2).titleLinesInCard)
        assertEquals(2, grid(6, 4).titleLinesInCard)
    }

    private data class Expected(
        val columns: Int,
        val rows: Int,
        val height: Float,
        val cardWidth: Float,
        val cardHeight: Float,
        val openWidth: Float,
    )

    @Test
    fun outOfRangeSettingsAreClampedAndRowsCounted() {
        assertEquals(grid(6, 1), grid(9, 0))
        assertEquals(grid(3, 4), grid(1, 7))
        assertEquals(grid(3, 1), grid(-2, -5))
        assertEquals(6, grid(9, 0).columns)
        assertEquals(1, grid(9, 0).rows)
        assertEquals(listOf(0, 1, 2, 50), listOf(0, 4, 5, 200).map { grid(4, 2).rowCount(it) })
        // Never below 1 dp, however small the screen.
        assertEquals(1f, HomeGrid.compute(6, 4, 10f, 10f, 32f).cardWidth, 0f)
    }

    // The open card's panel at 4 × 2 (180 dp inside its 12 dp edges) and 6 × 4 (75 dp): 26 sp names on 34 dp lines,
    // 24 sp lines of 32 dp, chips 38 dp tall at 24 sp and 26 dp at 16 sp, a 6 dp bar, 8 dp apart.
    private fun panel(height: Float, nameLines: Int, new: Boolean = false, largeChip: Float = 38f, episode: Boolean = false, bar: Boolean = false) =
        PanelFit.of(height, nameLines, 34f, if (new) 32f else 0f, largeChip, 26f, if (episode) 32f else 0f, if (bar) 6f else 0f, 8f)

    @Test
    fun theOpenPanelLeavesOutWhatDoesNotFitInOrder() {
        // Everything fits a tall panel; the name never takes more than three lines.
        assertEquals(PanelFit(3, newEpisodes = true, largeChip = true, episodeLine = true, bar = true), panel(400f, 5, new = true, episode = true, bar = true))
        // 4 × 2, a resumed episode with new ones and a three-line name: "2 new episodes" goes, then the episode line.
        assertEquals(PanelFit(3, newEpisodes = false, largeChip = true, episodeLine = false, bar = true), panel(180f, 3, new = true, episode = true, bar = true))
        assertEquals(PanelFit(3, newEpisodes = false, largeChip = true, episodeLine = true, bar = true), panel(220f, 3, new = true, episode = true, bar = true))
        // Then name lines, down to one.
        assertEquals(PanelFit(2, newEpisodes = false, largeChip = true, episodeLine = false, bar = true), panel(150f, 3, new = true, episode = true, bar = true))
        // 6 × 4: the 24 sp chip and the bar do not fit under one name line: a 16 sp chip, and the bar goes last.
        assertEquals(PanelFit(1, newEpisodes = false, largeChip = false, episodeLine = false, bar = false), panel(75f, 2, new = true, episode = true, bar = true))
        // Without a bar the 16 sp chip is for when the 24 sp one is too tall (or too wide: 0).
        assertEquals(PanelFit(1, newEpisodes = false, largeChip = true, episodeLine = false, bar = false), panel(80f, 2))
        assertEquals(PanelFit(1, newEpisodes = false, largeChip = false, episodeLine = false, bar = false), panel(79f, 2))
        assertEquals(PanelFit(2, newEpisodes = false, largeChip = false, episodeLine = false, bar = false), panel(180f, 2, largeChip = 0f))
        // Nothing left to leave out: the name's one line and the chip stay.
        assertEquals(PanelFit(1, newEpisodes = false, largeChip = false, episodeLine = false, bar = false), panel(20f, 1, bar = true))
    }
}
