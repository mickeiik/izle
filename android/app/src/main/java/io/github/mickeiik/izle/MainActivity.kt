package io.github.mickeiik.izle

import android.content.Intent
import android.os.Bundle
import android.view.KeyEvent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import io.github.mickeiik.izle.ui.AppViewModel
import io.github.mickeiik.izle.ui.IzleRoot
import io.github.mickeiik.izle.ui.Screen
import io.github.mickeiik.izle.ui.input.OkPressDetector

/**
 * The only activity. Key routing lives here because a remote's OK has two meanings (click / long-press menu)
 * and the player owns the D-pad while video is showing; everything else goes to Compose as usual.
 */
class MainActivity : ComponentActivity() {
    private val vm: AppViewModel by viewModels {
        viewModelFactory { initializer { AppViewModel((application as IzleApp).graph) } }
    }
    private val okPress = OkPressDetector()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        handleIntent(intent)
        setContent { IzleRoot(vm) }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        if (!BuildConfig.DEBUG) return
        intent?.getStringExtra(EXTRA_SERVER)?.let(vm::onLaunchServer)
    }

    override fun onStart() {
        super.onStart()
        vm.onForeground()
    }

    override fun onStop() {
        vm.onBackground()
        super.onStop()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (!hasFocus) okPress.reset()
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val code = event.keyCode
        val down = event.action == KeyEvent.ACTION_DOWN

        if (code == KeyEvent.KEYCODE_MENU) {
            if (down && event.repeatCount == 0) vm.openMenu()
            return true
        }

        val screen = vm.screen.value
        if (code in OK_KEYS && (screen == Screen.Home || screen == Screen.Player)) {
            val result = if (down) okPress.onDown(event.eventTime, event.downTime, event.repeatCount) else okPress.onUp(event.eventTime)
            when (result) {
                OkPressDetector.Result.Swallow -> Unit
                OkPressDetector.Result.LongPress -> vm.openMenu()
                OkPressDetector.Result.Click -> if (vm.playerHasKeys) {
                    vm.player.togglePause()
                } else {
                    // Deliver the held-back press as a normal click to whatever has focus.
                    super.dispatchKeyEvent(KeyEvent.changeAction(event, KeyEvent.ACTION_DOWN))
                    super.dispatchKeyEvent(event)
                }
            }
            return true
        }

        if (vm.playerHasKeys && handlePlayerKey(event)) return true
        return super.dispatchKeyEvent(event)
    }

    /** Video is showing: Left/Right seek, media keys work, Up/Down do nothing. Back is handled by Compose. */
    private fun handlePlayerKey(event: KeyEvent): Boolean {
        val down = event.action == KeyEvent.ACTION_DOWN
        val first = down && event.repeatCount == 0
        val player = vm.player
        when (event.keyCode) {
            KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_MEDIA_REWIND ->
                if (down) player.onSeekKeyDown(-1, event.eventTime, event.downTime, event.repeatCount) else player.onSeekKeyUp()
            KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_MEDIA_FAST_FORWARD ->
                if (down) player.onSeekKeyDown(1, event.eventTime, event.downTime, event.repeatCount) else player.onSeekKeyUp()
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> if (first) player.togglePause()
            KeyEvent.KEYCODE_MEDIA_PLAY -> if (first) player.resume()
            KeyEvent.KEYCODE_MEDIA_PAUSE -> if (first) player.pause()
            KeyEvent.KEYCODE_MEDIA_STOP -> if (first) player.exit()
            KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN -> Unit
            else -> return false
        }
        return true
    }

    companion object {
        /** Debug builds: `adb shell am start -n io.github.mickeiik.izle/.MainActivity --es izle.server <url>`. */
        const val EXTRA_SERVER = "izle.server"

        private val OK_KEYS = setOf(KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER)
    }
}
