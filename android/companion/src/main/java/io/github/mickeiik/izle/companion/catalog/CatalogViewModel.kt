package io.github.mickeiik.izle.companion.catalog

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.github.mickeiik.izle.companion.home.HomeError
import io.github.mickeiik.izle.companion.home.HomeViewModel
import io.github.mickeiik.izle.companion.home.UNTITLED_SECTION
import io.github.mickeiik.izle.data.api.AdminCatalog
import io.github.mickeiik.izle.data.api.AdminHomeEntry
import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.data.api.ApiException
import io.github.mickeiik.izle.data.api.CatalogBuild
import io.github.mickeiik.izle.data.api.CatalogChanges
import io.github.mickeiik.izle.data.api.CatalogHit
import io.github.mickeiik.izle.data.api.CatalogIssue
import io.github.mickeiik.izle.data.api.CatalogSearch
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

/** The Catalog tab: the search and its filters, the results (paged by [CatalogViewModel.PAGE]), and what this TV has on Home. */
data class CatalogState(
    val query: String = "",
    /** `movie`, `series`, `live`; empty: every kind. */
    val kinds: Set<String> = emptySet(),
    /** Only what the newest build added ([newSince]). */
    val onlyNew: Boolean = false,
    val notOnHome: Boolean = false,
    val sort: String = CatalogSearch.SORT_TITLE,
    val items: List<CatalogHit> = emptyList(),
    val total: Int = 0,
    /** Where the next page starts in the server's list. */
    val next: Int = 0,
    val searched: Boolean = false,
    /** Counts the searches answered from their first page: the list goes back to the top on each. */
    val generation: Int = 0,
    val loading: Boolean = true,
    val error: HomeError? = null,
    /** The shows on this TV's Home (null until read). */
    val onHome: Set<String>? = null,
    val catalog: AdminCatalog? = null,
    /** A reload of the bundle is running on the server. */
    val reloading: Boolean = false,
) {
    val hasMore: Boolean get() = next < total

    /** The newest build that is not the baseline: what What's new and the New filter are about. */
    val newestBuild: CatalogBuild? get() = catalog?.builds?.firstOrNull { !it.baseline }

    /** The New filter's `since`: when the newest build was loaded. */
    val newSince: String? get() = newestBuild?.loadedAt

    fun isOnHome(itemId: String): Boolean = onHome?.contains(itemId) == true
}

/** What's new: the chosen build ([buildId]) and what it changed. */
data class WhatsNew(
    val buildId: String,
    val changes: CatalogChanges? = null,
    /** The new shows found by a search (for their posters and lines), by id. */
    val hits: Map<String, CatalogHit> = emptyMap(),
    val loading: Boolean = true,
    val error: HomeError? = null,
    /** The item being added to Home. */
    val adding: String? = null,
)

/** What the tab says in a snackbar or a dialog. */
sealed interface CatalogNotice {
    data class Failed(val error: HomeError) : CatalogNotice
    data class Reloaded(val buildId: String) : CatalogNotice
    /** A reload the server refused: the catalog loaded before stays. */
    data class ReloadRefused(val issues: List<CatalogIssue>) : CatalogNotice
    data class Added(val title: String) : CatalogNotice
}

/**
 * The server's catalog seen from one TV: searched by title with filters (kinds, New, Not on Home) and a sort, paged
 * as the list scrolls; the loaded catalog (its builds, for What's new and About); a reload of the bundle.
 */
class CatalogViewModel(private val api: ApiClient, val tvId: String) : ViewModel() {
    private val _state = MutableStateFlow(CatalogState())
    val state: StateFlow<CatalogState> = _state.asStateFlow()

    private val _whatsNew = MutableStateFlow<WhatsNew?>(null)

    /** What's new while it is open (it stays open while a show opened from it is shown). */
    val whatsNew: StateFlow<WhatsNew?> = _whatsNew.asStateFlow()

    private val _notices = Channel<CatalogNotice>(Channel.BUFFERED)
    val notices: Flow<CatalogNotice> = _notices.receiveAsFlow()

    /** Where the list was scrolled to, kept while a show's page covers the tab. */
    var scrollIndex: Int = 0
    var scrollOffset: Int = 0

    private var searchJob: Job? = null
    private var whatsNewJob: Job? = null

    /**
     * The tab is shown: the catalog and this TV's Home are read (again), and the first time the search runs. Coming
     * back from a show keeps the results and only redraws what is on Home.
     */
    fun start() {
        viewModelScope.launch { readCatalog() }
        viewModelScope.launch { readHome() }
        if (!_state.value.searched) runSearch(debounce = false)
    }

    private suspend fun readCatalog() {
        try {
            val catalog = api.catalog()
            _state.update { it.copy(catalog = catalog) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // The list says why when the search fails too; the What's new row is just left out.
        }
    }

    private suspend fun readHome() {
        try {
            setHome(api.device(tvId).home.map(AdminHomeEntry::itemId).toSet())
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // Without it the rows just don't say "On Home".
        }
    }

    private fun setHome(home: Set<String>) {
        _state.update { s ->
            // With Not on Home, a show added since (from its page or What's new) leaves the results.
            if (!s.notOnHome) s.copy(onHome = home)
            else {
                val gone = s.items.count { it.id in home }
                s.copy(onHome = home, items = s.items.filter { it.id !in home }, total = (s.total - gone).coerceAtLeast(0), next = (s.next - gone).coerceAtLeast(0))
            }
        }
    }

    fun setQuery(q: String) {
        if (q == _state.value.query) return
        _state.update { it.copy(query = q) }
        runSearch(debounce = true)
    }

    fun toggleKind(kind: String) {
        _state.update { it.copy(kinds = if (kind in it.kinds) it.kinds - kind else it.kinds + kind) }
        runSearch(debounce = false)
    }

    fun toggleNew() {
        if (_state.value.newSince == null && !_state.value.onlyNew) return
        _state.update { it.copy(onlyNew = !it.onlyNew) }
        runSearch(debounce = false)
    }

    fun toggleNotOnHome() {
        _state.update { it.copy(notOnHome = !it.notOnHome) }
        runSearch(debounce = false)
    }

    fun setSort(sort: String) {
        if (sort == _state.value.sort) return
        _state.update { it.copy(sort = sort) }
        runSearch(debounce = false)
    }

    fun retry() = runSearch(debounce = false)

    /** The next page, when the list is scrolled near its end. */
    fun loadMore() {
        val s = _state.value
        if (s.loading || !s.hasMore || s.error != null) return
        searchJob = viewModelScope.launch { fetch(s.next) }
    }

    private fun runSearch(debounce: Boolean) {
        searchJob?.cancel()
        _state.update { it.copy(loading = true, error = null) }
        searchJob = viewModelScope.launch {
            if (debounce) delay(HomeViewModel.SEARCH_DEBOUNCE_MS)
            fetch(0)
        }
    }

    private suspend fun fetch(offset: Int) {
        val s = _state.value
        _state.update { it.copy(loading = true, error = null) }
        try {
            val page = api.catalogSearch(
                s.query.trim(),
                s.kinds.sorted(),
                notOnDevice = tvId.takeIf { s.notOnHome },
                offset = offset,
                limit = PAGE,
                since = s.newSince.takeIf { s.onlyNew },
                sort = s.sort,
            )
            _state.update {
                val items = if (offset == 0) page.items else (it.items + page.items).distinctBy(CatalogHit::id)
                it.copy(
                    items = items,
                    total = page.total,
                    next = offset + page.items.size,
                    loading = false,
                    searched = true,
                    generation = if (offset == 0) it.generation + 1 else it.generation,
                )
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _state.update { it.copy(loading = false, searched = true, error = HomeViewModel.errorOf(e)) }
        }
    }

    // --- the catalog: reload ----------------------------------------------------------------------------------------

    /** Re-reads the bundle on the server; says which build is loaded now, or the issues of the one it refused. */
    fun reload() {
        if (_state.value.reloading) return
        _state.update { it.copy(reloading = true) }
        viewModelScope.launch {
            try {
                val catalog = api.reloadCatalog()
                _state.update { it.copy(catalog = catalog) }
                _notices.trySend(CatalogNotice.Reloaded(catalog.buildId))
                runSearch(debounce = false)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val refused = e is ApiException && e.code == INVALID_CATALOG
                _notices.trySend(if (refused) CatalogNotice.ReloadRefused((e as ApiException).issues) else CatalogNotice.Failed(HomeViewModel.errorOf(e)))
            } finally {
                _state.update { it.copy(reloading = false) }
            }
        }
    }

    // --- What's new -------------------------------------------------------------------------------------------------

    /** Opens What's new on the newest build that is not the baseline (or the newest one). */
    fun openWhatsNew() {
        val catalog = _state.value.catalog ?: return
        val build = _state.value.newestBuild ?: catalog.builds.firstOrNull() ?: return
        selectBuild(build.buildId)
    }

    fun closeWhatsNew() {
        whatsNewJob?.cancel()
        _whatsNew.value = null
    }

    /** Shows what [buildId] changed: the newest build's changes come with the catalog, older ones are read. */
    fun selectBuild(buildId: String) {
        whatsNewJob?.cancel()
        val catalog = _state.value.catalog
        val build = catalog?.builds?.firstOrNull { it.buildId == buildId }
        _whatsNew.value = WhatsNew(buildId)
        whatsNewJob = viewModelScope.launch { loadBuild(buildId, build, catalog) }
    }

    /** The refresh icon: the catalog's history read again, then the chosen build. */
    fun refreshWhatsNew() {
        val current = _whatsNew.value ?: return
        whatsNewJob?.cancel()
        _whatsNew.update { it?.copy(loading = true, error = null) }
        whatsNewJob = viewModelScope.launch {
            readCatalog()
            readHome()
            val catalog = _state.value.catalog
            loadBuild(current.buildId, catalog?.builds?.firstOrNull { it.buildId == current.buildId }, catalog)
        }
    }

    private suspend fun loadBuild(buildId: String, build: CatalogBuild?, catalog: AdminCatalog?) {
        try {
            val newest = catalog?.builds?.firstOrNull { !it.baseline }
            val changes = catalog?.changes?.takeIf { newest?.buildId == buildId } ?: api.catalogBuild(buildId).changes
            _whatsNew.update { if (it?.buildId == buildId) it.copy(changes = changes, loading = false, error = null) else it }
            // The new shows' posters and lines: a search for what was first seen since that build, kept to its shows.
            val added = changes.items.added.mapTo(HashSet()) { it.id }
            val since = build?.loadedAt
            if (added.isEmpty() || since == null) return
            val hits = api.catalogSearch(since = since, sort = CatalogSearch.SORT_NEWEST, limit = POSTER_LIMIT).items.filter { it.id in added }
            _whatsNew.update { w ->
                if (w?.buildId != buildId) w
                else w.copy(hits = hits.associateBy(CatalogHit::id))
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _whatsNew.update { if (it?.buildId == buildId && it.changes == null) it.copy(loading = false, error = HomeViewModel.errorOf(e)) else it?.copy(loading = false) }
        }
    }

    /** Adds a new show to the end of the untitled section of this TV's Home. */
    fun add(itemId: String, title: String) {
        if (_whatsNew.value?.adding != null) return
        _whatsNew.update { it?.copy(adding = itemId) }
        viewModelScope.launch {
            try {
                val change = api.addHomeItem(tvId, itemId, UNTITLED_SECTION)
                setHome(change.home.map(AdminHomeEntry::itemId).toSet())
                _notices.trySend(CatalogNotice.Added(title))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _notices.trySend(CatalogNotice.Failed(HomeViewModel.errorOf(e)))
                readHome()
            } finally {
                _whatsNew.update { it?.copy(adding = null) }
            }
        }
    }

    companion object {
        const val PAGE = 50
        const val INVALID_CATALOG = "invalid_catalog"

        /** New shows whose posters What's new looks up (the search's largest page). */
        const val POSTER_LIMIT = 200
    }
}
