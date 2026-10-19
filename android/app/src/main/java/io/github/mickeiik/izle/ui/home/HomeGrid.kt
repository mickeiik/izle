package io.github.mickeiik.izle.ui.home

import kotlin.math.floor
import kotlin.math.min

/**
 * The sizes of Home's grid, in dp: [columns] × [rows] 16:9 cards (the owner's setting, clamped) as large as fit the
 * area, each with its title under it. The viewport is exactly [rows] rows tall; further rows scroll into it.
 *
 * [padding] goes around the cards inside the viewport, room for the focused card's 10 % growth; [titleLines] is 2
 * unless a second line would make the cards smaller than one line does.
 */
data class HomeGrid(
    val columns: Int,
    val rows: Int,
    val cardWidth: Float,
    val cardHeight: Float,
    val titleLines: Int,
    /** Card and title: one row of the grid, without the gap to the next. */
    val cellHeight: Float,
    val viewportWidth: Float,
    val viewportHeight: Float,
    val gap: Float,
    val padding: Float,
    val titleGap: Float,
    /** How many lines of [titleLine] fit inside a card with [CARD_TEXT_PADDING] around them, at least one. */
    val titleLinesInCard: Int,
) {
    /** The distance from one row's top to the next one's. */
    val rowPitch: Float get() = cellHeight + gap

    /** How many rows [count] cards take. */
    fun rowCount(count: Int): Int = (count + columns - 1) / columns

    /**
     * The row to have at the top so that [targetRow] is in view, moving as little as possible from [currentFirstRow]:
     * the grid stays put when the row is already on screen, else the row comes in at the top or the bottom edge.
     */
    fun firstRowShowing(targetRow: Int, currentFirstRow: Int): Int =
        currentFirstRow.coerceIn((targetRow - rows + 1).coerceAtLeast(0), targetRow)

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

        /**
         * The layout for [columns] × [rows] (clamped to 3–6 × 1–4) in an area of [width] × [height] dp, titles of
         * [titleLine] dp per line.
         */
        fun compute(
            columns: Int,
            rows: Int,
            width: Float,
            height: Float,
            titleLine: Float,
            gap: Float = GAP,
            padding: Float = PADDING,
            titleGap: Float = TITLE_GAP,
        ): HomeGrid {
            val cols = columns.coerceIn(MIN_COLUMNS, MAX_COLUMNS)
            val rowsShown = rows.coerceIn(MIN_ROWS, MAX_ROWS)
            val widthBound = (width - 2 * padding - (cols - 1) * gap) / cols
            fun titleHeight(lines: Int) = titleGap + titleLine * lines
            fun heightBound(lines: Int) = ((height - 2 * padding - (rowsShown - 1) * gap) / rowsShown - titleHeight(lines)) * 16f / 9f
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
                viewportWidth = cols * cardWidth + (cols - 1) * gap + 2 * padding,
                viewportHeight = rowsShown * cellHeight + (rowsShown - 1) * gap + 2 * padding,
                gap = gap,
                padding = padding,
                titleGap = titleGap,
                titleLinesInCard = floor((cardHeight - 2 * CARD_TEXT_PADDING) / titleLine).toInt().coerceAtLeast(1),
            )
        }
    }
}
