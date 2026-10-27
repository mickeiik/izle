package io.github.mickeiik.izle.companion.home

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.github.mickeiik.izle.companion.tv.CommandOutcome
import io.github.mickeiik.izle.companion.tv.episodeName
import io.github.mickeiik.izle.companion.tv.sendAndAwait
import io.github.mickeiik.izle.data.api.AdminApp
import io.github.mickeiik.izle.data.api.AdminEpisode
import io.github.mickeiik.izle.data.api.AdminHomeEntry
import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.data.api.ApiException
import io.github.mickeiik.izle.data.api.CatalogHit
import io.github.mickeiik.izle.data.api.CheckRun
import io.github.mickeiik.izle.data.api.HomeChange
import io.github.mickeiik.izle.data.api.HomeSection
import io.github.mickeiik.izle.data.api.SectionEntry
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonPrimitive

/** Why a call failed: [Unreachable] (no answer) or the API's error [code] (`http_<status>` without one). */
sealed interface HomeError {
    data object Unreachable : HomeError
    data class Server(val code: String) : HomeError
}

/** A TV's Home as the tab shows it: the sections in order, the shows by id, the TV's apps, the grid size. */
data class HomeState(
    val loaded: Boolean = false,
    val loading: Boolean = true,
    /** The first load failed (a later reload that fails keeps what is shown). */
    val loadError: HomeError? = null,
    val sections: List<HomeSection> = emptyList(),
    val entries: Map<String, AdminHomeEntry> = emptyMap(),
    val columns: Int = 4,
    val rows: Int = 2,
    val homeMax: Int = 200,
    val sectionsMax: Int = 20,
    /** The TV's apps by id, in its report's order, then the app cards it no longer reports. */
    val apps: Map<String, AdminApp> = emptyMap(),
    /** When the TV's list of apps last changed; null: it never reported one (its app predates app cards). */
    val appsReportedAt: String? = null,
    /** A change is being saved: drags are ignored, other edits wait their turn. */
    val saving: Boolean = false,
) {
    val showCount: Int get() = sections.sumOf { it.itemIds.size }

    val appCount: Int get() = sections.sumOf { it.appCount }

    /** Titled sections: the untitled one does not count against [sectionsMax]. */
    val titledCount: Int get() = sections.count { it.id != UNTITLED_SECTION }

    fun section(id: String): HomeSection? = sections.firstOrNull { it.id == id }
}

/**
 * The Add show screen: a catalog search leaving out what is on this TV, by kind, paged by [PAGE]; or, with the Apps
 * chip chosen, the TV's apps not on Home yet ([appChoices]).
 */
data class ShowSearch(
    val query: String = "",
    /** `movie`, `series`, `live`; empty: every kind. */
    val kinds: Set<String> = emptySet(),
    /** The Apps chip: the TV's apps instead of shows (it and the kinds exclude each other). */
    val apps: Boolean = false,
    val items: List<CatalogHit> = emptyList(),
    val total: Int = 0,
    val loading: Boolean = false,
    val error: HomeError? = null,
    /** Where the next page starts in the server's list (the hits read so far, less those added since). */
    val next: Int = 0,
    /** The section shows are added to ("No title" unless the owner picks another; kept while the tab lives). */
    val addTo: String = UNTITLED_SECTION,
    /** The item (or app) being added. */
    val adding: String? = null,
) {
    val hasMore: Boolean get() = next < total
}

/**
 * The Apps chip's list: the TV's [apps] it still has that are not on Home, in its order, whose name holds [query]
 * (ignoring case; all of them for a blank one).
 */
fun appChoices(apps: Collection<AdminApp>, query: String): List<AdminApp> {
    val q = query.trim()
    return apps.filter { it.installed && !it.onHome && (q.isEmpty() || (it.label ?: it.appId).contains(q, ignoreCase = true)) }
}

/** The episodes of a series for Continue from episode… (those that may play), or why they could not be read. */
data class EpisodePick(val itemId: String, val loading: Boolean = true, val episodes: List<AdminEpisode> = emptyList(), val error: HomeError? = null)

/** What the tab says in a snackbar (the host shows it). */
sealed interface HomeNotice {
    /** `home_changed`, `not_on_home`, `unknown_section`: reloaded. */
    data object ChangedElsewhere : HomeNotice
    data class Failed(val error: HomeError) : HomeNotice
    /** [sectionTitle] null: the untitled section ("added to Home."). */
    data class Added(val title: String, val sectionTitle: String?) : HomeNotice
    data class Continues(val title: String, val episode: String) : HomeNotice
    /** What Play now came to (queued for an offline TV, playing, refused, or no result yet). */
    data class Played(val title: String, val outcome: CommandOutcome) : HomeNotice
    /** A check was started while [run] was going: the strip follows that one instead. */
    data class CheckRunning(val run: CheckRun) : HomeNotice
}

/**
 * One TV's Home for the companion's Home tab: loaded with `GET admin/devices/:id`, followed through the event log
 * while [follow] runs, and changed one single change at a time (add, move, remove, one section's title, layout or
 * place; never the whole Home), each answer redrawing the list. A change the server refuses because Home changed
 * elsewhere reloads and says so.
 */
class HomeViewModel(private val api: ApiClient, val tvId: String) : ViewModel() {
    private val _state = MutableStateFlow(HomeState())
    val state: StateFlow<HomeState> = _state.asStateFlow()

    private val _search = MutableStateFlow(ShowSearch())
    val search: StateFlow<ShowSearch> = _search.asStateFlow()

    private val _episodes = MutableStateFlow<EpisodePick?>(null)
    val episodes: StateFlow<EpisodePick?> = _episodes.asStateFlow()

    private val _revoked = MutableStateFlow(false)

    /** The server answered `401`: this phone was disconnected (the host goes back to Connect). */
    val revoked: StateFlow<Boolean> = _revoked.asStateFlow()

    private val _notices = Channel<HomeNotice>(Channel.BUFFERED)
    val notices: Flow<HomeNotice> = _notices.receiveAsFlow()

    /** The check shown in the strip: a Home's or a show's run, started here or found running when the tab opened. */
    val checks = CheckRuns(api, viewModelScope) { _notices.trySend(it) }

    /** Changes run one after another, in the order they were made. */
    private val changes = Mutex()
    private var searchJob: Job? = null

    /** Loads Home, then reloads on each event about it (or a gap) until cancelled: run it while the tab is shown. */
    suspend fun follow() {
        var after: Long? = null
        var first = true
        while (true) {
            try {
                if (after == null) {
                    // Where the log is now, then the Home as it is: nothing that happens in between is missed.
                    after = api.adminEvents(null, types = EVENT_TYPES, devices = listOf(tvId)).last
                    if (first || !_state.value.loaded) changes.withLock { reload() }
                    if (first) resumeCheck()
                    first = false
                }
                val page = api.adminEvents(after, waitSec = 25, types = EVENT_TYPES, devices = listOf(tvId))
                // After the change being saved (its own event included), so a reload never draws the list from before it.
                if (page.gap || page.events.isNotEmpty()) changes.withLock { reload() }
                after = page.last
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                failure(e)
                if (first) {
                    // The log could not be read: load anyway, so the tab shows Home (or why not).
                    changes.withLock { reload() }
                    resumeCheck()
                    first = false
                }
                delay(RETRY_MS)
            }
        }
    }

    /** Follows a check already running for this TV's Home, or for one of its shows. */
    private suspend fun resumeCheck() = checks.resume { run ->
        run.target.deviceId == tvId || run.target.itemId?.let { it in _state.value.entries } == true
    }

    /** Reads Home anew; a failure keeps what is shown (only a first load shows the error). */
    suspend fun reload() {
        _state.update { it.copy(loading = true) }
        try {
            val d = api.device(tvId)
            _state.update {
                it.copy(
                    loaded = true,
                    loading = false,
                    loadError = null,
                    sections = d.sections,
                    entries = d.home.associateBy(AdminHomeEntry::itemId),
                    columns = d.device.effective?.homeColumns ?: it.columns,
                    rows = d.device.effective?.homeRows ?: it.rows,
                    homeMax = d.homeMax,
                    sectionsMax = d.sectionsMax,
                    apps = d.apps.associateBy(AdminApp::appId),
                    appsReportedAt = d.appsReportedAt,
                )
            }
        } catch (e: CancellationException) {
            _state.update { it.copy(loading = false) }
            throw e
        } catch (e: Exception) {
            val error = failure(e)
            _state.update { it.copy(loading = false, loadError = if (it.loaded) null else error) }
        }
    }

    fun retry() {
        viewModelScope.launch { changes.withLock { reload() } }
    }

    // --- single changes ---------------------------------------------------------------------------------------------

    /**
     * Moves a show or an app card (drag and drop, Move to section…, Move to first); the list shows the move at once.
     * [to]'s position counts every card of the section, as the server does.
     */
    fun move(card: SectionEntry, to: HomePlace) {
        if (placeOf(_state.value.sections, card) == to) return
        change(optimistic = { moveCard(it, card, to) }) {
            val appId = card.appId
            if (appId != null) api.moveHomeApp(tvId, appId, to.sectionId, to.position)
            else api.moveHomeItem(tvId, card.itemId.orEmpty(), to.sectionId, to.position)
        }
    }

    fun remove(card: SectionEntry) = change(optimistic = { removeCard(it, card) }) {
        val appId = card.appId
        if (appId != null) api.removeHomeApp(tvId, appId) else api.removeHomeItem(tvId, card.itemId.orEmpty())
    }

    fun addSection(title: String) {
        val t = title.trim()
        if (t.isEmpty()) return
        change { api.addSection(tvId, t) }
    }

    fun rename(sectionId: String, title: String) {
        val t = title.trim()
        if (t.isEmpty() || sectionId == UNTITLED_SECTION) return
        change(optimistic = { s -> s.map { if (it.id == sectionId) it.copy(title = t) else it } }) { api.updateSection(tvId, sectionId, title = t) }
    }

    fun setLayout(sectionId: String, layout: String) =
        change(optimistic = { s -> s.map { if (it.id == sectionId) it.copy(layout = layout) else it } }) {
            api.updateSection(tvId, sectionId, layout = layout)
        }

    /** Moves a section up (-1) or down (+1) among the sections. */
    fun moveSection(sectionId: String, by: Int) {
        val sections = _state.value.sections
        val from = sections.indexOfFirst { it.id == sectionId }
        val to = from + by
        if (from < 0 || to !in sections.indices) return
        change(optimistic = { s -> s.toMutableList().apply { add(to, removeAt(from)) } }) { api.updateSection(tvId, sectionId, position = to) }
    }

    fun deleteSection(sectionId: String) {
        if (sectionId == UNTITLED_SECTION) return
        change { api.deleteSection(tvId, sectionId) }
    }

    /** `PATCH` the grid: columns 3–10, rows 1–4. */
    fun setGrid(columns: Int, rows: Int) {
        viewModelScope.launch {
            changes.withLock {
                _state.update { it.copy(saving = true) }
                try {
                    val d = api.updateDevice(tvId, homeColumns = columns.coerceIn(3, 10), homeRows = rows.coerceIn(1, 4))
                    _state.update { it.copy(columns = d.effective?.homeColumns ?: columns, rows = d.effective?.homeRows ?: rows) }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    _notices.trySend(HomeNotice.Failed(failure(e)))
                } finally {
                    _state.update { it.copy(saving = false) }
                }
            }
        }
    }

    /**
     * One change: [optimistic] redraws the list at once, the answer redraws it again; on a failure the list is read
     * anew (and the previous one stays when that fails too).
     */
    private fun change(optimistic: ((List<HomeSection>) -> List<HomeSection>)? = null, call: suspend () -> HomeChange) {
        viewModelScope.launch {
            changes.withLock {
                val before = _state.value.sections
                _state.update { it.copy(saving = true, sections = optimistic?.invoke(it.sections) ?: it.sections) }
                try {
                    apply(call())
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    _state.update { it.copy(sections = before) }
                    val error = failure(e)
                    _notices.trySend(if (error is HomeError.Server && error.code in CHANGED_ELSEWHERE) HomeNotice.ChangedElsewhere else HomeNotice.Failed(error))
                    reload()
                } finally {
                    _state.update { it.copy(saving = false) }
                }
            }
        }
    }

    private fun apply(c: HomeChange) {
        _state.update {
            it.copy(sections = c.sections, entries = c.home.associateBy(AdminHomeEntry::itemId), apps = c.apps?.associateBy(AdminApp::appId) ?: it.apps)
        }
    }

    // --- playing and the cursor -------------------------------------------------------------------------------------

    /** Play on the TV now: what OK plays for [itemId]; says once whether it plays (or why not), within a few seconds. */
    fun play(itemId: String) {
        val title = titleOf(itemId)
        viewModelScope.launch {
            try {
                _notices.trySend(HomeNotice.Played(title, api.sendAndAwait(tvId, "play", mapOf("itemId" to JsonPrimitive(itemId)))))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _notices.trySend(HomeNotice.Failed(failure(e)))
            }
        }
    }

    /** Reads the episodes of [itemId] that may play, for Continue from episode…. */
    fun loadEpisodes(itemId: String) {
        _episodes.value = EpisodePick(itemId)
        viewModelScope.launch {
            _episodes.value = try {
                EpisodePick(itemId, loading = false, episodes = api.catalogItem(itemId).episodes.filter { it.playbackAllowed })
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                EpisodePick(itemId, loading = false, error = failure(e))
            }
        }
    }

    fun closeEpisodes() {
        _episodes.value = null
    }

    /** OK on the TV continues [itemId] from [episode] (from its beginning). */
    fun continueFrom(itemId: String, episode: AdminEpisode) {
        val title = titleOf(itemId)
        viewModelScope.launch {
            try {
                api.setCursor(tvId, itemId, episode.id)
                _notices.trySend(HomeNotice.Continues(title, episodeName(episode)))
                _episodes.value = null
                changes.withLock { reload() }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _notices.trySend(HomeNotice.Failed(failure(e)))
            }
        }
    }

    // --- Add show ---------------------------------------------------------------------------------------------------

    /** Opens the search anew (keeping the section chosen in Add to, when it still exists). */
    fun openSearch() {
        val addTo = _search.value.addTo.takeIf { id -> _state.value.section(id) != null } ?: UNTITLED_SECTION
        _search.value = ShowSearch(addTo = addTo)
        runSearch(debounce = false)
    }

    fun setQuery(q: String) {
        if (q == _search.value.query) return
        _search.update { it.copy(query = q) }
        // The apps are filtered here as the text changes; the catalog is searched when the Apps chip is let go.
        if (!_search.value.apps) runSearch(debounce = true)
    }

    fun toggleKind(kind: String) {
        _search.update { it.copy(kinds = if (kind in it.kinds) it.kinds - kind else it.kinds + kind, apps = false) }
        runSearch(debounce = false)
    }

    /** The Apps chip: the TV's apps instead of shows; choosing it lets go of the kinds. */
    fun toggleApps() {
        val apps = !_search.value.apps
        _search.update { it.copy(apps = apps, kinds = emptySet()) }
        if (apps) {
            searchJob?.cancel()
            _search.update { it.copy(loading = false, error = null) }
        } else {
            runSearch(debounce = false)
        }
    }

    fun setAddTo(sectionId: String) = _search.update { it.copy(addTo = sectionId) }

    /** The next page, when the list is scrolled to its end. */
    fun loadMore() {
        val s = _search.value
        if (s.apps || s.loading || !s.hasMore || s.error != null) return
        searchJob = viewModelScope.launch { fetch(s.next) }
    }

    private fun runSearch(debounce: Boolean) {
        searchJob?.cancel()
        _search.update { it.copy(loading = true, error = null) }
        searchJob = viewModelScope.launch {
            if (debounce) delay(SEARCH_DEBOUNCE_MS)
            fetch(0)
        }
    }

    private suspend fun fetch(offset: Int) {
        val s = _search.value
        _search.update { it.copy(loading = true, error = null) }
        try {
            val page = api.catalogSearch(s.query.trim(), s.kinds.sorted(), notOnDevice = tvId, playable = true, offset = offset, limit = PAGE)
            _search.update {
                // A page read before an add may still list what was added since.
                val fresh = page.items.filter { h -> _state.value.entries[h.id] == null }
                val items = if (offset == 0) fresh else (it.items + fresh).distinctBy(CatalogHit::id)
                it.copy(items = items, total = page.total, next = offset + page.items.size, loading = false)
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _search.update { it.copy(loading = false, error = failure(e)) }
        }
    }

    /** Adds [hit] to the end of the section chosen in Add to; it leaves the results (it is on this TV now). */
    fun add(hit: CatalogHit) = addCard(hit.id, hit.title, { sectionId -> api.addHomeItem(tvId, hit.id, sectionId) }) {
        _search.update { it.copy(items = it.items.filter { h -> h.id != hit.id }, total = (it.total - 1).coerceAtLeast(0), next = (it.next - 1).coerceAtLeast(0)) }
    }

    /** Puts an app card for [app] at the end of the section chosen in Add to; the answer's apps take it off the choices. */
    fun addApp(app: AdminApp) = addCard(app.appId, app.label ?: app.appId, { sectionId -> api.addHomeApp(tvId, app.appId, sectionId) }) {}

    /** One add from the Add show screen, one at a time; [added] updates the results once the server took it. */
    private fun addCard(id: String, title: String, call: suspend (sectionId: String) -> HomeChange, added: () -> Unit) {
        val s = _search.value
        if (s.adding != null) return
        val sectionId = s.addTo.takeIf { _state.value.section(it) != null } ?: UNTITLED_SECTION
        _search.update { it.copy(adding = id) }
        viewModelScope.launch {
            changes.withLock {
                _state.update { it.copy(saving = true) }
                try {
                    apply(call(sectionId))
                    added()
                    val section = _state.value.section(sectionId)
                    _notices.trySend(HomeNotice.Added(title, section?.title.takeIf { sectionId != UNTITLED_SECTION }))
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    val error = failure(e)
                    if (error is HomeError.Server && error.code in CHANGED_ELSEWHERE) {
                        _notices.trySend(HomeNotice.ChangedElsewhere)
                        reload()
                    } else {
                        _notices.trySend(HomeNotice.Failed(error))
                        // The TV's apps changed since they were read (gone, or put on Home elsewhere): show them as they are.
                        if (error is HomeError.Server && error.code in APPS_CHANGED) reload()
                    }
                } finally {
                    _search.update { it.copy(adding = null) }
                    _state.update { it.copy(saving = false) }
                }
            }
        }
    }

    /** [errorOf], noting a revoked phone. */
    private fun failure(e: Exception): HomeError {
        if (e is ApiException && e.status == 401) _revoked.value = true
        return errorOf(e)
    }

    private fun titleOf(itemId: String): String = _state.value.entries[itemId]?.title ?: itemId

    companion object {
        val EVENT_TYPES = listOf("home.changed", "cursor.changed", "device.updated", "device.apps", "catalog.reloaded", "check.finished")

        /** Answers that mean Home is not what this screen showed: reload and say so. */
        val CHANGED_ELSEWHERE = setOf("home_changed", "not_on_home", "unknown_section")

        /** Answers to adding an app that mean the TV's apps are not what this screen showed: said in words, then reloaded. */
        val APPS_CHANGED = setOf("unknown_app", "duplicate_app")

        const val PAGE = 50
        const val SEARCH_DEBOUNCE_MS = 300L
        const val RETRY_MS = 5_000L

        fun errorOf(e: Exception): HomeError =
            if (e is ApiException) HomeError.Server(e.code) else HomeError.Unreachable
    }
}
