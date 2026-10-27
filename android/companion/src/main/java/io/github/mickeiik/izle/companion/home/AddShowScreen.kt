package io.github.mickeiik.izle.companion.home

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import coil3.compose.AsyncImage
import io.github.mickeiik.izle.companion.R
import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.data.api.HomeSection

/**
 * Add show, over the whole screen: a catalog search that leaves out what is on this TV and what cannot play, by kind
 * (Films, Series, Channels), paged as the list is scrolled; Add to picks the section ("No title" unless chosen), Add
 * puts the show at its end. Back or ✕ closes it.
 */
@OptIn(ExperimentalMaterial3Api::class)
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
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize()) {
                TopAppBar(
                    title = { Text(stringResource(R.string.home_add_show)) },
                    navigationIcon = { IconButton(onClick = onClose) { Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.home_close)) } },
                )
                Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = search.query,
                        onValueChange = vm::setQuery,
                        leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
                        placeholder = { Text(stringResource(R.string.home_search)) },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        for ((kind, label) in KINDS) {
                            FilterChip(selected = kind in search.kinds, onClick = { vm.toggleKind(kind) }, label = { Text(stringResource(label), maxLines = 1) })
                        }
                    }
                    AddToPicker(sections, search.addTo, onPick = vm::setAddTo)
                }
                if (search.loading) LinearProgressIndicator(Modifier.fillMaxWidth().padding(top = 8.dp)) else Spacer(Modifier.padding(top = 12.dp))
                search.error?.let {
                    Text(errorText(res, it), color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp))
                }
                if (!search.loading && search.error == null && search.items.isEmpty()) {
                    Text(stringResource(R.string.home_no_results, tvName), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(16.dp))
                }
                val list = rememberLazyListState()
                val nearEnd by remember {
                    derivedStateOf { (list.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0) >= list.layoutInfo.totalItemsCount - 5 }
                }
                LaunchedEffect(nearEnd, search.items.size) { if (nearEnd) vm.loadMore() }
                LazyColumn(state = list, modifier = Modifier.fillMaxSize()) {
                    items(search.items, key = { it.id }) { hit ->
                        ListItem(
                            leadingContent = { HitPoster(api, hit.posterUrl) },
                            headlineContent = { Text(hit.title, maxLines = 2, overflow = TextOverflow.Ellipsis) },
                            supportingContent = { Text(hitLine(res, hit), maxLines = 1) },
                            trailingContent = {
                                FilledTonalButton(onClick = { vm.add(hit) }, enabled = search.adding == null, modifier = Modifier.widthIn(min = 72.dp)) {
                                    Label(stringResource(R.string.home_add))
                                }
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
    var open by remember { mutableStateOf(false) }
    val current = sections.firstOrNull { it.id == addTo } ?: sections.firstOrNull { it.id == UNTITLED_SECTION }
    Box {
        OutlinedButton(onClick = { open = true }, modifier = Modifier.fillMaxWidth()) {
            Text(
                stringResource(R.string.home_add_to_section, sectionTitle(res, current?.title)),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                textAlign = TextAlign.Center,
                modifier = Modifier.weight(1f, fill = false),
            )
            Icon(Icons.Filled.ArrowDropDown, contentDescription = null)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            for (s in sections) {
                DropdownMenuItem(text = { Text(sectionTitle(res, s.title), maxLines = 1, overflow = TextOverflow.Ellipsis) }, onClick = {
                    open = false
                    onPick(s.id)
                })
            }
        }
    }
}

@Composable
private fun HitPoster(api: ApiClient, posterUrl: String?) {
    val url = remember(posterUrl) { api.resolve(posterUrl)?.toString() }
    Box(Modifier.size(width = 40.dp, height = 60.dp).clip(RoundedCornerShape(4.dp)).background(MaterialTheme.colorScheme.surfaceVariant), contentAlignment = Alignment.Center) {
        if (url != null) AsyncImage(url, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
    }
}

private val KINDS = listOf("movie" to R.string.home_kind_movie, "series" to R.string.home_kind_series, "live" to R.string.home_kind_live)
