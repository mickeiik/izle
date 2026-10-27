package io.github.mickeiik.izle.companion.home

import io.github.mickeiik.izle.data.api.HomeSection
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The Home tab's rows and the drag and drop mapping: a row under the dragged show → a section and a position. */
class HomeLayoutTest {
    private val home = listOf(
        HomeSection(UNTITLED_SECTION, null, "grid", listOf("a1", "a2", "a3")),
        HomeSection("films", "Films", "row", listOf("b1", "b2")),
        HomeSection("kids", "Kids", "grid", emptyList()),
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
    fun movesAsTheServerDoes() {
        assertEquals(listOf("a2", "a1", "a3"), moveItem(home, "a1", HomePlace(UNTITLED_SECTION, 1))[0].itemIds)
        assertEquals(listOf("a2", "a3", "a1"), moveItem(home, "a1", HomePlace(UNTITLED_SECTION, 99))[0].itemIds)
        val across = moveItem(home, "a3", HomePlace("films", 0))
        assertEquals(listOf("a1", "a2"), across[0].itemIds)
        assertEquals(listOf("a3", "b1", "b2"), across[1].itemIds)
        assertEquals(home, moveItem(home, "nope", HomePlace("films", 0)))
        assertEquals(home, moveItem(home, "a1", HomePlace("nope", 0)))
        assertEquals(HomePlace("films", 1), placeOf(home, "b2"))
        assertNull(placeOf(home, "nope"))
    }

    @Test
    fun overAnotherShowTakesItsPlace() {
        assertEquals(HomePlace(UNTITLED_SECTION, 1), dragTarget(home, "a1", "i:a2")) // down: below a2
        assertEquals(HomePlace(UNTITLED_SECTION, 1), dragTarget(home, "a3", "i:a2")) // up: above a2
        assertEquals(HomePlace("films", 0), dragTarget(home, "a1", "i:b1"))
        assertNull(dragTarget(home, "a1", "i:a1"))
        assertNull(dragTarget(home, "a1", "i:unknown"))
    }

    @Test
    fun overAHeaderEntersOrLeavesItsSection() {
        // From above: the first place of that section.
        assertEquals(HomePlace("films", 0), dragTarget(home, "a3", "s:films"))
        assertEquals(HomePlace("kids", 0), dragTarget(home, "b2", "s:kids"))
        // From below: the end of the section above.
        assertEquals(HomePlace(UNTITLED_SECTION, 3), dragTarget(home, "b1", "s:films"))
        // Nothing is above the first section.
        assertNull(dragTarget(home, "a1", "s:untitled"))
        // An empty section: its first place.
        assertEquals(HomePlace("kids", 0), dragTarget(home, "a1", "e:kids"))
    }

    @Test
    fun aDragDownTheWholeListAndBackLandsWhereItStarted() {
        var sections = home
        fun over(key: String) {
            dragTarget(sections, "a1", key)?.let { sections = moveItem(sections, "a1", it) }
        }
        listOf("i:a2", "i:a3", "s:films", "i:b1", "i:b2", "s:kids").forEach(::over)
        assertEquals(HomePlace("kids", 0), placeOf(sections, "a1"))
        assertEquals(listOf("b1", "b2"), sections[1].itemIds)
        // Back up, row by row, as the list now draws it.
        listOf("s:kids", "i:b2", "i:b1", "s:films", "i:a3", "i:a2").forEach(::over)
        assertEquals(home, sections)
    }
}
