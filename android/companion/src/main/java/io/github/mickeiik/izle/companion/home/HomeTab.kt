package io.github.mickeiik.izle.companion.home

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
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
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.zIndex
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import io.github.mickeiik.izle.companion.R
import io.github.mickeiik.izle.companion.tv.episodeName
import io.github.mickeiik.izle.companion.ui.design.ButtonKind
import io.github.mickeiik.izle.companion.ui.design.ButtonRow
import io.github.mickeiik.izle.companion.ui.design.ButtonSize
import io.github.mickeiik.izle.companion.ui.design.Caption
import io.github.mickeiik.izle.companion.ui.design.EmptyState
import io.github.mickeiik.izle.companion.ui.design.Hairline
import io.github.mickeiik.izle.companion.ui.design.IzleButton
import io.github.mickeiik.izle.companion.ui.design.IzleIcons
import io.github.mickeiik.izle.companion.ui.design.IzleTheme
import io.github.mickeiik.izle.companion.ui.design.ListRow
import io.github.mickeiik.izle.companion.ui.design.MenuItem
import io.github.mickeiik.izle.companion.ui.design.OverflowMenu
import io.github.mickeiik.izle.companion.ui.design.Poster
import io.github.mickeiik.izle.companion.ui.design.ProgressBar
import io.github.mickeiik.izle.companion.ui.design.SectionHeader
import io.github.mickeiik.izle.companion.ui.design.Tone
import io.github.mickeiik.izle.data.api.AdminEpisode
import io.github.mickeiik.izle.data.api.AdminHomeEntry
import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.data.api.HomeSection
import io.github.mickeiik.izle.data.api.HomeSectionInfo

/**
 * The Home tab of a TV's page: the TV's Home as a list of sections and their shows, arranged by drag and drop, a
 * show's sheet (play, continue from, move, remove), the sections' menus, Add show and the grid size
 * (docs/ux/companion-home.md). Messages go to [onMessage] (the host's snackbar); a `401` to [onRevoked] (this phone was
 * disconnected).
 */
@Composable
fun HomeTab(api: ApiClient, tvId: String, tvName: String, onMessage: (String) -> Unit, onRevoked: () -> Unit, modifier: Modifier = Modifier) {
    // Per client too: a phone paired anew gets a new one, and a view model kept from before would go on with the old.
    val vm: HomeViewModel = viewModel(key = "home-$tvId-${System.identityHashCode(api)}") { HomeViewModel(api, tvId) }
    val res = resources()
    val message by rememberUpdatedState(onMessage)
    val name by rememberUpdatedState(tvName)
    LaunchedEffect(vm) { vm.follow() }
    LaunchedEffect(vm) { vm.notices.collect { message(noticeText(res, it, name, vm.state.value.sectionsMax)) } }
    val state by vm.state.collectAsStateWithLifecycle()
    val revoked by vm.revoked.collectAsStateWithLifecycle()
    val onRevokedNow by rememberUpdatedState(onRevoked)
    LaunchedEffect(revoked) { if (revoked) onRevokedNow() }
    HomeList(vm, state, api, tvName, modifier)
}

/** What a dialog of the tab is open for. */
private sealed interface HomeDialog {
    data object Grid : HomeDialog
    data object CheckHome : HomeDialog
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
    val check by vm.checks.run.collectAsStateWithLifecycle()
    val res = resources()

    Column(modifier = modifier.fillMaxSize()) {
        if (state.loading || state.saving) ProgressBar(null) else Hairline()
        if (!state.loaded) {
            state.loadError?.let { error ->
                Column(Modifier.padding(IzleTheme.spacing.lg), verticalArrangement = Arrangement.spacedBy(IzleTheme.spacing.sm)) {
                    Text(stringResource(R.string.home_load_failed), style = IzleTheme.type.body)
                    Caption(errorText(res, error), tone = Tone.Danger)
                    IzleButton(stringResource(R.string.try_again), onClick = vm::retry, enabled = !state.loading)
                }
            }
            return@Column
        }
        check?.let { CheckStrip(it, onStop = vm.checks::stop, onDismiss = vm.checks::dismiss) }
        val sections = drag.preview ?: state.sections
        val rows = homeRows(sections, state.entries)
        LazyColumn(state = list, modifier = Modifier.weight(1f).fillMaxWidth().homeDragContainer(drag)) {
            item(key = "top") {
                TopLine(state, onGrid = { dialog = HomeDialog.Grid }, onCheck = { dialog = HomeDialog.CheckHome })
            }
            if (state.showCount == 0) {
                item(key = "nothing") {
                    EmptyState(stringResource(R.string.home_nothing_yet), Modifier.padding(horizontal = IzleTheme.spacing.lg, vertical = IzleTheme.spacing.sm))
                }
            }
            items(rows, key = { it.key }) { row ->
                when (row) {
                    is HomeRow.Header -> HomeSectionHeader(
                        row,
                        onRename = { dialog = HomeDialog.Rename(row.section.id) },
                        onLayout = { vm.setLayout(row.section.id, it) },
                        onMove = { vm.moveSection(row.section.id, it) },
                        onDelete = { dialog = HomeDialog.Delete(row.section.id) },
                        modifier = Modifier.animateItem(),
                    )
                    is HomeRow.Empty -> Caption(
                        stringResource(R.string.home_empty_section),
                        Modifier.animateItem().fillMaxWidth().padding(horizontal = IzleTheme.spacing.lg, vertical = IzleTheme.spacing.md),
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
            item(key = "bottom") { Spacer(Modifier.height(IzleTheme.spacing.sm)) }
        }
        // Under the list, above the tabs, as in the mockup: + Section, then the screen's primary + Add show.
        Hairline()
        ButtonRow(Modifier.padding(horizontal = IzleTheme.spacing.lg, vertical = IzleTheme.spacing.sm)) {
            IzleButton(
                stringResource(R.string.home_new_section_button),
                onClick = { dialog = HomeDialog.NewSection },
                icon = Icons.Filled.Add,
            )
            IzleButton(
                stringResource(R.string.home_add_show),
                onClick = { vm.openSearch(); adding = true },
                kind = ButtonKind.Primary,
                icon = Icons.Filled.Add,
            )
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
                poster = { RowPoster(api, state.entries[itemId]?.posterUrl) },
                onDismiss = { sheetFor = null },
                onPlay = { vm.play(itemId) },
                onContinue = { vm.loadEpisodes(itemId); dialog = HomeDialog.Episodes(itemId) },
                onMoveTo = { dialog = HomeDialog.MoveTo(itemId) },
                onFirst = { vm.move(itemId, HomePlace(section.id, 0)) },
                onCheck = { vm.checks.startShow(itemId) },
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
        HomeDialog.CheckHome -> CheckHomeSheet(onPick = { vm.checks.startHome(vm.tvId, it) }, onDismiss = { dialog = null })
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

/** "6 shows · grid 4 × 2" and the tab's ⋮ (Grid size, Check Home…). */
@Composable
private fun TopLine(state: HomeState, onGrid: () -> Unit, onCheck: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(start = IzleTheme.spacing.lg, end = IzleTheme.spacing.xs), verticalAlignment = Alignment.CenterVertically) {
        Caption(
            stringResource(R.string.home_summary, state.columns, state.rows, pluralStringResource(R.plurals.home_shows, state.showCount, state.showCount)),
            Modifier.weight(1f),
        )
        OverflowMenu(stringResource(R.string.home_options), listOf(
                MenuItem(stringResource(R.string.home_grid_size), onGrid),
                MenuItem(stringResource(R.string.home_check_home), onCheck),
            ),)
    }
}

@Composable
private fun HomeSectionHeader(
    row: HomeRow.Header,
    onRename: () -> Unit,
    onLayout: (String) -> Unit,
    onMove: (Int) -> Unit,
    onDelete: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val s = row.section
    val title = sectionTitle(resources(), s.title)
    val oneLine = s.layout == HomeSectionInfo.LAYOUT_ROW
    val titled = s.title != null
    val items = buildList {
        if (titled) add(MenuItem(stringResource(R.string.home_rename), onRename))
        add(
            MenuItem(
                stringResource(R.string.home_one_line),
                { onLayout(if (oneLine) HomeSectionInfo.LAYOUT_GRID else HomeSectionInfo.LAYOUT_ROW) },
                checked = oneLine,
            ),
        )
        add(MenuItem(stringResource(R.string.home_move_up), { onMove(-1) }, enabled = row.index > 0))
        add(MenuItem(stringResource(R.string.home_move_down), { onMove(1) }, enabled = row.index < row.sectionCount - 1))
        if (titled) add(MenuItem(stringResource(R.string.home_delete), onDelete))
    }
    SectionHeader(
        title,
        modifier,
        meta = stringResource(if (oneLine) R.string.home_section_row else R.string.home_section_grid, row.count),
        trailing = { OverflowMenu(stringResource(R.string.home_section_options, title), items) },
    )
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
    val verdict = verdictOf(entry?.check)
    ListRow(
        title,
        modifier.background(if (dragged) IzleTheme.colors.surface else IzleTheme.colors.background),
        supporting = when {
            hidden != null -> stringResource(hidden)
            // New episodes join the line: a chip would squeeze the title at phone width.
            entry != null -> okPlaysText(res, entry) +
                (if (entry.newEpisodes > 0) " · " + res.getQuantityString(R.plurals.home_new_episodes, entry.newEpisodes, entry.newEpisodes) else "")
            else -> null
        },
        supportingTone = if (hidden != null) Tone.Warning else Tone.Neutral,
        badge = if (hidden == null && verdict.worthAChip) ({ VerdictChip(verdict) }) else null,
        leading = { Box(Modifier.alpha(if (hidden != null) 0.5f else 1f)) { RowPoster(api, entry?.posterUrl) } },
        trailing = {
            if (hidden != null) {
                IzleButton(stringResource(R.string.home_remove), onClick = onRemove, kind = ButtonKind.Danger, size = ButtonSize.Small)
            }
            Box(
                handle.size(IzleTheme.sizes.remoteButton).semantics { contentDescription = res.getString(R.string.home_drag, title) },
                contentAlignment = Alignment.Center,
            ) {
                Icon(IzleIcons.DragHandle, contentDescription = null, tint = IzleTheme.colors.textMuted, modifier = Modifier.size(IzleTheme.sizes.icon))
            }
        },
        onClick = onOpen,
        divider = !dragged,
    )
}

/** A show's poster in a row, resolved against the server. */
@Composable
internal fun RowPoster(api: ApiClient, posterUrl: String?) {
    val url = remember(posterUrl) { api.resolve(posterUrl)?.toString() }
    Poster(url, IzleTheme.sizes.posterRow)
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
            Column(verticalArrangement = Arrangement.spacedBy(IzleTheme.spacing.sm)) {
                note?.let { Text(it) }
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
        confirmButton = { IzleButton(confirm, onClick = { onDismiss(); onConfirm(text) }, kind = ButtonKind.Primary, enabled = ok) },
        dismissButton = { IzleButton(stringResource(R.string.cancel), onClick = onDismiss, kind = ButtonKind.Quiet) },
    )
}

@Composable
private fun DeleteDialog(section: HomeSection, onDelete: () -> Unit, onDismiss: () -> Unit) {
    val n = section.itemIds.size
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.home_delete_title, section.title.orEmpty())) },
        text = { Text(if (n == 0) stringResource(R.string.home_delete_empty) else pluralStringResource(R.plurals.home_delete_text, n, n)) },
        confirmButton = { IzleButton(stringResource(R.string.home_delete), onClick = { onDismiss(); onDelete() }, kind = ButtonKind.Danger) },
        dismissButton = { IzleButton(stringResource(R.string.home_keep), onClick = onDismiss, kind = ButtonKind.Quiet) },
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
                    PickRow(if (here) stringResource(R.string.home_current_section, name) else name, enabled = !here, emphasised = false) { onPick(s) }
                }
            }
        },
        confirmButton = {},
        dismissButton = { IzleButton(stringResource(R.string.cancel), onClick = onDismiss, kind = ButtonKind.Quiet) },
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
                pick == null || pick.loading -> ProgressBar(null)
                pick.error != null -> Caption(errorText(resources(), pick.error), tone = Tone.Danger)
                pick.episodes.isEmpty() -> Text(stringResource(R.string.home_no_episodes))
                else -> LazyColumn {
                    items(pick.episodes, key = { it.id }) { e ->
                        val name = episodeName(e)
                        val now = e.id == entry?.continueAt?.episodeId
                        PickRow(if (now) stringResource(R.string.home_now_marker, name) else name, enabled = true, emphasised = now) { onPick(e) }
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = { IzleButton(stringResource(R.string.cancel), onClick = onDismiss, kind = ButtonKind.Quiet) },
    )
}

/** One choice of a picking dialog: a line of text, [emphasised] for the current one, muted when it cannot be chosen. */
@Composable
private fun PickRow(text: String, enabled: Boolean, emphasised: Boolean, onClick: () -> Unit) {
    Text(
        text,
        style = if (emphasised) IzleTheme.type.heading else IzleTheme.type.rowTitle,
        color = if (enabled) IzleTheme.colors.textPrimary else IzleTheme.colors.textMuted,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.fillMaxWidth().clickable(enabled = enabled, onClick = onClick).padding(vertical = IzleTheme.spacing.md),
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
            Column(verticalArrangement = Arrangement.spacedBy(IzleTheme.spacing.sm)) {
                Caption(stringResource(R.string.home_grid_hint))
                Stepper(stringResource(R.string.home_columns), c, 3..10) { c = it }
                Stepper(stringResource(R.string.home_rows), r, 1..4) { r = it }
            }
        },
        confirmButton = {
            IzleButton(stringResource(R.string.home_save), onClick = { onDismiss(); onSave(c, r) }, kind = ButtonKind.Primary, enabled = c != columns || r != rows)
        },
        dismissButton = { IzleButton(stringResource(R.string.cancel), onClick = onDismiss, kind = ButtonKind.Quiet) },
    )
}

@Composable
private fun Stepper(label: String, value: Int, range: IntRange, onChange: (Int) -> Unit) {
    val fewer = stringResource(R.string.home_fewer, label.lowercase())
    val more = stringResource(R.string.home_more, label.lowercase())
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = IzleTheme.type.rowTitle, modifier = Modifier.weight(1f))
        StepButton("−", fewer, enabled = value > range.first) { onChange(value - 1) }
        Text(value.toString(), style = IzleTheme.type.heading, textAlign = TextAlign.Center, modifier = Modifier.width(IzleTheme.sizes.remoteButton))
        StepButton("+", more, enabled = value < range.last) { onChange(value + 1) }
    }
}

@Composable
private fun StepButton(sign: String, description: String, enabled: Boolean, onClick: () -> Unit) {
    IzleButton(
        sign,
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.width(IzleTheme.sizes.remoteButton).semantics { contentDescription = description },
    )
}

private const val TITLE_MAX = 40
