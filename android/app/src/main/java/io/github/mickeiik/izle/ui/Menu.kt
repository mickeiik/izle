package io.github.mickeiik.izle.ui

import io.github.mickeiik.izle.data.api.ItemCard
import io.github.mickeiik.izle.data.api.ItemDetailsResponse
import io.github.mickeiik.izle.player.TrackOption

enum class RootEntry { Episodes, StartOver, Audio, Subtitles, Settings, About }

enum class SettingsEntry { ServerAddress, Language, PairAgain }

sealed interface MenuPage {
    /** [focused]: the entry that opened the page above, so Back returns to it. */
    data class Root(val entries: List<RootEntry>, val focused: Int = 0) : MenuPage
    data class Episodes(val details: ItemDetailsResponse?, val failed: Boolean = false) : MenuPage
    data class Audio(val options: List<TrackOption>) : MenuPage
    data class Subtitles(val options: List<TrackOption>) : MenuPage
    data object Settings : MenuPage
    data object About : MenuPage
}

/** The hidden menu: a stack of pages; Back pops one, the last one closes the menu. */
data class MenuUi(val pages: List<MenuPage>, val item: ItemCard?, val fromPlayer: Boolean, val playingEpisodeId: String? = null) {
    val page: MenuPage get() = pages.last()

    fun push(next: MenuPage): MenuUi = copy(pages = pages + next)

    /** One page back, or null when the root page is the one closing (the menu closes). */
    fun pop(): MenuUi? = if (pages.size > 1) copy(pages = pages.dropLast(1)) else null

    /** The current page replaced in place (a loading page by what it loaded). */
    fun replaceTop(page: MenuPage): MenuUi = copy(pages = pages.dropLast(1) + page)

    /** The root page remembers [entry] as the one that opened the page above it. */
    fun focusingRoot(entry: RootEntry): MenuUi =
        copy(pages = pages.map { if (it is MenuPage.Root) it.copy(focused = it.entries.indexOf(entry)) else it })
}

/** What the hidden menu offers (docs/ux/senior-tv.md, "Hidden menu"). */
object MenuPlan {
    /**
     * The root page's entries for a show of [itemKind] (null: no show, an empty Home): Episodes for a series and Start
     * over for any show; in the player, Audio language with at least two audio tracks, and Subtitles; then Settings and
     * About, always.
     */
    fun rootEntries(itemKind: String?, fromPlayer: Boolean, audioTrackCount: Int): List<RootEntry> = buildList {
        if (itemKind != null) {
            if (itemKind == "series") add(RootEntry.Episodes)
            add(RootEntry.StartOver)
        }
        if (fromPlayer) {
            if (audioTrackCount > 1) add(RootEntry.Audio)
            add(RootEntry.Subtitles)
        }
        add(RootEntry.Settings)
        add(RootEntry.About)
    }
}
