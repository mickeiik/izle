package io.github.mickeiik.izle.domain

import io.github.mickeiik.izle.data.api.ContinueInfo
import io.github.mickeiik.izle.data.api.HomeEntry
import io.github.mickeiik.izle.data.api.HomeSectionInfo
import io.github.mickeiik.izle.data.api.ItemCard
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HomeSectionsTest {
    private fun show(id: String) = HomeEntry(ItemCard(id, "series", id), ContinueInfo("$id.e1"))

    private val home = listOf("a", "b", "c", "d", "e").map(::show)

    private fun section(id: String, title: String?, vararg ids: String, layout: String = "grid") = HomeSectionInfo(id, title, layout, ids.toList())

    private fun List<HomeSection>.shape() = map { s -> "${s.title ?: "-"}${if (s.row) "~" else ""}:" + s.entries.joinToString("") { it.item.id } }

    @Test
    fun noSectionsIsOneUntitledGridWithAllOfHome() {
        val drawn = HomeSections.of(home, emptyList())
        assertEquals(listOf("-:abcde"), drawn.shape())
        assertEquals(HomeSections.UNTITLED_ID, drawn.single().id)
        assertTrue(HomeSections.of(emptyList(), listOf(section("Hq7cP2xd", "Films", "a"))).isEmpty())
    }

    @Test
    fun onlyTheUntitledSectionKeepsItsLayout() {
        // A grid: Home without sections.
        assertEquals(listOf("-:abcde"), HomeSections.of(home, listOf(section("untitled", null, "a", "b", "c", "d", "e"))).shape())
        // A row: one line without a title.
        assertEquals(listOf("-~:abcde"), HomeSections.of(home, listOf(section("untitled", null, "a", "b", "c", "d", "e", layout = "row"))).shape())
        // Even with titled sections that hold nothing on Home; every entry of Home is in it.
        assertEquals(
            listOf("-~:abcde"),
            HomeSections.of(home, listOf(section("untitled", null, "a", "b", layout = "row"), section("Empty123", "Empty", "gone"))).shape(),
        )
    }

    @Test
    fun sectionsInTheirOrderWithTheirLayouts() {
        val sections = listOf(
            section("Hq7cP2xd", "Channels", "d", "e", layout = "row"),
            section("untitled", null, "a"),
            section("Zt3kQ9wm", "Films", "b", "c", layout = "carousel"),
        )
        val drawn = HomeSections.of(listOf("d", "e", "a", "b", "c").map(::show), sections)
        // An unknown layout is a grid.
        assertEquals(listOf("Channels~:de", "-:a", "Films:bc"), drawn.shape())
        assertEquals(listOf("Hq7cP2xd", "untitled", "Zt3kQ9wm"), drawn.map { it.id })
        assertFalse(drawn[2].row)
    }

    @Test
    fun idsNotOnHomeAndEmptySectionsAreLeftOut() {
        val sections = listOf(
            section("untitled", null, "a", "gone"),
            section("Empty123", "Empty", "gone"),
            section("Films123", "Films", "b", "a", "c", "d", "e"),
        )
        // "a" stays in the first section that names it; "Empty" holds nothing on Home.
        assertEquals(listOf("-:a", "Films:bcde"), HomeSections.of(home, sections).shape())
    }

    @Test
    fun entriesNoSectionHoldsGoToTheUntitledSection() {
        assertEquals(
            listOf("Films:b", "-:ade", "Kids:c"),
            HomeSections.of(home, listOf(section("Films123", "Films", "b"), section("untitled", null, "a"), section("Kids1234", "Kids", "c"))).shape(),
        )
        // None: one is added at the end.
        assertEquals(listOf("Films:bc", "-:ade"), HomeSections.of(home, listOf(section("Films123", "Films", "b", "c"))).shape())
    }

    @Test
    fun aBlankTitleIsNoTitle() {
        assertEquals(listOf("-:abcde"), HomeSections.of(home, listOf(section("Films123", "  ", "a", "b", "c", "d", "e"))).shape())
    }
}
