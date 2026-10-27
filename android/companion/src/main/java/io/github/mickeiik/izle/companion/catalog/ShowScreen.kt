package io.github.mickeiik.izle.companion.catalog

import android.content.res.Resources
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import io.github.mickeiik.izle.companion.R
import io.github.mickeiik.izle.companion.home.CheckStrip
import io.github.mickeiik.izle.companion.home.UNTITLED_SECTION
import io.github.mickeiik.izle.companion.home.VerdictChip
import io.github.mickeiik.izle.companion.home.errorText
import io.github.mickeiik.izle.companion.home.noticeText
import io.github.mickeiik.izle.companion.home.resources
import io.github.mickeiik.izle.companion.home.sectionTitle
import io.github.mickeiik.izle.companion.home.verdictOf
import io.github.mickeiik.izle.companion.home.worthAChip
import io.github.mickeiik.izle.companion.tv.episodeName
import io.github.mickeiik.izle.companion.tv.formatClock
import io.github.mickeiik.izle.companion.ui.design.ButtonKind
import io.github.mickeiik.izle.companion.ui.design.ButtonRow
import io.github.mickeiik.izle.companion.ui.design.ButtonSize
import io.github.mickeiik.izle.companion.ui.design.Caption
import io.github.mickeiik.izle.companion.ui.design.Hairline
import io.github.mickeiik.izle.companion.ui.design.IzleButton
import io.github.mickeiik.izle.companion.ui.design.IzleIcons
import io.github.mickeiik.izle.companion.ui.design.IzleTheme
import io.github.mickeiik.izle.companion.ui.design.ListRow
import io.github.mickeiik.izle.companion.ui.design.Poster
import io.github.mickeiik.izle.companion.ui.design.ProgressBar
import io.github.mickeiik.izle.companion.ui.design.SectionHeader
import io.github.mickeiik.izle.companion.ui.design.Tone
import io.github.mickeiik.izle.companion.ui.design.toneColor
import io.github.mickeiik.izle.data.api.AdminEpisode
import io.github.mickeiik.izle.data.api.AdminItem
import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.data.api.CheckRun
import io.github.mickeiik.izle.data.api.HomeSection

/**
 * A show's page for the TV [tvId] (docs/ux/companion-catalog.md, "A show's page"): the head, On Home / Add to Home
 * beside Play on <TV>, then the episodes (or a film's or channel's sources) with their checks, and an episode's sheet.
 * The host draws the top bar (back arrow and title); messages go to [onMessage].
 */
@Composable
fun ShowScreen(
    api: ApiClient,
    tvId: String,
    tvName: String,
    itemId: String,
    onMessage: (String) -> Unit,
    modifier: Modifier = Modifier,
    onTitle: (String) -> Unit = {},
) {
    val vm: ShowViewModel = viewModel(key = "show-$tvId-$itemId-${System.identityHashCode(api)}") { ShowViewModel(api, tvId, itemId) }
    val res = resources()
    val message by rememberUpdatedState(onMessage)
    val title by rememberUpdatedState(onTitle)
    val name by rememberUpdatedState(tvName)
    LaunchedEffect(vm) { vm.shown() }
    LaunchedEffect(vm) { vm.notices.collect { message(noticeText(res, it, name)) } }
    val state by vm.state.collectAsStateWithLifecycle()
    LaunchedEffect(state.item?.title) { state.item?.title?.let(title) }
    val run by vm.checks.run.collectAsStateWithLifecycle()
    val sheet by vm.sheet.collectAsStateWithLifecycle()
    var sheetFor by rememberSaveable { mutableStateOf<String?>(null) }

    ShowContent(
        state,
        run?.takeIf { it.target.itemId == itemId },
        api,
        tvName,
        actions = ShowActions(
            onRetry = vm::retry,
            onAdd = vm::addToHome,
            onRemove = vm::removeFromHome,
            onPlay = vm::play,
            onCheckAll = vm::checkAll,
            onCheckDirect = vm::checkDirect,
            onStopCheck = vm.checks::stop,
            onDismissCheck = vm.checks::dismiss,
            onEpisode = { e ->
                sheetFor = e.id
                vm.openEpisode(e)
            },
        ),
        modifier = modifier,
    )

    val episode = state.item?.episodes?.firstOrNull { it.id == sheetFor }
    // Back from the page (or a rotation) reopens the sheet with its sources read anew.
    // The view model's value, not the collected one: that lags a frame behind a tap's openEpisode.
    LaunchedEffect(episode?.id) { if (episode != null && vm.sheet.value?.episodeId != episode.id) vm.openEpisode(episode) }
    if (episode != null) {
        EpisodeSheet(
            episode,
            sheet?.takeIf { it.episodeId == episode.id },
            tvName,
            onPlay = { vm.play(episode) },
            onContinue = { vm.continueFrom(episode) },
            onCheck = vm::checkEpisode,
            onDismiss = {
                sheetFor = null
                vm.closeEpisode()
            },
        )
    }
}

/** What the page's controls do. */
internal class ShowActions(
    val onRetry: () -> Unit = {},
    val onAdd: (sectionId: String) -> Unit = {},
    val onRemove: () -> Unit = {},
    val onPlay: () -> Unit = {},
    val onCheckAll: () -> Unit = {},
    val onCheckDirect: () -> Unit = {},
    val onStopCheck: () -> Unit = {},
    val onDismissCheck: () -> Unit = {},
    val onEpisode: (AdminEpisode) -> Unit = {},
)

/** The page itself, from its [state] and the show's running [run] (stateless, for the screenshots too). */
@Composable
internal fun ShowContent(state: ShowState, run: CheckRun?, api: ApiClient, tvName: String, actions: ShowActions, modifier: Modifier = Modifier) {
    val res = resources()
    val s = IzleTheme.spacing
    Column(modifier.fillMaxSize()) {
        if (state.loading || state.saving) ProgressBar(null) else Hairline()
        val item = state.item
        if (item == null) {
            state.loadError?.let { error ->
                Column(Modifier.padding(s.lg), verticalArrangement = Arrangement.spacedBy(s.sm)) {
                    Text(stringResource(R.string.show_load_failed), style = IzleTheme.type.body, color = IzleTheme.colors.textPrimary)
                    Caption(errorText(res, error), tone = Tone.Danger)
                    IzleButton(stringResource(R.string.try_again), onClick = actions.onRetry, enabled = !state.loading)
                }
            }
            return@Column
        }
        run?.let { CheckStrip(it, onStop = actions.onStopCheck, onDismiss = actions.onDismissCheck) }
        LazyColumn(Modifier.weight(1f).fillMaxWidth()) {
            item(key = "head") { Head(item, api) }
            item(key = "actions") { Actions(state, tvName, actions, Modifier.padding(horizontal = s.lg).padding(bottom = s.lg)) }
            if (state.listsEpisodes) {
                item(key = "episodes") {
                    SectionHeader(
                        stringResource(R.string.show_episodes),
                        meta = pluralStringResource(R.plurals.show_episode_count, item.episodes.size, item.episodes.size),
                        trailing = {
                            IzleButton(
                                stringResource(R.string.show_check_all),
                                onClick = actions.onCheckAll,
                                kind = ButtonKind.Quiet,
                                size = ButtonSize.Small,
                                enabled = run?.running != true && item.episodes.any { it.playbackAllowed },
                            )
                        },
                    )
                }
                if (item.episodes.isEmpty()) {
                    item(key = "none") { Caption(stringResource(R.string.show_no_episodes), Modifier.padding(s.lg)) }
                }
                itemsIndexed(item.episodes, key = { _, e -> "e:" + e.id }) { i, e ->
                    EpisodeRow(e, okPlays = e.id == state.okPlays, new = e.id in state.newEpisodes, divider = i < item.episodes.lastIndex, onClick = { actions.onEpisode(e) })
                }
                item(key = "advance") {
                    Column {
                        Hairline()
                        Caption(
                            stringResource(if (item.autoAdvance != false) R.string.show_advances else R.string.show_does_not_advance),
                            Modifier.padding(horizontal = s.lg, vertical = s.md),
                        )
                    }
                }
            } else {
                val direct = state.direct
                val checking = direct?.checking == true
                item(key = "sources") {
                    SectionHeader(
                        stringResource(R.string.show_sources),
                        meta = checkedText(res, direct?.check ?: item.check ?: item.episodes.firstOrNull()?.check),
                        trailing = {
                            IzleButton(
                                stringResource(if (checking) R.string.show_checking else R.string.show_check),
                                onClick = actions.onCheckDirect,
                                kind = ButtonKind.Quiet,
                                size = ButtonSize.Small,
                                enabled = direct != null && !checking,
                            )
                        },
                    )
                    if (checking || direct?.loading != false) ProgressBar(null)
                    val sources = if (item.kind == ShowState.KIND_LIVE) item.sources else item.episodes.firstOrNull()?.sources.orEmpty()
                    Column { SourceRows(sources, direct) }
                    Hairline()
                }
            }
        }
    }
}

/** The poster beside the title, "Series · 2013 · Animation" and the original title; the synopsis under them, three lines until tapped. */
@Composable
private fun Head(item: AdminItem, api: ApiClient) {
    val res = resources()
    val s = IzleTheme.spacing
    var expanded by rememberSaveable(item.id) { mutableStateOf(false) }
    var clamped by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().padding(s.lg), verticalArrangement = Arrangement.spacedBy(s.md)) {
        Row(horizontalArrangement = Arrangement.spacedBy(s.md), verticalAlignment = Alignment.Top) {
            val url = remember(item.posterUrl) { api.resolve(item.posterUrl)?.toString() }
            Poster(url, IzleTheme.sizes.posterNow)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(s.line)) {
                Text(item.title, style = IzleTheme.type.title, color = IzleTheme.colors.textPrimary, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Caption(metaLine(res, item), maxLines = 2)
                item.originalTitle?.takeIf { it != item.title }?.let { Caption(it, maxLines = 2) }
            }
        }
        item.synopsis?.takeIf { it.isNotBlank() }?.let { synopsis ->
            Text(
                synopsis,
                style = IzleTheme.type.body,
                color = IzleTheme.colors.textSecondary,
                maxLines = if (expanded) Int.MAX_VALUE else SYNOPSIS_LINES,
                overflow = TextOverflow.Ellipsis,
                onTextLayout = { if (!expanded) clamped = it.hasVisualOverflow },
                modifier = Modifier.clickable(enabled = clamped || expanded, onClickLabel = res.getString(R.string.show_more)) { expanded = !expanded },
            )
        }
    }
}

/** On Home (its menu: Remove from Home) or Add to Home (its chevron: to a section), beside Play on <TV>. */
@Composable
private fun Actions(state: ShowState, tvName: String, actions: ShowActions, modifier: Modifier = Modifier) {
    val res = resources()
    val play = @Composable {
        IzleButton(stringResource(R.string.show_play_on, tvName), onClick = actions.onPlay, kind = ButtonKind.Primary, icon = Icons.Outlined.PlayArrow)
    }
    val home = @Composable {
        if (state.onHome) {
            var open by remember { mutableStateOf(false) }
            Box {
                IzleButton(stringResource(R.string.show_on_home), onClick = { open = true }, icon = Icons.Outlined.Check, enabled = !state.saving, modifier = Modifier.fillMaxWidth())
                DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.home_remove_from_home), style = IzleTheme.type.body, color = toneColor(Tone.Danger)) },
                        onClick = {
                            open = false
                            actions.onRemove()
                        },
                    )
                }
            }
        } else {
            AddToHome(state.sections, enabled = !state.saving, onAdd = actions.onAdd, sectionName = { sectionTitle(res, it.title) })
        }
    }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(IzleTheme.spacing.sm)) {
        when {
            state.playable -> ButtonRow { home(); play() }
            // Nothing to add or play; a show already on Home can still leave it.
            state.onHome -> ButtonRow { home(); Box {} }
        }
        if (!state.playable) Caption(stringResource(R.string.show_not_allowed), tone = Tone.Warning)
    }
}

/**
 * Add to Home: a tap adds to the untitled section. With titled sections a chevron at the button's end (its own touch
 * target, a split button) picks the section; the label then goes without its icon to leave the chevron room.
 */
@Composable
private fun AddToHome(sections: List<HomeSection>, enabled: Boolean, onAdd: (String) -> Unit, sectionName: (HomeSection) -> String) {
    var open by remember { mutableStateOf(false) }
    val choose = sections.size > 1
    Box {
        IzleButton(
            stringResource(R.string.show_add_to_home),
            onClick = { onAdd(UNTITLED_SECTION) },
            icon = if (choose) null else Icons.Outlined.Add,
            enabled = enabled,
            modifier = Modifier.fillMaxWidth(),
        )
        if (choose) {
            val chooseLabel = stringResource(R.string.show_add_to_section)
            Box(
                Modifier.align(Alignment.CenterEnd).size(IzleTheme.sizes.button)
                    .clickable(enabled = enabled, onClickLabel = chooseLabel, role = Role.DropdownList) { open = true },
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    IzleIcons.ExpandMore,
                    contentDescription = chooseLabel,
                    tint = if (enabled) IzleTheme.colors.textSecondary else IzleTheme.colors.textMuted,
                    modifier = Modifier.size(IzleTheme.sizes.icon),
                )
            }
            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                for (section in sections) {
                    DropdownMenuItem(
                        text = { Text(sectionName(section), style = IzleTheme.type.body, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                        enabled = enabled,
                        onClick = {
                            open = false
                            onAdd(section.id)
                        },
                    )
                }
            }
        }
    }
}

/** "S1 · E1 — Llama Drama"; "1:30 · new", "OK plays this" in `accent` and the check's chip. */
@Composable
private fun EpisodeRow(episode: AdminEpisode, okPlays: Boolean, new: Boolean, divider: Boolean, onClick: () -> Unit) {
    val verdict = verdictOf(episode.check)
    val supporting = listOfNotNull(
        episode.durationMs?.takeIf { it > 0 }?.let(::formatClock),
        stringResource(R.string.show_new).takeIf { new },
        stringResource(R.string.show_episode_not_allowed).takeIf { !episode.playbackAllowed },
    ).joinToString(" · ").ifEmpty { null }
    val badge = if (okPlays || verdict.worthAChip) {
        @Composable {
            Row(horizontalArrangement = Arrangement.spacedBy(IzleTheme.spacing.sm), verticalAlignment = Alignment.CenterVertically) {
                if (okPlays) Caption(stringResource(R.string.show_ok_plays_this), tone = Tone.Accent, maxLines = 1)
                if (verdict.worthAChip) VerdictChip(verdict)
            }
        }
    } else {
        null
    }
    ListRow(
        episodeName(episode),
        supporting = supporting,
        supportingTone = if (episode.playbackAllowed) Tone.Neutral else Tone.Warning,
        badge = badge,
        onClick = onClick,
        divider = divider,
    )
}

/** "Series · 2013 · Animation, Comedy", "Film · 2012", "Channel · News". */
internal fun metaLine(res: Resources, item: AdminItem): String = listOfNotNull(
    res.getString(
        when (item.kind) {
            ShowState.KIND_SERIES -> R.string.show_kind_series
            ShowState.KIND_LIVE -> R.string.home_hit_channel
            else -> R.string.home_film
        },
    ),
    item.year?.toString(),
    item.genres.takeIf { it.isNotEmpty() }?.joinToString(", "),
).joinToString(" · ")

private const val SYNOPSIS_LINES = 3
