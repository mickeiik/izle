package io.github.mickeiik.izle.ui.home

import io.github.mickeiik.izle.data.api.ContinueInfo
import io.github.mickeiik.izle.data.api.HomeEntry
import io.github.mickeiik.izle.data.api.HomeSectionInfo
import io.github.mickeiik.izle.data.api.ItemCard
import io.github.mickeiik.izle.data.api.SectionEntry
import io.github.mickeiik.izle.domain.HomeSections
import io.github.mickeiik.izle.domain.HomeTile
import io.github.mickeiik.izle.ui.home.HomeLayout.Cards
import io.github.mickeiik.izle.ui.home.HomeLayout.Title
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Home's sections in the safe area of the 960×540 dp canvas (864×486 dp), names in cards at 32 dp a line. */
class HomeLayoutTest {
    private fun layout(columns: Int, rows: Int, vararg sections: SectionShape) =
        HomeLayout.compute(columns, rows, width = 864f, height = 486f, titleLine = 32f, sections = sections.toList())

    private fun grid(count: Int, title: Boolean = false) = SectionShape(title, row = false, count = count)

    private fun row(count: Int, title: Boolean = false) = SectionShape(title, row = true, count = count)

    /** A section with app cards at [apps] (all of its cards when empty). */
    private fun SectionShape.apps(vararg apps: Int) = copy(apps = if (apps.isEmpty()) (0 until count).toSet() else apps.toSet())

    @Test
    fun withoutATitledSectionHomeIsTodaysGrid() {
        for ((columns, rows) in listOf(4 to 2, 4 to 3, 6 to 4, 3 to 1)) {
            val g = HomeGrid.compute(columns, rows, 864f, 486f, 32f)
            val l = layout(columns, rows, grid(11))
            assertEquals(g, l.grid)
            assertEquals(g.viewportHeight, l.viewportHeight, 0f)
            val count = g.rowCount(11)
            assertEquals(count, l.lines.size)
            l.lines.forEachIndexed { r, line ->
                assertEquals(g.padding + r * g.rowPitch, line.cardTop, 0.001f)
                // Scrolling to a row is today's whole-row scroll, from anywhere: Home stays put when the row is in
                // view, else the row comes in at the top or the bottom edge.
                for (firstRow in 0..maxOf(0, count - g.rows)) {
                    val expected = firstRow.coerceIn((r - g.rows + 1).coerceAtLeast(0), r) * g.rowPitch
                    assertEquals("row $r from $firstRow", expected, l.scrollFor(line = r, current = firstRow * g.rowPitch), 0.001f)
                }
            }
            assertEquals(count * g.rowPitch - g.gap + 2 * g.padding, l.contentHeight, 0.001f)
            // One item a row, no title.
            assertEquals((0 until count).map { Cards(0, it, g.padding + it * g.rowPitch) }, l.slots)
        }
    }

    @Test
    fun anUntitledLineAloneIsOneLineWithoutATitle() {
        for ((columns, rows) in listOf(4 to 2, 4 to 3, 6 to 4, 3 to 1)) {
            val g = HomeGrid.compute(columns, rows, 864f, 486f, 32f)
            val l = layout(columns, rows, row(11))
            // No title, nothing set aside: today's card size and viewport.
            assertEquals(g, l.grid)
            assertEquals(g.viewportHeight, l.viewportHeight, 0f)
            // One line, its cards at the padding from the top; Home does not scroll.
            assertEquals(1, l.lines.size)
            assertEquals(14f, l.lines.single().cardTop)
            assertEquals(0f, l.lines.single().top)
            assertEquals(listOf(Cards(0, 0, 14f)), l.slots)
            assertEquals(14f + g.cardHeight + 14f, l.contentHeight, 0.001f)
            assertEquals(0f, l.maxScroll)
            assertEquals(0f, l.scrollFor(0, current = 0f))
            assertNull(l.vertical(0, 5, 1) { 3 })
            assertEquals(6, l.horizontal(0, 5, 1))
        }
    }

    @Test
    fun aTitleSetsItsHeightAsideFromTheCardSize() {
        // 4 × 2 is set by the height: 131 dp cards (136 without the title), the viewport one title taller.
        val l = layout(4, 2, grid(4, title = true), grid(4))
        assertEquals(HomeGrid.compute(4, 2, 864f, 486f - 44f, 32f), l.grid)
        assertEquals(131f, l.grid.cardWidth, 0f)
        assertEquals(l.grid.viewportHeight + 44f, l.viewportHeight, 0f)
        assertTrue("a title and two rows fit: ${l.viewportHeight}", l.viewportHeight <= 486f)
        assertEquals(136f, layout(4, 2, grid(4), grid(4)).grid.cardWidth, 0f)
        // 3 × 1 is set by the width: the same cards, the viewport one title taller.
        val wide = layout(3, 1, grid(2), row(6, title = true))
        assertEquals(170f, wide.grid.cardWidth, 0f)
        assertEquals(255f + 28f + 44f, wide.viewportHeight, 0.001f)
    }

    @Test
    fun aTitledFirstSectionHasItsTitleAtTheTop() {
        val l = layout(4, 2, grid(6, title = true))
        val s = l.sections.single()
        assertEquals(0f, s.top)
        assertNull(s.divider)
        assertEquals(58f, l.lines[0].cardTop)
        assertEquals(0f, l.lines[0].top)
        assertEquals(58f + l.grid.rowPitch, l.lines[1].cardTop, 0.001f)
        assertEquals(l.lines[1].cardTop - 14f, l.lines[1].top, 0.001f)
        // The title item starts at the top padding, its text 14 above it, and the gap under it reaches the cards.
        val title = l.slots[0] as Title
        assertEquals(Title(0, 14f, 24f, -14f), title)
        assertEquals(58f, title.top + title.height + l.grid.gap)
        assertEquals(0f, l.scrollFor(0, current = 120f))
    }

    @Test
    fun aBoundaryTakesExactlyOneRowStep() {
        // 4 × 2: an untitled row, then a titled grid, then an untitled grid.
        val l = layout(4, 2, grid(4), grid(5, title = true), grid(3))
        val pitch = l.grid.rowPitch
        val (a, b, c) = l.sections
        // The titled section starts where a second row of the first would: its title there, its cards a title and
        // the padding below it.
        assertEquals(14f + pitch, b.top, 0.001f)
        assertEquals(14f + pitch + 44f + 14f, l.lines[b.firstLine].cardTop, 0.001f)
        // The untitled section's cards are exactly a row step under the titled one's last row.
        val bLast = l.lines[b.lastLine]
        assertEquals(bLast.cardTop + pitch, l.lines[c.firstLine].cardTop, 0.001f)
        assertEquals(l.lines[c.firstLine].cardTop - 14f, c.top, 0.001f)
        assertEquals(0f, a.top)
        // Content ends one padding under the last cards.
        assertEquals(l.lines.last().cardTop + l.grid.cardHeight + 14f, l.contentHeight, 0.001f)
        assertEquals(listOf(0, 1, 3), l.sections.map { it.firstLine })
        assertEquals(listOf(0, 2, 3), l.sections.map { it.lastLine })
    }

    @Test
    fun theLineLiesInTheMiddleOfTheGap() {
        // 4 × 2 with a title: 196.5 dp cards; the gap is 20 dp under them, the line's centre rounded halves up.
        val titled = layout(4, 2, grid(4), grid(4, title = true))
        assertEquals(kotlin.math.floor(14f + 196.5f + 10f + 0.5f), titled.sections[1].divider!!, 0f)
        assertEquals(221f, titled.sections[1].divider!!, 0f)
        // Without one: 204 dp cards.
        assertEquals(228f, layout(4, 2, grid(4), grid(4)).sections[1].divider!!, 0f)
        // An untitled section after a titled one gets its line too, and a row section's line is under all its cards.
        val row = layout(4, 2, row(9, title = true), grid(2))
        assertEquals(265f, row.sections[1].divider!!, 0f)
    }

    @Test
    fun theItemsReproduceTheLayout() {
        // App cards: a row of them only (lower than posters), a grid with one.
        val l = layout(4, 2, grid(6, title = true), grid(3), row(8, title = true), row(2).apps(), grid(5).apps(1))
        // One item a line or title; the next starts one gap under it.
        for (i in 1 until l.slots.size) {
            val above = l.slots[i - 1]
            val height = if (above is Title) above.height else l.sections[above.section].cardHeight
            assertEquals("item $i", above.top + height + l.grid.gap, l.slots[i].top, 0.001f)
        }
        assertEquals(14f, l.slots.first().top)
        assertEquals(l.contentHeight, l.slots.last().top + l.grid.cardHeight + l.grid.padding, 0.001f)
        // The cards sit where the layout puts them, each line in its own item.
        val cards = l.slots.withIndex().filter { it.value is Cards }
        assertEquals(l.lines.indices.toList(), cards.map { (it.value as Cards).line })
        cards.forEach { (i, slot) ->
            val line = l.lines[(slot as Cards).line]
            assertEquals(i, line.slot)
            assertEquals(line.cardTop, slot.top, 0f)
            assertEquals(line.section, slot.section)
        }
        assertEquals(listOf(0, 3, 4, 6, 7), l.sections.map { it.firstSlot })
        val title = l.slots[4] as Title
        assertEquals(2, title.section)
        assertEquals(l.sections[2].top, title.top, 0f)
        assertEquals(38f, title.height, 0.001f)
        assertEquals(0f, title.textOffset, 0.001f)
        // The lines between sections run across a row with one card open.
        assertEquals(l.grid.rowWidth, l.contentWidth, 0f)
    }

    @Test
    fun aRowSectionSlidesOnlyAtTheEdgeOfWhatIsInView() {
        // 4 columns, 9 cards: 0–3 in view.
        val l = layout(4, 2, row(9))
        assertEquals(0, l.rowFirst(0, first = 0, focus = 3))
        assertEquals(1, l.rowFirst(0, first = 0, focus = 4))
        assertEquals(5, l.rowFirst(0, first = 5, focus = 8))
        // Back the same way: only once the focus passes the first card in view.
        assertEquals(5, l.rowFirst(0, first = 5, focus = 5))
        assertEquals(4, l.rowFirst(0, first = 5, focus = 4))
        // Never beyond the last screenful, never before the start.
        assertEquals(5, l.rowFirst(0, first = 7, focus = 8))
        assertEquals(0, layout(4, 2, row(3)).rowFirst(0, first = 3, focus = 1))
        // After the last card: room for it to open.
        assertEquals(l.grid.openWidth - l.grid.cardWidth, l.rowEnd(0), 0f)
    }

    @Test
    fun appCardsAreTilesTwoColumnsWideAmongAppsOnlyAndOpenCardSizedAmongShows() {
        // 4 × 2 without a title: 136 × 204 dp posters, 362 dp open; tiles 292 × 164.25 among apps only.
        val l = layout(4, 2, grid(5).apps(), row(4).apps(1), grid(3))
        val (apps, mixed, posters) = l.sections
        assertEquals(listOf(true, false, false), listOf(apps.appsOnly, mixed.appsOnly, posters.appsOnly))
        assertEquals(292f to 362f, apps.tileWidth to mixed.tileWidth)
        assertEquals(listOf(164.25f, 204f, 204f), l.sections.map { it.cardHeight })
        assertEquals(listOf(292f, 136f, 362f, 136f), listOf(l.cardWidth(0, 4), l.cardWidth(1, 0), l.cardWidth(1, 1), l.cardWidth(2, 2)))
        // Two tiles a grid row; its rows a tile's height apart.
        assertEquals(listOf(0 to 2, 2 to 2, 4 to 1), l.lines.take(3).map { it.first to it.count })
        assertEquals(listOf(14f, 198.25f, 382.5f), l.lines.take(3).map { it.cardTop })
        assertEquals(382.5f + 164.25f + 14f, l.lines[2].bottom, 0.001f)
        // The next section starts where a next row would, its cards as tall as posters.
        val next = l.lines[mixed.firstLine]
        assertEquals(382.5f + 164.25f + 20f, next.cardTop, 0.001f)
        assertEquals(next.cardTop - 14f, mixed.top, 0.001f)
        assertEquals(next.cardTop + 204f + 14f, next.bottom, 0.001f)
        assertEquals(l.lines.last().cardTop + 204f + 14f, l.contentHeight, 0.001f)
        // Down onto the lower lines and back, the line whole at the edge.
        assertEquals(next.bottom - l.viewportHeight, l.scrollFor(mixed.firstLine, current = 0f), 0.001f)
        assertEquals(l.lines[1].top, l.scrollFor(1, current = 300f), 0.001f)
        // The line between sections in the middle of the gap under the tiles.
        assertEquals(kotlin.math.floor(382.5f + 164.25f + 10f + 0.5f), mixed.divider!!, 0f)
    }

    @Test
    fun aGridRowTakesCardsWhileTheyFitWithOneOpen() {
        // A section of app cards only: half the columns, at least one.
        for (columns in 3..10) {
            val l = layout(columns, 2, grid(12).apps())
            assertEquals("$columns columns", maxOf(1, columns / 2), l.lines.first().count)
            assertTrue(l.lines.all { it.count <= maxOf(1, columns / 2) })
        }
        // Among shows, 4 columns: a poster and a tile (one more poster would not fit with one open), then three
        // posters; four posters a row as without app cards.
        val l = layout(4, 2, grid(9).apps(1))
        assertEquals(listOf(0 to 2, 2 to 4, 6 to 3), l.lines.map { it.first to it.count })
        assertEquals(listOf(0, 0, 1, 1, 1, 1, 2, 2, 2), (0 until 9).map { l.lineOf(0, it) })
        // ← → stop at a row's ends, which depend on the widths.
        assertEquals(1, l.horizontal(0, 0, 1))
        assertNull(l.horizontal(0, 1, 1))
        assertNull(l.horizontal(0, 2, -1))
        assertEquals(5, l.horizontal(0, 4, 1))
        // A tile alone when a card after it does not fit.
        assertEquals(listOf(0 to 1, 1 to 1, 2 to 2), layout(3, 2, grid(4).apps(0, 1)).lines.map { it.first to it.count })
    }

    @Test
    fun aScrollingLineSlidesByOneCardWhateverItsWidth() {
        // Tiles only, 4 columns: two in view, the third in the margin.
        val apps = layout(4, 2, row(5).apps())
        assertEquals(0, apps.rowFirst(0, first = 0, focus = 1))
        assertEquals(1, apps.rowFirst(0, first = 0, focus = 2))
        assertEquals(3, apps.rowFirst(0, first = 2, focus = 4))
        assertEquals(2, apps.rowFirst(0, first = 3, focus = 2))
        assertEquals(3, apps.rowFirst(0, first = 4, focus = 4))
        // The last two tiles fill the columns.
        assertEquals(830f - 312f - 292f, apps.rowEnd(0), 0f)
        // Posters and tiles: a poster, then as far as shows the focused poster open.
        val mixed = layout(4, 2, row(6).apps(1, 4))
        assertEquals(0, mixed.rowFirst(0, first = 0, focus = 1))
        assertEquals(1, mixed.rowFirst(0, first = 0, focus = 2))
        assertEquals(2, mixed.rowFirst(0, first = 1, focus = 3))
        assertEquals(2, mixed.rowFirst(0, first = 2, focus = 4))
        assertEquals(4, mixed.rowFirst(0, first = 2, focus = 5))
        // A tile and the last poster open.
        assertEquals(830f - 382f - 136f, mixed.rowEnd(0), 0f)
    }

    @Test
    fun upAndDownGoToTheCardWithTheNearestLeftEdge() {
        // A row of tiles over a grid of posters (156 dp apart): tiles' left edges at 0 and 312 dp.
        val l = layout(4, 2, row(5).apps(), grid(8))
        var first = 0
        val rowFirst: (Int) -> Int = { if (it == 0) first else 0 }
        assertEquals(1 to 2, l.vertical(0, 1, 1, rowFirst))
        assertEquals(1 to 0, l.vertical(0, 0, 1, rowFirst))
        assertEquals(0 to 1, l.vertical(1, 3, -1, rowFirst))
        assertEquals(0 to 1, l.vertical(1, 2, -1, rowFirst))
        // Halfway: the first one.
        assertEquals(0 to 0, l.vertical(1, 1, -1, rowFirst))
        // Only the tiles in view: 3 and 4.
        first = 3
        assertEquals(0 to 4, l.vertical(1, 3, -1, rowFirst))
        assertEquals(1 to 2, l.vertical(0, 4, 1, rowFirst))
        // In a grid of tiles and posters: by the left edges of that row.
        val grid = layout(4, 2, grid(4), grid(4).apps(1))
        assertEquals(1 to 1, grid.vertical(0, 1, 1) { 0 })
        assertEquals(1 to 1, grid.vertical(0, 2, 1) { 0 })
        assertEquals(1 to 1, grid.vertical(0, 3, 1) { 0 })
        assertEquals(1 to 3, grid.vertical(1, 1, 1) { 0 })
        assertEquals(0 to 1, grid.vertical(1, 1, -1) { 0 })
    }

    @Test
    fun scrollingShowsTheFocusedLineWholeWithItsSectionTitle() {
        val l = layout(4, 2, grid(8), grid(4, title = true), grid(16))
        val vp = l.viewportHeight
        val titled = l.sections[1]
        // Down onto the titled section's row: the title comes in with it, at the bottom edge.
        val line = l.lines[titled.firstLine]
        assertEquals(line.cardTop + l.grid.cardHeight + 14f - vp, l.scrollFor(titled.firstLine, current = 0f), 0.001f)
        // Up onto it from below: its title at the top edge.
        assertEquals(titled.top, l.scrollFor(titled.firstLine, current = titled.top + 50f), 0.001f)
        // The untitled section's first row after it: its padding at the top (no title).
        val untitled = l.sections[2]
        assertEquals(l.lines[untitled.firstLine].cardTop - 14f, l.scrollFor(untitled.firstLine, current = l.maxScroll), 0.001f)
        // The last row: the end of Home at the bottom edge.
        assertEquals(l.maxScroll, l.scrollFor(l.lines.lastIndex, current = 0f), 0.001f)
        assertEquals(l.contentHeight - vp, l.maxScroll, 0.001f)
        // Home's first line: the top.
        assertEquals(0f, l.scrollFor(0, current = l.maxScroll))
        // The scroll bar.
        assertEquals(vp / l.contentHeight, l.thumbFraction, 0.0001f)
        assertEquals(l.maxScroll / l.contentHeight, l.thumbOffset(l.maxScroll + 40f), 0.0001f)
        assertEquals(1f, layout(4, 2, grid(3)).thumbFraction)
    }

    @Test
    fun leftAndRightStopAtTheEndsOfALine() {
        val l = layout(4, 2, grid(6), row(6, title = true))
        assertNull(l.horizontal(0, 0, -1))
        assertEquals(1, l.horizontal(0, 0, 1))
        assertNull("the end of the first row", l.horizontal(0, 3, 1))
        assertNull("the start of the second", l.horizontal(0, 4, -1))
        assertNull("the last card", l.horizontal(0, 5, 1))
        // A row section is one line.
        assertEquals(4, l.horizontal(1, 3, 1))
        assertEquals(5, l.horizontal(1, 4, 1))
        assertNull(l.horizontal(1, 5, 1))
        assertNull(l.horizontal(1, 0, -1))
    }

    @Test
    fun upAndDownGoToTheNearestCardLineByLineAcrossSections() {
        val l = layout(4, 2, grid(6), row(9, title = true), grid(2))
        var first = 0
        val rowFirst: (Int) -> Int = { if (it == 1) first else 0 }
        // Within a grid: the card under, or the nearest on a shorter row.
        assertEquals(0 to 5, l.vertical(0, 1, 1, rowFirst))
        assertEquals(0 to 5, l.vertical(0, 3, 1, rowFirst))
        // Into the row section, among the cards in view.
        assertEquals(1 to 1, l.vertical(0, 5, 1, rowFirst))
        first = 5
        assertEquals(1 to 6, l.vertical(0, 5, 1, rowFirst))
        assertEquals(1 to 5, l.vertical(0, 4, 1, rowFirst))
        // Out of it by where the card is on the screen, not by its index.
        assertEquals(2 to 1, l.vertical(1, 8, 1, rowFirst))
        assertEquals(2 to 0, l.vertical(1, 5, 1, rowFirst))
        assertEquals(0 to 4, l.vertical(1, 5, -1, rowFirst))
        assertEquals(0 to 5, l.vertical(1, 7, -1, rowFirst))
        // Home's ends.
        assertNull(l.vertical(0, 2, -1, rowFirst))
        assertNull(l.vertical(2, 1, 1, rowFirst))
        assertEquals(listOf(0, 1, 2, 3), listOf(l.lineOf(0, 3), l.lineOf(0, 4), l.lineOf(1, 8), l.lineOf(2, 1)))
        assertNull(l.vertical(0, 0, 0) { 0 })
    }

    @Test
    fun appCardsAreCardsLikeAnyOther() {
        val home = listOf("a", "b").map { HomeEntry(ItemCard(it, "movie", it), ContinueInfo("$it.film")) }
        val sections = HomeSections.of(
            home,
            listOf(
                HomeSectionInfo("Apps1234", "Apps", "row", emptyList(), listOf(SectionEntry(appId = "w"), SectionEntry(appId = "m"))),
                HomeSectionInfo("untitled", null, "grid", listOf("a", "b"), listOf(SectionEntry(itemId = "a"), SectionEntry(appId = "x"), SectionEntry(itemId = "b"))),
            ),
        ) { HomeTile.App(it, it) }
        val shapes = sections.map { s -> SectionShape(s.title != null, s.row, s.tiles.size, s.tiles.indices.filter { s.tiles[it] is HomeTile.App }.toSet()) }
        val l = layout(4, 2, *shapes.toTypedArray())
        assertEquals(listOf(2, 3), l.sections.map { it.count })
        assertEquals(listOf(setOf(0, 1), setOf(1)), l.sections.map { it.apps })
        fun key(at: Pair<Int, Int>?) = at?.let { (s, i) -> sections[s].tiles[i].key }
        // ↓ from the row's second app card: the card under it in the grid, an app card too.
        assertEquals("app:x", key(l.vertical(0, 1, 1) { 0 }))
        assertEquals("app:w", key(l.vertical(1, 0, -1) { 0 }))
        // ← → along the grid row, through the app card; the next show is on the next row.
        assertEquals("app:x", key(1 to l.horizontal(1, 0, 1)!!))
        assertNull(l.horizontal(1, 1, 1))
        assertEquals("b", key(l.vertical(1, 1, 1) { 0 }))
    }
}
