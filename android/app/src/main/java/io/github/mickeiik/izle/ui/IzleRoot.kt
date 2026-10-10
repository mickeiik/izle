package io.github.mickeiik.izle.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mickeiik.izle.ui.common.LocalizedContent
import io.github.mickeiik.izle.ui.hidden.HiddenMenu
import io.github.mickeiik.izle.ui.hidden.MenuActions
import io.github.mickeiik.izle.ui.home.HomeScreen
import io.github.mickeiik.izle.ui.pairing.PairingScreen
import io.github.mickeiik.izle.ui.player.PlayerScreen
import io.github.mickeiik.izle.ui.setup.SetupScreen
import io.github.mickeiik.izle.ui.theme.IzleColors
import io.github.mickeiik.izle.ui.theme.IzleTheme

@Composable
fun IzleRoot(vm: AppViewModel) {
    val language by vm.uiLanguage.collectAsStateWithLifecycle()
    LocalizedContent(language) {
        IzleTheme {
            // Back never leaves the app: the view model decides (close menu, leave player, or nothing on Home).
            BackHandler { vm.onBack() }
            val screen by vm.screen.collectAsStateWithLifecycle()
            val menu by vm.menu.collectAsStateWithLifecycle()
            val state by vm.state.collectAsStateWithLifecycle()
            Box(Modifier.fillMaxSize().background(IzleColors.Background)) {
                when (screen) {
                    Screen.Starting -> Unit
                    is Screen.Setup -> {
                        val setup by vm.setup.collectAsStateWithLifecycle()
                        SetupScreen(setup, vm::onAddressChange, vm::onConnect)
                    }
                    Screen.Pairing -> {
                        val pairing by vm.pairing.collectAsStateWithLifecycle()
                        PairingScreen(pairing)
                    }
                    Screen.Home -> {
                        val online by vm.online.collectAsStateWithLifecycle()
                        val message by vm.homeMessage.collectAsStateWithLifecycle()
                        HomeScreen(
                            state = state,
                            online = online,
                            message = message,
                            initialFocusItemId = vm.homeFocusItemId,
                            active = menu == null,
                            posterUrl = vm::absoluteUrl,
                            onFocused = vm::onTileFocused,
                            onPlay = vm::onTileClicked,
                        )
                    }
                    Screen.Player -> {
                        val ui by vm.player.ui.collectAsStateWithLifecycle()
                        val player by vm.player.player.collectAsStateWithLifecycle()
                        PlayerScreen(ui, player, onPlayNext = vm.player::playNextNow, onHome = vm.player::exit, onRetry = vm.player::retry)
                    }
                }
                menu?.let { m ->
                    val override by vm.uiLanguageOverride.collectAsStateWithLifecycle()
                    val actions = remember(vm) {
                        MenuActions(vm::onRootEntry, vm::onEpisodeChosen, vm::onAudioChosen, vm::onSubtitlesChosen, vm::onSettingsEntry)
                    }
                    HiddenMenu(
                        menu = m,
                        uiLanguage = state?.device?.uiLanguage ?: language,
                        uiLanguageOverride = override,
                        about = vm.aboutInfo(),
                        actions = actions,
                    )
                }
            }
        }
    }
}
