package io.github.mickeiik.izle.ui.home

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.BringIntoViewSpec
import androidx.compose.foundation.gestures.LocalBringIntoViewSpec
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyGridState
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.BiasAlignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.Hyphens
import androidx.compose.ui.text.style.LineBreak
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.times
import androidx.tv.material3.Card
import androidx.tv.material3.CardDefaults
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import io.github.mickeiik.izle.R
import io.github.mickeiik.izle.data.api.HomeEntry
import io.github.mickeiik.izle.data.api.TvState
import io.github.mickeiik.izle.domain.AutoplayPlan
import io.github.mickeiik.izle.domain.EpisodeNames
import io.github.mickeiik.izle.domain.TileBadge
import io.github.mickeiik.izle.ui.AutoplayUi
import io.github.mickeiik.izle.ui.HomeMessage
import io.github.mickeiik.izle.ui.common.PanelButton
import io.github.mickeiik.izle.ui.common.PanelCountdown
import io.github.mickeiik.izle.ui.common.PosterPanel
import io.github.mickeiik.izle.ui.common.ProgressBar
import io.github.mickeiik.izle.ui.common.requestFocusWithin
import io.github.mickeiik.izle.ui.common.tileBadgeText
import io.github.mickeiik.izle.ui.theme.IzleBorders
import io.github.mickeiik.izle.ui.theme.IzleColors
import io.github.mickeiik.izle.ui.theme.IzleShapes
import io.github.mickeiik.izle.ui.theme.IzleSpacing
import kotlin.math.roundToInt

/** The thin scroll indicator in the right safe margin, 22 dp from the screen's edge. */
private val ScrollIndicatorWidth = 6.dp
private val ScrollIndicatorEndGap = 22.dp

/** Where a portrait poster is cut to fill a landscape card: a band 28 % of the way down, above the poster's centre. */
private val PosterCrop = BiasAlignment(horizontalBias = 0f, verticalBias = -0.44f)

/**
 * The only screen the viewer navigates: a grid of 16:9 cards filling the screen, the owner's columns × rows of them
 * at a time, OK plays. The card played last (or focused last) gets the focus back when the screen appears. Nothing is
 * above the grid: the owner's message is drawn over it by IzleRoot, and "No connection" sits over its top left corner.
 */
@Composable
fun HomeScreen(
    state: TvState?,
    online: Boolean,
    message: HomeMessage?,
    initialFocusItemId: String?,
    /** False while the hidden menu or the autoplay countdown is on top: Home must not take the focus back then. */
    active: Boolean,
    /** A server-relative picture reference (`/assets/…`) as a URL to load. */
    imageUrl: (String?) -> String?,
    onFocused: (String) -> Unit,
    onPlay: (HomeEntry) -> Unit,
) {
    Box(Modifier.fillMaxSize().background(IzleColors.Background)) {
        Box(Modifier.fillMaxSize().padding(IzleSpacing.Safe)) {
            when {
                state == null && !online -> Message(stringResource(R.string.no_connection), stringResource(R.string.no_connection_detail))
                state == null -> Message(stringResource(R.string.loading))
                state.home.isEmpty() -> Message(stringResource(R.string.home_empty), stringResource(R.string.home_empty_detail))
                else -> TileGrid(
                    home = state.home,
                    columns = state.device.homeColumns,
                    rows = state.device.homeRows,
                    initialFocusItemId = initialFocusItemId,
                    active = active,
                    imageUrl = imageUrl,
                    onFocused = onFocused,
                    onPlay = onPlay,
                )
            }
            if (!online) OfflineChip(Modifier.align(Alignment.TopStart))
        }
        if (message == HomeMessage.NoConnection) {
            Box(Modifier.fillMaxSize().background(IzleColors.Scrim), contentAlignment = Alignment.Center) {
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    modifier = Modifier.background(IzleColors.Surface, IzleShapes.Large).padding(horizontal = IzleSpacing.Huge, vertical = IzleSpacing.XXLarge),
                ) {
                    Text(stringResource(R.string.no_connection), style = MaterialTheme.typography.displaySmall, color = IzleColors.Error)
                    Spacer(Modifier.height(IzleSpacing.Medium))
                    Text(stringResource(R.string.no_connection_detail), style = MaterialTheme.typography.bodyLarge, color = IzleColors.Dim)
                }
            }
        }
    }
}

@Composable
private fun Message(title: String, detail: String? = null) {
    Column(Modifier.fillMaxSize().padding(IzleSpacing.Safe), Arrangement.Center, Alignment.CenterHorizontally) {
        Text(title, style = MaterialTheme.typography.displaySmall, color = IzleColors.OnSurface, textAlign = TextAlign.Center)
        if (detail != null) {
            Spacer(Modifier.height(IzleSpacing.Large))
            Text(detail, style = MaterialTheme.typography.bodyLarge, color = IzleColors.Dim, textAlign = TextAlign.Center)
        }
    }
}

@Composable
private fun OfflineChip(modifier: Modifier) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = modifier.background(IzleColors.Offline, IzleShapes.Pill).padding(horizontal = IzleSpacing.Large, vertical = 2.dp),
    ) {
        Box(Modifier.size(14.dp).background(IzleColors.OnOffline, IzleShapes.Pill))
        Spacer(Modifier.width(IzleSpacing.Medium))
        Text(stringResource(R.string.no_connection), style = MaterialTheme.typography.titleMedium, color = IzleColors.OnOffline)
    }
}

/**
 * Scrolls the grid as little as shows the focused row (card and title) in full: ↓ on the last row in view brings
 * exactly one row in from below, ↑ on the first one row from above. [paddingPx] is the room around the rows inside
 * the viewport, [rowPx] a row's height, as laid out. [offset] is where the focused card (at the top of its row) is in
 * the viewport; it is asked again while the scroll runs, so the distance must be exact, with no tolerance.
 *
 * While Home is not [active] (the hidden menu or the autoplay countdown on top) the grid stays where it is: when the
 * tiles stop taking the focus, the focus passes through another tile for a moment, which would scroll it.
 */
@OptIn(ExperimentalFoundationApi::class)
private class RowInView(private val paddingPx: Float, private val rowPx: Float, private val active: () -> Boolean) : BringIntoViewSpec {
    override fun calculateScrollDistance(offset: Float, size: Float, containerSize: Float): Float {
        if (!active()) return 0f
        val top = paddingPx
        val bottom = containerSize - paddingPx
        return when {
            offset < top -> offset - top
            offset + rowPx > bottom -> offset + rowPx - bottom
            else -> 0f
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun TileGrid(
    home: List<HomeEntry>,
    columns: Int,
    rows: Int,
    initialFocusItemId: String?,
    active: Boolean,
    imageUrl: (String?) -> String?,
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
        requestFocusWithin({ requesters[ids[target]] }, took = { gridHasFocus })
    }

    val density = LocalDensity.current
    val titleLine = with(density) { MaterialTheme.typography.titleSmall.lineHeight.toDp() }
    val isActive by rememberUpdatedState(active)
    val measurer = rememberTextMeasurer()
    BoxWithConstraints(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        val grid = remember(columns, rows, maxWidth, maxHeight, titleLine) {
            HomeGrid.compute(columns, rows, maxWidth.value, maxHeight.value, titleLine.value)
        }
        val rowInView = remember(density, grid) {
            with(density) { RowInView(grid.padding.dp.toPx(), grid.cellHeight.dp.roundToPx().toFloat()) { isActive } }
        }
        CompositionLocalProvider(LocalBringIntoViewSpec provides rowInView) {
            LazyVerticalGrid(
                columns = GridCells.Fixed(grid.columns),
                state = gridState,
                horizontalArrangement = Arrangement.spacedBy(grid.gap.dp),
                verticalArrangement = Arrangement.spacedBy(grid.gap.dp),
                contentPadding = PaddingValues(grid.padding.dp),
                modifier = Modifier
                    .size(grid.viewportWidth.dp, grid.viewportHeight.dp)
                    .onFocusChanged { gridHasFocus = it.hasFocus },
            ) {
                itemsIndexed(home, key = { _, entry -> entry.item.id }) { index, entry ->
                    val requester = requesters.getOrPut(entry.item.id) { FocusRequester() }
                    Tile(
                        entry = entry,
                        grid = grid,
                        backdropUrl = imageUrl(entry.item.backdropUrl),
                        posterUrl = imageUrl(entry.item.posterUrl),
                        measurer = measurer,
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
        val totalRows = grid.rowCount(home.size)
        if (totalRows > grid.rows) {
            ScrollIndicator(
                gridState,
                grid,
                totalRows,
                // In the right safe margin, level with the rows.
                Modifier.align(Alignment.CenterEnd).offset(x = IzleSpacing.SafeHorizontal - ScrollIndicatorEndGap),
            )
        }
    }
}

/** Track and thumb: where the rows in view are among all of them. It takes no focus and says nothing. */
@Composable
private fun ScrollIndicator(state: LazyGridState, grid: HomeGrid, totalRows: Int, modifier: Modifier) {
    val trackHeight = (grid.viewportHeight - 2 * grid.padding).dp
    val density = LocalDensity.current
    val pitchPx = with(density) { grid.rowPitch.dp.toPx() }
    val trackPx = with(density) { trackHeight.toPx() }
    Box(modifier.size(ScrollIndicatorWidth, trackHeight).background(IzleColors.ScrollTrack, IzleShapes.Pill)) {
        Box(
            Modifier
                .fillMaxWidth()
                .fillMaxHeight(grid.rows.toFloat() / totalRows)
                .offset {
                    val scrolled = state.firstVisibleItemIndex / grid.columns + state.firstVisibleItemScrollOffset / pitchPx
                    val rowsAbove = scrolled.coerceIn(0f, (totalRows - grid.rows).toFloat())
                    IntOffset(0, (rowsAbove / totalRows * trackPx).roundToInt())
                }
                .background(IzleColors.ScrollThumb, IzleShapes.Pill),
        )
    }
}

@Composable
private fun Tile(
    entry: HomeEntry,
    grid: HomeGrid,
    backdropUrl: String?,
    posterUrl: String?,
    measurer: TextMeasurer,
    modifier: Modifier,
    onFocused: () -> Unit,
    onClick: () -> Unit,
) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    LaunchedEffect(focused) { if (focused) onFocused() }

    Column(Modifier.fillMaxWidth().height(grid.cellHeight.dp).alpha(if (focused) 1f else 0.62f)) {
        Card(
            onClick = onClick,
            interactionSource = interaction,
            scale = CardDefaults.scale(focusedScale = 1.1f),
            border = CardDefaults.border(focusedBorder = IzleBorders.focus(IzleShapes.Medium)),
            shape = CardDefaults.shape(IzleShapes.Medium),
            colors = CardDefaults.colors(containerColor = IzleColors.Surface),
            modifier = modifier.fillMaxWidth().aspectRatio(16f / 9f),
        ) {
            Box(Modifier.fillMaxSize()) {
                CardPicture(backdropUrl, posterUrl, entry.item.title, grid.titleLinesInCard)
                CardChips(entry, grid, measurer)
            }
        }
        Spacer(Modifier.height(grid.titleGap.dp))
        Text(
            entry.item.title,
            style = MaterialTheme.typography.titleSmall,
            color = IzleColors.OnSurface,
            maxLines = grid.titleLines,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/**
 * The backdrop, cropped to the card; else the poster, cropped to the card around its upper part (where posters keep
 * faces and titles); else (or when the picture cannot be loaded) the show's title in the card. A picture is
 * described by the show's title.
 */
@Composable
private fun BoxScope.CardPicture(backdropUrl: String?, posterUrl: String?, title: String, titleLines: Int) {
    var backdropFailed by remember(backdropUrl) { mutableStateOf(false) }
    var posterFailed by remember(posterUrl) { mutableStateOf(false) }
    when {
        backdropUrl != null && !backdropFailed ->
            AsyncImage(
                model = backdropUrl,
                contentDescription = title,
                contentScale = ContentScale.Crop,
                onError = { backdropFailed = true },
                modifier = Modifier.fillMaxSize(),
            )
        posterUrl != null && !posterFailed ->
            AsyncImage(
                model = posterUrl,
                contentDescription = title,
                contentScale = ContentScale.Crop,
                alignment = PosterCrop,
                onError = { posterFailed = true },
                modifier = Modifier.fillMaxSize(),
            )
        else -> Text(
            title,
            style = MaterialTheme.typography.titleSmall.copy(hyphens = Hyphens.Auto, lineBreak = LineBreak.Heading),
            color = IzleColors.OnSurface,
            textAlign = TextAlign.Center,
            maxLines = titleLines,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.align(Alignment.Center).padding(HomeGrid.CARD_TEXT_PADDING.dp),
        )
    }
}

/**
 * At the bottom, the chip saying what OK does (when it fits the card on one line) and the progress bar; at the top
 * right, the new-episode count (when it fits too).
 */
@Composable
private fun BoxScope.CardChips(entry: HomeEntry, grid: HomeGrid, measurer: TextMeasurer) {
    val badge = EpisodeNames.badge(entry.item.kind, entry.playNext)
    val progress = EpisodeNames.progressFraction(entry.playNext)
    val label = tileBadgeText(badge)
    val labelStyle = MaterialTheme.typography.labelMedium
    val cardWidth = grid.cardWidth.dp
    val cardHeight = grid.cardHeight.dp
    val barHeight = if (progress != null) IzleSpacing.Small + 6.dp else 0.dp

    val actionChip = chipSize(measurer, label, labelStyle, ChipVerticalPadding)
    val showAction = actionChip.width <= cardWidth - 2 * IzleSpacing.Small &&
        IzleSpacing.Small + actionChip.height + barHeight + IzleSpacing.Small <= cardHeight
    val bottomHeight = when {
        showAction -> IzleSpacing.Small + actionChip.height + barHeight + IzleSpacing.Small
        progress != null -> IzleSpacing.Small + 6.dp + IzleSpacing.Small
        else -> 0.dp
    }

    if (showAction || progress != null) {
        Column(
            Modifier.align(Alignment.BottomStart).fillMaxWidth()
                // Taller than a small card if need be (the shade then starts above it); the card clips it.
                .wrapContentHeight(Alignment.Bottom, unbounded = true)
                .background(Brush.verticalGradient(listOf(Color.Transparent, IzleColors.PosterShade)))
                .padding(start = IzleSpacing.Small, end = IzleSpacing.Small, top = IzleSpacing.Large, bottom = IzleSpacing.Small),
        ) {
            if (showAction) ActionChip(badge, label)
            if (progress != null) {
                if (showAction) Spacer(Modifier.height(IzleSpacing.Small))
                ProgressBar(progress)
            }
        }
    }
    if (entry.newEpisodes > 0) {
        val short = pluralStringResource(R.plurals.badge_new_episodes_short, entry.newEpisodes, entry.newEpisodes)
        val newChip = chipSize(measurer, short, MaterialTheme.typography.labelSmall, 0.dp)
        val fits = newChip.width <= cardWidth - 2 * IzleSpacing.Small &&
            IzleSpacing.Small + newChip.height + bottomHeight <= cardHeight
        if (fits) NewEpisodesChip(entry.newEpisodes, short, Modifier.align(Alignment.TopEnd).padding(IzleSpacing.Small))
    }
}

private val ChipVerticalPadding = 2.dp

private data class ChipSize(val width: Dp, val height: Dp)

/** How large a chip ([posterChip]) with [text] on one line is. */
@Composable
private fun chipSize(measurer: TextMeasurer, text: String, style: TextStyle, verticalPadding: Dp): ChipSize {
    val density = LocalDensity.current
    return remember(measurer, text, style, verticalPadding, density) {
        val size = measurer.measure(text, style, maxLines = 1, softWrap = false, density = density).size
        with(density) { ChipSize(size.width.toDp() + 2 * IzleSpacing.Small, size.height.toDp() + 2 * verticalPadding) }
    }
}

/** What OK does, in a solid chip that reads on any picture: mint for "New", the accent when OK resumes, else grey. */
@Composable
private fun ActionChip(badge: TileBadge, label: String) {
    val (background, foreground) = when (badge) {
        TileBadge.New -> IzleColors.New to IzleColors.OnNew
        TileBadge.Continue -> IzleColors.Accent to IzleColors.OnAccent
        TileBadge.WatchAgain -> IzleColors.ChipNeutral to IzleColors.OnChipNeutral
        is TileBadge.Episode -> if (badge.resume) IzleColors.Accent to IzleColors.OnAccent else IzleColors.ChipNeutral to IzleColors.OnChipNeutral
    }
    Box(Modifier.posterChip(background).padding(vertical = ChipVerticalPadding)) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = foreground, maxLines = 1, softWrap = false)
    }
}

/** A chip on a card, in [color]: the hairline edge lifts it off a busy picture. */
private fun Modifier.posterChip(color: Color) = this
    .border(1.dp, IzleColors.Hairline, IzleShapes.Small)
    .background(color, IzleShapes.Small)
    .padding(horizontal = IzleSpacing.Small)

/** "2 new" when episodes were added: quieter than the chip saying what OK does, no focus, read out in full. */
@Composable
private fun NewEpisodesChip(count: Int, text: String, modifier: Modifier) {
    val description = pluralStringResource(R.plurals.badge_new_episodes, count, count)
    Box(modifier.clearAndSetSemantics { contentDescription = description }.posterChip(IzleColors.ChipInfo)) {
        Text(text, style = MaterialTheme.typography.labelSmall, color = IzleColors.OnChipInfo, maxLines = 1, softWrap = false)
    }
}

/**
 * "Autoplay on start", drawn over Home like the player's "Up next": what OK on the show's tile would play, the
 * countdown, **Play now** (focused) and **Not now**. Back and any other key cancel it (see MainActivity).
 */
@Composable
fun AutoplayOverlay(ui: AutoplayUi, posterUrl: String?, onPlayNow: () -> Unit, onNotNow: () -> Unit) {
    val item = ui.entry.item
    PosterPanel(
        posterUrl = posterUrl,
        showTitle = item.title,
        title = item.title,
        lines = listOf(tileBadgeText(EpisodeNames.badge(item.kind, ui.entry.playNext))),
        countdown = PanelCountdown(stringResource(R.string.up_next_countdown, ui.secondsLeft), ui.secondsLeft, AutoplayPlan.COUNTDOWN_SEC),
        buttons = listOf(PanelButton(stringResource(R.string.play_now), onPlayNow), PanelButton(stringResource(R.string.not_now), onNotNow)),
    )
}
