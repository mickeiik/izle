package io.github.mickeiik.izle.ui.input

import android.view.KeyEvent
import io.github.mickeiik.izle.ui.input.PlayerKeyAction.Info
import io.github.mickeiik.izle.ui.input.PlayerKeyAction.Nothing
import io.github.mickeiik.izle.ui.input.PlayerKeyAction.Pause
import io.github.mickeiik.izle.ui.input.PlayerKeyAction.Play
import io.github.mickeiik.izle.ui.input.PlayerKeyAction.SeekBack
import io.github.mickeiik.izle.ui.input.PlayerKeyAction.SeekForward
import io.github.mickeiik.izle.ui.input.PlayerKeyAction.Stop
import io.github.mickeiik.izle.ui.input.PlayerKeyAction.TogglePause
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** docs/ux/senior-tv.md, "Remote key map": the "Player (video)" and "Player (channel)" columns. */
class PlayerKeysTest {
    private val ok = listOf(KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER)

    @Test
    fun anEpisodePausesAndSeeks() {
        ok.forEach { assertEquals(TogglePause, PlayerKeys.action(it, live = false)) }
        assertEquals(SeekBack, PlayerKeys.action(KeyEvent.KEYCODE_DPAD_LEFT, live = false))
        assertEquals(SeekBack, PlayerKeys.action(KeyEvent.KEYCODE_MEDIA_REWIND, live = false))
        assertEquals(SeekForward, PlayerKeys.action(KeyEvent.KEYCODE_DPAD_RIGHT, live = false))
        assertEquals(SeekForward, PlayerKeys.action(KeyEvent.KEYCODE_MEDIA_FAST_FORWARD, live = false))
        assertEquals(TogglePause, PlayerKeys.action(KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, live = false))
        assertEquals(Play, PlayerKeys.action(KeyEvent.KEYCODE_MEDIA_PLAY, live = false))
        assertEquals(Pause, PlayerKeys.action(KeyEvent.KEYCODE_MEDIA_PAUSE, live = false))
        assertEquals(Stop, PlayerKeys.action(KeyEvent.KEYCODE_MEDIA_STOP, live = false))
        assertEquals(Nothing, PlayerKeys.action(KeyEvent.KEYCODE_DPAD_UP, live = false))
        assertEquals(Nothing, PlayerKeys.action(KeyEvent.KEYCODE_DPAD_DOWN, live = false))
    }

    @Test
    fun aChannelOnlyShowsItsInformation() {
        ok.forEach { assertEquals(Info, PlayerKeys.action(it, live = true)) }
        for (key in listOf(
            KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_MEDIA_REWIND,
            KeyEvent.KEYCODE_MEDIA_FAST_FORWARD, KeyEvent.KEYCODE_MEDIA_PAUSE, KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN,
        )) {
            assertEquals("key $key", Nothing, PlayerKeys.action(key, live = true))
        }
        // Play only undoes a pause the system made; while the channel plays it does nothing.
        assertEquals(Play, PlayerKeys.action(KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, live = true))
        assertEquals(Play, PlayerKeys.action(KeyEvent.KEYCODE_MEDIA_PLAY, live = true))
        assertEquals(Stop, PlayerKeys.action(KeyEvent.KEYCODE_MEDIA_STOP, live = true))
    }

    @Test
    fun keysRoutedElsewhereAreNotThePlayers() {
        for (live in listOf(false, true)) {
            for (key in listOf(KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_MENU, KeyEvent.KEYCODE_CHANNEL_UP, KeyEvent.KEYCODE_MEDIA_NEXT, KeyEvent.KEYCODE_VOLUME_UP)) {
                assertNull("key $key", PlayerKeys.action(key, live))
            }
        }
    }
}
