package io.github.mickeiik.izle.ui.home

import kotlin.math.floor
import kotlin.math.min

/**
 * Home's grid, in dp: [columns] × [rows] 16:9 cards (the owner's setting, clamped) as large as fit, each with its title
 * under it; the viewport is exactly [rows] rows tall. [padding] around the cards leaves room for the focused card's
 * 10 % growth; [titleLines] is 2 unless a second line would make the cards smaller. [cellHeight]: card and title.
 * [titleLinesInCard]: the lines of title that fit inside a card without a picture, at least one.
 */
data class HomeGrid(
    val columns: Int,
    val rows: Int,
    val cardWidth: Float,
    val cardHeight: Float,
    val titleLines: Int,
    val cellHeight: Float,
    val viewportWidth: Float,
    val viewportHeight: Float,
    val titleLinesInCard: Int,
) {
    val gap: Float get() = GAP
    val padding: Float get() = PADDING
    val titleGap: Float get() = TITLE_GAP
    val rowPitch: Float get() = cellHeight + gap

    fun rowCount(count: Int): Int = (count + columns - 1) / columns

    companion object {
        const val MIN_COLUMNS = 3
        const val MAX_COLUMNS = 6
        const val MIN_ROWS = 1
        const val MAX_ROWS = 4
        const val GAP = 20f

        /** The focused card grows by 5 % on each side: 14 dp covers it up to a 280 dp wide card. */
        const val PADDING = 14f

        /** Between the card (grown by 5 % of its height when focused) and its title. */
        const val TITLE_GAP = 10f

        /** Around the title drawn inside a card that has no picture. */
        const val CARD_TEXT_PADDING = 8f

        fun compute(columns: Int, rows: Int, width: Float, height: Float, titleLine: Float): HomeGrid {
            val cols = columns.coerceIn(MIN_COLUMNS, MAX_COLUMNS)
            val rowsShown = rows.coerceIn(MIN_ROWS, MAX_ROWS)
            val widthBound = (width - 2 * PADDING - (cols - 1) * GAP) / cols
            fun titleHeight(lines: Int) = TITLE_GAP + titleLine * lines
            fun heightBound(lines: Int) = ((height - 2 * PADDING - (rowsShown - 1) * GAP) / rowsShown - titleHeight(lines)) * 16f / 9f
            fun cardWidth(lines: Int) = floor(min(widthBound, heightBound(lines))).coerceAtLeast(1f)

            val lines = if (cardWidth(2) < cardWidth(1)) 1 else 2
            val cardWidth = cardWidth(lines)
            val cardHeight = cardWidth * 9f / 16f
            val cellHeight = cardHeight + titleHeight(lines)
            return HomeGrid(
                columns = cols,
                rows = rowsShown,
                cardWidth = cardWidth,
                cardHeight = cardHeight,
                titleLines = lines,
                cellHeight = cellHeight,
                viewportWidth = cols * cardWidth + (cols - 1) * GAP + 2 * PADDING,
                viewportHeight = rowsShown * cellHeight + (rowsShown - 1) * GAP + 2 * PADDING,
                titleLinesInCard = floor((cardHeight - 2 * CARD_TEXT_PADDING) / titleLine).toInt().coerceAtLeast(1),
            )
        }
    }
}
