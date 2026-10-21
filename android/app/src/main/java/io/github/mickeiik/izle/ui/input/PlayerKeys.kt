package io.github.mickeiik.izle.ui.input

import android.view.KeyEvent

/** What a remote key does in the player while it has the keys (no hidden menu, no end screen). */
enum class PlayerKeyAction { TogglePause, Play, Pause, SeekBack, SeekForward, Info, Stop, Nothing }

/**
 * The player's columns of docs/ux/senior-tv.md's "Remote key map": "Player (video)" for an episode and "Player
 * (channel)" for a channel ([live]), which has no pause and no position. Back (Compose), Menu, OK's long press and the
 * channel keys are routed before these.
 */
object PlayerKeys {
    /** The action for [keyCode], or null for a key the player leaves to the rest of the app. */
    fun action(keyCode: Int, live: Boolean): PlayerKeyAction? = when (keyCode) {
        // A short OK (delivered on release).
        KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER ->
            if (live) PlayerKeyAction.Info else PlayerKeyAction.TogglePause
        KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_MEDIA_REWIND -> if (live) PlayerKeyAction.Nothing else PlayerKeyAction.SeekBack
        KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> if (live) PlayerKeyAction.Nothing else PlayerKeyAction.SeekForward
        // On a channel, Play only undoes a pause the system made (lost audio focus): while it plays it does nothing.
        KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> if (live) PlayerKeyAction.Play else PlayerKeyAction.TogglePause
        KeyEvent.KEYCODE_MEDIA_PLAY -> PlayerKeyAction.Play
        KeyEvent.KEYCODE_MEDIA_PAUSE -> if (live) PlayerKeyAction.Nothing else PlayerKeyAction.Pause
        KeyEvent.KEYCODE_MEDIA_STOP -> PlayerKeyAction.Stop
        KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN -> PlayerKeyAction.Nothing
        else -> null
    }
}
