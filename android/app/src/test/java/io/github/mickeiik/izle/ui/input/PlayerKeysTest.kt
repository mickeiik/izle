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
import org.junit.Test

/** docs/ux/senior-tv.md, "Remote key map": the "Player (video)" and "Player (channel)" columns. */
class PlayerKeysTest {
    @Test
    fun anEpisodePausesAndSeeksAChannelOnlyShowsItsInformation() {
        // Key: (episode, channel). A channel's Play only undoes a pause the system made: while it plays it does nothing.
        val keys = mapOf(
            KeyEvent.KEYCODE_DPAD_CENTER to (TogglePause to Info),
            KeyEvent.KEYCODE_ENTER to (TogglePause to Info),
            KeyEvent.KEYCODE_NUMPAD_ENTER to (TogglePause to Info),
            KeyEvent.KEYCODE_DPAD_LEFT to (SeekBack to Nothing),
            KeyEvent.KEYCODE_MEDIA_REWIND to (SeekBack to Nothing),
            KeyEvent.KEYCODE_DPAD_RIGHT to (SeekForward to Nothing),
            KeyEvent.KEYCODE_MEDIA_FAST_FORWARD to (SeekForward to Nothing),
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE to (TogglePause to Play),
            KeyEvent.KEYCODE_MEDIA_PLAY to (Play to Play),
            KeyEvent.KEYCODE_MEDIA_PAUSE to (Pause to Nothing),
            KeyEvent.KEYCODE_MEDIA_STOP to (Stop to Stop),
            KeyEvent.KEYCODE_DPAD_UP to (Nothing to Nothing),
            KeyEvent.KEYCODE_DPAD_DOWN to (Nothing to Nothing),
            // Routed elsewhere: not the player's.
            KeyEvent.KEYCODE_BACK to (null to null),
            KeyEvent.KEYCODE_MENU to (null to null),
            KeyEvent.KEYCODE_CHANNEL_UP to (null to null),
            KeyEvent.KEYCODE_MEDIA_NEXT to (null to null),
            KeyEvent.KEYCODE_VOLUME_UP to (null to null),
        )
        for ((key, actions) in keys) {
            assertEquals("key $key", actions, PlayerKeys.action(key, live = false) to PlayerKeys.action(key, live = true))
        }
    }
}
