package io.github.mickeiik.izle.ui.home

import kotlin.math.floor
import kotlin.math.min

/**
 * Home's grid, in dp: [columns] × [rows] portrait (2:3) cards (the owner's setting, clamped) as large as fit while
 * one card of a row is open ([openWidth]: 16:9 at the card's height); the viewport is exactly [rows] rows tall and a
 * row with an open card wide. [titleLinesInCard]: the lines of a name that fit inside a card without a picture, at
 * least one.
 */
data class HomeGrid(
    val columns: Int,
    val rows: Int,
    val cardWidth: Float,
    val cardHeight: Float,
    val openWidth: Float,
    val viewportWidth: Float,
    val viewportHeight: Float,
    val titleLinesInCard: Int,
) {
    val gap: Float get() = GAP
    val padding: Float get() = PADDING
    val rowPitch: Float get() = cardHeight + gap

    /** A row of cards with one open, from the first card's left edge to the last one's right edge. */
    val rowWidth: Float get() = (columns - 1) * (cardWidth + GAP) + openWidth

    fun rowCount(count: Int): Int = (count + columns - 1) / columns

    companion object {
        const val MIN_COLUMNS = 3
        const val MAX_COLUMNS = 6
        const val MIN_ROWS = 1
        const val MAX_ROWS = 4
        const val GAP = 20f

        /** Around the cards, inside the safe area. */
        const val PADDING = 14f

        /** Around the name drawn inside a card that has no picture. */
        const val CARD_TEXT_PADDING = 8f

        /** Inside an open card's panel, and around a channel's logo. */
        const val INSET = 12f

        /**
         * `w = floor(min(3·(W − 2P − (N − 1)·G) / (3·N + 5), 2·(H − 2P − (R − 1)·G) / (3·R)))`: N − 1 cards and one
         * open card fit a row, R cards the height (docs/ux/senior-tv.md, "Home"). Whole numbers divided once, so the
         * admin page's mirror gets the same widths.
         */
        fun compute(columns: Int, rows: Int, width: Float, height: Float, titleLine: Float): HomeGrid {
            val cols = columns.coerceIn(MIN_COLUMNS, MAX_COLUMNS)
            val rowsShown = rows.coerceIn(MIN_ROWS, MAX_ROWS)
            val widthBound = 3 * (width - 2 * PADDING - (cols - 1) * GAP) / (3 * cols + 5)
            val heightBound = 2 * (height - 2 * PADDING - (rowsShown - 1) * GAP) / (3 * rowsShown)
            val cardWidth = floor(min(widthBound, heightBound)).coerceAtLeast(1f)
            val cardHeight = 1.5f * cardWidth
            val openWidth = floor(8 * cardWidth / 3)
            return HomeGrid(
                columns = cols,
                rows = rowsShown,
                cardWidth = cardWidth,
                cardHeight = cardHeight,
                openWidth = openWidth,
                viewportWidth = (cols - 1) * (cardWidth + GAP) + openWidth + 2 * PADDING,
                viewportHeight = rowsShown * cardHeight + (rowsShown - 1) * GAP + 2 * PADDING,
                titleLinesInCard = floor((cardHeight - 2 * CARD_TEXT_PADDING) / titleLine).toInt().coerceAtLeast(1),
            )
        }
    }
}

/**
 * What an open card's panel keeps, in dp: the name at the top ([nameLines], at most [MAX_NAME_LINES]); at the bottom,
 * "2 new episodes" ([newEpisodes]), the chip saying what OK does (at 24 sp when [largeChip], else 16 sp), the episode
 * line under a "Continue" chip that the whole "Continue · Episode 2" did not fit ([episodeLine]) and the progress bar
 * ([bar]).
 */
data class PanelFit(val nameLines: Int, val newEpisodes: Boolean, val largeChip: Boolean, val episodeLine: Boolean, val bar: Boolean) {
    companion object {
        const val MAX_NAME_LINES = 3

        /**
         * In [height]: the name's [nameLines] of [nameLine] each, [gap] under it, then the bottom's parts [gap] apart:
         * [newLine] (0: none), the chip, [episodeLine] (0: none), [bar] (0: none). The chip is [largeChip] tall at
         * 24 sp (0: too wide), drawn so when one name line, it and the bar fit; else [smallChip] tall at 16 sp. Then
         * left out until the rest fits, in order: "2 new episodes", the episode line, name lines down to one, the bar.
         */
        fun of(
            height: Float,
            nameLines: Int,
            nameLine: Float,
            newLine: Float,
            largeChip: Float,
            smallChip: Float,
            episodeLine: Float,
            bar: Float,
            gap: Float,
        ): PanelFit {
            fun withBar(above: Float) = if (bar > 0f) above + gap + bar else above
            val large = largeChip > 0f && withBar(nameLine + gap + largeChip) <= height
            val chip = if (large) largeChip else smallChip
            var lines = nameLines.coerceIn(1, MAX_NAME_LINES)
            var new = newLine > 0f
            var episode = episodeLine > 0f
            var withBar = bar > 0f
            fun needed(): Float {
                val bottom = listOf(if (new) newLine else 0f, chip, if (episode) episodeLine else 0f, if (withBar) bar else 0f).filter { it > 0f }
                return lines * nameLine + gap + bottom.sum() + (bottom.size - 1) * gap
            }
            while (needed() > height) {
                when {
                    new -> new = false
                    episode -> episode = false
                    lines > 1 -> lines--
                    withBar -> withBar = false
                    else -> break
                }
            }
            return PanelFit(lines, new, large, episode, withBar)
        }
    }
}
