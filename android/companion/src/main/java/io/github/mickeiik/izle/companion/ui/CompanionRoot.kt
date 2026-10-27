package io.github.mickeiik.izle.companion.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import io.github.mickeiik.izle.companion.R
import io.github.mickeiik.izle.companion.finder.BrowserData
import kotlinx.coroutines.launch

/**
 * The app: one screen at a time, as the view model says, under an app bar with the TV's name (none over the link
 * finder). The menu holds what is not about the TV: the server's phones, disconnecting this phone, the browser's
 * cookies; screens opened from it (Phones) have a back arrow.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CompanionRoot(vm: CompanionViewModel = viewModel()) {
    val ui by vm.ui.collectAsStateWithLifecycle()
    val message by vm.snackbar.collectAsStateWithLifecycle()
    val snackbars = remember { SnackbarHostState() }
    LaunchedEffect(message) {
        val text = message ?: return@LaunchedEffect
        snackbars.showSnackbar(text)
        vm.dismissSnackbar()
    }
    var confirmDisconnect by rememberSaveable { mutableStateOf(false) }
    val onTvScreen = ui is CompanionUi.Listen || ui is CompanionUi.PickTv

    // The link finder has its own chrome (Close and the address row): no app bar while it is open, so the page gets
    // the room. Without a top bar the Scaffold's insets still start the content below the status bar.
    val finderOpen = (ui as? CompanionUi.Listen)?.finderOpen == true
    Scaffold(
        topBar = {
            if (!finderOpen) TopAppBar(
                title = {
                    val title = when (val screen = ui) {
                        is CompanionUi.Listen -> screen.tvName
                        is CompanionUi.Phones -> stringResource(R.string.phones_title)
                        else -> null
                    }
                    Text(title ?: stringResource(R.string.app_name))
                },
                navigationIcon = {
                    if (ui is CompanionUi.Phones) {
                        IconButton(onClick = vm::closePhones) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.back))
                        }
                    }
                },
                actions = {
                    if (ui is CompanionUi.Listen) {
                        TextButton(onClick = vm::changeTv) { Text(stringResource(R.string.change_tv)) }
                    }
                    if (onTvScreen) {
                        OverflowMenu(
                            onPhones = vm::openPhones,
                            onDisconnect = { confirmDisconnect = true },
                            onBrowserDataCleared = { snackbars.showSnackbar(it) },
                        )
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbars) },
    ) { insets ->
        val modifier = Modifier.fillMaxSize().padding(insets).consumeWindowInsets(insets).imePadding()
        when (val screen = ui) {
            CompanionUi.Starting -> Box(modifier)
            is CompanionUi.Connect ->
                ConnectScreen(screen, onConnect = vm::connect, onConnectWithToken = vm::connectWithToken, modifier = modifier)
            is CompanionUi.PickTv -> TvPickerScreen(screen, onPick = vm::pickTv, onRetry = vm::reloadTvs, modifier = modifier)
            is CompanionUi.Phones -> PhonesScreen(
                screen, onDisconnect = vm::disconnectPhone, onRetry = vm::reloadPhones, onBack = vm::closePhones, modifier = modifier,
            )
            is CompanionUi.Listen ->
                if (screen.finderOpen) {
                    LinkFinderScreen(vm.linkFinder, initialUrl = null, onListenToThis = vm::useFoundLink, onClose = vm::closeFinder, modifier = modifier)
                } else {
                    ListenScreen(screen, vm, modifier = modifier)
                }
        }
    }

    if (confirmDisconnect && onTvScreen) {
        AlertDialog(
            onDismissRequest = { confirmDisconnect = false },
            title = { Text(stringResource(R.string.disconnect_this_phone_title)) },
            text = { Text(stringResource(R.string.disconnect_self_text)) },
            confirmButton = {
                TextButton(onClick = {
                    confirmDisconnect = false
                    vm.forgetPairing()
                }) { Text(stringResource(R.string.disconnect)) }
            },
            dismissButton = { TextButton(onClick = { confirmDisconnect = false }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}

@Composable
private fun OverflowMenu(onPhones: () -> Unit, onDisconnect: () -> Unit, onBrowserDataCleared: suspend (String) -> Unit) {
    var open by rememberSaveable { mutableStateOf(false) }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val cleared = stringResource(R.string.browser_data_cleared)
    Box {
        IconButton(onClick = { open = true }) {
            Icon(Icons.Filled.MoreVert, contentDescription = stringResource(R.string.more_options))
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.phones)) },
                onClick = {
                    open = false
                    onPhones()
                },
            )
            DropdownMenuItem(
                text = { Text(stringResource(R.string.disconnect_this_phone)) },
                onClick = {
                    open = false
                    onDisconnect()
                },
            )
            DropdownMenuItem(
                text = { Text(stringResource(R.string.clear_browser_data)) },
                onClick = {
                    open = false
                    BrowserData.clear(context) { scope.launch { onBrowserDataCleared(cleared) } }
                },
            )
        }
    }
}
