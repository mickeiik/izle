package io.github.mickeiik.izle.ui.home

import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * A section as the layout needs it: titled or not, one line that scrolls sideways ([row]) or a grid, how many cards (at
 * least one), and which of them are app cards ([apps], by their place): tiles that never open.
 */
data class SectionShape(val titled: Boolean, val row: Boolean, val count: Int, val apps: Set<Int> = emptySet())

/**
 * Where everything on Home goes (docs/ux/senior-tv.md, "Sections" and "App cards"), in dp from the viewport's top. One
 * card size for all of Home ([grid]), [SECTION_HEADER] set aside from the height when a section has a title; app cards
 * are tiles, lower than the posters in a section of app cards only. Section k > 0 starts where a next row would; a
 * title takes [SECTION_HEADER] above its first row's padding. Without a titled section or app cards this is Home's grid
 * of rows exactly.
 */
data class HomeLayout(
    val grid: HomeGrid,
    val viewportHeight: Float,
    val contentHeight: Float,
    val sections: List<Section>,
    val lines: List<Line>,
    val slots: List<Slot>,
) {
    /**
     * [top]: what shows with its first line (its title, else the padding); [divider]: the line above it's centre;
     * [apps]: its app cards, tiles [tileWidth] wide; [cardHeight]: its cards' height, the posters' or, in a section of
     * app cards only, the tiles'.
     */
    data class Section(
        val titled: Boolean,
        val row: Boolean,
        val count: Int,
        val top: Float,
        val divider: Float?,
        val firstLine: Int,
        val lastLine: Int,
        val firstSlot: Int,
        val apps: Set<Int>,
        val tileWidth: Float,
        val cardHeight: Float,
    ) {
        /** Only app cards: tiles two columns wide, lower than posters, that grow a little with the focus. */
        val appsOnly: Boolean get() = apps.size == count
    }

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
        if (s.row) return s.firstLine
        return (s.firstLine until s.lastLine).firstOrNull { index < lines[it].first + lines[it].count } ?: s.lastLine
    }

    /** Card [index] of [section] closed: a poster [HomeGrid.cardWidth] wide, an app card its section's tile. */
    fun cardWidth(section: Int, index: Int): Float = sections[section].let { if (index in it.apps) it.tileWidth else grid.cardWidth }

    /** What card [index] of [section] widens by with the focus: a poster opens, a tile does not. */
    private fun opening(section: Int, index: Int): Float = if (index in sections[section].apps) 0f else grid.openWidth - grid.cardWidth

    /** From card [from]'s left edge to card [to]'s (negative before it), all closed. */
    private fun x(section: Int, from: Int, to: Int): Float =
        if (to < from) -x(section, to, from) else (from until to).sumOf { (cardWidth(section, it) + grid.gap).toDouble() }.toFloat()

    /** Whether cards [first] to [focus] fit the columns, [focus] open if it opens. */
    private fun fits(section: Int, first: Int, focus: Int): Boolean =
        x(section, first, focus) + cardWidth(section, focus) + opening(section, focus) <= grid.rowWidth + FIT_SLACK

    /** A row section's first card in view at its end: its last cards that fit the columns with any one of them open. */
    private fun lastFirst(section: Int): Int {
        val last = sections[section].count - 1
        fun fitsToEnd(first: Int) =
            x(section, first, last) + cardWidth(section, last) + (first..last).maxOf { opening(section, it) } <= grid.rowWidth + FIT_SLACK
        var first = last
        while (first > 0 && fitsToEnd(first - 1)) first--
        return first
    }

    /**
     * A row section's first card in view once the focus moved to [focus] from a line showing [first] first: it slides
     * only at the edge of what is in view, by one card whatever its width (as far as shows [focus] whole, open if it
     * opens), never beyond its last cards.
     */
    fun rowFirst(section: Int, first: Int, focus: Int): Int {
        var f = min(first, focus).coerceAtLeast(0)
        while (f < focus && !fits(section, f, focus)) f++
        return min(f, lastFirst(section))
    }

    /** What a row section leaves after its last card (besides the screen's margin), so its last cards can come in view. */
    fun rowEnd(section: Int): Float {
        val last = sections[section].count - 1
        return grid.rowWidth - x(section, lastFirst(section), last) - cardWidth(section, last)
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
        return if (s.row || lineOf(section, target) == lineOf(section, index)) target else null
    }

    /**
     * The card ↑ ([direction] < 0) or ↓, as (section, index): on the next line, the one whose left edge is nearest; in
     * a row section only among the cards in view ([rowFirst]: a section's first card in view). Null at Home's ends.
     */
    fun vertical(section: Int, index: Int, direction: Int, rowFirst: (Int) -> Int): Pair<Int, Int>? {
        if (direction == 0) return null
        val from = lineOf(section, index)
        val to = lines.getOrNull(from + if (direction > 0) 1 else -1) ?: return null
        val left = left(section, index, rowFirst)
        val target = sections[to.section]
        val inView = if (target.row) {
            val first = rowFirst(to.section).coerceIn(0, max(0, target.count - 1))
            (first until target.count).takeWhile { fits(to.section, first, it) }
        } else {
            (to.first until to.first + to.count).toList()
        }
        val best = inView.minBy { abs(left(to.section, it, rowFirst) - left) }
        return to.section to best
    }

    /** Where a card's left edge is (all cards closed) from the first column's: in its grid row, or in what a row section shows. */
    private fun left(section: Int, index: Int, rowFirst: (Int) -> Int): Float =
        x(section, if (sections[section].row) rowFirst(section) else lines[lineOf(section, index)].first, index)

    /** The scroll bar's thumb and its top, as fractions of the track. */
    val thumbFraction: Float get() = min(1f, viewportHeight / contentHeight)

    fun thumbOffset(scroll: Float): Float = scroll.coerceIn(0f, maxScroll) / contentHeight

    companion object {
        /** A section title's block: 30 sp bold on a 38 dp line, and 6 dp under it. */
        const val SECTION_HEADER = 44f
        const val DIVIDER_HEIGHT = 2f

        fun grid(columns: Int, rows: Int, width: Float, height: Float, titleLine: Float, titled: Boolean): HomeGrid =
            HomeGrid.compute(columns, rows, width, height - if (titled) SECTION_HEADER else 0f, titleLine)

        /** Widths are whole dp, summed exactly; the slack only keeps a fit from being refused for a rounding error. */
        private const val FIT_SLACK = 0.01f

        /**
         * A grid section's rows, as (first card, count): each takes cards in order while they fit the columns together
         * with one open card's extra width, at least one; [width]: a card's width closed.
         */
        private fun gridRows(g: HomeGrid, count: Int, width: (Int) -> Float): List<Pair<Int, Int>> {
            val rows = ArrayList<Pair<Int, Int>>()
            var at = 0
            while (at < count) {
                var end = at + 1
                var used = width(at)
                while (end < count && used + g.gap + width(end) + g.openWidth - g.cardWidth <= g.rowWidth + FIT_SLACK) used += g.gap + width(end++)
                rows += at to end - at
                at = end
            }
            return rows
        }

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
                // App cards are tiles: two columns wide and 16:9 in a section of app cards only, else as tall as the
                // posters and as wide as an open card.
                val appsOnly = s.apps.size == s.count
                val tileWidth = if (appsOnly) g.appTileWidth else g.openWidth
                val cardHeight = if (appsOnly) g.appTileHeight else g.cardHeight
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
                val rows = if (s.row) listOf(0 to s.count) else gridRows(g, s.count) { if (it in s.apps) tileWidth else g.cardWidth }
                val firstLine = lines.size
                for ((r, row) in rows.withIndex()) {
                    val (first, count) = row
                    val cardTop = firstCardTop + r * (cardHeight + g.gap)
                    lines += Line(k, first, count, cardTop, top = if (r == 0) top else cardTop - g.padding, bottom = cardTop + cardHeight + g.padding, slot = slots.size)
                    slots += Cards(k, lines.lastIndex, cardTop)
                    cardBottom = cardTop + cardHeight
                }
                placed += Section(s.titled, s.row, s.count, top, divider, firstLine, lines.size - 1, firstSlot, s.apps, tileWidth, cardHeight)
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
