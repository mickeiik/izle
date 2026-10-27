package io.github.mickeiik.izle.companion.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import io.github.mickeiik.izle.companion.R
import io.github.mickeiik.izle.companion.finder.BrowserData
import io.github.mickeiik.izle.companion.home.HomeTab
import kotlinx.coroutines.launch

/**
 * The app: one screen at a time, as the view model says, under an app bar (none over the link finder). On a TV's page
 * the bar's title is the TV's name (tap it to switch TV), a bottom bar switches between Now and Home, and Listen
 * along opens over Now with a back arrow. The menu holds what is not about the TV: the server's phones, disconnecting
 * this phone, the browser's cookies; screens opened from it (Phones) have a back arrow. Back on a TV's page goes to
 * the TV list when the server has more than one TV, else it leaves the app (listening goes on in its notification).
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
    val onTvScreen = ui is CompanionUi.Tv || ui is CompanionUi.PickTv
    val tv = ui as? CompanionUi.Tv

    // The link finder has its own chrome (Close and the address row): no app bar while it is open, so the page gets
    // the room. Without a top bar the Scaffold's insets still start the content below the status bar.
    val finderOpen = tv?.finderOpen == true
    BackHandler(enabled = tv != null && tv.listenOpen && !finderOpen, onBack = vm::closeListen)
    BackHandler(enabled = tv != null && !tv.listenOpen && tv.severalTvs, onBack = vm::changeTv)
    Scaffold(
        topBar = {
            if (!finderOpen) TopAppBar(
                title = {
                    when {
                        tv?.listenOpen == true -> Text(stringResource(R.string.listen_along))
                        tv != null -> TvName(tv.tvName ?: stringResource(R.string.app_name), onClick = vm::changeTv)
                        ui is CompanionUi.Phones -> Text(stringResource(R.string.phones_title))
                        else -> Text(stringResource(R.string.app_name))
                    }
                },
                navigationIcon = {
                    val back = when {
                        ui is CompanionUi.Phones -> vm::closePhones
                        tv?.listenOpen == true -> vm::closeListen
                        else -> null
                    }
                    if (back != null) {
                        IconButton(onClick = back) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.back))
                        }
                    }
                },
                actions = {
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
        bottomBar = {
            if (tv != null && !tv.listenOpen && !finderOpen) {
                NavigationBar {
                    NavigationBarItem(
                        selected = tv.tab == TvTab.Now,
                        onClick = { vm.selectTab(TvTab.Now) },
                        icon = { Icon(Icons.Filled.PlayArrow, contentDescription = null) },
                        label = { Text(stringResource(R.string.tab_now)) },
                    )
                    NavigationBarItem(
                        selected = tv.tab == TvTab.Home,
                        onClick = { vm.selectTab(TvTab.Home) },
                        icon = { Icon(Icons.Filled.Home, contentDescription = null) },
                        label = { Text(stringResource(R.string.tab_home)) },
                    )
                }
            }
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
            is CompanionUi.Tv -> when {
                screen.finderOpen ->
                    LinkFinderScreen(vm.linkFinder, initialUrl = null, onListenToThis = vm::useFoundLink, onClose = vm::closeFinder, modifier = modifier)
                screen.listenOpen -> ListenScreen(screen, vm, modifier = modifier)
                screen.tab == TvTab.Now -> NowTab(screen, vm, modifier = modifier)
                else -> vm.apiClient?.let { api ->
                    HomeTab(api, tvId = screen.tvId, tvName = screen.displayName, onMessage = vm::say, modifier = modifier)
                }
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

/** The TV's name in the app bar: tapping it goes to the TV list. */
@Composable
private fun TvName(name: String, onClick: () -> Unit) {
    val switch = stringResource(R.string.switch_tv)
    Row(
        modifier = Modifier.clickable(onClickLabel = switch, onClick = onClick).padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(name, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        Icon(Icons.Filled.ArrowDropDown, contentDescription = null)
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
