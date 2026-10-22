package io.github.mickeiik.izle.domain

import io.github.mickeiik.izle.data.api.HomeEntry
import io.github.mickeiik.izle.data.api.HomeSectionInfo

/**
 * A section as Home draws it: its [title] (null: the untitled section, drawn without one), whether it is one line
 * that scrolls sideways ([row]) or a grid, and its [entries] in order. Never empty.
 */
data class HomeSection(val id: String, val title: String?, val row: Boolean, val entries: List<HomeEntry>)

/** How Home cuts `home` into the sections it draws (docs/ux/senior-tv.md, "Sections"). */
object HomeSections {
    const val UNTITLED_ID = "untitled"

    /**
     * The sections to draw, in order, from the state's flat [home] (Home order) and its [sections]. Ids that are not
     * in [home] (or already in an earlier section) are left out, and so are the sections left empty; an entry of
     * [home] that no section holds goes to the end of the untitled section (one is added at the end if there is
     * none), so every entry is drawn once. Without a titled section the result is the untitled section with all of
     * [home] in its order, in its own layout: as a grid (or without sections at all) it is Home without sections
     * exactly, as a row one line without a title. An unknown layout is a grid.
     */
    fun of(home: List<HomeEntry>, sections: List<HomeSectionInfo>): List<HomeSection> {
        if (home.isEmpty()) return emptyList()
        val byId = home.associateBy { it.item.id }
        val placed = HashSet<String>()
        val drawn = sections.map { s ->
            HomeSection(
                id = s.id,
                title = s.title?.trim()?.takeIf { it.isNotEmpty() },
                row = s.layout == HomeSectionInfo.LAYOUT_ROW,
                entries = s.itemIds.mapNotNull { id -> byId[id]?.takeIf { placed.add(id) } },
            )
        }.filter { it.entries.isNotEmpty() }.toMutableList()
        if (drawn.none { it.title != null }) {
            val untitled = drawn.firstOrNull()
            return listOf(HomeSection(untitled?.id ?: UNTITLED_ID, null, row = untitled?.row == true, entries = home))
        }

        val rest = home.filter { it.item.id !in placed }
        if (rest.isNotEmpty()) {
            val at = drawn.indexOfFirst { it.title == null }
            if (at >= 0) drawn[at] = drawn[at].copy(entries = drawn[at].entries + rest)
            else drawn += HomeSection(UNTITLED_ID, null, row = false, entries = rest)
        }
        return drawn
    }
}
