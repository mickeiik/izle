package io.github.mickeiik.izle.ui.home

import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * A section of Home as the layout needs it: whether it has a title, whether it is one line that scrolls sideways
 * ([row]) or a grid, how many cards it holds (at least one), and whether a card title in its last line (every card of
 * a [row]) needs two lines at the card width.
 */
data class SectionShape(val titled: Boolean, val row: Boolean, val count: Int, val lastLineNeedsTwoTitleLines: Boolean = false)

/**
 * Where everything on Home goes, in dp, in content coordinates: y = 0 at the viewport's top, the viewport [grid]'s
 * (centred in the safe area as without sections) plus [titleReserve]. docs/ux/senior-tv.md, "Sections".
 *
 * One card size for the whole Home ([grid]): when a section has a title, [SECTION_HEADER] is set aside from the height
 * first. Section k > 0 starts where a next row would: one [HomeGrid.gap] under the previous section's last cell. A
 * titled section's title takes [SECTION_HEADER] above its first row's [HomeGrid.padding]. Without a titled section
 * this is Home's grid of rows exactly.
 */
data class HomeLayout(
    val grid: HomeGrid,
    val titleReserve: Float,
    val viewportHeight: Float,
    val contentHeight: Float,
    val sections: List<Section>,
    val lines: List<Line>,
    /** The items of the lazy grid that draws Home, in order (see [Slot]). */
    val slots: List<Slot>,
) {
    data class Section(
        val titled: Boolean,
        val row: Boolean,
        val count: Int,
        /** The title's top, else the first row's top − padding: what shows with its first line. */
        val top: Float,
        /** The centre of the line between this section and the one above (null for the first section). */
        val divider: Float?,
        val firstLine: Int,
        val lastLine: Int,
        /** Its first slot (its title's, else its first line's). */
        val firstSlot: Int,
    )

    /**
     * One line of cards: a row of a grid section, or a whole row section. [first] and [count]: its cards' indices in
     * the section. [top] and [bottom]: what must show when it has the focus (the section's title included on its first
     * line, else the padding above the row; the padding under the cell).
     */
    data class Line(val section: Int, val first: Int, val count: Int, val cardTop: Float, val top: Float, val bottom: Float, val slot: Int)

    /**
     * An item of the lazy grid that draws Home with `spacedBy(gap)` between lines and [HomeGrid.padding] above and
     * below: every line is a [Card] row (or one [Row] item for a row section), a titled section has a full-width
     * [Title] item before its first line, so a gap above and below it place the title and the cards as the layout
     * says. [top] is the item's top in content coordinates.
     */
    sealed interface Slot {
        val top: Float
        val section: Int
    }

    /** [height] is the item's, [textOffset] where the title's text is drawn in it (above it on Home's first line). */
    data class Title(override val section: Int, override val top: Float, val height: Float, val textOffset: Float) : Slot

    /** [span]: more than one column for a grid section's last card when an untitled grid follows, to end the row. */
    data class Card(override val section: Int, val index: Int, override val top: Float, val span: Int) : Slot

    data class Row(override val section: Int, override val top: Float) : Slot

    /** The width the cards take: the first column's left edge to the last column's right edge. */
    val contentWidth: Float get() = grid.viewportWidth - 2 * grid.padding

    /** The furthest Home scrolls. */
    val maxScroll: Float get() = max(0f, contentHeight - viewportHeight)

    /** The line that holds card [index] of section [section]. */
    fun lineOf(section: Int, index: Int): Int {
        val s = sections[section]
        return if (s.row) s.firstLine else s.firstLine + index / grid.columns
    }

    /**
     * The scroll offset that shows [line] whole, moving as little as possible from [current]: the line comes in at the
     * top or the bottom edge, or Home stays put when it is already in view. Home's first line is shown at offset 0.
     */
    fun scrollFor(line: Int, current: Float): Float {
        val l = lines[line]
        val offset = min(max(current, l.bottom - viewportHeight), l.top)
        return offset.coerceIn(0f, maxScroll)
    }

    /** The card ← ([direction] < 0) or → of card [index] in its line, or null at the line's end: the focus stays. */
    fun horizontal(section: Int, index: Int, direction: Int): Int? {
        val s = sections[section]
        val target = index + direction.coerceIn(-1, 1)
        if (direction == 0 || target !in 0 until s.count) return null
        return if (s.row || target / grid.columns == index / grid.columns) target else null
    }

    /**
     * The card ↑ ([direction] < 0) or ↓ of card [index] of [section], as (section, index): on the line above or below,
     * across sections, the one whose left edge is nearest this card's; in a row section only among the cards in view,
     * [rowFirst] of a section being its first card in view. Null on Home's first line going up or its last going down.
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

    /** The column a card's left edge is at: its place in a grid row, or in what a row section shows. */
    private fun column(section: Int, index: Int, rowFirst: (Int) -> Int): Int =
        if (sections[section].row) index - rowFirst(section) else index % grid.columns

    /** The scroll bar's thumb, as a fraction of its track. */
    val thumbFraction: Float get() = min(1f, viewportHeight / contentHeight)

    /** Where the thumb's top is, as a fraction of the track, for the scroll offset [scroll]. */
    fun thumbOffset(scroll: Float): Float = scroll.coerceIn(0f, maxScroll) / contentHeight

    companion object {
        /** A section title's block: 30 sp bold on a 38 dp line, and 6 dp under it. */
        const val SECTION_HEADER = 44f

        /** The line between two sections. */
        const val DIVIDER_HEIGHT = 2f

        /** [HomeGrid.compute] with [SECTION_HEADER] set aside from [height] when a section is [titled]. */
        fun grid(columns: Int, rows: Int, width: Float, height: Float, titleLine: Float, titled: Boolean): HomeGrid =
            HomeGrid.compute(columns, rows, width, height - if (titled) SECTION_HEADER else 0f, titleLine)

        /**
         * The first card in view of a row section of [count] cards after the focus moved to [focus], [first] being
         * the one before: the line slides only once the focus reaches the edge of what is in view.
         */
        fun rowFirst(first: Int, focus: Int, count: Int, columns: Int): Int =
            minOf(max(first, focus - columns + 1), focus, max(0, count - columns)).coerceAtLeast(0)

        /** JavaScript's `Math.round` (halves up), as the admin page's mirror of this layout rounds. */
        private fun round(value: Float): Float = floor(value + 0.5f)

        /**
         * The layout of [sections] (not empty ones) on a Home of [columns] × [rows] in an area of [width] × [height]
         * dp (the safe area), card titles of [titleLine] dp per line.
         */
        fun compute(columns: Int, rows: Int, width: Float, height: Float, titleLine: Float, sections: List<SectionShape>): HomeLayout {
            val titled = sections.any { it.titled }
            val g = grid(columns, rows, width, height, titleLine, titled)
            val reserve = if (titled) SECTION_HEADER else 0f
            val placed = ArrayList<Section>(sections.size)
            val lines = ArrayList<Line>()
            val slots = ArrayList<Slot>()
            var cellBottom = 0f
            for ((k, s) in sections.withIndex()) {
                val top: Float
                val divider: Float?
                val firstCardTop: Float
                if (k == 0) {
                    top = 0f
                    divider = null
                    firstCardTop = (if (s.titled) SECTION_HEADER else 0f) + g.padding
                } else {
                    val nextTop = cellBottom + g.gap
                    val needed = if (sections[k - 1].lastLineNeedsTwoTitleLines) 2 else 1
                    val unused = g.titleLines - min(g.titleLines, needed)
                    divider = round((cellBottom - unused * titleLine + nextTop) / 2)
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
                    lines += Line(k, first, count, cardTop, top = if (r == 0) top else cardTop - g.padding, bottom = cardTop + g.cellHeight + g.padding, slot = slots.size)
                    if (s.row) {
                        slots += Row(k, cardTop)
                    } else {
                        val endsRow = r == lineCount - 1 && sections.getOrNull(k + 1)?.let { !it.titled && !it.row } == true
                        for (j in first until first + count) {
                            val span = if (endsRow && j == first + count - 1) g.columns - (count - 1) else 1
                            slots += Card(k, j, cardTop, span)
                        }
                    }
                    cellBottom = cardTop + g.cellHeight
                }
                placed += Section(s.titled, s.row, s.count, top, divider, firstLine, lines.size - 1, firstSlot)
            }
            return HomeLayout(
                grid = g,
                titleReserve = reserve,
                viewportHeight = g.viewportHeight + reserve,
                contentHeight = if (lines.isEmpty()) 0f else cellBottom + g.padding,
                sections = placed,
                lines = lines,
                slots = slots,
            )
        }
    }
}
