package io.github.mickeiik.izle.companion.catalog

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import io.github.mickeiik.izle.companion.R
import io.github.mickeiik.izle.companion.home.RowPoster
import io.github.mickeiik.izle.companion.home.errorText
import io.github.mickeiik.izle.companion.home.resources
import io.github.mickeiik.izle.companion.ui.design.Chevron
import io.github.mickeiik.izle.companion.ui.design.ButtonSize
import io.github.mickeiik.izle.companion.ui.design.Caption
import io.github.mickeiik.izle.companion.ui.design.ChipRow
import io.github.mickeiik.izle.companion.ui.design.EmptyState
import io.github.mickeiik.izle.companion.ui.design.FilterChip
import io.github.mickeiik.izle.companion.ui.design.Hairline
import io.github.mickeiik.izle.companion.ui.design.IconAction
import io.github.mickeiik.izle.companion.ui.design.IzleButton
import io.github.mickeiik.izle.companion.ui.design.IzleTheme
import io.github.mickeiik.izle.companion.ui.design.IzleTopBar
import io.github.mickeiik.izle.companion.ui.design.ListRow
import io.github.mickeiik.izle.companion.ui.design.ProgressBar
import io.github.mickeiik.izle.companion.ui.design.SectionHeader
import io.github.mickeiik.izle.companion.ui.design.Tone
import io.github.mickeiik.izle.data.api.ApiClient

/**
 * What's new, over the whole screen: the builds as chips (newest first, the baseline last), what the chosen one
 * changed (new shows with Add, new episodes by show, what left). A tap on a show opens it ([onOpenShow]); Back closes.
 */
@Composable
internal fun WhatsNewScreen(w: WhatsNew, state: CatalogState, api: ApiClient, vm: CatalogViewModel, onOpenShow: (String) -> Unit) {
    Dialog(onDismissRequest = vm::closeWhatsNew, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        WhatsNewContent(w, state, api, vm, onOpenShow)
    }
}

/** What's new's page, without the window it opens in. */
@Composable
internal fun WhatsNewContent(w: WhatsNew, state: CatalogState, api: ApiClient, vm: CatalogViewModel, onOpenShow: (String) -> Unit, modifier: Modifier = Modifier) {
    val res = resources()
    val space = IzleTheme.spacing
    val builds = state.catalog?.builds.orEmpty()
    val build = builds.firstOrNull { it.buildId == w.buildId }
    Surface(modifier.fillMaxSize(), color = IzleTheme.colors.background) {
        Column(Modifier.fillMaxSize()) {
            IzleTopBar(
                stringResource(R.string.whats_new),
                onBack = vm::closeWhatsNew,
                actions = { IconAction(Icons.Filled.Refresh, stringResource(R.string.whats_new_refresh), onClick = vm::refreshWhatsNew) },
            )
            Box(Modifier.fillMaxWidth().height(IzleTheme.sizes.progress)) { if (w.loading) ProgressBar(null) }
            ChipRow(Modifier.padding(top = space.sm, bottom = space.md)) {
                for ((b, label) in buildChips(res, builds)) {
                    FilterChip(label, selected = b.buildId == w.buildId, onClick = { vm.selectBuild(b.buildId) })
                }
            }
            build?.let { Caption(buildSummary(res, it), Modifier.padding(horizontal = space.lg).padding(bottom = space.md)) }
            Hairline()
            val changes = w.changes
            when {
                w.error != null -> Caption(stringResource(R.string.whats_new_failed, errorText(res, w.error)), Modifier.padding(space.lg), tone = Tone.Danger)
                changes == null -> Unit
                else -> {
                    val newShows = changes.items.added
                    val episodes = newEpisodeGroups(changes)
                    val gone = goneLines(res, changes)
                    if (newShows.isEmpty() && episodes.isEmpty() && gone.isEmpty()) {
                        EmptyState(stringResource(R.string.whats_new_unchanged), Modifier.padding(space.lg))
                    }
                    LazyColumn(Modifier.fillMaxSize()) {
                        if (newShows.isNotEmpty()) {
                            item(key = "h-shows") { SectionHeader(stringResource(R.string.whats_new_new_shows)) }
                            items(newShows, key = { "s-${it.id}" }) { show ->
                                val hit = w.hits[show.id]
                                val title = hit?.title ?: show.title ?: show.id
                                ListRow(
                                    title,
                                    supporting = hit?.let { catalogLine(res, it) } ?: kindWord(res, show.kind),
                                    leading = { RowPoster(api, hit?.posterUrl) },
                                    trailing = {
                                        if (state.isOnHome(show.id)) OnHome()
                                        else IzleButton(
                                            stringResource(R.string.home_add),
                                            onClick = { vm.add(show.id, title) },
                                            size = ButtonSize.Small,
                                            enabled = w.adding == null && state.onHome != null,
                                        )
                                    },
                                    onClick = { onOpenShow(show.id) },
                                )
                            }
                        }
                        if (episodes.isNotEmpty()) {
                            item(key = "h-episodes") {
                                SectionHeader(stringResource(R.string.whats_new_new_episodes))
                            }
                            items(episodes, key = { "e-${it.itemId}" }) { group ->
                                ListRow(
                                    group.title,
                                    supporting = group.episodes.joinToString(", "),
                                    trailing = { Chevron() },
                                    onClick = { onOpenShow(group.itemId) },
                                )
                            }
                        }
                        if (gone.isNotEmpty()) {
                            item(key = "h-gone") { SectionHeader(stringResource(R.string.whats_new_gone)) }
                            items(gone) { line -> GoneRow(line) }
                        }
                    }
                }
            }
        }
    }
}

/** A show that left: its title in `textSecondary`, not tappable. */
@Composable
private fun GoneRow(text: String) {
    Column(Modifier.fillMaxWidth()) {
        Box(Modifier.fillMaxWidth().heightIn(min = IzleTheme.sizes.actionRow).padding(horizontal = IzleTheme.spacing.lg), contentAlignment = Alignment.CenterStart) {
            Text(text, style = IzleTheme.type.rowTitle, color = IzleTheme.colors.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Hairline(Modifier.padding(start = IzleTheme.spacing.lg))
    }
}
