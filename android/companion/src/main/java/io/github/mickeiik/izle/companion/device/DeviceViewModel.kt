package io.github.mickeiik.izle.companion.device

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.github.mickeiik.izle.companion.activity.ACTIVITY_TYPES
import io.github.mickeiik.izle.companion.home.HomeError
import io.github.mickeiik.izle.companion.home.HomeViewModel
import io.github.mickeiik.izle.companion.tv.CommandOutcome
import io.github.mickeiik.izle.companion.tv.sendAndAwait
import io.github.mickeiik.izle.data.api.AdminDevice
import io.github.mickeiik.izle.data.api.AdminEvent
import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.data.api.ApiException
import io.github.mickeiik.izle.data.api.DeviceChange
import io.github.mickeiik.izle.data.api.DeviceEffective
import io.github.mickeiik.izle.data.api.DeviceProblems
import io.github.mickeiik.izle.data.api.DeviceSettings
import io.github.mickeiik.izle.data.api.PlayableReport
import io.github.mickeiik.izle.data.api.Problem
import io.github.mickeiik.izle.data.api.SetTo
import kotlinx.coroutines.CancellationException
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

/** The TV tab: the TV as the server keeps it and its problems, newest first (all the server keeps, at most 100). */
data class DeviceState(
    val loaded: Boolean = false,
    val loading: Boolean = true,
    /** The first load failed (a later reload that fails keeps what is shown). */
    val loadError: HomeError? = null,
    val device: AdminDevice? = null,
    val problems: List<Problem> = emptyList(),
    /** Update now was sent and its result is awaited. */
    val updating: Boolean = false,
    /** The TV was forgotten: the host goes to the TV list. */
    val forgotten: Boolean = false,
    /** The newest event Activity shows, for its row (null: none among the log's recent events). */
    val latest: AdminEvent? = null,
) {
    /** Problems of the last 24 hours, as the TV list's device says. */
    val recent: Int get() = device?.problems?.recent ?: 0
}

/** A problem's check (`POST …/diagnostics/resolve` of its episode, or of its channel): running, or what it found. */
data class ProblemCheck(val problemId: Long, val checking: Boolean = true, val report: PlayableReport? = null)

/** What the tab says in a snackbar (the host shows it). */
sealed interface DeviceNotice {
    data class Failed(val error: HomeError) : DeviceNotice

    /** A setting was not saved: the row shows [before]'s value again. */
    data class NotSaved(val error: HomeError, val setting: Setting, val before: AdminDevice) : DeviceNotice

    /** What Update now came to. */
    data class Updated(val outcome: CommandOutcome) : DeviceNotice

    data object ProblemsCleared : DeviceNotice
}

/**
 * One TV for the companion's TV tab (docs/ux/companion-tv.md): `GET admin/devices/:id` and its problems, read again on
 * each `problem.recorded`, `device.updated` or `device.app_version` event for this TV while [follow] runs. A setting
 * is a `PATCH` at once (the row shows the new value, and the old one again when it fails); Clear, Update now, a
 * problem's check and Forget.
 */
class DeviceViewModel(private val api: ApiClient, val tvId: String) : ViewModel() {
    private val _state = MutableStateFlow(DeviceState())
    val state: StateFlow<DeviceState> = _state.asStateFlow()

    private val _check = MutableStateFlow<ProblemCheck?>(null)

    /** The check of the problem whose sheet is open. */
    val check: StateFlow<ProblemCheck?> = _check.asStateFlow()

    private val _notices = Channel<DeviceNotice>(Channel.BUFFERED)
    val notices: Flow<DeviceNotice> = _notices.receiveAsFlow()

    /** Changes run one after another, and a reload never draws the TV from before one. */
    private val changes = Mutex()

    /** Loads the TV, then reloads on each event about it (or a gap) until cancelled: run it while the tab is shown. */
    suspend fun follow() {
        var after: Long? = null
        while (true) {
            try {
                if (after == null) {
                    // Where the log is now, then the TV as it is: nothing that happens in between is missed.
                    val last = api.adminEvents(null, types = FOLLOWED, devices = listOf(tvId)).last
                    after = last
                    changes.withLock { reload() }
                    val recent = api.adminEvents((last - LATEST_WINDOW).coerceAtLeast(0), types = ACTIVITY_TYPES, devices = listOf(tvId), limit = LATEST_WINDOW.toInt())
                    recent.events.lastOrNull()?.let { latest -> _state.update { it.copy(latest = latest) } }
                }
                val page = api.adminEvents(after, waitSec = 25, types = FOLLOWED, devices = listOf(tvId))
                page.events.lastOrNull { it.type in ACTIVITY_TYPES }?.let { latest -> _state.update { it.copy(latest = latest) } }
                if (page.gap || page.events.any { it.type in EVENT_TYPES }) changes.withLock { reload() }
                after = page.last
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // The log could not be read: load anyway, so the tab shows the TV (or why not).
                if (!_state.value.loaded) changes.withLock { reload() }
                delay(RETRY_MS)
            }
        }
    }

    /** Reads the TV and its problems anew; a failure keeps what is shown (only a first load shows the error). */
    suspend fun reload() {
        _state.update { it.copy(loading = true) }
        try {
            val device = api.device(tvId).device
            val problems = api.problems(tvId, PROBLEMS_MAX)
            _state.update { it.copy(loaded = true, loading = false, loadError = null, device = device, problems = problems) }
        } catch (e: CancellationException) {
            _state.update { it.copy(loading = false) }
            throw e
        } catch (e: Exception) {
            val error = errorOf(e)
            _state.update { it.copy(loading = false, loadError = if (it.loaded) null else error) }
        }
    }

    fun retry() {
        viewModelScope.launch { changes.withLock { reload() } }
    }

    // --- settings ---------------------------------------------------------------------------------------------------

    /** Renames the TV (1–60 characters once trimmed). */
    fun rename(name: String) {
        val n = name.trim()
        if (n.isEmpty() || n.length > NAME_MAX) return
        save(Setting.Name, DeviceChange(name = n)) { it.copy(name = n) }
    }

    /** The TV's menu language (`tr` or `en`). */
    fun setMenuLanguage(tag: String) =
        save(Setting.MenuLanguage, DeviceChange(uiLanguage = SetTo(tag))) { it.withSettings { s -> s.copy(uiLanguage = tag) } }

    /** The audio language; null: the server's default. */
    fun setAudio(tag: String?) =
        save(Setting.Audio, DeviceChange(preferredAudioLanguage = SetTo(tag))) { it.withSettings { s -> s.copy(preferredAudioLanguage = tag) } }

    /** The subtitles' language; null: off. */
    fun setSubtitles(tag: String?) = save(Setting.Subtitles, DeviceChange(subtitlesLanguage = SetTo(tag))) {
        it.withSettings { s -> s.copy(subtitlesLanguage = tag) }.withEffective { e -> e.copy(subtitlesLanguage = tag) }
    }

    fun setPlayOnStart(on: Boolean) = save(Setting.PlayOnStart, DeviceChange(autoplayOnStart = on)) {
        it.withSettings { s -> s.copy(autoplayOnStart = on) }.withEffective { e -> e.copy(autoplayOnStart = on) }
    }

    /** One setting: [shown] draws it at once; the answer redraws the TV, a failure the TV from before. */
    private fun save(setting: Setting, change: DeviceChange, shown: (AdminDevice) -> AdminDevice) {
        val before = _state.value.device ?: return
        viewModelScope.launch {
            changes.withLock {
                _state.update { s -> s.copy(device = s.device?.let(shown)) }
                try {
                    val saved = api.updateDevice(tvId, change)
                    // The answer has no problem counts of its own to trust over the list's.
                    _state.update { s -> s.copy(device = saved.copy(problems = saved.problems ?: s.device?.problems)) }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    _state.update { it.copy(device = before) }
                    _notices.trySend(DeviceNotice.NotSaved(errorOf(e), setting, before))
                }
            }
        }
    }

    // --- problems -----------------------------------------------------------------------------------------------------

    /** Forgets the TV's problems. */
    fun clearProblems() {
        viewModelScope.launch {
            changes.withLock {
                try {
                    api.clearProblems(tvId)
                    _state.update { s -> s.copy(problems = emptyList(), device = s.device?.copy(problems = DeviceProblems())) }
                    _notices.trySend(DeviceNotice.ProblemsCleared)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    _notices.trySend(DeviceNotice.Failed(errorOf(e)))
                }
            }
        }
    }

    /** Checks the problem's episode (or its channel) now; the verdict shows in its sheet when the server answers. */
    fun checkProblem(p: Problem) {
        val itemId = p.itemId ?: return
        if (p.missing || _check.value?.let { it.problemId == p.id && it.checking } == true) return
        _check.value = ProblemCheck(p.id)
        viewModelScope.launch {
            try {
                val report = if (p.episodeId != null && p.itemKind != KIND_LIVE) api.checkNow(episodeId = p.episodeId) else api.checkNow(itemId = itemId)
                _check.update { if (it?.problemId == p.id) ProblemCheck(p.id, checking = false, report = report) else it }
            } catch (e: CancellationException) {
                _check.update { if (it?.problemId == p.id) null else it }
                throw e
            } catch (e: Exception) {
                _check.update { if (it?.problemId == p.id) null else it }
                _notices.trySend(DeviceNotice.Failed(errorOf(e)))
            }
        }
    }

    /** A problem's sheet closed: its check result is not kept. */
    fun closeProblem() {
        if (_check.value?.checking != true) _check.value = null
    }

    // --- the app and the TV ---------------------------------------------------------------------------------------------

    /** Update now: the `update` command; says once what came of it. */
    fun update() {
        if (_state.value.updating) return
        _state.update { it.copy(updating = true) }
        viewModelScope.launch {
            try {
                _notices.trySend(DeviceNotice.Updated(api.sendAndAwait(tvId, "update")))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _notices.trySend(DeviceNotice.Failed(errorOf(e)))
            } finally {
                _state.update { it.copy(updating = false) }
            }
        }
    }

    /** Forgets the TV: it has to pair again to play. */
    fun forget() {
        viewModelScope.launch {
            changes.withLock {
                try {
                    api.forgetDevice(tvId)
                    _state.update { it.copy(forgotten = true) }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    // Already gone: the TV list says so.
                    if (e is ApiException && e.code == "unknown_device") _state.update { it.copy(forgotten = true) }
                    else _notices.trySend(DeviceNotice.Failed(errorOf(e)))
                }
            }
        }
    }

    private fun errorOf(e: Exception): HomeError = HomeViewModel.errorOf(e)

    companion object {
        /** The events that change what the tab shows. */
        val EVENT_TYPES = listOf("problem.recorded", "device.updated", "device.app_version")

        /** What the tab follows: its own reasons to reload, and what Activity shows (for the row's newest event). */
        private val FOLLOWED = (EVENT_TYPES + ACTIVITY_TYPES).distinct()

        /** How far back in the log (event ids) the row looks for its newest event. */
        const val LATEST_WINDOW = 500L

        /** A TV keeps its newest 100 problems: the tab reads them all, so it knows how many there are. */
        const val PROBLEMS_MAX = 100

        /** The newest problems on the tab itself. */
        const val PROBLEMS_SHOWN = 5

        const val NAME_MAX = 60
        const val RETRY_MS = 5_000L
        private const val KIND_LIVE = "live"
    }
}

private fun AdminDevice.withSettings(change: (DeviceSettings) -> DeviceSettings): AdminDevice =
    copy(settings = change(settings ?: DeviceSettings()))

private fun AdminDevice.withEffective(change: (DeviceEffective) -> DeviceEffective): AdminDevice =
    copy(effective = change(effective ?: DeviceEffective()))
