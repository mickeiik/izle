package io.github.mickeiik.izle.companion.activity

import androidx.lifecycle.ViewModel
import io.github.mickeiik.izle.data.api.AdminEvent
import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.data.api.ApiException
import io.github.mickeiik.izle.data.api.orNullOnFailure
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** The Activity as shown: [events] newest first, the [filter], and what names their episodes ([context]). */
data class ActivityState(
    val filter: ActivityFilter = ActivityFilter.Everything,
    val loaded: Boolean = false,
    val loading: Boolean = true,
    /** The last read failed: null (no answer) or the API's error code; cleared by the next read that works. */
    val error: String? = null,
    val failed: Boolean = false,
    val events: List<AdminEvent> = emptyList(),
    val context: EventContext = EventContext(),
)

/**
 * One TV's event log for the Activity screen: read from the start of the kept log (`after=0`), 500 a page up to the
 * newest, the newest [KEEP] kept, then followed by long-poll while [follow] runs; a gap reads it all again. A filter
 * reads anew with its types. The episodes that events name only by id are looked up in the catalog once each.
 */
class ActivityViewModel(private val api: ApiClient, val tvId: String) : ViewModel() {
    private val _state = MutableStateFlow(ActivityState())
    val state: StateFlow<ActivityState> = _state.asStateFlow()

    /** Shows already looked up (whether or not the catalog had them). */
    private val lookedUp = mutableSetOf<String>()

    /** Picks a filter; the screen restarts [follow], which reads anew. */
    fun select(filter: ActivityFilter) {
        if (filter == _state.value.filter) return
        _state.update { it.copy(filter = filter, loaded = false, loading = true, events = emptyList()) }
    }

    fun setThisPhone(phoneId: String?) {
        _state.update { it.copy(context = it.context.copy(thisPhoneId = phoneId)) }
    }

    /** Reads the log for the current filter, then follows it until cancelled: run it while the screen is shown. */
    suspend fun follow() {
        val filter = _state.value.filter
        var after: Long? = null
        while (true) {
            try {
                if (after == null) after = readAll(filter)
                val page = api.adminEvents(after, waitSec = WAIT_SEC, types = filter.types, devices = listOf(tvId), limit = PAGE)
                if (page.gap) {
                    after = null
                    continue
                }
                if (page.events.isNotEmpty()) add(page.events, replace = false)
                after = page.last
                _state.update { it.copy(error = null, failed = false) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _state.update { it.copy(loading = false, failed = true, error = (e as? ApiException)?.code) }
                delay(RETRY_MS)
            }
        }
    }

    /** Reads the whole kept log, page after page, keeping the newest [KEEP]; answers where to follow from. */
    private suspend fun readAll(filter: ActivityFilter): Long {
        _state.update { it.copy(loading = true) }
        var after = 0L
        val kept = ArrayDeque<AdminEvent>()
        while (true) {
            // From the start: a gap here only says the oldest events are gone, which is what reading from 0 means.
            val page = api.adminEvents(after, types = filter.types, devices = listOf(tvId), limit = PAGE)
            for (e in page.events) {
                kept.addLast(e)
                if (kept.size > KEEP) kept.removeFirst()
            }
            if (page.last <= after || page.events.size < PAGE) {
                after = maxOf(after, page.last)
                break
            }
            after = page.last
        }
        add(kept.toList(), replace = true)
        _state.update { it.copy(loaded = true, loading = false, error = null, failed = false) }
        return after
    }

    /** Adds [oldestFirst] events (or replaces them all), newest first, at most [KEEP]; then names their episodes. */
    private suspend fun add(oldestFirst: List<AdminEvent>, replace: Boolean) {
        _state.update { s ->
            val events = ((if (replace) emptyList() else s.events.asReversed()) + oldestFirst)
                .distinctBy { it.id }
                .takeLast(KEEP)
                .asReversed()
            s.copy(events = events, context = s.context.learn(oldestFirst))
        }
        lookUpEpisodes()
    }

    /** Reads the shows whose episodes events name only by id (a continue point, a seen episode, a problem). */
    private suspend fun lookUpEpisodes() {
        val s = _state.value
        val needed = s.events.filter { it.type in NAMED_BY_ID }.mapNotNull { e ->
            val episodeId = e.data.string("episodeId")
            val itemId = e.data.string("itemId") ?: return@mapNotNull null
            itemId.takeIf { episodeId == null || episodeId !in s.context.episodes }
        }.distinct().filter { it !in lookedUp }.take(MAX_LOOKUPS)
        for (itemId in needed) {
            lookedUp += itemId
            val item = orNullOnFailure { api.catalogItem(itemId) } ?: continue
            _state.update { st ->
                val refs = item.episodes.associate { it.id to EpisodeRef(item.title, it.season, it.number, it.label, it.title) }
                st.copy(context = st.context.copy(episodes = st.context.episodes + refs, items = st.context.items + (item.id to item.title)))
            }
        }
    }

    companion object {
        /** Events kept on screen. */
        const val KEEP = 300

        /** Events per page (the server's most). */
        const val PAGE = 500
        const val WAIT_SEC = 25
        const val RETRY_MS = 5_000L

        /** Shows looked up per read at most. */
        private const val MAX_LOOKUPS = 20

        private val NAMED_BY_ID = setOf("cursor.changed", "episode.seen", "problem.recorded")

        private fun kotlinx.serialization.json.JsonObject.string(key: String): String? =
            (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
    }
}
