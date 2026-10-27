package io.github.mickeiik.izle.domain

import io.github.mickeiik.izle.data.api.ContinueInfo
import io.github.mickeiik.izle.data.api.HomeEntry
import io.github.mickeiik.izle.data.api.HomeSectionInfo
import io.github.mickeiik.izle.data.api.ItemCard
import io.github.mickeiik.izle.data.api.SectionEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HomeSectionsTest {
    private fun show(id: String) = HomeEntry(ItemCard(id, "series", id), ContinueInfo("$id.e1"))

    private val home = listOf("a", "b", "c", "d", "e").map(::show)

    private fun section(id: String, title: String?, vararg ids: String, layout: String = "grid") = HomeSectionInfo(id, title, layout, ids.toList())

    /** A section's `entries`: `[w]` is the app card of `w`, anything else a show. */
    private fun entries(vararg cards: String) =
        cards.map { if (it.startsWith("[")) SectionEntry(appId = it.trim('[', ']')) else SectionEntry(itemId = it) }

    private fun withEntries(id: String, title: String?, vararg cards: String, layout: String = "grid") =
        HomeSectionInfo(id, title, layout, cards.filter { !it.startsWith("[") }, entries(*cards))

    /** The apps this TV can open: `w` and `m`. */
    private val installed = mapOf("w" to "Weather", "m" to "Music")

    private fun of(home: List<HomeEntry>, sections: List<HomeSectionInfo>) =
        HomeSections.of(home, sections) { id -> installed[id]?.let { HomeTile.App(id, it) } }

    /** A show is its id, an app card `[appId]`. */
    private fun List<HomeSection>.shape() = map { s ->
        (s.title ?: "-") + (if (s.row) "~" else "") + ":" + s.tiles.joinToString("") { t ->
            when (t) {
                is HomeTile.Show -> t.entry.item.id
                is HomeTile.App -> "[" + t.appId + "]"
            }
        }
    }

    @Test
    fun noSectionsIsOneUntitledGridWithAllOfHome() {
        val drawn = of(home, emptyList())
        assertEquals(listOf("-:abcde"), drawn.shape())
        assertEquals(HomeSections.UNTITLED_ID, drawn.single().id)
        assertTrue(of(emptyList(), listOf(section("Hq7cP2xd", "Films", "a"))).isEmpty())
        // A blank title is no title.
        assertEquals(listOf("-:abcde"), of(home, listOf(section("Films123", "  ", "a", "b", "c", "d", "e"))).shape())
    }

    @Test
    fun onlyTheUntitledSectionKeepsItsLayout() {
        // A grid: Home without sections.
        assertEquals(listOf("-:abcde"), of(home, listOf(section("untitled", null, "a", "b", "c", "d", "e"))).shape())
        // A row: one line without a title.
        assertEquals(listOf("-~:abcde"), of(home, listOf(section("untitled", null, "a", "b", "c", "d", "e", layout = "row"))).shape())
        // Even with titled sections that hold nothing on Home; every entry of Home is in it.
        assertEquals(
            listOf("-~:abcde"),
            of(home, listOf(section("untitled", null, "a", "b", layout = "row"), section("Empty123", "Empty", "gone"))).shape(),
        )
    }

    @Test
    fun sectionsInTheirOrderWithTheirLayouts() {
        val sections = listOf(
            section("Hq7cP2xd", "Channels", "d", "e", layout = "row"),
            section("untitled", null, "a"),
            section("Zt3kQ9wm", "Films", "b", "c", layout = "carousel"),
        )
        val drawn = of(listOf("d", "e", "a", "b", "c").map(::show), sections)
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
        assertEquals(listOf("-:a", "Films:bcde"), of(home, sections).shape())
    }

    @Test
    fun entriesNoSectionHoldsGoToTheUntitledSection() {
        assertEquals(
            listOf("Films:b", "-:ade", "Kids:c"),
            of(home, listOf(section("Films123", "Films", "b"), section("untitled", null, "a"), section("Kids1234", "Kids", "c"))).shape(),
        )
        // None: one is added at the end.
        assertEquals(listOf("Films:bc", "-:ade"), of(home, listOf(section("Films123", "Films", "b", "c"))).shape())
    }

    @Test
    fun aSectionsEntriesPlaceAppCardsAmongItsShows() {
        val sections = listOf(withEntries("untitled", null, "a", "[w]", "b"), withEntries("Kids1234", "Kids", "[m]", "c", "d", "e", layout = "row"))
        val drawn = of(home, sections)
        assertEquals(listOf("-:a[w]b", "Kids~:[m]cde"), drawn.shape())
        val tile = drawn[0].tiles[1] as HomeTile.App
        // The name this TV gives the app, not the server's.
        assertEquals("Weather", tile.label)
        assertEquals("app:w", tile.key)
        assertTrue(HomeTile.isAppKey(tile.key))
        assertFalse(HomeTile.isAppKey(drawn[0].tiles[0].key))
        // Without a titled section, the untitled one keeps its app cards at their place.
        assertEquals(listOf("-:a[w]bcde"), of(home, listOf(withEntries("untitled", null, "a", "[w]", "b", "c", "d", "e"))).shape())
    }

    @Test
    fun withoutEntriesASectionIsItsItemIds() {
        // A server from before app cards: no entries.
        assertEquals(listOf("Films:b", "-:acde"), of(home, listOf(section("Films123", "Films", "b"), section("untitled", null, "a", "c", "d", "e"))).shape())
        // Entries, when given, are the section's cards.
        val both = HomeSectionInfo("Films123", "Films", "grid", listOf("b", "c"), entries("c", "[w]", "b"))
        assertEquals(listOf("Films:c[w]b", "-:ade"), of(home, listOf(both)).shape())
    }

    @Test
    fun unknownEntriesAndAppsThisTvCannotOpenAreLeftOut() {
        val sections = listOf(
            HomeSectionInfo("Films123", "Films", "grid", listOf("a"), listOf(SectionEntry(), SectionEntry(itemId = "a"), SectionEntry(appId = "gone"))),
            // An app card twice: drawn once.
            withEntries("untitled", null, "[w]", "b", "[w]", "gone", "c", "d", "e"),
        )
        assertEquals(listOf("Films:a", "-:[w]bcde"), of(home, sections).shape())
    }

    @Test
    fun aSectionOfAppCardsAloneIsDrawnAndOneLeftEmptyIsNot() {
        val sections = listOf(
            withEntries("Apps1234", "Apps", "[w]", "[m]", layout = "row"),
            withEntries("Gone1234", "Gone", "[gone]"),
            withEntries("untitled", null, "a", "b", "c", "d", "e"),
        )
        assertEquals(listOf("Apps~:[w][m]", "-:abcde"), of(home, sections).shape())
        // A Home of app cards only, without a show.
        assertEquals(listOf("-:[w][m]"), of(emptyList(), listOf(withEntries("untitled", null, "[w]", "[m]"))).shape())
        assertEquals(listOf("Apps:[w]"), of(emptyList(), listOf(withEntries("Apps1234", "Apps", "[w]"), withEntries("untitled", null))).shape())
        // Nothing this TV can open: "Nothing here yet".
        assertTrue(of(emptyList(), listOf(withEntries("untitled", null, "[gone]"))).isEmpty())
    }
}
