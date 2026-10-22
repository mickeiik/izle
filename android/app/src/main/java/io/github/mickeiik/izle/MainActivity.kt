package io.github.mickeiik.izle

import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Bundle
import android.view.KeyEvent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import io.github.mickeiik.izle.ui.AppViewModel
import io.github.mickeiik.izle.ui.IzleRoot
import io.github.mickeiik.izle.ui.Screen
import io.github.mickeiik.izle.ui.input.OkPressDetector
import io.github.mickeiik.izle.ui.input.PlayerKeyAction
import io.github.mickeiik.izle.ui.input.PlayerKeys
import io.github.mickeiik.izle.update.AppInstaller
import kotlinx.coroutines.launch

/**
 * The only activity. Key routing lives here because OK has two meanings (click / long-press menu), the player owns
 * the D-pad while video is showing, channel keys must never reach the system, and the autoplay countdown gives way to
 * any key. It also receives the app's install session statuses and starts a guided update's system dialog.
 */
class MainActivity : ComponentActivity() {
    private val vm: AppViewModel by viewModels {
        viewModelFactory { initializer { AppViewModel((application as IzleApp).graph) } }
    }
    private val okPress = OkPressDetector()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // A recreated activity gets its old intent again: an install status must not be handled twice.
        if (savedInstanceState == null) handleIntent(intent)
        setContent { IzleRoot(vm) }
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                vm.launchIntents.collect { target ->
                    try {
                        startActivity(target)
                    } catch (e: ActivityNotFoundException) {
                        vm.onLaunchFailed()
                    } catch (e: SecurityException) {
                        vm.onLaunchFailed()
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        if (intent?.action == AppInstaller.ACTION_INSTALL_STATUS) return vm.onInstallStatus(intent)
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
        if (down) vm.onKeyDown()

        // The autoplay-on-start countdown: OK presses its focused button and Back (BackHandler) cancels it; any other
        // key cancels it too and does nothing else (the viewer started doing something).
        if (vm.autoplayShowing && code !in OK_KEYS && code != KeyEvent.KEYCODE_BACK) {
            if (down) vm.cancelAutoplay()
            return true
        }

        // Channel and track-skip keys never reach the system: unconsumed, many TVs open their Live TV app and the
        // viewer is out of izle. They switch episodes (or channels) in the player, and do nothing anywhere else.
        CHANNEL_KEYS[code]?.let { direction ->
            if (down && event.repeatCount == 0) vm.onChannelKey(direction)
            return true
        }

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
                    PlayerKeys.action(code, vm.player.ui.value.live)?.let { run(it, event, first = true) }
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

    /** Back is handled by Compose. */
    private fun handlePlayerKey(event: KeyEvent): Boolean {
        val action = PlayerKeys.action(event.keyCode, vm.player.ui.value.live) ?: return false
        run(action, event, first = event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0)
        return true
    }

    /** [first]: the key's first DOWN (not a repeat, not the release), when one-shot actions happen. */
    private fun run(action: PlayerKeyAction, event: KeyEvent, first: Boolean) {
        val down = event.action == KeyEvent.ACTION_DOWN
        val player = vm.player
        when (action) {
            PlayerKeyAction.SeekBack, PlayerKeyAction.SeekForward -> if (!down) player.onSeekKeyUp() else {
                player.onSeekKeyDown(if (action == PlayerKeyAction.SeekBack) -1 else 1, event.eventTime, event.downTime, event.repeatCount)
            }
            PlayerKeyAction.TogglePause -> if (first) player.togglePause()
            PlayerKeyAction.Play -> if (first) player.resume()
            PlayerKeyAction.Pause -> if (first) player.pause()
            PlayerKeyAction.Info -> if (first) player.showChannelInfo()
            PlayerKeyAction.Stop -> if (first) player.exit()
            PlayerKeyAction.Nothing -> Unit
        }
    }

    companion object {
        /** Debug builds: `adb shell am start -n io.github.mickeiik.izle/.MainActivity --es izle.server <url>`. */
        const val EXTRA_SERVER = "izle.server"

        private val OK_KEYS = setOf(KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER)

        /** CH+/CH− and the remote's |◀◀ ▶▶| keys: the next (+1) or previous (−1) episode or channel. */
        private val CHANNEL_KEYS = mapOf(
            KeyEvent.KEYCODE_CHANNEL_UP to 1,
            KeyEvent.KEYCODE_MEDIA_NEXT to 1,
            KeyEvent.KEYCODE_CHANNEL_DOWN to -1,
            KeyEvent.KEYCODE_MEDIA_PREVIOUS to -1,
        )
    }
}
