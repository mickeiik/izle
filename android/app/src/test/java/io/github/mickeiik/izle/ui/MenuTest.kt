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
    fun theRootPageOffersWhatTheShowAndThePlayerAllow() {
        // (kind, in the player, audio tracks): a series has Episodes, any show Start over, a channel neither; the player
        // adds Audio language with two tracks or more, and Subtitles. A null kind: an empty Home.
        val cases = mapOf(
            Triple("series", false, 0) to listOf(Episodes, StartOver, Settings, About),
            Triple("movie", false, 0) to listOf(StartOver, Settings, About),
            Triple(null, false, 0) to listOf(Settings, About),
            Triple("series", true, 2) to listOf(Episodes, StartOver, Audio, Subtitles, Settings, About),
            Triple("movie", true, 1) to listOf(StartOver, Subtitles, Settings, About),
            Triple("movie", true, 0) to listOf(StartOver, Subtitles, Settings, About),
            Triple("live", false, 0) to listOf(Settings, About),
            Triple("live", true, 2) to listOf(Audio, Subtitles, Settings, About),
            Triple("live", true, 1) to listOf(Subtitles, Settings, About),
        )
        for ((args, entries) in cases) assertEquals("$args", entries, MenuPlan.rootEntries(args.first, args.second, args.third))
    }

    @Test
    fun installUpdateIsOfferedWhileANewerVersionIsButNeverOverThePlayer() {
        assertEquals("0.3.0", MenuPlan.installUpdateVersion("0.3.0", fromPlayer = false))
        assertNull(MenuPlan.installUpdateVersion("0.3.0", fromPlayer = true))
        assertNull(MenuPlan.installUpdateVersion(null, fromPlayer = false))
    }
}
