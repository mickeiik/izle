package io.github.mickeiik.izle.companion.home

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import io.github.mickeiik.izle.companion.R
import io.github.mickeiik.izle.companion.tv.episodeName
import io.github.mickeiik.izle.companion.ui.design.IzleTheme
import io.github.mickeiik.izle.companion.ui.design.Poster
import io.github.mickeiik.izle.data.api.AdminEpisode
import io.github.mickeiik.izle.data.api.AdminHomeEntry
import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.data.api.HomeSection
import io.github.mickeiik.izle.data.api.HomeSectionInfo

/**
 * The Home tab of a TV's page: the TV's Home as a list of sections and their shows, arranged by drag and drop, a
 * show's sheet (play, continue from, move, remove), the sections' menus, Add show and the grid size
 * (docs/ux/companion-home.md). Messages go to [onMessage] (the host's snackbar).
 */
@Composable
fun HomeTab(api: ApiClient, tvId: String, tvName: String, onMessage: (String) -> Unit, modifier: Modifier = Modifier) {
    val vm: HomeViewModel = viewModel(key = "home-$tvId") { HomeViewModel(api, tvId) }
    val res = resources()
    val message by rememberUpdatedState(onMessage)
    val name by rememberUpdatedState(tvName)
    LaunchedEffect(vm) { vm.follow() }
    LaunchedEffect(vm) { vm.notices.collect { message(noticeText(res, it, name)) } }
    val state by vm.state.collectAsStateWithLifecycle()
    HomeList(vm, state, api, tvName, modifier)
}

/** What a dialog of the tab is open for. */
private sealed interface HomeDialog {
    data object Grid : HomeDialog
    data object NewSection : HomeDialog
    data class Rename(val sectionId: String) : HomeDialog
    data class Delete(val sectionId: String) : HomeDialog
    data class MoveTo(val itemId: String) : HomeDialog
    data class Episodes(val itemId: String) : HomeDialog
}

@Composable
private fun HomeList(vm: HomeViewModel, state: HomeState, api: ApiClient, tvName: String, modifier: Modifier) {
    val list = rememberLazyListState()
    val drag = rememberHomeDragState(
        list,
        sections = { vm.state.value.sections },
        canStart = { !vm.state.value.saving },
        onDrop = vm::move,
    )
    var dialog by remember { mutableStateOf<HomeDialog?>(null) }
    var sheetFor by rememberSaveable { mutableStateOf<String?>(null) }
    var adding by rememberSaveable { mutableStateOf(false) }

    Column(modifier = modifier.fillMaxSize()) {
        if (state.loading || state.saving) LinearProgressIndicator(modifier = Modifier.fillMaxWidth()) else HorizontalDivider()
        if (!state.loaded) {
            state.loadError?.let { error ->
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(stringResource(R.string.home_load_failed), style = MaterialTheme.typography.bodyLarge)
                    Text(errorText(resources(), error), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                    OutlinedButton(onClick = vm::retry, enabled = !state.loading) { Label(stringResource(R.string.try_again)) }
                }
            }
            return@Column
        }
        val sections = drag.preview ?: state.sections
        val rows = homeRows(sections, state.entries)
        LazyColumn(state = list, modifier = Modifier.fillMaxSize().homeDragContainer(drag)) {
            item(key = "top") {
                TopLine(state, onGrid = { dialog = HomeDialog.Grid })
            }
            item(key = "actions") {
                Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Button(onClick = { vm.openSearch(); adding = true }, modifier = Modifier.weight(1f)) {
                        Icon(Icons.Filled.Add, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(8.dp))
                        Label(stringResource(R.string.home_add_show))
                    }
                    OutlinedButton(onClick = { dialog = HomeDialog.NewSection }, modifier = Modifier.weight(1f)) {
                        Icon(Icons.Filled.Add, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(8.dp))
                        Label(stringResource(R.string.home_new_section_button))
                    }
                }
            }
            if (state.showCount == 0) {
                item(key = "nothing") {
                    Text(
                        stringResource(R.string.home_nothing_yet),
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                    )
                }
            }
            items(rows, key = { it.key }) { row ->
                when (row) {
                    is HomeRow.Header -> SectionHeader(
                        row,
                        onRename = { dialog = HomeDialog.Rename(row.section.id) },
                        onLayout = { vm.setLayout(row.section.id, it) },
                        onMove = { vm.moveSection(row.section.id, it) },
                        onDelete = { dialog = HomeDialog.Delete(row.section.id) },
                        modifier = Modifier.animateItem(),
                    )
                    is HomeRow.Empty -> Text(
                        stringResource(R.string.home_empty_section),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.animateItem().fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
                    )
                    is HomeRow.Show -> {
                        val dragged = drag.draggedId == row.itemId
                        ShowRow(
                            row,
                            api,
                            dragged = dragged,
                            handle = Modifier.homeDragHandle(drag, row.itemId),
                            onOpen = { sheetFor = row.itemId },
                            onRemove = { vm.remove(row.itemId) },
                            modifier = if (dragged) Modifier.zIndex(1f).graphicsLayer { translationY = drag.draggedOffset } else Modifier.animateItem(),
                        )
                    }
                }
            }
            item(key = "bottom") { Spacer(Modifier.height(24.dp)) }
        }
    }

    sheetFor?.let { itemId ->
        val place = placeOf(state.sections, itemId)
        val section = place?.let { state.section(it.sectionId) }
        if (place == null || section == null) {
            // The show left Home (here or elsewhere): its sheet closes.
            LaunchedEffect(itemId) { sheetFor = null }
        } else {
            ShowSheet(
                entry = state.entries[itemId],
                itemId = itemId,
                section = section,
                index = place.position,
                sectionCount = state.sections.size,
                tvName = tvName,
                onDismiss = { sheetFor = null },
                onPlay = { vm.play(itemId) },
                onContinue = { vm.loadEpisodes(itemId); dialog = HomeDialog.Episodes(itemId) },
                onMoveTo = { dialog = HomeDialog.MoveTo(itemId) },
                onFirst = { vm.move(itemId, HomePlace(section.id, 0)) },
                onRemove = { vm.remove(itemId) },
            )
        }
    }

    if (adding) {
        val search by vm.search.collectAsStateWithLifecycle()
        AddShowScreen(search, state.sections, api, tvName, vm, onClose = { adding = false })
    }

    when (val d = dialog) {
        null -> Unit
        HomeDialog.Grid -> GridDialog(state.columns, state.rows, onSave = { c, r -> vm.setGrid(c, r) }, onDismiss = { dialog = null })
        HomeDialog.NewSection -> {
            val full = state.titledCount >= state.sectionsMax
            TitleDialog(
                title = stringResource(R.string.home_new_section),
                initial = "",
                confirm = stringResource(R.string.home_add),
                note = if (full) stringResource(R.string.home_sections_full, state.sectionsMax) else null,
                enabled = !full,
                onConfirm = vm::addSection,
                onDismiss = { dialog = null },
            )
        }
        is HomeDialog.Rename -> state.section(d.sectionId)?.let { s ->
            TitleDialog(
                title = stringResource(R.string.home_rename_section),
                initial = s.title.orEmpty(),
                confirm = stringResource(R.string.home_save),
                onConfirm = { vm.rename(s.id, it) },
                onDismiss = { dialog = null },
            )
        } ?: LaunchedEffect(d) { dialog = null }
        is HomeDialog.Delete -> state.section(d.sectionId)?.let { s ->
            DeleteDialog(s, onDelete = { vm.deleteSection(s.id) }, onDismiss = { dialog = null })
        } ?: LaunchedEffect(d) { dialog = null }
        is HomeDialog.MoveTo -> {
            val from = placeOf(state.sections, d.itemId)
            if (from == null) LaunchedEffect(d) { dialog = null }
            else MoveToDialog(state.sections, from.sectionId, onPick = { target ->
                dialog = null
                sheetFor = null
                vm.move(d.itemId, HomePlace(target.id, target.itemIds.size))
            }, onDismiss = { dialog = null })
        }
        is HomeDialog.Episodes -> {
            val pick by vm.episodes.collectAsStateWithLifecycle()
            val entry = state.entries[d.itemId]
            EpisodesDialog(pick, entry, onPick = { vm.continueFrom(d.itemId, it) }, onDismiss = {
                vm.closeEpisodes()
                dialog = null
            })
            if (pick == null && dialog == d) {
                // continueFrom closed the pick once the cursor was set.
                LaunchedEffect(d) { dialog = null }
            }
        }
    }
}

/** "Grid 4 × 2 · 24 shows" and the tab's ⋮ (Grid size). */
@Composable
private fun TopLine(state: HomeState, onGrid: () -> Unit) {
    var menu by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(
            stringResource(R.string.home_summary, state.columns, state.rows, pluralStringResource(R.plurals.home_shows, state.showCount, state.showCount)),
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.weight(1f),
        )
        Box {
            IconButton(onClick = { menu = true }) { Icon(Icons.Filled.MoreVert, contentDescription = stringResource(R.string.home_options)) }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                DropdownMenuItem(text = { Text(stringResource(R.string.home_grid_size)) }, onClick = { menu = false; onGrid() })
            }
        }
    }
}

@Composable
private fun SectionHeader(
    row: HomeRow.Header,
    onRename: () -> Unit,
    onLayout: (String) -> Unit,
    onMove: (Int) -> Unit,
    onDelete: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val s = row.section
    val title = sectionTitle(resources(), s.title)
    var menu by remember { mutableStateOf(false) }
    val oneLine = s.layout == HomeSectionInfo.LAYOUT_ROW
    Row(
        modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainer).padding(start = 16.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                stringResource(if (oneLine) R.string.home_section_row else R.string.home_section_grid, row.count),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Box {
            IconButton(onClick = { menu = true }) {
                Icon(Icons.Filled.MoreVert, contentDescription = stringResource(R.string.home_section_options, title))
            }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                if (s.title != null) {
                    DropdownMenuItem(text = { Text(stringResource(R.string.home_rename)) }, onClick = { menu = false; onRename() })
                }
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.home_one_line)) },
                    leadingIcon = { if (oneLine) Icon(Icons.Filled.Check, contentDescription = null) else Spacer(Modifier.size(24.dp)) },
                    onClick = {
                        menu = false
                        onLayout(if (oneLine) HomeSectionInfo.LAYOUT_GRID else HomeSectionInfo.LAYOUT_ROW)
                    },
                )
                DropdownMenuItem(text = { Text(stringResource(R.string.home_move_up)) }, enabled = row.index > 0, onClick = { menu = false; onMove(-1) })
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.home_move_down)) },
                    enabled = row.index < row.sectionCount - 1,
                    onClick = { menu = false; onMove(1) },
                )
                if (s.title != null) {
                    DropdownMenuItem(text = { Text(stringResource(R.string.home_delete)) }, onClick = { menu = false; onDelete() })
                }
            }
        }
    }
}

@Composable
private fun ShowRow(
    row: HomeRow.Show,
    api: ApiClient,
    dragged: Boolean,
    handle: Modifier,
    onOpen: () -> Unit,
    onRemove: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val res = resources()
    val entry = row.entry
    val hidden = hiddenReason(entry)
    // A show gone from the catalog has no title any more: its id says which it was.
    val title = entry?.title ?: row.itemId
    Surface(
        modifier = modifier.fillMaxWidth(),
        tonalElevation = if (dragged) 6.dp else 0.dp,
        shadowElevation = if (dragged) 6.dp else 0.dp,
    ) {
        Row(
            Modifier.fillMaxWidth().clickable(onClick = onOpen).heightIn(min = 72.dp).padding(start = 16.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(Modifier.weight(1f).alpha(if (hidden != null) 0.5f else 1f), verticalAlignment = Alignment.CenterVertically) {
                RowPoster(api, entry?.posterUrl)
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(title, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (hidden != null) {
                        Text(stringResource(hidden), style = MaterialTheme.typography.bodySmall, maxLines = 2, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    } else if (entry != null) {
                        Text(
                            okPlaysText(res, entry),
                            style = MaterialTheme.typography.bodySmall,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                            VerdictChip(verdictOf(entry.check))
                            if (entry.newEpisodes > 0) {
                                Text(
                                    pluralStringResource(R.plurals.home_new_episodes, entry.newEpisodes, entry.newEpisodes),
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.secondary,
                                )
                            }
                        }
                    }
                }
            }
            if (hidden != null) {
                TextButton(onClick = onRemove) { Label(stringResource(R.string.home_remove)) }
            }
            Box(
                handle.size(48.dp).semantics { contentDescription = res.getString(R.string.home_drag, title) },
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Filled.Menu, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

/** A show's poster in a row, resolved against the server. */
@Composable
internal fun RowPoster(api: ApiClient, posterUrl: String?) {
    val url = remember(posterUrl) { api.resolve(posterUrl)?.toString() }
    Poster(url, IzleTheme.sizes.posterRow)
}

/** A button's label: one line, centred. */
@Composable
internal fun RowScope.Label(text: String) {
    Text(text, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
}

/** A full-width button's label: one line, centred across the whole button. */
@Composable
internal fun RowScope.WideLabel(text: String) {
    Text(text, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center, modifier = Modifier.weight(1f))
}

@Composable
private fun TitleDialog(
    title: String,
    initial: String,
    confirm: String,
    onConfirm: (String) -> Unit,
    onDismiss: () -> Unit,
    note: String? = null,
    enabled: Boolean = true,
) {
    var text by rememberSaveable { mutableStateOf(initial) }
    val ok = enabled && text.isNotBlank() && text.trim().length <= TITLE_MAX
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                note?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                if (enabled) {
                    OutlinedTextField(
                        value = text,
                        onValueChange = { text = it.take(TITLE_MAX) },
                        label = { Text(stringResource(R.string.home_section_title)) },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { onDismiss(); onConfirm(text) }, enabled = ok) { Label(confirm) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Label(stringResource(R.string.cancel)) } },
    )
}

@Composable
private fun DeleteDialog(section: HomeSection, onDelete: () -> Unit, onDismiss: () -> Unit) {
    val n = section.itemIds.size
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.home_delete_title, section.title.orEmpty())) },
        text = { Text(if (n == 0) stringResource(R.string.home_delete_empty) else pluralStringResource(R.plurals.home_delete_text, n, n)) },
        confirmButton = { TextButton(onClick = { onDismiss(); onDelete() }) { Label(stringResource(R.string.home_delete)) } },
        dismissButton = { TextButton(onClick = onDismiss) { Label(stringResource(R.string.home_keep)) } },
    )
}

@Composable
private fun MoveToDialog(sections: List<HomeSection>, current: String, onPick: (HomeSection) -> Unit, onDismiss: () -> Unit) {
    val res = resources()
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.home_move_title)) },
        text = {
            LazyColumn {
                items(sections, key = { it.id }) { s ->
                    val name = sectionTitle(res, s.title)
                    val here = s.id == current
                    Text(
                        if (here) stringResource(R.string.home_current_section, name) else name,
                        style = MaterialTheme.typography.bodyLarge,
                        color = if (here) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.fillMaxWidth().clickable(enabled = !here) { onPick(s) }.padding(vertical = 12.dp),
                    )
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss) { Label(stringResource(R.string.cancel)) } },
    )
}

@Composable
private fun EpisodesDialog(pick: EpisodePick?, entry: AdminHomeEntry?, onPick: (AdminEpisode) -> Unit, onDismiss: () -> Unit) {
    val title = entry?.title.orEmpty()
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.home_continue_title, title), maxLines = 2, overflow = TextOverflow.Ellipsis) },
        text = {
            when {
                pick == null || pick.loading -> LinearProgressIndicator(Modifier.fillMaxWidth())
                pick.error != null -> Text(errorText(resources(), pick.error), color = MaterialTheme.colorScheme.error)
                pick.episodes.isEmpty() -> Text(stringResource(R.string.home_no_episodes))
                else -> LazyColumn {
                    items(pick.episodes, key = { it.id }) { e ->
                        val name = episodeName(e)
                        val now = e.id == entry?.continueAt?.episodeId
                        Text(
                            if (now) stringResource(R.string.home_now_marker, name) else name,
                            style = MaterialTheme.typography.bodyLarge,
                            fontWeight = if (now) FontWeight.SemiBold else null,
                            modifier = Modifier.fillMaxWidth().clickable { onPick(e) }.padding(vertical = 12.dp),
                        )
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss) { Label(stringResource(R.string.cancel)) } },
    )
}

@Composable
private fun GridDialog(columns: Int, rows: Int, onSave: (Int, Int) -> Unit, onDismiss: () -> Unit) {
    var c by rememberSaveable { mutableIntStateOf(columns) }
    var r by rememberSaveable { mutableIntStateOf(rows) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.home_grid_size)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.home_grid_hint), style = MaterialTheme.typography.bodyMedium)
                Stepper(stringResource(R.string.home_columns), c, 3..10) { c = it }
                Stepper(stringResource(R.string.home_rows), r, 1..4) { r = it }
            }
        },
        confirmButton = {
            TextButton(onClick = { onDismiss(); onSave(c, r) }, enabled = c != columns || r != rows) { Label(stringResource(R.string.home_save)) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Label(stringResource(R.string.cancel)) } },
    )
}

@Composable
private fun Stepper(label: String, value: Int, range: IntRange, onChange: (Int) -> Unit) {
    val fewer = stringResource(R.string.home_fewer, label.lowercase())
    val more = stringResource(R.string.home_more, label.lowercase())
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
        StepButton("−", fewer, enabled = value > range.first) { onChange(value - 1) }
        Text(value.toString(), style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center, modifier = Modifier.width(40.dp))
        StepButton("+", more, enabled = value < range.last) { onChange(value + 1) }
    }
}

@Composable
private fun StepButton(sign: String, description: String, enabled: Boolean, onClick: () -> Unit) {
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        contentPadding = PaddingValues(0.dp),
        modifier = Modifier.size(48.dp).semantics(mergeDescendants = true) { contentDescription = description },
    ) {
        Text(sign, style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center, modifier = Modifier.clearAndSetSemantics {})
    }
}

private const val TITLE_MAX = 40
