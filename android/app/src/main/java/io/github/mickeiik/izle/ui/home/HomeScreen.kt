package io.github.mickeiik.izle.ui.home

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.BringIntoViewSpec
import androidx.compose.foundation.gestures.LocalBringIntoViewSpec
import androidx.compose.foundation.gestures.animateScrollBy
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
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyGridState
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.layout.LazyLayoutCacheWindow
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.BiasAlignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.Hyphens
import androidx.compose.ui.text.style.LineBreak
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Density
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
import io.github.mickeiik.izle.domain.HomeSection
import io.github.mickeiik.izle.domain.HomeSections
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
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.math.abs
import kotlin.math.roundToInt

/** The thin scroll indicator in the right safe margin, 22 dp from the screen's edge. */
private val ScrollIndicatorWidth = 6.dp
private val ScrollIndicatorEndGap = 22.dp

/** An unfocused tile: the background at 38 % over it looks like the tile at 62 % opacity, without an offscreen layer. */
private val UnfocusedVeil = IzleColors.Background.copy(alpha = 0.38f)

/** Where a portrait poster is cut to fill a landscape card: a band 28 % of the way down, above the poster's centre. */
private val PosterCrop = BiasAlignment(horizontalBias = 0f, verticalBias = -0.44f)

/**
 * The only screen the viewer navigates: a grid of 16:9 cards filling the screen, the owner's columns × rows of them
 * at a time (with the owner's sections: their titles, grids and sideways lines, see [HomeLayout]), OK plays. The card played last (or focused last) gets the focus back when the screen appears. Nothing is
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
        if (state != null && state.home.isNotEmpty()) {
            // The whole width: a row section's cards show into the side margins.
            val sections = remember(state.home, state.homeSections) { HomeSections.of(state.home, state.homeSections) }
            Box(Modifier.fillMaxSize().padding(vertical = IzleSpacing.SafeVertical)) {
                SectionsGrid(
                    sections = sections,
                    columns = state.device.homeColumns,
                    rows = state.device.homeRows,
                    initialFocusItemId = initialFocusItemId,
                    active = active,
                    imageUrl = imageUrl,
                    onFocused = onFocused,
                    onPlay = onPlay,
                )
            }
        }
        Box(Modifier.fillMaxSize().padding(IzleSpacing.Safe)) {
            when {
                state == null && !online -> Message(stringResource(R.string.no_connection), stringResource(R.string.no_connection_detail))
                state == null -> Message(stringResource(R.string.loading))
                state.home.isEmpty() -> Message(stringResource(R.string.home_empty), stringResource(R.string.home_empty_detail))
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
 * Scrolls Home as little as shows the focused line whole (docs/ux/senior-tv.md, "Sections"): the padding above its
 * row, or its section's title on the section's first line (Home's first line at the very top), down to the padding
 * under its cell. [focusedLine] is the focused card's line in [layout]. [offset] and [size] are the focused card's
 * bounds, which grow with its 110 % scale while that runs, so its unscaled top is worked out from its centre. The
 * distance is asked again on every frame of the scroll, so it must be exact, with no tolerance.
 *
 * While Home is not [active] (the hidden menu or the autoplay countdown on top) the grid stays where it is: when the
 * tiles stop taking the focus, the focus passes through another tile for a moment, which would scroll it.
 */
@OptIn(ExperimentalFoundationApi::class)
private class LineInView(
    private val density: Density,
    private val layout: () -> HomeLayout,
    private val focusedLine: () -> Int?,
    private val active: () -> Boolean,
) : BringIntoViewSpec {
    override fun calculateScrollDistance(offset: Float, size: Float, containerSize: Float): Float = with(density) {
        if (!active()) return 0f
        val l = layout()
        val g = l.grid
        val line = focusedLine()?.let { l.lines.getOrNull(it) }
        val cardTop = offset + size / 2 - g.cardHeight.dp.toPx() / 2
        val top = cardTop - (if (line != null) line.cardTop - line.top else g.padding).dp.toPx()
        val bottom = cardTop + g.cellHeight.dp.roundToPx() + g.padding.dp.toPx()
        when {
            top < 0f -> top
            bottom > containerSize -> bottom - containerSize
            else -> 0f
        }
    }
}

/**
 * Slides a row section as little as shows the focused card within the columns ([startPx] to [endPx] in the line,
 * which spans the screen): one card at a time once the focus reaches the edge of what is in view. [cardPx] is a card's
 * unscaled width, as laid out. Exact, like [LineInView].
 */
@OptIn(ExperimentalFoundationApi::class)
private class CardInView(
    private val startPx: Float,
    private val endPx: Float,
    private val cardPx: Float,
    private val active: () -> Boolean,
) : BringIntoViewSpec {
    override fun calculateScrollDistance(offset: Float, size: Float, containerSize: Float): Float {
        if (!active()) return 0f
        val left = offset + size / 2 - cardPx / 2
        return when {
            left < startPx -> left - startPx
            left + cardPx > endPx -> left + cardPx - endPx
            else -> 0f
        }
    }
}

/** The focused card, known as soon as the focus moves: the scroll asks for its line in the same frame. */
private class FocusTrack {
    var itemId: String? = null

    /** The section the focus is in (−1: none), for its title's colour. */
    val section = mutableIntStateOf(-1)

    /** A move to a card not laid out yet: the keys wait for it (a few frames). */
    var pendingMove: Job? = null
}

/** How long a move waits for its card to be laid out, at most. */
private const val PENDING_MOVE_MS = 1_000L

/** A row section's first card in view: the one at the start of the columns. */
private fun LazyListState.firstInView(): Int =
    layoutInfo.visibleItemsInfo.minByOrNull { abs(it.offset) }?.index ?: firstVisibleItemIndex

/** Where Home is scrolled to, in the layout's dp. */
private fun HomeLayout.scrollOf(state: LazyGridState, density: Density): Float {
    val slot = slots.getOrNull(state.firstVisibleItemIndex) ?: return 0f
    return slot.top - grid.padding + state.firstVisibleItemScrollOffset / density.density
}

/** Scrolls Home to [offset] (the layout's dp) at once. */
private suspend fun LazyGridState.scrollTo(layout: HomeLayout, offset: Float, density: Density) {
    val padding = layout.grid.padding
    val at = layout.slots.indexOfLast { it.top - padding <= offset }.coerceAtLeast(0)
    scrollToItem(at, ((offset - (layout.slots[at].top - padding)) * density.density).roundToInt())
}

private const val TITLE_KEY = "\u0000title:"
private const val ROW_KEY = "\u0000row:"

/** The line between two sections: white at 18 %. */
private val DividerColor = Color(0x2EFFFFFF)

/**
 * Home's cards in their sections, one lazy grid for all of them: rows of [columns] cards, a section's title as an item
 * across the grid, a row section as one item holding a lazy row that spans the screen. The lines between sections are
 * drawn over the grid where the layout puts them. ↑ ↓ ← → follow [HomeLayout] (the next line, nearest card; stop at a
 * line's ends).
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SectionsGrid(
    sections: List<HomeSection>,
    columns: Int,
    rows: Int,
    initialFocusItemId: String?,
    active: Boolean,
    imageUrl: (String?) -> String?,
    onFocused: (String) -> Unit,
    onPlay: (HomeEntry) -> Unit,
) {
    // A row beyond each edge is composed ahead, so ↓ or ↑ onto it does not compose a whole row in one frame.
    val rowsShown = rows.coerceIn(HomeGrid.MIN_ROWS, HomeGrid.MAX_ROWS)
    val cacheWindow = remember(rowsShown) { LazyLayoutCacheWindow(aheadFraction = 1f / rowsShown, behindFraction = 1f / rowsShown) }
    val gridState = rememberLazyGridState(cacheWindow)
    // A row section keeps its place when it scrolls out of the grid and back.
    val rowStates = remember { mutableMapOf<String, LazyListState>() }
    val requesters = remember { mutableMapOf<String, FocusRequester>() }
    val focus = remember { FocusTrack() }
    val scope = rememberCoroutineScope()
    var gridHasFocus by remember { mutableStateOf(false) }
    var lastFocusedIndex by remember { mutableIntStateOf(0) }
    val ids = remember(sections) { sections.flatMap { s -> s.entries.map { it.item.id } } }
    val sectionStarts = remember(sections) { sections.runningFold(0) { at, s -> at + s.entries.size } }
    val places = remember(sections) {
        HashMap<String, Pair<Int, Int>>().apply { sections.forEachIndexed { k, s -> s.entries.forEachIndexed { i, e -> put(e.item.id, k to i) } } }
    }
    // The focus is put back when this changes: which card is in which section, laid out how.
    val structure = remember(sections) { sections.map { s -> Triple(s.id, s.row, s.entries.map { it.item.id }) } }

    val density = LocalDensity.current
    val cardTitleStyle = MaterialTheme.typography.titleSmall
    val titleLine = with(density) { cardTitleStyle.lineHeight.toDp() }
    val isActive by rememberUpdatedState(active)
    val chipSizes = rememberChipSizes()
    val measurer = rememberTextMeasurer()
    BoxWithConstraints(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        val safeWidth = maxWidth.value - 2 * IzleSpacing.SafeHorizontal.value
        val titled = sections.any { it.title != null }
        val g = remember(columns, rows, safeWidth, maxHeight, titleLine, titled) {
            HomeLayout.grid(columns, rows, safeWidth, maxHeight.value, titleLine.value, titled)
        }
        // Whether a name in a section's last line (all of a row section's) takes two lines at the card's width: the
        // line between sections sits lower when one does. Only what comes before another section is measured.
        val lastNames = remember(sections, g.columns) {
            sections.dropLast(1).map { s -> (if (s.row) s.entries else s.entries.drop((s.entries.size - 1) / g.columns * g.columns)).map { it.item.title } }
        }
        val twoLines = remember(lastNames, g.cardWidth, g.titleLines, cardTitleStyle, density) {
            val width = with(density) { g.cardWidth.dp.roundToPx() }
            lastNames.map { names ->
                g.titleLines > 1 && names.any { measurer.measure(it, cardTitleStyle, constraints = Constraints(maxWidth = width), density = density).lineCount > 1 }
            }
        }
        val layout = remember(sections, twoLines, columns, rows, safeWidth, maxHeight, titleLine) {
            val shapes = sections.mapIndexed { k, s -> SectionShape(s.title != null, s.row, s.entries.size, twoLines.getOrElse(k) { false }) }
            HomeLayout.compute(columns, rows, safeWidth, maxHeight.value, titleLine.value, shapes)
        }
        val currentLayout by rememberUpdatedState(layout)
        val currentSections by rememberUpdatedState(sections)
        val currentPlaces by rememberUpdatedState(places)
        // The first column's left edge, from the screen's: the grid spans the screen, its content the columns.
        val x0 = (maxWidth.value - g.viewportWidth) / 2 + g.padding

        fun rowFirst(section: Int): Int = rowStates[currentSections[section].id]?.firstInView() ?: 0

        // The card that had the focus when the sections changed: when it moved to another section its old place went
        // away, and Compose hands the focus to another card (which then counts as focused last).
        val focusedBefore = remember(structure) { focus.itemId }

        // Focus a tile when the screen appears, when the menu closes, and if the focused tile disappeared or moved to
        // another section after a live update. Its line is brought into view the way moving there would: Home stays
        // put when the line is already on screen (back from the player, the screen looks as the viewer left it).
        LaunchedEffect(structure, active) {
            if (!active) return@LaunchedEffect
            val moved = focusedBefore?.takeIf { it in places }
            if (moved != null) withFrameNanos { }
            val id = if (gridHasFocus) {
                // The focused card may have kept the focus but moved out of view: its line comes back into view.
                moved?.takeIf { it != focus.itemId } ?: focus.itemId?.takeIf { it in places } ?: return@LaunchedEffect
            } else {
                initialFocusItemId?.takeIf { it in places } ?: ids[lastFocusedIndex.coerceIn(0, ids.lastIndex)]
            }
            val (s, i) = places.getValue(id)
            val l = currentLayout
            if (l.sections[s].row) {
                val row = rowStates.getOrPut(sections[s].id) { LazyListState() }
                row.requestScrollToItem(HomeLayout.rowFirst(row.firstInView(), i, l.sections[s].count, l.grid.columns))
            }
            val now = l.scrollOf(gridState, density)
            val to = l.scrollFor(l.lineOf(s, i), now)
            // Already in view: a scroll under way (the viewer's) is left alone.
            if (abs(to - now) >= 0.5f) gridState.scrollTo(l, to, density)
            requestFocusWithin({ requesters[id] }, took = { gridHasFocus && focus.itemId == id })
        }

        /** Whether the card [id] of [section] is laid out (on screen, if only in part), so it can take the focus. */
        fun laidOut(section: HomeSection, id: String): Boolean {
            val visible = gridState.layoutInfo.visibleItemsInfo
            return if (section.row) {
                visible.any { it.key == ROW_KEY + section.id } && rowStates[section.id]?.layoutInfo?.visibleItemsInfo?.any { it.key == id } == true
            } else {
                visible.any { it.key == id }
            }
        }

        // ↑ ↓ ← → as the layout says. A card on a line beyond the edge is not laid out yet (Compose's own search would
        // take the first card of that line it lays out): Home scrolls towards the line, and the card takes the focus
        // as soon as it is laid out; its bringing into view then carries the scroll on to the same place.
        fun move(key: Key): Boolean {
            val direction = when (key) {
                Key.DirectionLeft, Key.DirectionUp -> -1
                Key.DirectionRight, Key.DirectionDown -> 1
                else -> return false
            }
            if (focus.pendingMove?.isActive == true) return true
            val (s, i) = focus.itemId?.let { currentPlaces[it] } ?: return false
            val l = currentLayout
            val (ts, ti) = if (key == Key.DirectionLeft || key == Key.DirectionRight) {
                s to (l.horizontal(s, i, direction) ?: return true)
            } else {
                l.vertical(s, i, direction, ::rowFirst) ?: return true
            }
            val target = currentSections[ts]
            val id = target.entries[ti].item.id
            val requester = requesters[id]
            if (requester != null && laidOut(target, id)) return requester.requestFocus(FocusDirection.Enter)
            val from = l.scrollOf(gridState, density)
            val to = l.scrollFor(l.lineOf(ts, ti), from)
            scope.launch { gridState.animateScrollBy((to - from) * density.density) }
            focus.pendingMove = scope.launch {
                withTimeoutOrNull(PENDING_MOVE_MS) { snapshotFlow { laidOut(target, id) }.first { it } } ?: return@launch
                requesters[id]?.requestFocus(FocusDirection.Enter)
            }
            return true
        }

        val lineInView = remember(density) {
            LineInView(density, { currentLayout }, { focus.itemId?.let { currentPlaces[it] }?.let { (s, i) -> currentLayout.lineOf(s, i) } }) { isActive }
        }
        val cardInView = remember(density, g, x0) {
            with(density) {
                val start = x0.dp.roundToPx().toFloat()
                val card = g.cardWidth.dp.roundToPx()
                val end = start + g.columns * card + (g.columns - 1) * g.gap.dp.roundToPx()
                CardInView(start, end, card.toFloat()) { isActive }
            }
        }

        @Composable
        fun CardTile(entry: HomeEntry, section: Int, index: Int, outer: Modifier) {
            val id = entry.item.id
            val requester = requesters.getOrPut(id) { FocusRequester() }
            Tile(
                entry = entry,
                grid = g,
                backdropUrl = imageUrl(entry.item.backdropUrl),
                posterUrl = imageUrl(entry.item.posterUrl),
                chipSizes = chipSizes,
                outer = outer,
                // While the hidden menu is open, focus must not fall through to the tiles behind it.
                modifier = Modifier
                    .focusRequester(requester)
                    .focusProperties { canFocus = active }
                    .onFocusChanged {
                        if (it.isFocused) {
                            focus.itemId = id
                            focus.section.intValue = section
                        }
                    },
                onFocused = {
                    lastFocusedIndex = sectionStarts[section] + index
                    onFocused(id)
                },
                onClick = { onPlay(entry) },
            )
        }

        CompositionLocalProvider(LocalBringIntoViewSpec provides lineInView) {
            LazyVerticalGrid(
                columns = GridCells.Fixed(g.columns),
                state = gridState,
                horizontalArrangement = Arrangement.spacedBy(g.gap.dp),
                verticalArrangement = Arrangement.spacedBy(g.gap.dp),
                contentPadding = PaddingValues(horizontal = x0.dp, vertical = g.padding.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .height(layout.viewportHeight.dp)
                    .drawWithContent {
                        drawContent()
                        // Over the cards: an unfocused card's veil would dim it where it crosses an unused title line.
                        drawDividers(currentLayout, gridState, x0)
                    }
                    .onFocusChanged {
                        gridHasFocus = it.hasFocus
                        if (!it.hasFocus) focus.section.intValue = -1
                    }
                    .onPreviewKeyEvent { it.type == KeyEventType.KeyDown && move(it.key) },
            ) {
                items(
                    count = layout.slots.size,
                    key = { i ->
                        when (val slot = layout.slots[i]) {
                            is HomeLayout.Card -> sections[slot.section].entries[slot.index].item.id
                            is HomeLayout.Title -> TITLE_KEY + sections[slot.section].id
                            is HomeLayout.Row -> ROW_KEY + sections[slot.section].id
                        }
                    },
                    span = { i -> GridItemSpan((layout.slots[i] as? HomeLayout.Card)?.span ?: maxLineSpan) },
                    contentType = { i -> layout.slots[i]::class },
                ) { i ->
                    when (val slot = layout.slots[i]) {
                        is HomeLayout.Card -> CardTile(
                            sections[slot.section].entries[slot.index],
                            slot.section,
                            slot.index,
                            // A section's last card ending its grid row spans the rest of it, at one card's width.
                            if (slot.span > 1) Modifier.wrapContentWidth(Alignment.Start).width(g.cardWidth.dp) else Modifier.fillMaxWidth(),
                        )
                        is HomeLayout.Title -> SectionTitle(sections[slot.section].title.orEmpty(), slot) { focus.section.intValue == slot.section }
                        is HomeLayout.Row -> {
                            val section = sections[slot.section]
                            val rowState = rowStates.getOrPut(section.id) { LazyListState() }
                            CompositionLocalProvider(LocalBringIntoViewSpec provides cardInView) {
                                LazyRow(
                                    state = rowState,
                                    contentPadding = PaddingValues(horizontal = x0.dp),
                                    horizontalArrangement = Arrangement.spacedBy(g.gap.dp),
                                    // From the screen's left edge to its right: the cards around the columns show in
                                    // the side margins.
                                    modifier = Modifier
                                        .layout { measurable, constraints ->
                                            val width = maxWidth.roundToPx()
                                            val placeable = measurable.measure(constraints.copy(minWidth = width, maxWidth = width))
                                            layout(constraints.maxWidth, placeable.height) { placeable.place(-x0.dp.roundToPx(), 0) }
                                        }
                                        .height(g.cellHeight.dp),
                                ) {
                                    itemsIndexed(section.entries, key = { _, entry -> entry.item.id }) { index, entry ->
                                        CardTile(entry, slot.section, index, Modifier.width(g.cardWidth.dp))
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        if (layout.contentHeight > layout.viewportHeight) {
            // In the right safe margin, level with the rows.
            ScrollIndicator(gridState, layout, Modifier.align(Alignment.CenterEnd).offset(x = -ScrollIndicatorEndGap))
        }
    }
}

/**
 * The lines between sections, where [layout] puts them relative to a section's first item or the last line above it
 * (whichever is laid out), so they scroll with the cards; clipped to the grid.
 */
private fun DrawScope.drawDividers(layout: HomeLayout, state: LazyGridState, x0: Float) {
    if (layout.sections.size < 2) return
    val info = state.layoutInfo
    val visible = info.visibleItemsInfo
    val thickness = HomeLayout.DIVIDER_HEIGHT.dp.toPx()
    clipRect {
        for (k in 1 until layout.sections.size) {
            val section = layout.sections[k]
            val centre = section.divider ?: continue
            val above = layout.lines[layout.sections[k - 1].lastLine].slot
            val anchor = visible.firstOrNull { it.index == section.firstSlot } ?: visible.firstOrNull { it.index == above } ?: continue
            val y = anchor.offset.y - info.viewportStartOffset + (centre - layout.slots[anchor.index].top).dp.toPx()
            drawRoundRect(
                DividerColor,
                topLeft = Offset(x0.dp.toPx(), y - thickness / 2),
                size = Size(layout.contentWidth.dp.toPx(), thickness),
                cornerRadius = CornerRadius(thickness / 2),
            )
        }
    }
}

/** A section's title: one line, white while the focus is in the section, dimmed like the cards otherwise. No focus. */
@Composable
private fun SectionTitle(text: String, slot: HomeLayout.Title, focused: () -> Boolean) {
    Box(Modifier.fillMaxWidth().height(slot.height.dp)) {
        Text(
            text,
            style = MaterialTheme.typography.headlineSmall,
            color = if (focused()) IzleColors.OnSurface else IzleColors.Dim,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .fillMaxWidth()
                .wrapContentHeight(Alignment.Top, unbounded = true)
                .offset(y = slot.textOffset.dp)
                .semantics { heading() },
        )
    }
}

/** Track and thumb: where the screen is in all of Home. It takes no focus and says nothing. */
@Composable
private fun ScrollIndicator(state: LazyGridState, layout: HomeLayout, modifier: Modifier) {
    val trackHeight = (layout.viewportHeight - 2 * layout.grid.padding).dp
    val density = LocalDensity.current
    val trackPx = with(density) { trackHeight.toPx() }
    Box(modifier.size(ScrollIndicatorWidth, trackHeight).background(IzleColors.ScrollTrack, IzleShapes.Pill)) {
        Box(
            Modifier
                .fillMaxWidth()
                .fillMaxHeight(layout.thumbFraction)
                .offset { IntOffset(0, (layout.thumbOffset(layout.scrollOf(state, density)) * trackPx).roundToInt()) }
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
    chipSizes: ChipSizes,
    /** The cell's width: its grid cell's, or one card's. */
    outer: Modifier,
    /** The card's. */
    modifier: Modifier,
    onFocused: () -> Unit,
    onClick: () -> Unit,
) {
    // The focus is read in the effect and the draw phase only: moving it recomposes no tile here.
    val interaction = remember { MutableInteractionSource() }
    val focused = interaction.collectIsFocusedAsState()
    val currentOnFocused by rememberUpdatedState(onFocused)
    LaunchedEffect(interaction) { snapshotFlow { focused.value }.collect { if (it) currentOnFocused() } }

    Column(
        outer.height(grid.cellHeight.dp).drawWithContent {
            drawContent()
            if (!focused.value) drawRect(UnfocusedVeil)
        },
    ) {
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
                CardChips(entry, grid, chipSizes)
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
 * At the bottom, the chip saying what OK does (when it fits the card on one line; "Live" on a channel) and the progress
 * bar; at the top right, the new-episode count (when it fits too). A channel has neither a progress bar nor a count.
 */
@Composable
private fun BoxScope.CardChips(entry: HomeEntry, grid: HomeGrid, chipSizes: ChipSizes) {
    val badge = EpisodeNames.badge(entry.item.kind, entry.playNext)
    val progress = EpisodeNames.progressFraction(entry.playNext)
    val label = tileBadgeText(badge)
    val labelStyle = MaterialTheme.typography.labelMedium
    val cardWidth = grid.cardWidth.dp
    val cardHeight = grid.cardHeight.dp
    val barHeight = if (progress != null) IzleSpacing.Small + 6.dp else 0.dp

    val actionChip = chipSizes.of(label, labelStyle, ChipVerticalPadding)
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
    val newEpisodes = EpisodeNames.newEpisodes(entry)
    if (newEpisodes > 0) {
        val short = pluralStringResource(R.plurals.badge_new_episodes_short, newEpisodes, newEpisodes)
        val newChip = chipSizes.of(short, MaterialTheme.typography.labelSmall, 0.dp)
        val fits = newChip.width <= cardWidth - 2 * IzleSpacing.Small &&
            IzleSpacing.Small + newChip.height + bottomHeight <= cardHeight
        if (fits) NewEpisodesChip(newEpisodes, short, Modifier.align(Alignment.TopEnd).padding(IzleSpacing.Small))
    }
}

private val ChipVerticalPadding = 2.dp

private data class ChipSize(val width: Dp, val height: Dp)

/**
 * How large a chip ([posterChip]) with a text on one line is, measured once per text for the whole grid: the same few
 * labels ("New", "Live", "Episode 5") come back on most cards, and a row scrolling in measures none of them again.
 */
private class ChipSizes(private val measurer: TextMeasurer, private val density: Density) {
    private val sizes = HashMap<Triple<String, TextStyle, Dp>, ChipSize>()

    fun of(text: String, style: TextStyle, verticalPadding: Dp): ChipSize = sizes.getOrPut(Triple(text, style, verticalPadding)) {
        val size = measurer.measure(text, style, maxLines = 1, softWrap = false, density = density).size
        with(density) { ChipSize(size.width.toDp() + 2 * IzleSpacing.Small, size.height.toDp() + 2 * verticalPadding) }
    }
}

@Composable
private fun rememberChipSizes(): ChipSizes {
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    return remember(measurer, density) { ChipSizes(measurer, density) }
}

/**
 * What OK does, in a solid chip that reads on any picture: mint for "New", the accent when OK resumes, red with white
 * text for a channel ("Live"), else grey.
 */
@Composable
private fun ActionChip(badge: TileBadge, label: String) {
    val (background, foreground) = when (badge) {
        TileBadge.Live -> IzleColors.Live to IzleColors.OnLive
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
 * "Autoplay on start", drawn over Home like the player's "Up next": what OK on the tile would play ("Live" for a
 * channel), the countdown, **Play now** (focused) and **Not now**. Back and any other key cancel it (see MainActivity).
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
