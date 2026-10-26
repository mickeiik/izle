package io.github.mickeiik.izle.companion.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
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

/** The app: one screen at a time, as the view model says, under an app bar with the TV's name. */
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

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text((ui as? CompanionUi.Listen)?.tvName ?: stringResource(R.string.app_name)) },
                actions = {
                    if (ui is CompanionUi.Listen) {
                        TextButton(onClick = vm::changeTv) { Text(stringResource(R.string.change_tv)) }
                    }
                    if (ui is CompanionUi.Listen || ui is CompanionUi.PickTv) {
                        OverflowMenu(onChangeServer = vm::forgetPairing, onBrowserDataCleared = { snackbars.showSnackbar(it) })
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbars) },
    ) { insets ->
        val modifier = Modifier.fillMaxSize().padding(insets).consumeWindowInsets(insets).imePadding()
        when (val screen = ui) {
            CompanionUi.Starting -> Box(modifier)
            is CompanionUi.Pairing -> PairingScreen(screen, onConnect = vm::connect, modifier = modifier)
            is CompanionUi.PickTv -> TvPickerScreen(screen, onPick = vm::pickTv, onRetry = vm::reloadTvs, modifier = modifier)
            is CompanionUi.Listen -> ListenScreen(screen, vm, modifier = modifier)
        }
    }
}

@Composable
private fun OverflowMenu(onChangeServer: () -> Unit, onBrowserDataCleared: suspend (String) -> Unit) {
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
                text = { Text(stringResource(R.string.change_server)) },
                onClick = {
                    open = false
                    onChangeServer()
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
