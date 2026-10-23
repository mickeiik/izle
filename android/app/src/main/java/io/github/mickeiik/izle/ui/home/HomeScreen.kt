package io.github.mickeiik.izle.ui.home

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
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
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.layout.LazyLayoutCacheWindow
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
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
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.times
import androidx.tv.material3.Card
import androidx.tv.material3.CardDefaults
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import coil3.compose.LocalPlatformContext
import coil3.request.ImageRequest
import coil3.size.Precision
import io.github.mickeiik.izle.R
import io.github.mickeiik.izle.data.api.HomeEntry
import io.github.mickeiik.izle.data.api.ItemCard
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
import io.github.mickeiik.izle.ui.common.ProgressBarHeight
import io.github.mickeiik.izle.ui.common.episodeNameText
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

/** The scroll indicator sits in the right safe margin, 22 dp from the screen's edge. */
private val ScrollIndicatorWidth = 6.dp
private val ScrollIndicatorEndGap = 22.dp

/** The background at 38 % over an unfocused tile: the tile at 62 % opacity, without an offscreen layer. */
private val UnfocusedVeil = IzleColors.Background.copy(alpha = 0.38f)

/** A poster that is not 2:3 is cut around its upper part, where posters keep faces and titles. */
private val PosterCrop = BiasAlignment(horizontalBias = 0f, verticalBias = -0.44f)

/** A card opens (and closes) in this time, the cards after it sliding along. */
private const val OPEN_MS = 200

/** The poster behind an open card's panel is decoded this small, then stretched: a blur on every Android version. */
private const val BLUR_WIDTH_PX = 16
private const val BLUR_HEIGHT_PX = 24

/**
 * The only screen the viewer navigates: the owner's sections of poster cards ([HomeLayout]), the focused one open, OK
 * plays. The card played (or focused) last gets the focus back. Nothing is above the cards: IzleRoot draws the owner's
 * message over them. [active] is false while the hidden menu or the autoplay countdown is on top: Home must not take
 * the focus back then.
 */
@Composable
fun HomeScreen(
    state: TvState?,
    online: Boolean,
    message: HomeMessage?,
    initialFocusItemId: String?,
    active: Boolean,
    imageUrl: (String?) -> String?,
    onFocused: (String) -> Unit,
    onPlay: (HomeEntry) -> Unit,
) {
    Box(Modifier.fillMaxSize().background(IzleColors.Background)) {
        if (state != null && state.home.isNotEmpty()) {
            // The whole width: a row section's cards show into the side margins.
            val sections = remember(state.home, state.homeSections) { HomeSections.of(state.home, state.homeSections) }
            Box(Modifier.fillMaxSize().padding(vertical = IzleSpacing.SafeVertical)) {
                HomeLines(
                    sections, state.device.homeColumns, state.device.homeRows, initialFocusItemId, active, imageUrl, onFocused, onPlay,
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
 * Scrolls Home as little as shows the focused line whole ([HomeLayout.Line.top] to its bottom padding), from the
 * focused card's top; the distance is asked again on every frame, so it is exact. Not [active]: the focus passes
 * through another tile for a moment while the tiles stop taking it, which must not scroll.
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
        val top = offset - (if (line != null) line.cardTop - line.top else g.padding).dp.toPx()
        val bottom = offset + g.cardHeight.dp.roundToPx() + g.padding.dp.toPx()
        when {
            top < 0f -> top
            bottom > containerSize -> bottom - containerSize
            else -> 0f
        }
    }
}

/** A row section slides only as [HomeLayout.rowFirst] says (`slide` in [HomeLines]), never to bring a card into view. */
@OptIn(ExperimentalFoundationApi::class)
private object NoSlide : BringIntoViewSpec {
    override fun calculateScrollDistance(offset: Float, size: Float, containerSize: Float): Float = 0f
}

/**
 * The focused card, known as soon as the focus moves (the scroll asks for its line in the same frame); its [section]
 * (−1: none) lights that section's title; [pendingMove] is a move waiting for its card to be laid out.
 */
private class FocusTrack {
    var itemId: String? = null
    val section = mutableIntStateOf(-1)
    var pendingMove: Job? = null
}

private const val PENDING_MOVE_MS = 1_000L

/** A row section's first card in view: the one at the start of the columns. */
private fun LazyListState.firstInView(): Int =
    layoutInfo.visibleItemsInfo.minByOrNull { abs(it.offset) }?.index ?: firstVisibleItemIndex

/** Where Home is scrolled to, in the layout's dp ([scrollTo] goes there at once). */
private fun HomeLayout.scrollOf(state: LazyListState, density: Density): Float {
    val slot = slots.getOrNull(state.firstVisibleItemIndex) ?: return 0f
    return slot.top - grid.padding + state.firstVisibleItemScrollOffset / density.density
}

private suspend fun LazyListState.scrollTo(layout: HomeLayout, offset: Float, density: Density) {
    val padding = layout.grid.padding
    val at = layout.slots.indexOfLast { it.top - padding <= offset }.coerceAtLeast(0)
    scrollToItem(at, ((offset - (layout.slots[at].top - padding)) * density.density).roundToInt())
}

/** A row section's slide under way, to [first]; told apart from a later one to the same card by identity. */
private class RowSlide(val first: Int)

private const val TITLE_KEY = "\u0000title:"
private const val LINE_KEY = "\u0000line:"

/** An item's key: a section's title, or its line of cards by its place in the section. */
private fun slotKey(layout: HomeLayout, sections: List<HomeSection>, slot: Int): String = when (val s = layout.slots[slot]) {
    is HomeLayout.Title -> TITLE_KEY + sections[s.section].id
    is HomeLayout.Cards -> LINE_KEY + sections[s.section].id + ":" + (s.line - layout.sections[s.section].firstLine)
}

/** The line between two sections: white at 18 %. */
private val DividerColor = Color(0x2EFFFFFF)

/**
 * One lazy column for all sections, one item a line across the screen: a grid row's cards in a plain row, a row
 * section's in a lazy row, a title; the lines between sections are drawn over it. The focused card opens, and the
 * cards after it in its line move along. ↑ ↓ ← → follow [HomeLayout].
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun HomeLines(
    sections: List<HomeSection>,
    columns: Int,
    rows: Int,
    initialFocusItemId: String?,
    active: Boolean,
    imageUrl: (String?) -> String?,
    onFocused: (String) -> Unit,
    onPlay: (HomeEntry) -> Unit,
) {
    // A line beyond each edge is composed ahead, so ↓ or ↑ onto it does not compose a whole line in one frame.
    val rowsShown = rows.coerceIn(HomeGrid.MIN_ROWS, HomeGrid.MAX_ROWS)
    val cacheWindow = remember(rowsShown) { LazyLayoutCacheWindow(aheadFraction = 1f / rowsShown, behindFraction = 1f / rowsShown) }
    val listState = rememberLazyListState(cacheWindow)
    // A row section keeps its place when it scrolls out of Home and back.
    val rowStates = remember { mutableMapOf<String, LazyListState>() }
    // A row section's first card in view while it slides there.
    val slides = remember { mutableMapOf<String, RowSlide>() }
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
    val measurer = rememberTextMeasurer()
    val textSizes = remember(measurer, density) { TextSizes(measurer, density) }
    BoxWithConstraints(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        val safeWidth = maxWidth.value - 2 * IzleSpacing.SafeHorizontal.value
        val layout = remember(sections, columns, rows, safeWidth, maxHeight, titleLine) {
            val shapes = sections.map { s -> SectionShape(s.title != null, s.row, s.entries.size) }
            HomeLayout.compute(columns, rows, safeWidth, maxHeight.value, titleLine.value, shapes)
        }
        val g = layout.grid
        val currentLayout by rememberUpdatedState(layout)
        val currentSections by rememberUpdatedState(sections)
        val currentPlaces by rememberUpdatedState(places)
        // The first column's left edge, from the screen's: a row with one card open is centred.
        val x0 = (maxWidth.value - g.rowWidth) / 2

        fun rowFirst(section: Int): Int {
            val id = currentSections[section].id
            return slides[id]?.first ?: rowStates[id]?.firstInView() ?: 0
        }

        /** Slides a row section until [first] is its first card in view. */
        fun slide(section: HomeSection, first: Int) {
            val state = rowStates.getOrPut(section.id) { LazyListState() }
            val slide = RowSlide(first)
            slides[section.id] = slide
            scope.launch {
                try {
                    state.animateScrollToItem(first)
                } finally {
                    // A slide cancelled by a later one leaves that one's place (even when both go to the same card).
                    if (slides[section.id] === slide) slides.remove(section.id)
                }
            }
        }

        // The card that had the focus when the sections changed: when it moved to another line its old place went
        // away, and Compose hands the focus to another card (which then counts as focused last).
        val focusedBefore = remember(structure) { focus.itemId }

        // Focus a tile when the screen appears, when the menu closes, and if the focused tile disappeared or moved to
        // another line after a live update. Its line is brought into view the way moving there would: Home stays put
        // when the line is already on screen (back from the player, the screen looks as the viewer left it).
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
            val now = l.scrollOf(listState, density)
            val to = l.scrollFor(l.lineOf(s, i), now)
            // Already in view: a scroll under way (the viewer's) is left alone.
            if (abs(to - now) >= 0.5f) listState.scrollTo(l, to, density)
            requestFocusWithin({ requesters[id] }, took = { gridHasFocus && focus.itemId == id })
        }

        /** Whether card [index] of [section] (its id: [id]) is laid out (on screen, if only in part), so it can take the focus. */
        fun laidOut(section: Int, index: Int, id: String): Boolean {
            val l = currentLayout
            val key = slotKey(l, currentSections, l.lines[l.lineOf(section, index)].slot)
            if (listState.layoutInfo.visibleItemsInfo.none { it.key == key }) return false
            val s = currentSections[section]
            return !s.row || rowStates[s.id]?.layoutInfo?.visibleItemsInfo?.any { it.key == id } == true
        }

        // ↑ ↓ ← → as the layout says. A card on a line beyond the edge is not laid out yet (Compose's own search would
        // take the first card of that line it lays out): Home scrolls towards the line, and the card takes the focus
        // as soon as it is laid out; its bringing into view then carries the scroll on to the same place. A row
        // section slides at the edge of what is in view; the card coming in already shows in the margin.
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
            if (target.row) {
                val first = rowFirst(ts)
                val to = HomeLayout.rowFirst(first, ti, target.entries.size, l.grid.columns)
                if (to != first) slide(target, to)
            }
            val requester = requesters[id]
            if (requester != null && laidOut(ts, ti, id)) return requester.requestFocus(FocusDirection.Enter)
            val from = l.scrollOf(listState, density)
            val to = l.scrollFor(l.lineOf(ts, ti), from)
            scope.launch { listState.animateScrollBy((to - from) * density.density) }
            focus.pendingMove = scope.launch {
                withTimeoutOrNull(PENDING_MOVE_MS) { snapshotFlow { laidOut(ts, ti, id) }.first { it } } ?: return@launch
                requesters[id]?.requestFocus(FocusDirection.Enter)
            }
            return true
        }

        val lineInView = remember(density) {
            LineInView(density, { currentLayout }, { focus.itemId?.let { currentPlaces[it] }?.let { (s, i) -> currentLayout.lineOf(s, i) } }) { isActive }
        }

        /** A poster card, open while it has the focus: [HomeGrid.openWidth] wide, the panel at the poster's right. */
        @Composable
        fun CardTile(entry: HomeEntry, section: Int, index: Int) {
            val id = entry.item.id
            val requester = requesters.getOrPut(id) { FocusRequester() }
            // A card that keeps the focus while the sections around it move lights its section's title at its new place.
            LaunchedEffect(section) { if (gridHasFocus && focus.itemId == id) focus.section.intValue = section }
            // Moving the focus recomposes the two cards that open and close; their width changes in the layout phase only.
            val interaction = remember { MutableInteractionSource() }
            val focused = interaction.collectIsFocusedAsState()
            val onTileFocused by rememberUpdatedState {
                lastFocusedIndex = sectionStarts[section] + index
                onFocused(id)
            }
            LaunchedEffect(interaction) { snapshotFlow { focused.value }.collect { if (it) onTileFocused() } }
            val width = animateFloatAsState(if (focused.value) g.openWidth else g.cardWidth, tween(OPEN_MS), label = "open")
            // The panel stays while the card closes.
            val open by remember(g) { derivedStateOf { focused.value || width.value > g.cardWidth } }
            Card(
                onClick = { onPlay(entry) },
                interactionSource = interaction,
                scale = CardDefaults.scale(focusedScale = 1f),
                border = CardDefaults.border(focusedBorder = IzleBorders.focus(IzleShapes.Medium)),
                shape = CardDefaults.shape(IzleShapes.Medium),
                colors = CardDefaults.colors(containerColor = IzleColors.Surface),
                // While the hidden menu is open, focus must not fall through to the tiles behind it.
                modifier = Modifier
                    .layout { measurable, _ ->
                        val w = width.value.dp.roundToPx()
                        val h = g.cardHeight.dp.roundToPx()
                        val placeable = measurable.measure(Constraints.fixed(w, h))
                        layout(w, h) { placeable.place(0, 0) }
                    }
                    .drawWithContent {
                        drawContent()
                        if (!focused.value) drawRect(UnfocusedVeil)
                    }
                    .focusRequester(requester)
                    .focusProperties { canFocus = active }
                    .onFocusChanged {
                        if (it.isFocused) {
                            focus.itemId = id
                            focus.section.intValue = section
                        }
                    },
            ) {
                Box(Modifier.fillMaxSize()) {
                    Box(Modifier.width(g.cardWidth.dp).fillMaxHeight()) {
                        CardPicture(entry.item, imageUrl(entry.item.posterUrl), g.titleLinesInCard)
                        // On the open card, what the chips say is in the panel.
                        if (!open) CardChips(entry, g, textSizes)
                    }
                    if (open) {
                        OpenPanel(
                            entry,
                            imageUrl(entry.item.backdropUrl),
                            imageUrl(entry.item.posterUrl),
                            g,
                            textSizes,
                            // At its full width while the card opens and closes: the card's edge uncovers it.
                            Modifier
                                .padding(start = g.cardWidth.dp)
                                .wrapContentWidth(Alignment.Start, unbounded = true)
                                .width((g.openWidth - g.cardWidth).dp)
                                .fillMaxHeight(),
                        )
                    }
                }
            }
        }

        CompositionLocalProvider(LocalBringIntoViewSpec provides lineInView) {
            LazyColumn(
                state = listState,
                verticalArrangement = Arrangement.spacedBy(g.gap.dp),
                contentPadding = PaddingValues(vertical = g.padding.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .height(layout.viewportHeight.dp)
                    .drawWithContent {
                        drawContent()
                        drawDividers(currentLayout, listState, x0)
                    }
                    .onFocusChanged {
                        gridHasFocus = it.hasFocus
                        if (!it.hasFocus) focus.section.intValue = -1
                    }
                    .onPreviewKeyEvent { it.type == KeyEventType.KeyDown && move(it.key) },
            ) {
                items(
                    count = layout.slots.size,
                    key = { i -> slotKey(layout, sections, i) },
                    // A row section's lazy row and a grid row's cards are not reused for one another.
                    contentType = { i ->
                        when (val slot = layout.slots[i]) {
                            is HomeLayout.Title -> "title"
                            is HomeLayout.Cards -> if (layout.sections[slot.section].row) "row" else "grid"
                        }
                    },
                ) { i ->
                    when (val slot = layout.slots[i]) {
                        is HomeLayout.Title -> SectionTitle(sections[slot.section].title.orEmpty(), slot, x0) { focus.section.intValue == slot.section }
                        is HomeLayout.Cards -> {
                            val section = sections[slot.section]
                            val line = layout.lines[slot.line]
                            if (section.row) {
                                val rowState = rowStates.getOrPut(section.id) { LazyListState() }
                                CompositionLocalProvider(LocalBringIntoViewSpec provides NoSlide) {
                                    LazyRow(
                                        state = rowState,
                                        // From the screen's left edge to its right: the cards around the columns show in
                                        // the side margins. The end leaves room for the last card in view to be open, so
                                        // the line keeps its place when it closes.
                                        contentPadding = PaddingValues(start = x0.dp, end = (x0 + g.openWidth - g.cardWidth).dp),
                                        horizontalArrangement = Arrangement.spacedBy(g.gap.dp),
                                        modifier = Modifier.fillMaxWidth().height(g.cardHeight.dp),
                                    ) {
                                        itemsIndexed(section.entries, key = { _, entry -> entry.item.id }) { index, entry ->
                                            CardTile(entry, slot.section, index)
                                        }
                                    }
                                }
                            } else {
                                // A grid row fits one open card, so it never slides.
                                Row(Modifier.padding(start = x0.dp).height(g.cardHeight.dp), horizontalArrangement = Arrangement.spacedBy(g.gap.dp)) {
                                    for (j in line.first until line.first + line.count) {
                                        val entry = section.entries[j]
                                        key(entry.item.id) { CardTile(entry, slot.section, j) }
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
            ScrollIndicator(listState, layout, Modifier.align(Alignment.CenterEnd).offset(x = -ScrollIndicatorEndGap))
        }
    }
}

/**
 * The lines between sections, where [layout] puts them relative to a section's first item or the last line above it
 * (whichever is laid out), so they scroll with the cards; clipped to Home.
 */
private fun DrawScope.drawDividers(layout: HomeLayout, state: LazyListState, x0: Float) {
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
            val y = anchor.offset - info.viewportStartOffset + (centre - layout.slots[anchor.index].top).dp.toPx()
            drawRoundRect(
                DividerColor,
                topLeft = Offset(x0.dp.toPx(), y - thickness / 2),
                size = Size(layout.contentWidth.dp.toPx(), thickness),
                cornerRadius = CornerRadius(thickness / 2),
            )
        }
    }
}

/**
 * A section's title: one line from the first column's left edge ([x0]) across the cards, white while the focus is in
 * the section, dimmed like the cards otherwise. No focus.
 */
@Composable
private fun SectionTitle(text: String, slot: HomeLayout.Title, x0: Float, focused: () -> Boolean) {
    Box(Modifier.padding(horizontal = x0.dp).fillMaxWidth().height(slot.height.dp)) {
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
private fun ScrollIndicator(state: LazyListState, layout: HomeLayout, modifier: Modifier) {
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

/**
 * The poster, filling the card; a channel's logo, whole, [HomeGrid.INSET] inside the card; else (or when the picture
 * cannot be loaded) the name. A picture is described by the name.
 */
@Composable
private fun BoxScope.CardPicture(item: ItemCard, posterUrl: String?, titleLines: Int) {
    var failed by remember(posterUrl) { mutableStateOf(false) }
    if (posterUrl != null && !failed) {
        if (item.isLive) {
            AsyncImage(
                posterUrl, item.title, Modifier.fillMaxSize().padding(HomeGrid.INSET.dp), contentScale = ContentScale.Fit, onError = { failed = true },
            )
        } else {
            AsyncImage(
                posterUrl, item.title, Modifier.fillMaxSize(), alignment = PosterCrop, contentScale = ContentScale.Crop, onError = { failed = true },
            )
        }
    } else {
        Text(
            item.title,
            style = MaterialTheme.typography.titleSmall.copy(hyphens = Hyphens.Auto, lineBreak = LineBreak.Heading),
            color = IzleColors.OnSurface,
            textAlign = TextAlign.Center,
            maxLines = titleLines,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.align(Alignment.Center).padding(HomeGrid.CARD_TEXT_PADDING.dp),
        )
    }
}

/** What a chip says ([full]); when OK resumes an episode, also its two parts: [short] ("Continue") and [episode]. */
private class ChipText(val full: String, val short: String?, val episode: String?)

@Composable
private fun chipText(badge: TileBadge): ChipText {
    val episode = (badge as? TileBadge.Episode)?.takeIf { it.resume }?.let { episodeNameText(it.name) }
    return ChipText(tileBadgeText(badge), if (episode != null) stringResource(R.string.badge_continue) else null, episode)
}

/**
 * On a closed card: at the bottom, the chip saying what OK does ("Continue · Episode 2", else "Continue", else none:
 * whatever fits the card on one line; "Live" on a channel) and the progress bar; at the top right, the new-episode
 * count when it fits too. A channel has neither a progress bar nor a count.
 */
@Composable
private fun BoxScope.CardChips(entry: HomeEntry, grid: HomeGrid, sizes: TextSizes) {
    val badge = EpisodeNames.badge(entry.item.kind, entry.playNext)
    val progress = EpisodeNames.progressFraction(entry.playNext)
    val text = chipText(badge)
    val style = MaterialTheme.typography.labelMedium
    val barHeight = if (progress != null) IzleSpacing.Small + ProgressBarHeight else 0.dp
    // On one line, with what goes under it ([below]), inside the card's margins.
    fun fits(chip: DpSize, below: Dp) =
        chip.width <= grid.cardWidth.dp - 2 * IzleSpacing.Small && IzleSpacing.Small + chip.height + below <= grid.cardHeight.dp

    val label = listOfNotNull(text.full, text.short).firstOrNull { fits(sizes.chip(it, style, ChipVerticalPadding), barHeight + IzleSpacing.Small) }
    val bottomHeight = when {
        label != null -> IzleSpacing.Small + sizes.chip(label, style, ChipVerticalPadding).height + barHeight + IzleSpacing.Small
        progress != null -> IzleSpacing.Small + ProgressBarHeight + IzleSpacing.Small
        else -> 0.dp
    }

    if (label != null || progress != null) {
        Column(
            Modifier.align(Alignment.BottomStart).fillMaxWidth()
                // Taller than a small card if need be (the shade then starts above it); the card clips it.
                .wrapContentHeight(Alignment.Bottom, unbounded = true)
                .background(Brush.verticalGradient(listOf(Color.Transparent, IzleColors.PosterShade)))
                .padding(start = IzleSpacing.Small, end = IzleSpacing.Small, top = IzleSpacing.Large, bottom = IzleSpacing.Small),
        ) {
            if (label != null) ActionChip(badge, label, style)
            if (progress != null) {
                if (label != null) Spacer(Modifier.height(IzleSpacing.Small))
                ProgressBar(progress)
            }
        }
    }
    // "2 new" when episodes were added: quieter than the chip saying what OK does, no focus, read out in full.
    val newEpisodes = EpisodeNames.newEpisodes(entry)
    if (newEpisodes <= 0) return
    val short = pluralStringResource(R.plurals.badge_new_episodes_short, newEpisodes, newEpisodes)
    if (!fits(sizes.chip(short, MaterialTheme.typography.labelSmall, 0.dp), bottomHeight)) return
    val description = pluralStringResource(R.plurals.badge_new_episodes, newEpisodes, newEpisodes)
    Box(
        Modifier.align(Alignment.TopEnd).padding(IzleSpacing.Small)
            .clearAndSetSemantics { contentDescription = description }.posterChip(IzleColors.ChipInfo),
    ) {
        Text(short, style = MaterialTheme.typography.labelSmall, color = IzleColors.OnChipInfo, maxLines = 1, softWrap = false)
    }
}

/**
 * The open card's panel, [HomeGrid.INSET] inside its edges: the name at the top; at the bottom "2 new episodes", what
 * OK does in a 24 sp chip ("Continue · Episode 2", else "Continue" with "Episode 2" under it; 16 sp when the panel is
 * too narrow or short) and the progress bar, left out as [PanelFit] says. It lies over the backdrop, else the poster blurred, darkened; a
 * channel's (its name and "Live") or a show's without a picture is plain.
 */
@Composable
private fun OpenPanel(entry: HomeEntry, backdropUrl: String?, posterUrl: String?, grid: HomeGrid, sizes: TextSizes, modifier: Modifier) {
    val item = entry.item
    val badge = EpisodeNames.badge(item.kind, entry.playNext)
    val progress = EpisodeNames.progressFraction(entry.playNext)
    val newEpisodes = EpisodeNames.newEpisodes(entry)
    val text = chipText(badge)
    val typography = MaterialTheme.typography
    val inset = HomeGrid.INSET.dp
    val width = (grid.openWidth - grid.cardWidth).dp - 2 * inset
    val split = text.short != null && sizes.chip(text.full, typography.labelLarge, ChipVerticalPadding).width > width
    val label = if (split) text.short.orEmpty() else text.full
    val large = sizes.chip(label, typography.labelLarge, ChipVerticalPadding)
    val fit = PanelFit.of(
        height = (grid.cardHeight.dp - 2 * inset).value,
        nameLines = sizes.lines(item.title, typography.titleMedium, width),
        nameLine = sizes.lineHeight(typography.titleMedium).value,
        newLine = if (newEpisodes > 0) sizes.lineHeight(typography.bodySmall).value else 0f,
        largeChip = if (large.width <= width) large.height.value else 0f,
        smallChip = sizes.chip(label, typography.labelMedium, ChipVerticalPadding).height.value,
        episodeLine = if (split) sizes.lineHeight(typography.bodySmall).value else 0f,
        bar = if (progress != null) ProgressBarHeight.value else 0f,
        gap = IzleSpacing.Small.value,
    )
    Box(modifier.background(IzleColors.SurfaceHigh)) {
        if (!item.isLive) PanelPicture(backdropUrl, posterUrl)
        Column(Modifier.fillMaxSize().padding(inset)) {
            Text(item.title, style = typography.titleMedium, color = IzleColors.OnSurface, maxLines = fit.nameLines, overflow = TextOverflow.Ellipsis)
            Spacer(Modifier.weight(1f).heightIn(min = IzleSpacing.Small))
            if (fit.newEpisodes) {
                val count = pluralStringResource(R.plurals.badge_new_episodes, newEpisodes, newEpisodes)
                Text(count, style = typography.bodySmall, color = IzleColors.OnSurface, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Spacer(Modifier.height(IzleSpacing.Small))
            }
            ActionChip(badge, label, if (fit.largeChip) typography.labelLarge else typography.labelMedium)
            if (fit.episodeLine) {
                Spacer(Modifier.height(IzleSpacing.Small))
                Text(text.episode.orEmpty(), style = typography.bodySmall, color = IzleColors.OnSurface, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (progress != null && fit.bar) {
                Spacer(Modifier.height(IzleSpacing.Small))
                ProgressBar(progress)
            }
        }
    }
}

/**
 * Behind an open card's panel: the backdrop, else the poster decoded at [BLUR_WIDTH_PX] × [BLUR_HEIGHT_PX] and
 * stretched, under a scrim for white text; nothing without either.
 */
@Composable
private fun BoxScope.PanelPicture(backdropUrl: String?, posterUrl: String?) {
    var backdropFailed by remember(backdropUrl) { mutableStateOf(false) }
    val context = LocalPlatformContext.current
    if (backdropUrl != null && !backdropFailed) {
        AsyncImage(backdropUrl, null, Modifier.matchParentSize(), contentScale = ContentScale.Crop, onError = { backdropFailed = true })
    } else if (posterUrl != null) {
        val blurred = remember(posterUrl, context) {
            // Its own memory-cache entry: under the poster's, it would replace the card's poster there.
            ImageRequest.Builder(context).data(posterUrl).memoryCacheKey("$posterUrl#blur")
                .size(BLUR_WIDTH_PX, BLUR_HEIGHT_PX).precision(Precision.EXACT).build()
        }
        AsyncImage(blurred, null, Modifier.matchParentSize(), contentScale = ContentScale.Crop)
    } else {
        return
    }
    Box(Modifier.matchParentSize().background(IzleColors.PanelScrim))
}

private val ChipVerticalPadding = 2.dp

/** A chip's hairline edge, outside its text's padding (the admin page's mirror counts it too). */
private val ChipEdge = 1.dp

/**
 * How large texts are, for what fits a card: a chip ([posterChip]) with its text on one line, measured once per text
 * for all of Home (the same few labels, "New", "Live", "Episode 5", come back on most cards), and a name's lines.
 */
private class TextSizes(private val measurer: TextMeasurer, private val density: Density) {
    private val chips = HashMap<Triple<String, TextStyle, Dp>, DpSize>()

    fun chip(text: String, style: TextStyle, verticalPadding: Dp): DpSize = chips.getOrPut(Triple(text, style, verticalPadding)) {
        val size = measurer.measure(text, style, maxLines = 1, softWrap = false, density = density).size
        with(density) { DpSize(size.width.toDp() + 2 * (IzleSpacing.Small + ChipEdge), size.height.toDp() + 2 * (verticalPadding + ChipEdge)) }
    }

    /** The lines [text] takes at [width]. */
    fun lines(text: String, style: TextStyle, width: Dp): Int {
        val maxWidth = with(density) { width.roundToPx() }.coerceAtLeast(0)
        return measurer.measure(text, style, constraints = Constraints(maxWidth = maxWidth), density = density).lineCount
    }

    fun lineHeight(style: TextStyle): Dp = with(density) { style.lineHeight.toDp() }
}

/** What OK does, in a solid chip that reads on any picture; cut with "…" when even [style] is too wide. */
@Composable
private fun ActionChip(badge: TileBadge, label: String, style: TextStyle) {
    val (background, foreground) = when (badge) {
        TileBadge.Live -> IzleColors.Live to IzleColors.OnLive
        TileBadge.New -> IzleColors.New to IzleColors.OnNew
        TileBadge.Continue -> IzleColors.Accent to IzleColors.OnAccent
        TileBadge.WatchAgain -> IzleColors.ChipNeutral to IzleColors.OnChipNeutral
        is TileBadge.Episode -> if (badge.resume) IzleColors.Accent to IzleColors.OnAccent else IzleColors.ChipNeutral to IzleColors.OnChipNeutral
    }
    Box(Modifier.posterChip(background).padding(vertical = ChipVerticalPadding)) {
        Text(label, style = style, color = foreground, maxLines = 1, softWrap = false, overflow = TextOverflow.Ellipsis)
    }
}

/** A chip on a card, in [color]: the hairline edge lifts it off a busy picture. */
private fun Modifier.posterChip(color: Color) = this
    .border(ChipEdge, IzleColors.Hairline, IzleShapes.Small)
    .background(color, IzleShapes.Small)
    .padding(ChipEdge)
    .padding(horizontal = IzleSpacing.Small)

/** "Autoplay on start" over Home, like the player's "Up next". Back and any other key cancel it (see MainActivity). */
@Composable
fun AutoplayOverlay(ui: AutoplayUi, posterUrl: String?, onPlayNow: () -> Unit, onNotNow: () -> Unit) {
    val item = ui.entry.item
    PosterPanel(
        posterUrl,
        showTitle = item.title,
        title = item.title,
        lines = listOf(tileBadgeText(EpisodeNames.badge(item.kind, ui.entry.playNext))),
        countdown = PanelCountdown(stringResource(R.string.up_next_countdown, ui.secondsLeft), ui.secondsLeft, AutoplayPlan.COUNTDOWN_SEC),
        buttons = listOf(PanelButton(stringResource(R.string.play_now), onPlayNow), PanelButton(stringResource(R.string.not_now), onNotNow)),
    )
}
