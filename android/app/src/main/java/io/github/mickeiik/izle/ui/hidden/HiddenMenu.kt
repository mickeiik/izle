package io.github.mickeiik.izle.ui.hidden

import androidx.compose.foundation.background
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.ListItem
import androidx.tv.material3.ListItemDefaults
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import io.github.mickeiik.izle.R
import io.github.mickeiik.izle.data.api.EpisodeDetails
import io.github.mickeiik.izle.domain.EpisodeNames
import io.github.mickeiik.izle.player.TrackOption
import io.github.mickeiik.izle.ui.AboutInfo
import io.github.mickeiik.izle.ui.MenuPage
import io.github.mickeiik.izle.ui.MenuPlan
import io.github.mickeiik.izle.ui.MenuUi
import io.github.mickeiik.izle.ui.RootEntry
import io.github.mickeiik.izle.ui.SettingsEntry
import io.github.mickeiik.izle.ui.common.CheckIcon
import io.github.mickeiik.izle.ui.common.ErrorText
import io.github.mickeiik.izle.ui.common.PlayIcon
import io.github.mickeiik.izle.ui.common.Spinner
import io.github.mickeiik.izle.ui.common.episodeNameText
import io.github.mickeiik.izle.ui.common.languageLabel
import io.github.mickeiik.izle.ui.common.languageName
import io.github.mickeiik.izle.ui.common.requestFocusWithin
import io.github.mickeiik.izle.ui.theme.IzleBorders
import io.github.mickeiik.izle.ui.theme.IzleColors
import io.github.mickeiik.izle.ui.theme.IzleShapes
import io.github.mickeiik.izle.ui.theme.IzleSpacing

/** A little over half the screen, so the rows keep their width inside the safe margin. */
private val PanelWidth = 520.dp
private val IconSize = 28.dp

class MenuActions(
    val onRoot: (RootEntry) -> Unit,
    val onEpisode: (EpisodeDetails) -> Unit,
    val onAudio: (TrackOption?) -> Unit,
    val onSubtitles: (TrackOption?) -> Unit,
    val onSettings: (SettingsEntry) -> Unit,
)

/** The helper's menu (Menu key or long-press OK), drawn over Home or the paused player. Back closes it. */
@Composable
fun HiddenMenu(
    menu: MenuUi,
    uiLanguage: String,
    uiLanguageOverride: String?,
    about: AboutInfo,
    actions: MenuActions,
) {
    val page = menu.page
    Box(Modifier.fillMaxSize().background(IzleColors.Scrim)) {
        Column(
            Modifier.align(Alignment.CenterEnd).fillMaxHeight().width(PanelWidth)
                // D-pad focus must not wander to the screen underneath.
                .focusProperties { onExit = { cancelFocusChange() } }
                .focusGroup()
                .background(IzleColors.Surface)
                // The panel's right edge is the screen's: the rows end at the safe margin, out of the overscan.
                .padding(start = IzleSpacing.XXLarge, end = IzleSpacing.SafeHorizontal, top = IzleSpacing.SafeVertical, bottom = IzleSpacing.SafeVertical),
        ) {
            Text(title(menu), style = MaterialTheme.typography.headlineMedium, color = IzleColors.OnSurface, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Spacer(Modifier.height(IzleSpacing.Large))
            Box(Modifier.weight(1f)) {
                when (page) {
                    is MenuPage.Root -> MenuList(page.entries, initial = page.focused) { focus ->
                        page.entries.forEachIndexed { i, entry ->
                            item(key = entry.name) {
                                MenuRow(stringResource(entry.label()), modifier = focus(i)) { actions.onRoot(entry) }
                            }
                        }
                    }
                    is MenuPage.Episodes -> EpisodesPage(menu, page, actions)
                    is MenuPage.Audio -> TrackPage(page, page.options, automatic = R.string.audio_automatic, onChoose = actions.onAudio)
                    is MenuPage.Subtitles -> TrackPage(page, page.options, automatic = R.string.subtitles_off, onChoose = actions.onSubtitles)
                    MenuPage.Settings -> {
                        val language = uiLanguageOverride?.let { languageLabel(it) }
                            ?: stringResource(R.string.settings_language_auto, languageLabel(uiLanguage))
                        val rows = listOfNotNull(
                            Triple(SettingsEntry.ServerAddress, R.string.settings_server, about.server),
                            Triple(SettingsEntry.Language, R.string.settings_language, language),
                            Triple(SettingsEntry.PairAgain, R.string.settings_pair_again, null),
                            // Last, so the focus never starts on it.
                            MenuPlan.installUpdateVersion(about.updateVersion, menu.fromPlayer)
                                ?.let { Triple(SettingsEntry.InstallUpdate, R.string.settings_install_update, it) },
                        )
                        MenuList(page, initial = 0) { focus ->
                            rows.forEachIndexed { i, (entry, label, value) ->
                                item(key = entry.name) {
                                    MenuRow(stringResource(label), value, modifier = focus(i)) { actions.onSettings(entry) }
                                }
                            }
                        }
                    }
                    MenuPage.About -> MenuList(page, initial = 0) { focus ->
                        val rows = listOf(
                            R.string.about_version to about.appVersion,
                            R.string.about_device to about.deviceName,
                            R.string.about_server to about.server,
                            R.string.about_catalog to about.catalogName,
                            R.string.about_build to about.catalogBuild,
                        )
                        rows.forEachIndexed { i, (label, value) ->
                            item(key = label) { MenuRow(stringResource(label), value ?: "–", modifier = focus(i)) {} }
                        }
                        item(key = "update") {
                            val label = if (about.updateVersion != null) R.string.about_update_available else R.string.about_up_to_date
                            MenuRow(stringResource(label), about.updateVersion, modifier = focus(rows.size)) {}
                        }
                    }
                }
            }
            Spacer(Modifier.height(IzleSpacing.Medium))
            Text(stringResource(R.string.menu_back_hint), style = MaterialTheme.typography.bodySmall, color = IzleColors.Dim)
        }
    }
}

@Composable
private fun title(menu: MenuUi): String = when (menu.page) {
    is MenuPage.Root -> menu.item?.title ?: stringResource(R.string.menu_title)
    is MenuPage.Episodes -> menu.item?.title ?: stringResource(R.string.menu_episodes)
    is MenuPage.Audio -> stringResource(R.string.menu_audio)
    is MenuPage.Subtitles -> stringResource(R.string.menu_subtitles)
    MenuPage.Settings -> stringResource(R.string.menu_settings)
    MenuPage.About -> stringResource(R.string.menu_about)
}

private fun RootEntry.label(): Int = when (this) {
    RootEntry.Episodes -> R.string.menu_episodes
    RootEntry.StartOver -> R.string.menu_start_over
    RootEntry.Audio -> R.string.menu_audio
    RootEntry.Subtitles -> R.string.menu_subtitles
    RootEntry.Settings -> R.string.menu_settings
    RootEntry.About -> R.string.menu_about
}

/** A list whose row [initial] takes the focus whenever [page] changes. */
@Composable
private fun MenuList(page: Any, initial: Int, content: LazyListScope.(focus: (Int) -> Modifier) -> Unit) {
    val state = rememberLazyListState()
    val requesters = remember(page) { mutableMapOf<Int, FocusRequester>() }
    LaunchedEffect(page) {
        state.scrollToItem(initial.coerceAtLeast(0))
        requestFocusWithin({ requesters[initial] })
    }
    LazyColumn(state = state) {
        content { index -> Modifier.focusRequester(requesters.getOrPut(index) { FocusRequester() }) }
    }
}

/** No fill of its own; focused, the tiles' white border on a lighter fill. Not scaled: the panel ends at the safe margin. */
@Composable
private fun MenuRow(
    headline: String,
    supporting: String? = null,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    selected: Boolean = false,
    leading: (@Composable () -> Unit)? = null,
    onClick: () -> Unit,
) {
    ListItem(
        selected = selected,
        onClick = onClick,
        enabled = enabled,
        headlineContent = { Text(headline, style = MaterialTheme.typography.titleLarge, maxLines = 2, overflow = TextOverflow.Ellipsis) },
        supportingContent = supporting?.let { { Text(it, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis) } },
        leadingContent = leading?.let { { it() } },
        shape = ListItemDefaults.shape(IzleShapes.Medium),
        colors = ListItemDefaults.colors(
            containerColor = Color.Transparent,
            contentColor = IzleColors.OnSurface,
            selectedContainerColor = Color.Transparent,
            selectedContentColor = IzleColors.OnSurface,
            focusedContainerColor = IzleColors.SurfaceHigh,
            focusedContentColor = IzleColors.OnSurface,
            pressedContainerColor = IzleColors.SurfaceHigh,
            pressedContentColor = IzleColors.OnSurface,
            focusedSelectedContainerColor = IzleColors.SurfaceHigh,
            focusedSelectedContentColor = IzleColors.OnSurface,
            pressedSelectedContainerColor = IzleColors.SurfaceHigh,
            pressedSelectedContentColor = IzleColors.OnSurface,
            disabledContainerColor = Color.Transparent,
            disabledContentColor = IzleColors.Dim,
        ),
        border = ListItemDefaults.border(
            focusedBorder = IzleBorders.focus(IzleShapes.Medium),
            pressedBorder = IzleBorders.focus(IzleShapes.Medium),
            focusedSelectedBorder = IzleBorders.focus(IzleShapes.Medium),
            focusedDisabledBorder = IzleBorders.focus(IzleShapes.Medium),
            pressedSelectedBorder = IzleBorders.focus(IzleShapes.Medium),
        ),
        scale = ListItemDefaults.scale(focusedScale = 1f, pressedScale = 1f, focusedSelectedScale = 1f, focusedDisabledScale = 1f, pressedSelectedScale = 1f),
        modifier = modifier.padding(vertical = IzleSpacing.XSmall),
    )
}

@Composable
private fun EpisodesPage(menu: MenuUi, page: MenuPage.Episodes, actions: MenuActions) {
    val details = page.details
    when {
        page.failed -> ErrorText(stringResource(R.string.episodes_failed))
        details == null -> Spinner(Modifier.padding(IzleSpacing.XLarge), size = 48.dp)
        else -> {
            val currentId = menu.playingEpisodeId ?: details.cursorEpisodeId
            val initial = details.episodes.indexOfFirst { it.id == currentId }.coerceAtLeast(0)
            MenuList(page, initial) { focus ->
                details.episodes.forEachIndexed { i, ep ->
                    item(key = ep.id) {
                        val name = episodeNameText(EpisodeNames.name(details.item.kind, ep.season, ep.number, ep.label, ep.index))
                        val headline = listOfNotNull(name, ep.title?.takeIf { it.isNotBlank() }).joinToString(" · ").ifEmpty { menu.item?.title.orEmpty() }
                        val current = ep.id == currentId
                        val watched = ep.progress?.status == "finished"
                        val supporting = when {
                            !ep.playbackAllowed -> stringResource(R.string.episode_not_allowed)
                            current && menu.playingEpisodeId != null -> stringResource(R.string.episode_playing)
                            current -> stringResource(R.string.episode_current)
                            watched -> stringResource(R.string.episode_watched)
                            else -> null
                        }
                        MenuRow(
                            headline, supporting, modifier = focus(i), enabled = ep.playbackAllowed, selected = current,
                            leading = when {
                                current -> ({ PlayIcon(Modifier.size(IconSize), color = IzleColors.Accent) })
                                // Grey, not the mint of "New": a watched episode is done.
                                watched -> ({ CheckIcon(Modifier.size(IconSize), color = IzleColors.Dim) })
                                else -> ({ Spacer(Modifier.size(IconSize)) })
                            },
                        ) { actions.onEpisode(ep) }
                    }
                }
            }
        }
    }
}

@Composable
private fun TrackPage(page: MenuPage, options: List<TrackOption>, automatic: Int, onChoose: (TrackOption?) -> Unit) {
    val locale = LocalConfiguration.current.locales[0]
    val unknown = stringResource(R.string.track_unknown)
    val selectedIndex = options.indexOfFirst { it.selected }
    MenuList(page, initial = if (page is MenuPage.Subtitles && selectedIndex >= 0) selectedIndex + 1 else 0) { focus ->
        item(key = "auto") {
            val none = page is MenuPage.Subtitles && selectedIndex < 0
            MenuRow(stringResource(automatic), modifier = focus(0), selected = none, leading = checkIf(none)) { onChoose(null) }
        }
        options.forEachIndexed { i, option ->
            item(key = "${option.groupIndex}/${option.trackIndex}") {
                val name = languageName(option.language, locale) ?: option.label ?: unknown
                val supporting = option.label?.takeIf { it != name }
                MenuRow(name, supporting, modifier = focus(i + 1), selected = option.selected, leading = checkIf(option.selected)) { onChoose(option) }
            }
        }
    }
}

/** The track in use: a white check. */
private fun checkIf(on: Boolean): @Composable () -> Unit =
    if (on) ({ CheckIcon(Modifier.size(IconSize), color = IzleColors.OnSurface) }) else ({ Spacer(Modifier.size(IconSize)) })
