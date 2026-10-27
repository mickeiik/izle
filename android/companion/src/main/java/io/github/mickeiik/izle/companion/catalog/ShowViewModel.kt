package io.github.mickeiik.izle.companion.catalog

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.github.mickeiik.izle.companion.home.CheckRuns
import io.github.mickeiik.izle.companion.home.HomeError
import io.github.mickeiik.izle.companion.home.HomeNotice
import io.github.mickeiik.izle.companion.home.HomeViewModel
import io.github.mickeiik.izle.companion.home.UNTITLED_SECTION
import io.github.mickeiik.izle.companion.tv.episodeName
import io.github.mickeiik.izle.companion.tv.sendAndAwait
import io.github.mickeiik.izle.data.api.AdminEpisode
import io.github.mickeiik.izle.data.api.AdminItem
import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.data.api.CheckSummary
import io.github.mickeiik.izle.data.api.HomeChange
import io.github.mickeiik.izle.data.api.HomeSection
import io.github.mickeiik.izle.data.api.SourceReport
import io.github.mickeiik.izle.data.api.orNullOnFailure
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive

/** A show's page as seen from one TV: the item, whether that TV has it on Home, and what OK plays there. */
data class ShowState(
    val loading: Boolean = true,
    /** The first load failed (a later one that fails keeps what is shown). */
    val loadError: HomeError? = null,
    val item: AdminItem? = null,
    val onHome: Boolean = false,
    /** The TV's Home sections, for Add to Home's choice. */
    val sections: List<HomeSection> = emptyList(),
    /** The episode OK plays for this show on this TV (null for a channel, or when none may play). */
    val okPlays: String? = null,
    /** The episodes the newest catalog build added. */
    val newEpisodes: Set<String> = emptySet(),
    /** A Home change is being saved. */
    val saving: Boolean = false,
    /** A film's single episode or a channel: its sources on the page itself. */
    val direct: PlayableSources? = null,
) {
    val loaded: Boolean get() = item != null

    /** A series lists its episodes; a film of one episode and a channel show their sources directly. */
    val listsEpisodes: Boolean get() = item != null && item.kind != KIND_LIVE && (item.kind == KIND_SERIES || item.episodes.size != 1)

    /** OK can play something of it: an allowed episode, or a channel the catalog lets play. */
    val playable: Boolean
        get() = item != null && if (item.kind == KIND_LIVE) item.playbackAllowed == true else item.episodes.any { it.playbackAllowed }

    companion object {
        const val KIND_LIVE = "live"
        const val KIND_SERIES = "series"
    }
}

/**
 * The sources of an episode (or of a channel: [episodeId] null) and their last check, by source id; [checking] while
 * `POST …/diagnostics/resolve` runs.
 */
data class PlayableSources(
    val episodeId: String?,
    val loading: Boolean = true,
    val checking: Boolean = false,
    val reports: Map<String, SourceReport> = emptyMap(),
    val check: CheckSummary? = null,
    val error: HomeError? = null,
)

/**
 * A show's page for one TV ([tvId]): the catalog item, its place on that TV's Home (add, remove), Play and an episode's
 * Play, Continue from here and checks (the whole show as a run in Home's strip, one episode or a channel at once).
 * Messages are Home's [HomeNotice]s, said the Home tab's way.
 */
class ShowViewModel(private val api: ApiClient, val tvId: String, val itemId: String) : ViewModel() {
    private val _state = MutableStateFlow(ShowState())
    val state: StateFlow<ShowState> = _state.asStateFlow()

    /** The episode whose sheet is open, with its sources. */
    private val _sheet = MutableStateFlow<PlayableSources?>(null)
    val sheet: StateFlow<PlayableSources?> = _sheet.asStateFlow()

    private val _notices = Channel<HomeNotice>(Channel.BUFFERED)
    val notices: Flow<HomeNotice> = _notices.receiveAsFlow()

    /** Check all: the run shown in the strip (this show's, or one found running for it). */
    val checks = CheckRuns(api, viewModelScope) { _notices.trySend(it) }

    init {
        viewModelScope.launch {
            load()
            checks.resume { it.target.itemId == itemId }
        }
        // A run of this show that ends brings new chips.
        viewModelScope.launch {
            var running = false
            checks.run.collect { run ->
                val now = run?.running == true && run.target.itemId == itemId
                if (running && !now) load()
                running = now
            }
        }
    }

    /** Reads the item, the TV's Home and (for a show not on it) where OK continues; a film's or channel's sources too. */
    suspend fun load() {
        _state.update { it.copy(loading = true) }
        try {
            coroutineScope {
                val item = async { api.catalogItem(itemId) }
                val device = async { api.device(tvId) }
                val catalog = async { orNullOnFailure { api.catalog() } }
                val i = item.await()
                val d = device.await()
                val entry = d.home.firstOrNull { it.itemId == itemId }
                val okPlays = when {
                    i.kind == ShowState.KIND_LIVE -> null
                    entry != null -> entry.continueAt?.episodeId
                    else -> orNullOnFailure { api.deviceProgress(tvId) }?.okPlays(i)
                }
                val added = catalog.await()?.changes?.episodes?.added.orEmpty()
                _state.update {
                    it.copy(
                        loading = false,
                        loadError = null,
                        item = i,
                        onHome = entry != null,
                        sections = d.sections,
                        okPlays = okPlays,
                        newEpisodes = added.filter { e -> e.itemId == itemId }.mapTo(HashSet()) { e -> e.id },
                    )
                }
            }
        } catch (e: CancellationException) {
            _state.update { it.copy(loading = false) }
            throw e
        } catch (e: Exception) {
            val error = HomeViewModel.errorOf(e)
            _state.update { it.copy(loading = false, loadError = if (it.loaded) null else error) }
            return
        }
        val s = _state.value
        val item = s.item ?: return
        if (!s.listsEpisodes) {
            val episodeId = if (item.kind == ShowState.KIND_LIVE) null else item.episodes.firstOrNull()?.id
            if (s.direct?.checking != true) {
                val read = readSources(episodeId)
                // A check started meanwhile owns `direct` until it answers.
                _state.update { if (it.direct?.checking == true) it else it.copy(direct = read) }
            }
        }
    }

    fun retry() {
        viewModelScope.launch { load() }
    }

    private var shownBefore = false

    /** The page is shown; the view model outlives it, so a show opened again is read anew (init reads it the first time). */
    fun shown() {
        if (shownBefore) retry() else shownBefore = true
    }

    // --- Home -------------------------------------------------------------------------------------------------------

    /** Adds the show to the end of [sectionId] (the untitled section unless the owner chose one). */
    fun addToHome(sectionId: String = UNTITLED_SECTION) = homeChange(
        call = { api.addHomeItem(tvId, itemId, sectionId) },
        done = { c ->
            val section = c.sections.firstOrNull { it.id == sectionId }
            HomeNotice.Added(titleOf(), section?.title.takeIf { sectionId != UNTITLED_SECTION })
        },
    )

    fun removeFromHome() = homeChange(call = { api.removeHomeItem(tvId, itemId) }, done = { null })

    private fun homeChange(call: suspend () -> HomeChange, done: (HomeChange) -> HomeNotice?) {
        if (_state.value.saving) return
        _state.update { it.copy(saving = true) }
        viewModelScope.launch {
            try {
                val c = call()
                _state.update { it.copy(onHome = c.home.any { e -> e.itemId == itemId }, sections = c.sections) }
                done(c)?.let { _notices.trySend(it) }
                // What OK plays may come from Home now (or from the cursor no more).
                load()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val error = HomeViewModel.errorOf(e)
                val elsewhere = error is HomeError.Server && error.code in HOME_CHANGED
                _notices.trySend(if (elsewhere) HomeNotice.ChangedElsewhere else HomeNotice.Failed(error))
                if (elsewhere) load()
            } finally {
                _state.update { it.copy(saving = false) }
            }
        }
    }

    // --- playing and the cursor -------------------------------------------------------------------------------------

    /** Play on the TV: what OK plays for this show there, or the channel. */
    fun play() = command(mapOf("itemId" to JsonPrimitive(itemId)))

    /** Play this episode on the TV (from its saved position). */
    fun play(episode: AdminEpisode) = command(mapOf("episodeId" to JsonPrimitive(episode.id)))

    private fun command(fields: Map<String, JsonPrimitive>) {
        viewModelScope.launch {
            try {
                _notices.trySend(HomeNotice.Played(titleOf(), api.sendAndAwait(tvId, "play", fields)))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _notices.trySend(HomeNotice.Failed(HomeViewModel.errorOf(e)))
            }
        }
    }

    /** OK on the TV continues this show from [episode] (from its beginning). */
    fun continueFrom(episode: AdminEpisode) {
        viewModelScope.launch {
            try {
                api.setCursor(tvId, itemId, episode.id)
                _state.update { it.copy(okPlays = episode.id) }
                _notices.trySend(HomeNotice.Continues(titleOf(), episodeName(episode)))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _notices.trySend(HomeNotice.Failed(HomeViewModel.errorOf(e)))
            }
        }
    }

    // --- checks -----------------------------------------------------------------------------------------------------

    /** Check all: every episode that may play, followed in the strip. */
    fun checkAll() = checks.startShow(itemId)

    /** Opens [episode]'s sheet and reads its sources' last check. */
    fun openEpisode(episode: AdminEpisode) {
        _sheet.value = PlayableSources(episode.id)
        viewModelScope.launch {
            val read = readSources(episode.id)
            _sheet.update { if (it?.episodeId == episode.id && !it.checking) read else it }
        }
    }

    fun closeEpisode() {
        _sheet.value = null
    }

    /** Checks every source of the open episode now; its rows update when the server answers. */
    fun checkEpisode() {
        val episodeId = _sheet.value?.episodeId ?: return
        checkNow(episodeId, get = { _sheet.value?.takeIf { it.episodeId == episodeId } }) { f -> _sheet.update { s -> if (s != null && s.episodeId == episodeId) f(s) else s } }
    }

    /** Checks the film's episode or the channel shown on the page now. */
    fun checkDirect() {
        val direct = _state.value.direct ?: return
        checkNow(direct.episodeId, get = { _state.value.direct }) { f -> _state.update { s -> s.copy(direct = s.direct?.let(f)) } }
    }

    private fun checkNow(episodeId: String?, get: () -> PlayableSources?, set: ((PlayableSources) -> PlayableSources) -> Unit) {
        if (get()?.checking != false) return
        set { it.copy(checking = true, error = null) }
        viewModelScope.launch {
            try {
                val report = if (episodeId != null) api.checkNow(episodeId = episodeId) else api.checkNow(itemId = itemId)
                // The stored summary (checked when, how many work) as the server keeps it now.
                val check = orNullOnFailure { api.checkPlayable(episodeId ?: itemId, itemId).check }
                set { it.copy(checking = false, loading = false, reports = report.sources.associateBy(SourceReport::sourceId), check = check ?: it.check) }
                load()
            } catch (e: CancellationException) {
                set { it.copy(checking = false) }
                throw e
            } catch (e: Exception) {
                val error = HomeViewModel.errorOf(e)
                set { it.copy(checking = false, error = error) }
                _notices.trySend(HomeNotice.Failed(error))
            }
        }
    }

    private suspend fun readSources(episodeId: String?): PlayableSources = try {
        val c = api.checkPlayable(episodeId ?: itemId, itemId)
        PlayableSources(episodeId, loading = false, reports = c.sources.associateBy(SourceReport::sourceId), check = c.check)
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        PlayableSources(episodeId, loading = false, error = HomeViewModel.errorOf(e))
    }

    private fun titleOf(): String = _state.value.item?.title ?: itemId

    companion object {
        /** Answers that mean the TV's Home is not what this page thought: read it anew. */
        val HOME_CHANGED = setOf("home_changed", "not_on_home", "duplicate_item", "unknown_section")
    }
}
