package io.github.mickeiik.izle.companion.home

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import io.github.mickeiik.izle.companion.R
import io.github.mickeiik.izle.companion.ui.design.ButtonSize
import io.github.mickeiik.izle.companion.ui.design.Caption
import io.github.mickeiik.izle.companion.ui.design.ChoiceGrid
import io.github.mickeiik.izle.companion.ui.design.Hairline
import io.github.mickeiik.izle.companion.ui.design.IzleButton
import io.github.mickeiik.izle.companion.ui.design.IzleTheme
import io.github.mickeiik.izle.companion.ui.design.IzleTopBar
import io.github.mickeiik.izle.companion.ui.design.ListRow
import io.github.mickeiik.izle.companion.ui.design.MenuItem
import io.github.mickeiik.izle.companion.ui.design.ProgressBar
import io.github.mickeiik.izle.companion.ui.design.SelectButton
import io.github.mickeiik.izle.companion.ui.design.Tone
import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.data.api.HomeSection

/**
 * Add show, over the whole screen: a catalog search that leaves out what is on this TV and what cannot play, by kind
 * (Films, Series, Channels), paged as the list is scrolled; Add to picks the section ("No title" unless chosen), Add
 * puts the show at its end. Back closes it.
 */
@Composable
internal fun AddShowScreen(
    search: ShowSearch,
    sections: List<HomeSection>,
    api: ApiClient,
    tvName: String,
    vm: HomeViewModel,
    onClose: () -> Unit,
) {
    val res = resources()
    val space = IzleTheme.spacing
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize(), color = IzleTheme.colors.background) {
            Column(Modifier.fillMaxSize()) {
                IzleTopBar(stringResource(R.string.home_add_show), onBack = onClose)
                Column(Modifier.padding(horizontal = space.lg).padding(top = space.md), verticalArrangement = Arrangement.spacedBy(space.sm)) {
                    OutlinedTextField(
                        value = search.query,
                        onValueChange = vm::setQuery,
                        leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
                        placeholder = { Text(stringResource(R.string.home_search)) },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    ChoiceGrid(
                        KINDS,
                        label = { res.getString(it.second) },
                        selected = { it.first in search.kinds },
                        onSelect = { vm.toggleKind(it.first) },
                        size = ButtonSize.Small,
                    )
                    AddToPicker(sections, search.addTo, onPick = vm::setAddTo)
                }
                if (search.loading) ProgressBar(null, Modifier.padding(top = space.md)) else Hairline(Modifier.padding(top = space.md))
                search.error?.let { Caption(errorText(res, it), Modifier.padding(space.lg), tone = Tone.Danger) }
                if (!search.loading && search.error == null && search.items.isEmpty()) {
                    Caption(stringResource(R.string.home_no_results, tvName), Modifier.padding(space.lg))
                }
                val list = rememberLazyListState()
                val nearEnd by remember {
                    derivedStateOf { (list.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0) >= list.layoutInfo.totalItemsCount - 5 }
                }
                LaunchedEffect(nearEnd, search.items.size) { if (nearEnd) vm.loadMore() }
                LazyColumn(state = list, modifier = Modifier.fillMaxSize()) {
                    items(search.items, key = { it.id }) { hit ->
                        ListRow(
                            hit.title,
                            supporting = hitLine(res, hit),
                            leading = { RowPoster(api, hit.posterUrl) },
                            trailing = {
                                IzleButton(stringResource(R.string.home_add), onClick = { vm.add(hit) }, size = ButtonSize.Small, enabled = search.adding == null)
                            },
                        )
                    }
                }
            }
        }
    }
}

/** Add to: the sections by title ("No title" for the untitled one). */
@Composable
private fun AddToPicker(sections: List<HomeSection>, addTo: String, onPick: (String) -> Unit) {
    val res = resources()
    val current = sections.firstOrNull { it.id == addTo } ?: sections.firstOrNull { it.id == UNTITLED_SECTION }
    SelectButton(
        stringResource(R.string.home_add_to_section, sectionTitle(res, current?.title)),
        sections.map { s -> MenuItem(sectionTitle(res, s.title), { onPick(s.id) }) },
    )
}

private val KINDS = listOf("movie" to R.string.home_kind_movie, "series" to R.string.home_kind_series, "live" to R.string.home_kind_live)
