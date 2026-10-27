package io.github.mickeiik.izle.companion.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
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
import io.github.mickeiik.izle.companion.catalog.CatalogTab
import io.github.mickeiik.izle.companion.catalog.ShowScreen
import io.github.mickeiik.izle.companion.finder.BrowserData
import io.github.mickeiik.izle.companion.home.HomeTab
import io.github.mickeiik.izle.companion.ui.design.ButtonKind
import io.github.mickeiik.izle.companion.ui.design.IzleBottomBar
import io.github.mickeiik.izle.companion.ui.design.IzleButton
import io.github.mickeiik.izle.companion.ui.design.IzleIcons
import io.github.mickeiik.izle.companion.ui.design.IzleTopBar
import io.github.mickeiik.izle.companion.ui.design.MenuItem
import io.github.mickeiik.izle.companion.ui.design.OverflowMenu
import io.github.mickeiik.izle.companion.ui.design.TabItem
import kotlinx.coroutines.launch

/**
 * The app: one screen at a time, as the view model says, under an app bar (none over the link finder). On a TV's page
 * the bar's title is the TV's name (tap it to switch TV), a bottom bar switches between Now, Home and Catalog, and Listen
 * along opens over Now with a back arrow. The menu holds what is not about the TV: the server's phones, disconnecting
 * this phone, the browser's cookies; screens opened from it (Phones) have a back arrow. Back on a TV's page goes to
 * the TV list when the server has more than one TV, else it leaves the app (listening goes on in its notification).
 * A show's page (from the Catalog tab) covers the tabs, with a back arrow and the show's title; Back closes it.
 */
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
    val showOpen = tv?.openShow != null && !finderOpen && !tv.listenOpen
    BackHandler(enabled = tv != null && tv.listenOpen && !finderOpen, onBack = vm::closeListen)
    BackHandler(enabled = tv != null && !tv.listenOpen && !showOpen && tv.severalTvs, onBack = vm::changeTv)
    BackHandler(enabled = showOpen, onBack = vm::closeShow)
    Scaffold(
        topBar = {
            if (!finderOpen) {
                val appName = stringResource(R.string.app_name)
                IzleTopBar(
                    title = when {
                        tv?.listenOpen == true -> stringResource(R.string.listen_along)
                        showOpen -> tv?.openShowTitle.orEmpty()
                        tv != null -> tv.tvName ?: appName
                        ui is CompanionUi.Phones -> stringResource(R.string.phones)
                        else -> appName
                    },
                    onBack = when {
                        ui is CompanionUi.Phones -> vm::closePhones
                        tv?.listenOpen == true -> vm::closeListen
                        showOpen -> vm::closeShow
                        else -> null
                    },
                    onTitleClick = if (tv != null && !tv.listenOpen && !showOpen) vm::changeTv else null,
                    titleClickLabel = stringResource(R.string.switch_tv),
                    actions = {
                        if (onTvScreen && !showOpen) {
                            AppMenu(
                                onPhones = vm::openPhones,
                                onDisconnect = { confirmDisconnect = true },
                                onBrowserDataCleared = { snackbars.showSnackbar(it) },
                            )
                        }
                    },
                )
            }
        },
        bottomBar = {
            if (tv != null && !tv.listenOpen && !finderOpen && !showOpen) {
                IzleBottomBar(
                    listOf(
                        TabItem(stringResource(R.string.tab_now), IzleIcons.Tv, tv.tab == TvTab.Now) { vm.selectTab(TvTab.Now) },
                        TabItem(stringResource(R.string.tab_home), IzleIcons.Grid, tv.tab == TvTab.Home) { vm.selectTab(TvTab.Home) },
                        TabItem(stringResource(R.string.tab_catalog), IzleIcons.Library, tv.tab == TvTab.Catalog) { vm.selectTab(TvTab.Catalog) },
                    ),
                )
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
                screen.openShow != null -> vm.apiClient?.let { api ->
                    ShowScreen(api, tvId = screen.tvId, tvName = screen.displayName, itemId = screen.openShow, onMessage = vm::say, modifier = modifier)
                }
                screen.tab == TvTab.Now -> NowTab(screen, vm, modifier = modifier)
                screen.tab == TvTab.Catalog -> vm.apiClient?.let { api ->
                    CatalogTab(api, tvId = screen.tvId, tvName = screen.displayName, onOpenShow = vm::openShow, onMessage = vm::say, modifier = modifier)
                }
                else -> vm.apiClient?.let { api ->
                    HomeTab(api, tvId = screen.tvId, tvName = screen.displayName, onMessage = vm::say, onRevoked = vm::homeRevoked, modifier = modifier)
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
                IzleButton(stringResource(R.string.disconnect), kind = ButtonKind.Danger, onClick = {
                    confirmDisconnect = false
                    vm.forgetPairing()
                })
            },
            dismissButton = { IzleButton(stringResource(R.string.cancel), kind = ButtonKind.Quiet, onClick = { confirmDisconnect = false }) },
        )
    }
}

/** The app bar's ⋮: Phones, Disconnect this phone, Clear browser cookies. */
@Composable
private fun AppMenu(onPhones: () -> Unit, onDisconnect: () -> Unit, onBrowserDataCleared: suspend (String) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val cleared = stringResource(R.string.browser_data_cleared)
    OverflowMenu(
        stringResource(R.string.more_options),
        listOf(
            MenuItem(stringResource(R.string.phones), onPhones),
            MenuItem(stringResource(R.string.disconnect_this_phone), onDisconnect),
            MenuItem(stringResource(R.string.clear_browser_data), {
                BrowserData.clear(context) { scope.launch { onBrowserDataCleared(cleared) } }
            }),
        ),
    )
}
