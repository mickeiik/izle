package io.github.mickeiik.izle.companion.catalog

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import io.github.mickeiik.izle.companion.R
import io.github.mickeiik.izle.companion.home.RowPoster
import io.github.mickeiik.izle.companion.home.errorText
import io.github.mickeiik.izle.companion.home.resources
import io.github.mickeiik.izle.companion.ui.design.ButtonKind
import io.github.mickeiik.izle.companion.ui.design.Caption
import io.github.mickeiik.izle.companion.ui.design.ChipRow
import io.github.mickeiik.izle.companion.ui.design.EmptyState
import io.github.mickeiik.izle.companion.ui.design.FilterChip
import io.github.mickeiik.izle.companion.ui.design.IzleButton
import io.github.mickeiik.izle.companion.ui.design.IzleIcons
import io.github.mickeiik.izle.companion.ui.design.IzleTheme
import io.github.mickeiik.izle.companion.ui.design.ListRow
import io.github.mickeiik.izle.companion.ui.design.MenuItem
import io.github.mickeiik.izle.companion.ui.design.OverflowMenu
import io.github.mickeiik.izle.companion.ui.design.ProgressBar
import io.github.mickeiik.izle.companion.ui.design.QuietSelect
import io.github.mickeiik.izle.companion.ui.design.SearchField
import io.github.mickeiik.izle.companion.ui.design.Tone
import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.data.api.CatalogHit
import io.github.mickeiik.izle.data.api.CatalogIssue
import io.github.mickeiik.izle.data.api.CatalogSearch

/**
 * The Catalog tab of a TV's page (docs/ux/companion-catalog.md): the server's catalog seen from this TV, searched and
 * filtered, with What's new, and the tab's ⋮ (Reload catalog, About the catalog). A tap on a show calls [onOpenShow];
 * messages go to [onMessage] (the host's snackbar).
 */
@Composable
fun CatalogTab(
    api: ApiClient,
    tvId: String,
    tvName: String,
    onOpenShow: (itemId: String) -> Unit,
    onMessage: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    // Per client too, as Home: a phone paired anew gets a new one.
    val vm: CatalogViewModel = viewModel(key = "catalog-$tvId-${System.identityHashCode(api)}") { CatalogViewModel(api, tvId) }
    val res = resources()
    val message by rememberUpdatedState(onMessage)
    var refused by remember { mutableStateOf<List<CatalogIssue>?>(null) }
    var about by remember { mutableStateOf(false) }
    LaunchedEffect(vm) { vm.start() }
    LaunchedEffect(vm) {
        vm.notices.collect { n ->
            when (n) {
                is CatalogNotice.Failed -> message(errorText(res, n.error))
                is CatalogNotice.Reloaded -> message(res.getString(R.string.catalog_reloaded, n.buildId))
                is CatalogNotice.Added -> message(res.getString(R.string.home_added_home, n.title))
                is CatalogNotice.ReloadRefused -> refused = n.issues
            }
        }
    }
    val state by vm.state.collectAsStateWithLifecycle()
    val whatsNew by vm.whatsNew.collectAsStateWithLifecycle()

    CatalogList(vm, state, api, onOpenShow, onAbout = { about = true }, modifier)

    whatsNew?.let { w -> WhatsNewScreen(w, state, api, vm, onOpenShow) }
    refused?.let { ReloadRefusedDialog(it, onDismiss = { refused = null }) }
    if (about) state.catalog?.let { AboutDialog(it, onDismiss = { about = false }) }
}

@Composable
private fun CatalogList(
    vm: CatalogViewModel,
    state: CatalogState,
    api: ApiClient,
    onOpenShow: (String) -> Unit,
    onAbout: () -> Unit,
    modifier: Modifier,
) {
    val res = resources()
    val space = IzleTheme.spacing
    val list = rememberLazyListState(vm.scrollIndex, vm.scrollOffset)
    DisposableEffect(list) {
        onDispose {
            vm.scrollIndex = list.firstVisibleItemIndex
            vm.scrollOffset = list.firstVisibleItemScrollOffset
        }
    }
    // A new search starts at the top; coming back from a show does not.
    val seen = remember { mutableIntStateOf(state.generation) }
    LaunchedEffect(state.generation) {
        if (state.generation != seen.intValue) {
            seen.intValue = state.generation
            list.scrollToItem(0)
        }
    }
    val nearEnd by remember {
        derivedStateOf { (list.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0) >= list.layoutInfo.totalItemsCount - 5 }
    }
    LaunchedEffect(nearEnd, state.next) { if (nearEnd) vm.loadMore() }

    Column(modifier.fillMaxSize()) {
        Box(Modifier.fillMaxWidth().height(IzleTheme.sizes.progress)) {
            if (state.loading || state.reloading) ProgressBar(null)
        }
        SearchField(
            state.query,
            onValueChange = vm::setQuery,
            placeholder = stringResource(R.string.catalog_search),
            modifier = Modifier.padding(horizontal = space.lg).padding(top = space.sm),
        )
        Filters(state, vm, Modifier.padding(vertical = space.md))
        LazyColumn(state = list, modifier = Modifier.fillMaxSize()) {
            state.newestBuild?.let { build ->
                item(key = "whats-new") {
                    ListRow(
                        stringResource(R.string.whats_new),
                        supporting = whatsNewRowText(res, build),
                        leading = { Icon(IzleIcons.Sparkle, contentDescription = null, tint = IzleTheme.colors.accent, modifier = Modifier.size(IzleTheme.sizes.icon)) },
                        trailing = { Chevron() },
                        onClick = vm::openWhatsNew,
                    )
                }
            }
            item(key = "count") { CountLine(state, vm, onAbout) }
            if (state.reloading) {
                item(key = "reloading") { Caption(stringResource(R.string.catalog_reloading), Modifier.padding(horizontal = space.lg, vertical = space.sm)) }
            }
            state.error?.let { error ->
                item(key = "error") {
                    Column(Modifier.padding(horizontal = space.lg, vertical = space.md), verticalArrangement = Arrangement.spacedBy(space.sm)) {
                        Caption(stringResource(R.string.catalog_load_failed, errorText(res, error)), tone = Tone.Danger)
                        IzleButton(stringResource(R.string.try_again), onClick = vm::retry, kind = ButtonKind.Quiet)
                    }
                }
            }
            if (state.searched && !state.loading && state.error == null && state.items.isEmpty()) {
                item(key = "empty") {
                    EmptyState(
                        stringResource(if (state.notOnHome) R.string.catalog_all_on_home else R.string.catalog_nothing_matches),
                        Modifier.padding(space.lg),
                    )
                }
            }
            items(state.items, key = { it.id }) { hit ->
                ShowRow(hit, api, onHome = state.isOnHome(hit.id), withNew = state.onlyNew, onClick = { onOpenShow(hit.id) })
            }
        }
    }
}

/** Films, Series, Channels (any of them), New (when a build added something) and Not on Home, in one scrolling line. */
@Composable
private fun Filters(state: CatalogState, vm: CatalogViewModel, modifier: Modifier = Modifier) {
    val res = resources()
    ChipRow(modifier) {
        for ((kind, label) in KINDS) {
            FilterChip(res.getString(label), selected = kind in state.kinds, onClick = { vm.toggleKind(kind) })
        }
        if (state.newSince != null || state.onlyNew) {
            FilterChip(stringResource(R.string.catalog_filter_new), selected = state.onlyNew, onClick = vm::toggleNew)
        }
        FilterChip(stringResource(R.string.catalog_filter_not_on_home), selected = state.notOnHome, onClick = vm::toggleNotOnHome)
    }
}

/** "142 shows", then the sort and the tab's ⋮ at the right. */
@Composable
private fun CountLine(state: CatalogState, vm: CatalogViewModel, onAbout: () -> Unit) {
    val res = resources()
    Row(
        Modifier.fillMaxWidth().padding(start = IzleTheme.spacing.lg, end = IzleTheme.spacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            if (state.searched) pluralStringResource(R.plurals.catalog_shows, state.total, state.total) else "",
            style = IzleTheme.type.caption,
            color = IzleTheme.colors.textSecondary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        QuietSelect(
            sortLabel(res, state.sort),
            SORTS.map { sort -> MenuItem(sortLabel(res, sort), { vm.setSort(sort) }, checked = sort == state.sort) },
            description = stringResource(R.string.catalog_sort),
        )
        OverflowMenu(
            stringResource(R.string.catalog_options),
            listOf(
                MenuItem(stringResource(R.string.catalog_reload), vm::reload, enabled = !state.reloading),
                MenuItem(stringResource(R.string.catalog_about), onAbout, enabled = state.catalog != null),
            ),
        )
    }
}

/** A show: poster, title, "Series · 2013 · 3 episodes", and "On Home" in `textMuted` at the end when this TV has it. */
@Composable
private fun ShowRow(hit: CatalogHit, api: ApiClient, onHome: Boolean, withNew: Boolean, onClick: () -> Unit) {
    ListRow(
        hit.title,
        supporting = catalogLine(resources(), hit, withNew),
        leading = { RowPoster(api, hit.posterUrl) },
        trailing = if (onHome) ({ OnHome() }) else null,
        onClick = onClick,
    )
}

/** "On Home", muted: what this TV has already. */
@Composable
internal fun OnHome() {
    Text(stringResource(R.string.catalog_on_home), style = IzleTheme.type.caption, color = IzleTheme.colors.textMuted, maxLines = 1)
}

@Composable
internal fun Chevron() {
    Icon(
        Icons.AutoMirrored.Filled.KeyboardArrowRight,
        contentDescription = null,
        tint = IzleTheme.colors.textMuted,
        modifier = Modifier.size(IzleTheme.sizes.icon),
    )
}

private val KINDS = listOf("movie" to R.string.home_kind_movie, "series" to R.string.home_kind_series, "live" to R.string.home_kind_live)
private val SORTS = listOf(CatalogSearch.SORT_TITLE, CatalogSearch.SORT_NEWEST, CatalogSearch.SORT_YEAR)
