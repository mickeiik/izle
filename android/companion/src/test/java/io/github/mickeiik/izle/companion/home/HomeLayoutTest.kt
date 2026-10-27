package io.github.mickeiik.izle.companion.home

import io.github.mickeiik.izle.data.api.AdminApp
import io.github.mickeiik.izle.data.api.HomeSection
import io.github.mickeiik.izle.data.api.SectionEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The Home tab's rows and the drag and drop mapping: a row under the dragged card → a section and a position. */
class HomeLayoutTest {
    // As a server from before app cards sends it: itemIds only.
    private val home = listOf(
        HomeSection(UNTITLED_SECTION, null, "grid", listOf("a1", "a2", "a3")),
        HomeSection("films", "Films", "row", listOf("b1", "b2")),
        HomeSection("kids", "Kids", "grid", emptyList()),
    )

    // Shows and app cards mixed, as `entries` lists them.
    private val mixed = listOf(
        section(UNTITLED_SECTION, null, show("a1"), app("weather"), show("a2")),
        section("films", "Films", app("radio"), show("b1")),
        section("apps", "Apps", app("mail")),
    )

    @Test
    fun rowsAreHeadersThenShowsOrEmpty() {
        assertEquals(
            listOf("s:untitled", "i:a1", "i:a2", "i:a3", "s:films", "i:b1", "i:b2", "s:kids", "e:kids"),
            homeRows(home, emptyMap()).map { it.key },
        )
        val b2 = homeRows(home, emptyMap()).filterIsInstance<HomeRow.Show>().first { it.itemId == "b2" }
        assertEquals(1, b2.index)
        assertEquals(2, b2.sectionSize)
        assertEquals("films", b2.section.id)
    }

    @Test
    fun appCardsAreRowsAmongTheShows() {
        val weather = AdminApp("weather", "Weather", installed = true, onHome = true)
        val rows = homeRows(mixed, emptyMap(), mapOf("weather" to weather))
        assertEquals(
            listOf("s:untitled", "i:a1", "a:weather", "i:a2", "s:films", "a:radio", "i:b1", "s:apps", "a:mail"),
            rows.map { it.key },
        )
        val row = rows.filterIsInstance<HomeRow.App>().first()
        assertEquals(weather, row.app)
        assertEquals(1, row.index)
        assertEquals(3, row.sectionSize)
        assertNull("an app the server does not name", rows.filterIsInstance<HomeRow.App>().last().app)
        assertEquals(3, rows.filterIsInstance<HomeRow.Header>().first().count)
        assertEquals(listOf(show("a1"), app("weather"), show("a2")), mixed[0].cards)
        assertEquals(1, mixed[0].appCount)
        assertEquals(show("b1"), cardOfKey("i:b1"))
        assertEquals(app("radio"), cardOfKey("a:radio"))
        assertNull(cardOfKey("s:films"))
    }

    @Test
    fun cardsComeFromEntriesElseItemIdsAndALaterKindIsSkipped() {
        assertEquals(listOf(show("a1"), show("a2"), show("a3")), home[0].cards)
        val later = HomeSection("x", "X", "grid", listOf("a1"), listOf(show("a1"), SectionEntry(), app("weather")))
        assertEquals(listOf(show("a1"), app("weather")), later.cards)
        // Writing cards back keeps itemIds the section's shows.
        val written = home[0].withCards(listOf(app("weather"), show("a3")))
        assertEquals(listOf("a3"), written.itemIds)
        assertEquals(listOf(app("weather"), show("a3")), written.entries)
    }

    @Test
    fun movesAsTheServerDoes() {
        assertEquals(listOf("a2", "a1", "a3"), moveCard(home, show("a1"), HomePlace(UNTITLED_SECTION, 1))[0].itemIds)
        assertEquals(listOf("a2", "a3", "a1"), moveCard(home, show("a1"), HomePlace(UNTITLED_SECTION, 99))[0].itemIds)
        val across = moveCard(home, show("a3"), HomePlace("films", 0))
        assertEquals(listOf("a1", "a2"), across[0].itemIds)
        assertEquals(listOf("a3", "b1", "b2"), across[1].itemIds)
        assertEquals(home, moveCard(home, show("nope"), HomePlace("films", 0)))
        assertEquals(home, moveCard(home, show("a1"), HomePlace("nope", 0)))
        assertEquals(HomePlace("films", 1), placeOf(home, show("b2")))
        assertNull(placeOf(home, show("nope")))
    }

    @Test
    fun positionsCountEveryCardOfTheSection() {
        // A show's place counts the app cards before it, and an app card's the shows.
        assertEquals(HomePlace(UNTITLED_SECTION, 2), placeOf(mixed, show("a2")))
        assertEquals(HomePlace("films", 0), placeOf(mixed, app("radio")))
        assertNull("an app id is not an item id", placeOf(mixed, show("weather")))

        val first = moveCard(mixed, app("weather"), HomePlace(UNTITLED_SECTION, 0))
        assertEquals(listOf(app("weather"), show("a1"), show("a2")), first[0].cards)
        assertEquals("the shows keep their order", listOf("a1", "a2"), first[0].itemIds)

        val across = moveCard(mixed, show("a2"), HomePlace("films", 1))
        assertEquals(listOf(app("radio"), show("a2"), show("b1")), across[1].cards)
        assertEquals(listOf("a2", "b1"), across[1].itemIds)

        val emptied = removeCard(mixed, app("mail"))
        assertEquals(emptyList<SectionEntry>(), emptied[2].cards)
        assertEquals(HomeRow.Empty(emptied[2]), homeRows(emptied, emptyMap()).last())
    }

    @Test
    fun aDragOverMixedCardsLandsWhereTheServerCountsIt() {
        // The show a2 dragged up over the app card: the place the app card had, 1.
        assertEquals(HomePlace(UNTITLED_SECTION, 1), dragTarget(mixed, show("a2"), "a:weather"))
        // An app card dragged down into Films over its header: Films' first place, before its app card.
        assertEquals(HomePlace("films", 0), dragTarget(mixed, app("weather"), "s:films"))
        // An app card dragged up over the Apps header from below: the end of Films, after its 2 cards.
        assertEquals(HomePlace("films", 2), dragTarget(mixed, app("mail"), "s:apps"))
        assertEquals(HomePlace("films", 1), dragTarget(mixed, app("mail"), "i:b1"))
    }

    @Test
    fun theAppsChipListsTheAppsNotOnHomeByName() {
        val apps = listOf(
            AdminApp("com.example.weather", "Weather", onHome = true),
            AdminApp("com.example.mail", "Mail"),
            AdminApp("com.example.maps", "Maps"),
            AdminApp("com.example.radio", "Radio", installed = false, onHome = true),
            AdminApp("com.example.gone", "Mahjong", installed = false),
            AdminApp("com.example.nolabel"),
        )
        // In the TV's order, without the cards on Home and the apps the TV no longer has.
        assertEquals(listOf("Mail", "Maps", null), appChoices(apps, "").map { it.label })
        assertEquals(listOf("Mail", "Maps"), appChoices(apps, "  MA ").map { it.label })
        assertEquals(listOf("Maps"), appChoices(apps, "map").map { it.label })
        assertEquals(emptyList<AdminApp>(), appChoices(apps, "weather"))
        // Without a label, its id is its name.
        assertEquals(listOf("com.example.nolabel"), appChoices(apps, "nolabel").map { it.appId })
    }

    @Test
    fun overAnotherShowTakesItsPlace() {
        assertEquals(HomePlace(UNTITLED_SECTION, 1), dragTarget(home, show("a1"), "i:a2")) // down: below a2
        assertEquals(HomePlace(UNTITLED_SECTION, 1), dragTarget(home, show("a3"), "i:a2")) // up: above a2
        assertEquals(HomePlace("films", 0), dragTarget(home, show("a1"), "i:b1"))
        assertNull(dragTarget(home, show("a1"), "i:a1"))
        assertNull(dragTarget(home, show("a1"), "i:unknown"))
    }

    @Test
    fun overAHeaderEntersOrLeavesItsSection() {
        // From above: the first place of that section.
        assertEquals(HomePlace("films", 0), dragTarget(home, show("a3"), "s:films"))
        assertEquals(HomePlace("kids", 0), dragTarget(home, show("b2"), "s:kids"))
        // From below: the end of the section above.
        assertEquals(HomePlace(UNTITLED_SECTION, 3), dragTarget(home, show("b1"), "s:films"))
        // Nothing is above the first section.
        assertNull(dragTarget(home, show("a1"), "s:untitled"))
        // An empty section: its first place.
        assertEquals(HomePlace("kids", 0), dragTarget(home, show("a1"), "e:kids"))
    }

    @Test
    fun aDragDownTheWholeListAndBackLandsWhereItStarted() {
        var sections = home
        fun over(key: String) {
            dragTarget(sections, show("a1"), key)?.let { sections = moveCard(sections, show("a1"), it) }
        }
        listOf("i:a2", "i:a3", "s:films", "i:b1", "i:b2", "s:kids").forEach(::over)
        assertEquals(HomePlace("kids", 0), placeOf(sections, show("a1")))
        assertEquals(listOf("b1", "b2"), sections[1].itemIds)
        // Back up, row by row, as the list now draws it.
        listOf("s:kids", "i:b2", "i:b1", "s:films", "i:a3", "i:a2").forEach(::over)
        assertEquals(home.map { it.cards }, sections.map { it.cards })
    }

    private fun show(itemId: String) = SectionEntry(itemId = itemId)
    private fun app(appId: String) = SectionEntry(appId = appId)
    private fun section(id: String, title: String?, vararg cards: SectionEntry) =
        HomeSection(id, title).withCards(cards.toList())
}
