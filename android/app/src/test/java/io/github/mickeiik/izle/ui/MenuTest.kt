package io.github.mickeiik.izle.ui

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
    fun installUpdateIsOfferedWhileANewerVersionIsButNeverOverThePlayer() {
        assertEquals("0.3.0", MenuPlan.installUpdateVersion("0.3.0", fromPlayer = false))
        assertNull(MenuPlan.installUpdateVersion("0.3.0", fromPlayer = true))
        assertNull(MenuPlan.installUpdateVersion(null, fromPlayer = false))
    }
}
