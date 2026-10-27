package io.github.mickeiik.izle.domain

import io.github.mickeiik.izle.data.api.HomeEntry
import io.github.mickeiik.izle.data.api.HomeSectionInfo

/** A card on Home: a show or channel OK plays, or an app OK opens (docs/ux/senior-tv.md, "App cards"). */
sealed interface HomeTile {
    /** Unique on Home: a show's item id, `app:<appId>` for an app card (item ids have no colon). */
    val key: String

    data class Show(val entry: HomeEntry) : HomeTile {
        override val key: String get() = entry.item.id
    }

    /** An app this TV can open now; [label] is its name on this TV (PackageManager's, not the server's). */
    data class App(val appId: String, val label: String) : HomeTile {
        override val key: String get() = appKey(appId)
    }

    companion object {
        private const val APP_PREFIX = "app:"

        fun appKey(appId: String): String = APP_PREFIX + appId

        fun isAppKey(key: String): Boolean = key.startsWith(APP_PREFIX)
    }
}

/** [title] null: the untitled section; [row]: one line that scrolls sideways, else a grid. Never empty. */
data class HomeSection(val id: String, val title: String?, val row: Boolean, val tiles: List<HomeTile>)

/** How Home cuts `home` into the sections it draws (docs/ux/senior-tv.md, "Sections"). */
object HomeSections {
    const val UNTITLED_ID = "untitled"

    /**
     * Every entry of [home] is drawn once: ids not in [home] or already placed are left out, empty sections too, and
     * entries no section holds go to the end of the untitled section (added last if there is none). A section's
     * `entries` (shows and app cards) are drawn when given, else its `itemIds`; an app card [app] does not know (not
     * installed, no launch entry) is left out, and so is an entry of a kind this TV does not know. Without a titled
     * section: one untitled section with all the cards, in their order, in the first section's layout.
     */
    fun of(home: List<HomeEntry>, sections: List<HomeSectionInfo>, app: (String) -> HomeTile.App?): List<HomeSection> {
        val byId = home.associateBy { it.item.id }
        val placed = HashSet<String>()
        fun show(id: String): HomeTile? = byId[id]?.takeIf { placed.add(id) }?.let(HomeTile::Show)
        val drawn = sections.map { s ->
            val tiles = if (s.entries.isEmpty()) {
                s.itemIds.mapNotNull(::show)
            } else {
                s.entries.mapNotNull { e ->
                    val itemId = e.itemId
                    val appId = e.appId
                    when {
                        itemId != null -> show(itemId)
                        appId != null -> app(appId)?.takeIf { placed.add(it.key) }
                        else -> null
                    }
                }
            }
            HomeSection(s.id, s.title?.trim()?.takeIf { it.isNotEmpty() }, row = s.layout == HomeSectionInfo.LAYOUT_ROW, tiles)
        }.filter { it.tiles.isNotEmpty() }.toMutableList()

        val rest = home.filter { it.item.id !in placed }.map(HomeTile::Show)
        if (drawn.none { it.title != null }) {
            val tiles = drawn.flatMap { it.tiles } + rest
            if (tiles.isEmpty()) return emptyList()
            val untitled = drawn.firstOrNull()
            return listOf(HomeSection(untitled?.id ?: UNTITLED_ID, null, row = untitled?.row == true, tiles))
        }
        if (rest.isNotEmpty()) {
            val at = drawn.indexOfFirst { it.title == null }
            if (at >= 0) drawn[at] = drawn[at].copy(tiles = drawn[at].tiles + rest)
            else drawn += HomeSection(UNTITLED_ID, null, row = false, tiles = rest)
        }
        return drawn
    }
}
