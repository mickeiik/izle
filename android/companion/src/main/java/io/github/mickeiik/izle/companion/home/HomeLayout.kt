package io.github.mickeiik.izle.companion.home

import io.github.mickeiik.izle.data.api.AdminApp
import io.github.mickeiik.izle.data.api.AdminHomeEntry
import io.github.mickeiik.izle.data.api.HomeSection
import io.github.mickeiik.izle.data.api.SectionEntry

// The Home tab's list, flattened: a header row per section, then its cards (shows and app cards) or one "Empty" row.
// Pure, so that the drag and drop mapping (a row under the finger → a section and a position) is unit-tested without
// Compose. A card is its section entry: `SectionEntry(itemId = …)` a show, `SectionEntry(appId = …)` an app card.

/** The id of the section without a title (docs/spec/server-api-v1.md, "Home sections"). */
const val UNTITLED_SECTION = "untitled"

/**
 * The section's cards in display order: its `entries`, or its `itemIds` from a server that sends none. An entry with
 * neither field (a later kind of card) is skipped.
 */
val HomeSection.cards: List<SectionEntry>
    get() = if (entries.isEmpty()) itemIds.map { SectionEntry(itemId = it) } else entries.filter { it.itemId != null || it.appId != null }

/** The section holding [cards] in that order: its `entries`, and its shows' ids as `itemIds`. */
fun HomeSection.withCards(cards: List<SectionEntry>): HomeSection = copy(itemIds = cards.mapNotNull { it.itemId }, entries = cards)

/** The app cards of the section. */
val HomeSection.appCount: Int get() = cards.count { it.itemId == null }

/** One row of the Home tab's list; [key] is stable across moves (the LazyColumn's key). */
sealed interface HomeRow {
    val key: String

    /** A section's header: [index] among the sections, [count] of its cards. */
    data class Header(val section: HomeSection, val index: Int, val sectionCount: Int) : HomeRow {
        override val key: String get() = headerKey(section.id)
        val count: Int get() = section.cards.size
    }

    /** A card: [index] within its section of [sectionSize] cards. */
    sealed interface Card : HomeRow {
        val card: SectionEntry
        val section: HomeSection
        val index: Int
        val sectionSize: Int
        override val key: String get() = cardKey(card)
    }

    /** A show; [entry] null when the list has no entry for it (yet). */
    data class Show(val itemId: String, override val section: HomeSection, override val index: Int, override val sectionSize: Int, val entry: AdminHomeEntry?) : Card {
        override val card: SectionEntry get() = SectionEntry(itemId = itemId)
    }

    /** An app card; [app] null when the server names no such app (yet). */
    data class App(val appId: String, override val section: HomeSection, override val index: Int, override val sectionSize: Int, val app: AdminApp?) : Card {
        override val card: SectionEntry get() = SectionEntry(appId = appId)
    }

    /** A section without cards: "Empty: not shown on the TV". */
    data class Empty(val section: HomeSection) : HomeRow {
        override val key: String get() = emptyKey(section.id)
    }
}

fun headerKey(sectionId: String): String = "s:$sectionId"
fun showKey(itemId: String): String = "i:$itemId"
fun appKey(appId: String): String = "a:$appId"
fun emptyKey(sectionId: String): String = "e:$sectionId"

fun cardKey(card: SectionEntry): String = card.itemId?.let(::showKey) ?: appKey(card.appId.orEmpty())

/** The card a row key names ([showKey] or [appKey]); null for a header or an empty section. */
fun cardOfKey(key: String): SectionEntry? = when {
    key.startsWith("i:") -> SectionEntry(itemId = key.removePrefix("i:"))
    key.startsWith("a:") -> SectionEntry(appId = key.removePrefix("a:"))
    else -> null
}

/** The rows for [sections] in Home order. */
fun homeRows(sections: List<HomeSection>, entries: Map<String, AdminHomeEntry>, apps: Map<String, AdminApp> = emptyMap()): List<HomeRow> = buildList {
    sections.forEachIndexed { i, section ->
        add(HomeRow.Header(section, i, sections.size))
        val cards = section.cards
        if (cards.isEmpty()) add(HomeRow.Empty(section))
        cards.forEachIndexed { j, card ->
            val itemId = card.itemId
            val appId = card.appId
            add(
                if (itemId != null) HomeRow.Show(itemId, section, j, cards.size, entries[itemId])
                else HomeRow.App(appId.orEmpty(), section, j, cards.size, apps[appId]),
            )
        }
    }
}

/** Where a card is: its section's id and its index among the section's cards; null when it is not on Home. */
data class HomePlace(val sectionId: String, val position: Int)

fun placeOf(sections: List<HomeSection>, card: SectionEntry): HomePlace? {
    for (s in sections) {
        val i = s.cards.indexOf(card)
        if (i >= 0) return HomePlace(s.id, i)
    }
    return null
}

/**
 * [sections] after moving [card] to [to], as the server does it (`PATCH …/home/items/:itemId` or `…/home/apps/:appId`):
 * taken out of its section, then put at `position` among the target's cards, app cards and shows alike (clamped to
 * its end). Unchanged when the card or section is unknown.
 */
fun moveCard(sections: List<HomeSection>, card: SectionEntry, to: HomePlace): List<HomeSection> {
    if (placeOf(sections, card) == null || sections.none { it.id == to.sectionId }) return sections
    val removed = sections.map { s -> if (card in s.cards) s.withCards(s.cards - card) else s }
    return removed.map { s ->
        if (s.id != to.sectionId) s
        else s.withCards(s.cards.toMutableList().apply { add(to.position.coerceIn(0, size), card) })
    }
}

/** [sections] without [card]. */
fun removeCard(sections: List<HomeSection>, card: SectionEntry): List<HomeSection> =
    sections.map { s -> if (card in s.cards) s.withCards(s.cards - card) else s }

/**
 * Where the dragged card [dragged] goes when its middle is over the row [hoveredKey] (a key of [homeRows]):
 * - another card: its place (above it when coming from below, below it when coming from above, as a list reorder);
 * - an empty section: its first place;
 * - a section's header, coming from above: the first place of that section; coming from below: the end of the section
 *   before it (none above the first section).
 * Null when the drag changes nothing.
 */
fun dragTarget(sections: List<HomeSection>, dragged: SectionEntry, hoveredKey: String): HomePlace? {
    val from = placeOf(sections, dragged) ?: return null
    val rows = homeRows(sections, emptyMap())
    val draggedRow = rows.indexOfFirst { it.key == cardKey(dragged) }
    val hoveredRow = rows.indexOfFirst { it.key == hoveredKey }
    if (hoveredRow < 0 || hoveredRow == draggedRow) return null
    val target = when (val row = rows[hoveredRow]) {
        is HomeRow.Card -> HomePlace(row.section.id, row.index)
        is HomeRow.Empty -> HomePlace(row.section.id, 0)
        is HomeRow.Header ->
            if (hoveredRow > draggedRow) HomePlace(row.section.id, 0)
            else if (row.index == 0) return null
            else sections[row.index - 1].let { above -> HomePlace(above.id, above.cards.size) }
    }
    return target.takeIf { it != from }
}
