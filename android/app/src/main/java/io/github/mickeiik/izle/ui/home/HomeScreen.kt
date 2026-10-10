package io.github.mickeiik.izle.ui.home

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Border
import androidx.tv.material3.Card
import androidx.tv.material3.CardDefaults
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import io.github.mickeiik.izle.R
import io.github.mickeiik.izle.data.api.HomeEntry
import io.github.mickeiik.izle.data.api.TvState
import io.github.mickeiik.izle.domain.EpisodeNames
import io.github.mickeiik.izle.domain.TileBadge
import io.github.mickeiik.izle.ui.HomeMessage
import io.github.mickeiik.izle.ui.common.Clock
import io.github.mickeiik.izle.ui.common.FullScreenMessage
import io.github.mickeiik.izle.ui.common.ProgressBar
import io.github.mickeiik.izle.ui.common.episodeNameText
import io.github.mickeiik.izle.ui.theme.IzleColors

private val TileWidth = 190.dp
private val TileGap = 24.dp

/**
 * The only screen the viewer navigates: big poster tiles, OK plays. The tile played last (or focused last) gets
 * the focus back when the screen appears.
 */
@Composable
fun HomeScreen(
    state: TvState?,
    online: Boolean,
    message: HomeMessage?,
    initialFocusItemId: String?,
    /** False while the hidden menu is open on top: Home must not take the focus back then. */
    active: Boolean,
    posterUrl: (String?) -> String?,
    onFocused: (String) -> Unit,
    onPlay: (HomeEntry) -> Unit,
) {
    Box(Modifier.fillMaxSize().background(IzleColors.Background)) {
        Column(Modifier.fillMaxSize().padding(horizontal = 48.dp, vertical = 24.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().height(48.dp)) {
                if (!online) OfflineBanner()
                Spacer(Modifier.weight(1f))
                Clock()
            }
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
                when {
                    state == null && !online -> FullScreenMessage(stringResource(R.string.no_connection), stringResource(R.string.no_connection_detail))
                    state == null -> FullScreenMessage(stringResource(R.string.loading))
                    state.home.isEmpty() -> FullScreenMessage(stringResource(R.string.home_empty), stringResource(R.string.home_empty_detail))
                    else -> TileGrid(state.home, initialFocusItemId, active, posterUrl, onFocused, onPlay)
                }
            }
            Text(
                stringResource(R.string.home_hint),
                style = MaterialTheme.typography.bodySmall,
                color = IzleColors.Dim,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        if (message == HomeMessage.NoConnection) {
            Box(Modifier.fillMaxSize().background(IzleColors.Scrim), contentAlignment = Alignment.Center) {
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    modifier = Modifier.background(IzleColors.Surface, RoundedCornerShape(24.dp)).padding(horizontal = 64.dp, vertical = 40.dp),
                ) {
                    Text(stringResource(R.string.no_connection), style = MaterialTheme.typography.displaySmall, color = IzleColors.Error)
                    Spacer(Modifier.height(12.dp))
                    Text(stringResource(R.string.no_connection_detail), style = MaterialTheme.typography.bodyLarge, color = IzleColors.Dim)
                }
            }
        }
    }
}

@Composable
private fun OfflineBanner() {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.background(Color(0x33FF8A80), RoundedCornerShape(24.dp)).padding(horizontal = 20.dp, vertical = 4.dp),
    ) {
        Box(Modifier.size(16.dp).background(IzleColors.Error, CircleShape))
        Spacer(Modifier.width(12.dp))
        Text(stringResource(R.string.no_connection), style = MaterialTheme.typography.titleMedium, color = IzleColors.Error)
    }
}

@Composable
private fun TileGrid(
    home: List<HomeEntry>,
    initialFocusItemId: String?,
    active: Boolean,
    posterUrl: (String?) -> String?,
    onFocused: (String) -> Unit,
    onPlay: (HomeEntry) -> Unit,
) {
    val gridState = rememberLazyGridState()
    val requesters = remember { mutableMapOf<String, FocusRequester>() }
    var gridHasFocus by remember { mutableStateOf(false) }
    var lastFocusedIndex by remember { mutableStateOf(0) }
    val ids = home.map { it.item.id }

    // Focus a tile when the screen appears, when the menu closes, and if the focused tile disappeared after a
    // live update.
    LaunchedEffect(ids, active) {
        if (!active || gridHasFocus) return@LaunchedEffect
        val target = ids.indexOf(initialFocusItemId).takeIf { it >= 0 } ?: lastFocusedIndex.coerceIn(0, ids.lastIndex)
        gridState.scrollToItem(target)
        repeat(10) {
            withFrameNanos { }
            val requester = requesters[ids[target]] ?: return@repeat
            if (runCatching { requester.requestFocus() }.isSuccess && gridHasFocus) return@LaunchedEffect
        }
    }

    LazyVerticalGrid(
        columns = GridCells.Fixed(4),
        state = gridState,
        horizontalArrangement = Arrangement.spacedBy(TileGap),
        verticalArrangement = Arrangement.spacedBy(TileGap),
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 20.dp),
        modifier = Modifier
            .width(TileWidth * 4 + TileGap * 3 + 32.dp)
            .fillMaxSize()
            .onFocusChanged { gridHasFocus = it.hasFocus },
    ) {
        itemsIndexed(home, key = { _, entry -> entry.item.id }) { index, entry ->
            val requester = requesters.getOrPut(entry.item.id) { FocusRequester() }
            Tile(
                entry = entry,
                posterUrl = posterUrl(entry.item.posterUrl),
                // While the hidden menu is open, focus must not fall through to the tiles behind it.
                modifier = Modifier.focusRequester(requester).focusProperties { canFocus = active },
                onFocused = {
                    lastFocusedIndex = index
                    onFocused(entry.item.id)
                },
                onClick = { onPlay(entry) },
            )
        }
    }
}

@Composable
private fun Tile(entry: HomeEntry, posterUrl: String?, modifier: Modifier, onFocused: () -> Unit, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    LaunchedEffect(focused) { if (focused) onFocused() }
    val badge = EpisodeNames.badge(entry.item.kind, entry.playNext)
    val progress = EpisodeNames.progressFraction(entry.playNext)

    Column(Modifier.width(TileWidth).alpha(if (focused) 1f else 0.62f)) {
        Card(
            onClick = onClick,
            interactionSource = interaction,
            scale = CardDefaults.scale(focusedScale = 1.1f),
            border = CardDefaults.border(
                focusedBorder = Border(androidx.compose.foundation.BorderStroke(4.dp, IzleColors.Focus), shape = RoundedCornerShape(12.dp)),
            ),
            shape = CardDefaults.shape(RoundedCornerShape(12.dp)),
            colors = CardDefaults.colors(containerColor = IzleColors.Surface),
            modifier = modifier.fillMaxWidth().aspectRatio(2f / 3f),
        ) {
            Box(Modifier.fillMaxSize()) {
                if (posterUrl != null) {
                    AsyncImage(model = posterUrl, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                } else {
                    Text(
                        entry.item.title,
                        style = MaterialTheme.typography.headlineSmall,
                        color = IzleColors.OnSurface,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.align(Alignment.Center).padding(16.dp),
                    )
                }
                Column(
                    Modifier.align(Alignment.BottomStart).fillMaxWidth()
                        .background(Brush.verticalGradient(listOf(Color.Transparent, Color(0xE6000000))))
                        .padding(start = 10.dp, end = 10.dp, top = 36.dp, bottom = 10.dp),
                ) {
                    BadgeChip(badge)
                    if (progress != null) {
                        Spacer(Modifier.height(8.dp))
                        ProgressBar(progress, height = 6.dp)
                    }
                }
            }
        }
        Spacer(Modifier.height(14.dp))
        Text(
            entry.item.title,
            style = MaterialTheme.typography.titleSmall,
            color = IzleColors.OnSurface,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun BadgeChip(badge: TileBadge) {
    val (text, background, foreground) = when (badge) {
        TileBadge.New -> Triple(stringResource(R.string.badge_new), IzleColors.New, IzleColors.OnNew)
        TileBadge.Continue -> Triple(stringResource(R.string.badge_continue), IzleColors.Accent, IzleColors.OnAccent)
        TileBadge.WatchAgain -> Triple(stringResource(R.string.badge_watch_again), IzleColors.SurfaceHigh, IzleColors.OnSurface)
        is TileBadge.Episode -> {
            val name = episodeNameText(badge.name).orEmpty()
            if (badge.resume) Triple(stringResource(R.string.badge_continue_episode, name), IzleColors.Accent, IzleColors.OnAccent)
            else Triple(name, IzleColors.SurfaceHigh, IzleColors.OnSurface)
        }
    }
    Box(
        Modifier.border(1.dp, Color(0x33FFFFFF), RoundedCornerShape(8.dp))
            .background(background, RoundedCornerShape(8.dp))
            .padding(horizontal = 10.dp, vertical = 2.dp),
    ) {
        Text(text, style = MaterialTheme.typography.labelMedium, color = foreground, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}
