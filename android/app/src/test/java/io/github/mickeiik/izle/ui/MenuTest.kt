package io.github.mickeiik.izle.ui

import io.github.mickeiik.izle.data.api.ItemCard
import io.github.mickeiik.izle.ui.RootEntry.About
import io.github.mickeiik.izle.ui.RootEntry.Audio
import io.github.mickeiik.izle.ui.RootEntry.Episodes
import io.github.mickeiik.izle.ui.RootEntry.Settings
import io.github.mickeiik.izle.ui.RootEntry.StartOver
import io.github.mickeiik.izle.ui.RootEntry.Subtitles
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MenuTest {
    @Test
    fun onHomeASeriesOffersItsEpisodesAndAnyShowStartingOver() {
        assertEquals(listOf(Episodes, StartOver, Settings, About), MenuPlan.rootEntries("series", fromPlayer = false, audioTrackCount = 0))
        assertEquals(listOf(StartOver, Settings, About), MenuPlan.rootEntries("movie", fromPlayer = false, audioTrackCount = 0))
        assertEquals("an empty Home", listOf(Settings, About), MenuPlan.rootEntries(null, fromPlayer = false, audioTrackCount = 0))
    }

    @Test
    fun inThePlayerAudioNeedsTwoTracksAndSubtitlesAreAlwaysThere() {
        assertEquals(listOf(Episodes, StartOver, Audio, Subtitles, Settings, About), MenuPlan.rootEntries("series", fromPlayer = true, audioTrackCount = 2))
        assertEquals(listOf(StartOver, Subtitles, Settings, About), MenuPlan.rootEntries("movie", fromPlayer = true, audioTrackCount = 1))
        assertEquals(listOf(StartOver, Subtitles, Settings, About), MenuPlan.rootEntries("movie", fromPlayer = true, audioTrackCount = 0))
    }

    @Test
    fun pagesStackAndBackPopsThemUntilTheRootCloses() {
        val root = MenuPage.Root(listOf(Episodes, StartOver, Settings, About))
        val menu = MenuUi(listOf(root), ItemCard("show", "series", "Show"), fromPlayer = false)
        val settings = menu.push(MenuPage.Settings)
        assertEquals(listOf(root, MenuPage.Settings), settings.pages)
        assertEquals(MenuPage.Settings, settings.page)
        assertEquals(menu, settings.pop())
        assertNull("Back on the root page closes the menu", menu.pop())
        assertEquals(menu.item, settings.item)
    }

    @Test
    fun aLoadedPageReplacesItsLoadingPage() {
        val root = MenuPage.Root(listOf(Episodes, StartOver, Settings, About))
        val loading = MenuUi(listOf(root), null, fromPlayer = false).push(MenuPage.Episodes(details = null))
        val failed = loading.replaceTop(MenuPage.Episodes(details = null, failed = true))
        assertEquals(listOf(root, MenuPage.Episodes(details = null, failed = true)), failed.pages)
    }

    @Test
    fun theRootRemembersTheEntryThatOpenedThePageAbove() {
        val entries = listOf(Episodes, StartOver, Settings, About)
        val menu = MenuUi(listOf(MenuPage.Root(entries, focused = 1)), null, fromPlayer = true, playingEpisodeId = "show.e2")
        assertEquals(MenuPage.Root(entries, focused = 2), menu.focusingRoot(Settings).page)
        val deeper = menu.push(MenuPage.Settings).focusingRoot(About)
        assertEquals(listOf(MenuPage.Root(entries, focused = 3), MenuPage.Settings), deeper.pages)
        assertEquals("show.e2", deeper.playingEpisodeId)
    }
}
