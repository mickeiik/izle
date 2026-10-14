package io.github.mickeiik.izle.ui.home

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.BringIntoViewSpec
import androidx.compose.foundation.gestures.LocalBringIntoViewSpec
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.style.Hyphens
import androidx.compose.ui.text.style.LineBreak
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
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
import io.github.mickeiik.izle.ui.common.MessageBanner
import io.github.mickeiik.izle.ui.common.ProgressBar
import io.github.mickeiik.izle.ui.common.tileBadgeText
import io.github.mickeiik.izle.ui.theme.IzleBorders
import io.github.mickeiik.izle.ui.theme.IzleColors
import io.github.mickeiik.izle.ui.theme.IzleShapes
import io.github.mickeiik.izle.ui.theme.IzleSpacing

private val TileWidth = 190.dp
private val PosterHeight = 285.dp
private val TileGap = 24.dp

/** Above, below and beside the rows: the focused poster grows by 10 %, 14 dp up and down and 10 dp sideways. */
private val GridPadding = 16.dp

/** Between the poster and its title: the focused poster's 14 dp of growth, and air before the title. */
private val TitleGap = 22.dp

/** The top band holds the clock (34 sp): at least this tall, taller while the owner's message is in it. */
private val TopBandMinHeight = 42.dp

/** How much of the grid's bottom edge fades out while more rows are below. */
private val FadeHeight = 24.dp

/**
 * The only screen the viewer navigates: big poster tiles, OK plays. The tile played last (or focused last) gets
 * the focus back when the screen appears.
 *
 * The top band holds the clock and, at its left, the "No connection" chip and the owner's [banner], so the message
 * never covers the clock or a tile; the band grows to fit it, and the hint at the bottom makes room meanwhile.
 */
@Composable
fun HomeScreen(
    state: TvState?,
    online: Boolean,
    message: HomeMessage?,
    /** The owner's message, laid out in the top band; null when there is none or it is drawn over an overlay. */
    banner: String?,
    initialFocusItemId: String?,
    /** False while the hidden menu or the autoplay countdown is on top: Home must not take the focus back then. */
    active: Boolean,
    posterUrl: (String?) -> String?,
    onFocused: (String) -> Unit,
    onPlay: (HomeEntry) -> Unit,
) {
    Box(Modifier.fillMaxSize().background(IzleColors.Background)) {
        Column(Modifier.fillMaxSize().padding(IzleSpacing.Safe)) {
            TopBand(online, banner)
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
                when {
                    state == null && !online -> FullScreenMessage(stringResource(R.string.no_connection), stringResource(R.string.no_connection_detail))
                    state == null -> FullScreenMessage(stringResource(R.string.loading))
                    state.home.isEmpty() -> FullScreenMessage(stringResource(R.string.home_empty), stringResource(R.string.home_empty_detail))
                    else -> TileGrid(state.home, initialFocusItemId, active, posterUrl, onFocused, onPlay)
                }
            }
            if (banner == null && !state?.home.isNullOrEmpty()) {
                Text(
                    stringResource(R.string.home_hint),
                    style = MaterialTheme.typography.bodySmall,
                    color = IzleColors.Dim,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().padding(top = IzleSpacing.XSmall),
                )
            }
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

/**
 * The clock at the right; at the left the "No connection" chip and the owner's message. A message that does not fit
 * beside the clock in three lines (the longest ones, near the server's 200 characters) takes the band's full width
 * under it instead, so it is never cut and never covers the clock.
 */
@Composable
private fun TopBand(online: Boolean, banner: String?) {
    var wide by remember(banner) { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().heightIn(min = TopBandMinHeight)) {
            if (!online) {
                OfflineChip()
                Spacer(Modifier.width(IzleSpacing.Large))
            }
            Box(Modifier.weight(1f)) {
                if (banner != null && !wide) MessageBanner(banner, Modifier.align(Alignment.CenterStart), onCutShort = { wide = true })
            }
            Spacer(Modifier.width(IzleSpacing.XLarge))
            Clock()
        }
        if (banner != null && wide) {
            Spacer(Modifier.height(IzleSpacing.Small))
            MessageBanner(banner)
        }
    }
}

/** Solid red with dark text: the TV cannot reach the server (it keeps retrying; OK says so instead of playing). */
@Composable
private fun OfflineChip() {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.background(IzleColors.Offline, IzleShapes.Pill).padding(horizontal = IzleSpacing.Large, vertical = 2.dp),
    ) {
        Box(Modifier.size(14.dp).background(IzleColors.OnOffline, CircleShape))
        Spacer(Modifier.width(IzleSpacing.Medium))
        Text(stringResource(R.string.no_connection), style = MaterialTheme.typography.titleMedium, color = IzleColors.OnOffline)
    }
}

/**
 * Brings a focused row to the top of the grid (just below [GridPadding]), the way a TV channel list moves: the
 * focused poster and its title are always fully in view, whichever way the viewer moved and however tall the
 * owner's message makes the top band; the row above leaves completely, and the next one peeks in below.
 *
 * While Home is not [active] (the hidden menu or the autoplay countdown on top) the grid stays where it is: when the
 * tiles stop taking the focus, the focus passes through another tile for a moment, which would scroll it up.
 */
@OptIn(ExperimentalFoundationApi::class)
private class RowAtTop(private val topPx: Float, private val active: () -> Boolean) : BringIntoViewSpec {
    override fun calculateScrollDistance(offset: Float, size: Float, containerSize: Float): Float =
        if (active()) offset - topPx else 0f
}

@OptIn(ExperimentalFoundationApi::class)
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

    // A tile cut by the bottom edge, or rows below it: the edge fades out to say there is more.
    val moreBelow by remember {
        derivedStateOf {
            val info = gridState.layoutInfo
            val visible = info.visibleItemsInfo
            visible.isNotEmpty() &&
                (visible.last().index < info.totalItemsCount - 1 || visible.any { it.offset.y + it.size.height > info.viewportEndOffset })
        }
    }
    val fade by animateFloatAsState(if (moreBelow) 1f else 0f, label = "fade")

    val density = LocalDensity.current
    val titleLine = with(density) { MaterialTheme.typography.titleSmall.lineHeight.toDp() }
    val isActive by rememberUpdatedState(active)
    val rowAtTop = remember(density) { RowAtTop(with(density) { GridPadding.toPx() }) { isActive } }
    BoxWithConstraints(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
        // Room under the last row, so that it too can come up to the top when focused.
        val bottom = (maxHeight - GridPadding - PosterHeight - TitleGap - titleLine).coerceAtLeast(GridPadding)
        // The fade never reaches the focused poster (grown by 10 %), even when a long message leaves little room.
        val fadeHeight = (maxHeight - GridPadding - PosterHeight * 1.05f).coerceIn(0.dp, FadeHeight)
        CompositionLocalProvider(LocalBringIntoViewSpec provides rowAtTop) {
            LazyVerticalGrid(
                columns = GridCells.Fixed(4),
                state = gridState,
                horizontalArrangement = Arrangement.spacedBy(TileGap),
                verticalArrangement = Arrangement.spacedBy(TileGap),
                contentPadding = PaddingValues(start = GridPadding, end = GridPadding, top = GridPadding, bottom = bottom),
                modifier = Modifier
                    .width(TileWidth * 4 + TileGap * 3 + GridPadding * 2)
                    .fillMaxHeight()
                    .fadeOutBottom(fadeHeight) { fade }
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
    }
}

/** Fades the bottom [height] of the content out, by [strength] (0 = no fade). */
private fun Modifier.fadeOutBottom(height: Dp, strength: () -> Float) = this
    .graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }
    .drawWithContent {
        drawContent()
        val s = strength()
        if (s > 0f && height > 0.dp) {
            val h = height.toPx()
            val top = size.height - h
            drawRect(
                Brush.verticalGradient(listOf(Color.Black, Color.Black.copy(alpha = 1f - s)), startY = top, endY = size.height),
                topLeft = Offset(0f, top),
                size = Size(size.width, h),
                blendMode = BlendMode.DstIn,
            )
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
            border = CardDefaults.border(focusedBorder = IzleBorders.focus(IzleShapes.Medium)),
            shape = CardDefaults.shape(IzleShapes.Medium),
            colors = CardDefaults.colors(containerColor = IzleColors.Surface),
            modifier = modifier.fillMaxWidth().aspectRatio(2f / 3f),
        ) {
            Box(Modifier.fillMaxSize()) {
                if (posterUrl != null) {
                    AsyncImage(model = posterUrl, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                } else {
                    // No poster: the title, drawn as one (split at syllables, not anywhere, when a word is too long).
                    Text(
                        entry.item.title,
                        style = MaterialTheme.typography.headlineSmall.copy(hyphens = Hyphens.Auto, lineBreak = LineBreak.Heading),
                        color = IzleColors.OnSurface,
                        textAlign = TextAlign.Center,
                        maxLines = 4,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.align(Alignment.Center).padding(IzleSpacing.Large),
                    )
                }
                Column(
                    Modifier.align(Alignment.BottomStart).fillMaxWidth()
                        .background(Brush.verticalGradient(listOf(Color.Transparent, IzleColors.PosterShade)))
                        .padding(start = IzleSpacing.Small, end = IzleSpacing.Small, top = IzleSpacing.XXLarge, bottom = IzleSpacing.Small),
                ) {
                    ActionChip(badge)
                    if (progress != null) {
                        Spacer(Modifier.height(IzleSpacing.Small))
                        ProgressBar(progress, height = 6.dp)
                    }
                }
                if (entry.newEpisodes > 0) {
                    NewEpisodesChip(entry.newEpisodes, Modifier.align(Alignment.TopEnd).padding(IzleSpacing.Small))
                }
            }
        }
        Spacer(Modifier.height(TitleGap))
        Text(
            entry.item.title,
            style = MaterialTheme.typography.titleSmall,
            color = IzleColors.OnSurface,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/**
 * What OK does, at the bottom of the poster, in a solid chip that reads on any poster: mint for "New", the warm
 * accent when OK resumes ("Continue · Episode 2", with the progress bar under it), light grey otherwise.
 */
@Composable
private fun ActionChip(badge: TileBadge) {
    val (background, foreground) = when (badge) {
        TileBadge.New -> IzleColors.New to IzleColors.OnNew
        TileBadge.Continue -> IzleColors.Accent to IzleColors.OnAccent
        TileBadge.WatchAgain -> IzleColors.ChipNeutral to IzleColors.OnChipNeutral
        is TileBadge.Episode -> if (badge.resume) IzleColors.Accent to IzleColors.OnAccent else IzleColors.ChipNeutral to IzleColors.OnChipNeutral
    }
    Box(
        Modifier.border(1.dp, IzleColors.Hairline, IzleShapes.Small)
            .background(background, IzleShapes.Small)
            .padding(horizontal = IzleSpacing.Small, vertical = 2.dp),
    ) {
        // Tighter lines than running text: "Continue · Episode 2" takes two lines on a 190 dp poster.
        Text(
            tileBadgeText(badge),
            style = MaterialTheme.typography.labelMedium.copy(lineHeight = 28.sp),
            color = foreground,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/**
 * "2 new" at the top of the poster when episodes were added: dark, regular weight and short, so it stays quieter than
 * the chip saying what OK does. It only informs: no focus, and OK still plays what the bottom chip says. Read out in
 * full ("2 new episodes").
 */
@Composable
private fun NewEpisodesChip(count: Int, modifier: Modifier) {
    val description = pluralStringResource(R.plurals.badge_new_episodes, count, count)
    Box(
        modifier.clearAndSetSemantics { contentDescription = description }
            .border(1.dp, IzleColors.Hairline, IzleShapes.Small)
            .background(IzleColors.ChipInfo, IzleShapes.Small)
            .padding(horizontal = IzleSpacing.Small),
    ) {
        Text(pluralStringResource(R.plurals.badge_new_episodes_short, count, count), style = MaterialTheme.typography.labelSmall, color = IzleColors.OnChipInfo, maxLines = 1)
    }
}
