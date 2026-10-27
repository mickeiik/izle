package io.github.mickeiik.izle.companion.home

import io.github.mickeiik.izle.data.api.AdminHomeEntry
import io.github.mickeiik.izle.data.api.HomeSection

// The Home tab's list, flattened: a header row per section, then its shows (or one "Empty" row). Pure, so that the
// drag and drop mapping (a row under the finger → a section and a position) is unit-tested without Compose.

/** The id of the section without a title (docs/spec/server-api-v1.md, "Home sections"). */
const val UNTITLED_SECTION = "untitled"

/** One row of the Home tab's list; [key] is stable across moves (the LazyColumn's key). */
sealed interface HomeRow {
    val key: String

    /** A section's header: [index] among the sections, [count] of its shows. */
    data class Header(val section: HomeSection, val index: Int, val sectionCount: Int) : HomeRow {
        override val key: String get() = headerKey(section.id)
        val count: Int get() = section.itemIds.size
    }

    /** A show: [index] within its section of [sectionSize]; [entry] null when the list has no entry for it (yet). */
    data class Show(val itemId: String, val section: HomeSection, val index: Int, val sectionSize: Int, val entry: AdminHomeEntry?) : HomeRow {
        override val key: String get() = showKey(itemId)
    }

    /** A section without shows: "Empty: not shown on the TV". */
    data class Empty(val section: HomeSection) : HomeRow {
        override val key: String get() = emptyKey(section.id)
    }
}

fun headerKey(sectionId: String): String = "s:$sectionId"
fun showKey(itemId: String): String = "i:$itemId"
fun emptyKey(sectionId: String): String = "e:$sectionId"

/** The rows for [sections] in Home order. */
fun homeRows(sections: List<HomeSection>, entries: Map<String, AdminHomeEntry>): List<HomeRow> = buildList {
    sections.forEachIndexed { i, section ->
        add(HomeRow.Header(section, i, sections.size))
        if (section.itemIds.isEmpty()) add(HomeRow.Empty(section))
        section.itemIds.forEachIndexed { j, id -> add(HomeRow.Show(id, section, j, section.itemIds.size, entries[id])) }
    }
}

/** Where a show is: its section's id and its index there; null when it is not on Home. */
data class HomePlace(val sectionId: String, val position: Int)

fun placeOf(sections: List<HomeSection>, itemId: String): HomePlace? {
    for (s in sections) {
        val i = s.itemIds.indexOf(itemId)
        if (i >= 0) return HomePlace(s.id, i)
    }
    return null
}

/**
 * [sections] after moving [itemId] to [to], as the server does it (`PATCH …/home/items/:itemId`): taken out of its
 * section, then put at `position` in the target (clamped to its end). Unchanged when the item or section is unknown.
 */
fun moveItem(sections: List<HomeSection>, itemId: String, to: HomePlace): List<HomeSection> {
    if (placeOf(sections, itemId) == null || sections.none { it.id == to.sectionId }) return sections
    val removed = sections.map { s -> if (itemId in s.itemIds) s.copy(itemIds = s.itemIds - itemId) else s }
    return removed.map { s ->
        if (s.id != to.sectionId) s
        else s.copy(itemIds = s.itemIds.toMutableList().apply { add(to.position.coerceIn(0, size), itemId) })
    }
}

/**
 * Where the dragged show [draggedId] goes when its middle is over the row [hoveredKey] (a key of [homeRows]):
 * - another show: its place (above it when coming from below, below it when coming from above, as a list reorder);
 * - an empty section: its first place;
 * - a section's header, coming from above: the first place of that section; coming from below: the end of the section
 *   before it (none above the first section).
 * Null when the drag changes nothing.
 */
fun dragTarget(sections: List<HomeSection>, draggedId: String, hoveredKey: String): HomePlace? {
    val from = placeOf(sections, draggedId) ?: return null
    val rows = homeRows(sections, emptyMap())
    val draggedRow = rows.indexOfFirst { it.key == showKey(draggedId) }
    val hoveredRow = rows.indexOfFirst { it.key == hoveredKey }
    if (hoveredRow < 0 || hoveredRow == draggedRow) return null
    val target = when (val row = rows[hoveredRow]) {
        is HomeRow.Show -> HomePlace(row.section.id, row.index)
        is HomeRow.Empty -> HomePlace(row.section.id, 0)
        is HomeRow.Header ->
            if (hoveredRow > draggedRow) HomePlace(row.section.id, 0)
            else if (row.index == 0) return null
            else sections[row.index - 1].let { above -> HomePlace(above.id, above.itemIds.size) }
    }
    return target.takeIf { it != from }
}
