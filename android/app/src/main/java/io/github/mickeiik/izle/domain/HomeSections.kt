package io.github.mickeiik.izle.domain

import io.github.mickeiik.izle.data.api.HomeEntry
import io.github.mickeiik.izle.data.api.HomeSectionInfo

/** [title] null: the untitled section; [row]: one line that scrolls sideways, else a grid. Never empty. */
data class HomeSection(val id: String, val title: String?, val row: Boolean, val entries: List<HomeEntry>)

/** How Home cuts `home` into the sections it draws (docs/ux/senior-tv.md, "Sections"). */
object HomeSections {
    const val UNTITLED_ID = "untitled"

    /**
     * Every entry of [home] is drawn once: ids not in [home] or already placed are left out, empty sections too, and
     * entries no section holds go to the end of the untitled section (added last if there is none). Without a titled
     * section: the untitled section with all of [home] in its order, in its own layout.
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
