package io.github.mickeiik.izle.companion.home

import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.lazy.LazyListItemInfo
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import io.github.mickeiik.izle.data.api.HomeSection
import io.github.mickeiik.izle.data.api.SectionEntry
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Drag and drop of the Home tab's cards (shows and app cards), in plain Compose: while a card is dragged, [preview] is
 * Home with the card where it would land (the list draws it), moved one row at a time by [dragTarget] as the card's
 * middle passes over another row; on release [onDrop] gets the card and its new place (once, and only when it
 * changed), which the view model sends as one move. The list scrolls by itself when the card is held past its top or
 * bottom edge.
 */
class HomeDragState(
    private val list: LazyListState,
    private val scope: CoroutineScope,
    private val sections: () -> List<HomeSection>,
    private val canStart: () -> Boolean,
    private val onDrop: (card: SectionEntry, to: HomePlace) -> Unit,
) {
    var dragged: SectionEntry? by mutableStateOf(null)
        private set

    /** Home as the list draws it while dragging; null when nothing is dragged. */
    var preview: List<HomeSection>? by mutableStateOf(null)
        private set

    private var startTop = 0
    private var distance by mutableFloatStateOf(0f)
    private var autoScroll: Job? = null
    private var laidOutBeforeMove: Any? = null

    /** How far the dragged row is drawn from where the list lays it out. */
    val draggedOffset: Float
        get() = draggedItem()?.let { startTop + distance - it.offset } ?: 0f

    /** Starts dragging the card under [y] (a long press on its row). */
    fun startAt(y: Float) {
        val hit = list.layoutInfo.visibleItemsInfo.firstOrNull { y.toInt() in it.offset until it.offset + it.size } ?: return
        (hit.key as? String)?.let(::cardOfKey)?.let(::start)
    }

    /** Starts dragging [card] (its handle). Ignored while a change is being saved. */
    fun start(card: SectionEntry) {
        if (dragged != null || !canStart()) return
        val item = list.layoutInfo.visibleItemsInfo.firstOrNull { it.key == cardKey(card) } ?: return
        if (placeOf(sections(), card) == null) return
        startTop = item.offset
        distance = 0f
        preview = sections()
        dragged = card
    }

    fun drag(dy: Float) {
        if (dragged == null) return
        distance += dy
        step()
        val edge = overEdge()
        if (edge != 0f && autoScroll?.isActive != true) {
            autoScroll = scope.launch {
                while (isActive && dragged != null) {
                    val by = overEdge()
                    if (by == 0f) break
                    val scrolled = list.scrollBy(by.coerceIn(-MAX_SCROLL, MAX_SCROLL))
                    if (scrolled == 0f) break
                    step()
                    delay(16)
                }
            }
        }
    }

    fun end() {
        val card = dragged
        val landed = preview?.let { p -> card?.let { placeOf(p, it) } }
        val was = card?.let { placeOf(sections(), it) }
        clear()
        if (card != null && landed != null && landed != was) onDrop(card, landed)
    }

    fun cancel() = clear()

    private fun clear() {
        autoScroll?.cancel()
        autoScroll = null
        dragged = null
        preview = null
        distance = 0f
        laidOutBeforeMove = null
    }

    private fun draggedItem(): LazyListItemInfo? {
        val card = dragged ?: return null
        return list.layoutInfo.visibleItemsInfo.firstOrNull { it.key == cardKey(card) }
    }

    /** Moves the dragged card one place when its middle is over another row of Home. */
    private fun step() {
        val card = dragged ?: return
        val current = preview ?: return
        // Until the list is laid out anew after a move, its rows are where they were: wait for it (else it swings back).
        if (list.layoutInfo === laidOutBeforeMove) return
        val item = draggedItem() ?: return
        val middle = startTop + distance + item.size / 2f
        val over = list.layoutInfo.visibleItemsInfo.firstOrNull { other ->
            other.key != item.key && (other.key as? String)?.let(::isHomeRowKey) == true &&
                middle >= other.offset && middle < other.offset + other.size
        } ?: return
        val to = dragTarget(current, card, over.key as String) ?: return
        // The list keeps its first visible row in place: when that is one of the two rows trading places, keep the scroll.
        val first = list.firstVisibleItemIndex
        val firstOffset = list.firstVisibleItemScrollOffset
        val keepScroll = item.index == first || over.index == first
        laidOutBeforeMove = list.layoutInfo
        preview = moveCard(current, card, to)
        if (keepScroll) scope.launch { list.scrollToItem(first, firstOffset) }
    }

    /** How far the dragged row is past the list's top (negative) or bottom (positive) edge. */
    private fun overEdge(): Float {
        val item = draggedItem() ?: return 0f
        val top = startTop + distance
        val info = list.layoutInfo
        return when {
            top < info.viewportStartOffset -> top - info.viewportStartOffset
            top + item.size > info.viewportEndOffset -> top + item.size - info.viewportEndOffset
            else -> 0f
        }
    }

    private companion object {
        const val MAX_SCROLL = 24f
        fun isHomeRowKey(key: String) = key.startsWith("i:") || key.startsWith("a:") || key.startsWith("s:") || key.startsWith("e:")
    }
}

@Composable
fun rememberHomeDragState(
    list: LazyListState,
    sections: () -> List<HomeSection>,
    canStart: () -> Boolean,
    onDrop: (SectionEntry, HomePlace) -> Unit,
): HomeDragState {
    val scope = rememberCoroutineScope()
    val currentSections by rememberUpdatedState(sections)
    val currentCanStart by rememberUpdatedState(canStart)
    val currentOnDrop by rememberUpdatedState(onDrop)
    return remember(list) { HomeDragState(list, scope, { currentSections() }, { currentCanStart() }, { card, to -> currentOnDrop(card, to) }) }
}

/** On the list: a long press on a card's row picks it up. */
fun Modifier.homeDragContainer(drag: HomeDragState): Modifier = pointerInput(drag) {
    detectDragGesturesAfterLongPress(
        onDragStart = { drag.startAt(it.y) },
        onDrag = { change, amount ->
            if (drag.dragged != null) {
                change.consume()
                drag.drag(amount.y)
            }
        },
        onDragEnd = drag::end,
        onDragCancel = drag::cancel,
    )
}

/** On a card's handle: dragging picks it up at once. */
fun Modifier.homeDragHandle(drag: HomeDragState, card: SectionEntry): Modifier = pointerInput(drag, card) {
    detectDragGestures(
        onDragStart = { drag.start(card) },
        onDrag = { change, amount ->
            if (drag.dragged == card) {
                change.consume()
                drag.drag(amount.y)
            }
        },
        onDragEnd = drag::end,
        onDragCancel = drag::cancel,
    )
}
