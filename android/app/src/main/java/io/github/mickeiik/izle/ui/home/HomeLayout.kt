package io.github.mickeiik.izle.ui.home

import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/** A section as the layout needs it: titled or not, one line that scrolls sideways ([row]) or a grid, how many cards (at least one). */
data class SectionShape(val titled: Boolean, val row: Boolean, val count: Int)

/**
 * Where everything on Home goes (docs/ux/senior-tv.md, "Sections"), in dp from the viewport's top. One card size for
 * all of Home ([grid]), [SECTION_HEADER] set aside from the height when a section has a title. Section k > 0 starts
 * where a next row would; a title takes [SECTION_HEADER] above its first row's padding. Without a titled section this
 * is Home's grid of rows exactly.
 */
data class HomeLayout(
    val grid: HomeGrid,
    val viewportHeight: Float,
    val contentHeight: Float,
    val sections: List<Section>,
    val lines: List<Line>,
    val slots: List<Slot>,
) {
    /** [top]: what shows with its first line (its title, else the padding); [divider]: the line above it's centre. */
    data class Section(
        val titled: Boolean,
        val row: Boolean,
        val count: Int,
        val top: Float,
        val divider: Float?,
        val firstLine: Int,
        val lastLine: Int,
        val firstSlot: Int,
    )

    /**
     * A row of a grid section, or a whole row section: cards [first] to [first] + [count] of [section]. [top] to
     * [bottom] must show when it has the focus (its section's title on the first line, the padding otherwise).
     */
    data class Line(val section: Int, val first: Int, val count: Int, val cardTop: Float, val top: Float, val bottom: Float, val slot: Int)

    /**
     * An item of the lazy column that draws Home, with `spacedBy(gap)` between items and the padding above and below:
     * a line of [Cards], and a full-width [Title] before a titled section's first line.
     */
    sealed interface Slot {
        val top: Float
        val section: Int
    }

    /** [textOffset]: where the title's text is drawn in the item (above it on Home's first line). */
    data class Title(override val section: Int, override val top: Float, val height: Float, val textOffset: Float) : Slot

    /** The cards of [line]: a grid row, or a whole row section. */
    data class Cards(override val section: Int, val line: Int, override val top: Float) : Slot

    /** From the first column's left edge to the last column's right edge, one card open. */
    val contentWidth: Float get() = grid.rowWidth

    val maxScroll: Float get() = max(0f, contentHeight - viewportHeight)

    fun lineOf(section: Int, index: Int): Int {
        val s = sections[section]
        return if (s.row) s.firstLine else s.firstLine + index / grid.columns
    }

    /** The scroll offset that shows [line] whole, moving as little as possible from [current]. */
    fun scrollFor(line: Int, current: Float): Float {
        val l = lines[line]
        return min(max(current, l.bottom - viewportHeight), l.top).coerceIn(0f, maxScroll)
    }

    /** The card ← ([direction] < 0) or → of card [index] in its line, or null at the line's end: the focus stays. */
    fun horizontal(section: Int, index: Int, direction: Int): Int? {
        val s = sections[section]
        val target = index + direction.coerceIn(-1, 1)
        if (direction == 0 || target !in 0 until s.count) return null
        return if (s.row || target / grid.columns == index / grid.columns) target else null
    }

    /**
     * The card ↑ ([direction] < 0) or ↓, as (section, index): on the next line, the one whose left edge is nearest; in
     * a row section only among the cards in view ([rowFirst]: a section's first card in view). Null at Home's ends.
     */
    fun vertical(section: Int, index: Int, direction: Int, rowFirst: (Int) -> Int): Pair<Int, Int>? {
        if (direction == 0) return null
        val from = lineOf(section, index)
        val to = lines.getOrNull(from + if (direction > 0) 1 else -1) ?: return null
        val column = column(section, index, rowFirst)
        val target = sections[to.section]
        val inView = if (target.row) {
            val first = rowFirst(to.section).coerceIn(0, max(0, target.count - 1))
            first until min(target.count, first + grid.columns)
        } else {
            to.first until to.first + to.count
        }
        val best = inView.minBy { abs(column(to.section, it, rowFirst) - column) }
        return to.section to best
    }

    /** The column a card's left edge is at (all cards closed): its place in a grid row, or in what a row section shows. */
    private fun column(section: Int, index: Int, rowFirst: (Int) -> Int): Int =
        if (sections[section].row) index - rowFirst(section) else index % grid.columns

    /** The scroll bar's thumb and its top, as fractions of the track. */
    val thumbFraction: Float get() = min(1f, viewportHeight / contentHeight)

    fun thumbOffset(scroll: Float): Float = scroll.coerceIn(0f, maxScroll) / contentHeight

    companion object {
        /** A section title's block: 30 sp bold on a 38 dp line, and 6 dp under it. */
        const val SECTION_HEADER = 44f
        const val DIVIDER_HEIGHT = 2f

        fun grid(columns: Int, rows: Int, width: Float, height: Float, titleLine: Float, titled: Boolean): HomeGrid =
            HomeGrid.compute(columns, rows, width, height - if (titled) SECTION_HEADER else 0f, titleLine)

        /**
         * A row section's first card in view once the focus moved to [focus]: it slides only at the edge of what is in
         * view ([columns] cards, one of them open).
         */
        fun rowFirst(first: Int, focus: Int, count: Int, columns: Int): Int =
            minOf(max(first, focus - columns + 1), focus, max(0, count - columns)).coerceAtLeast(0)

        /** JavaScript's `Math.round` (halves up), as the admin page's mirror of this layout rounds. */
        private fun round(value: Float): Float = floor(value + 0.5f)

        /** [sections] (none empty) on a Home of [columns] × [rows] in the safe area, names in cards [titleLine] dp a line. */
        fun compute(columns: Int, rows: Int, width: Float, height: Float, titleLine: Float, sections: List<SectionShape>): HomeLayout {
            val titled = sections.any { it.titled }
            val g = grid(columns, rows, width, height, titleLine, titled)
            val placed = ArrayList<Section>(sections.size)
            val lines = ArrayList<Line>()
            val slots = ArrayList<Slot>()
            var cardBottom = 0f
            for ((k, s) in sections.withIndex()) {
                val top: Float
                val divider: Float?
                val firstCardTop: Float
                if (k == 0) {
                    top = 0f
                    divider = null
                    firstCardTop = (if (s.titled) SECTION_HEADER else 0f) + g.padding
                } else {
                    // The line lies in the middle of the gap above the next section.
                    val nextTop = cardBottom + g.gap
                    divider = round((cardBottom + nextTop) / 2)
                    top = if (s.titled) nextTop else nextTop - g.padding
                    firstCardTop = if (s.titled) nextTop + SECTION_HEADER + g.padding else nextTop
                }
                val firstSlot = slots.size
                if (s.titled) {
                    // The item starts at the top padding on Home's first line (the title is drawn above it), else at
                    // the title; the gap under it brings the cards to their place.
                    val slotTop = if (k == 0) g.padding else top
                    slots += Title(k, slotTop, height = firstCardTop - g.gap - slotTop, textOffset = top - slotTop)
                }
                val lineCount = if (s.row) 1 else g.rowCount(s.count)
                val firstLine = lines.size
                for (r in 0 until lineCount) {
                    val cardTop = firstCardTop + r * g.rowPitch
                    val first = if (s.row) 0 else r * g.columns
                    val count = if (s.row) s.count else min(g.columns, s.count - first)
                    lines += Line(k, first, count, cardTop, top = if (r == 0) top else cardTop - g.padding, bottom = cardTop + g.cardHeight + g.padding, slot = slots.size)
                    slots += Cards(k, lines.lastIndex, cardTop)
                    cardBottom = cardTop + g.cardHeight
                }
                placed += Section(s.titled, s.row, s.count, top, divider, firstLine, lines.size - 1, firstSlot)
            }
            return HomeLayout(
                grid = g,
                viewportHeight = g.viewportHeight + if (titled) SECTION_HEADER else 0f,
                contentHeight = if (lines.isEmpty()) 0f else cardBottom + g.padding,
                sections = placed,
                lines = lines,
                slots = slots,
            )
        }
    }
}
