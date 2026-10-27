package io.github.mickeiik.izle.companion.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import io.github.mickeiik.izle.companion.BuildConfig
import io.github.mickeiik.izle.companion.CompanionApp
import io.github.mickeiik.izle.companion.CompanionGraph
import io.github.mickeiik.izle.companion.R
import io.github.mickeiik.izle.companion.connect.ConnectLink
import io.github.mickeiik.izle.companion.finder.FoundLink
import io.github.mickeiik.izle.companion.finder.LinkConfirmer
import io.github.mickeiik.izle.companion.finder.LinkFinder
import io.github.mickeiik.izle.companion.sync.ListenPhase
import io.github.mickeiik.izle.companion.sync.ListenService
import io.github.mickeiik.izle.companion.sync.ListenSession
import io.github.mickeiik.izle.companion.sync.ListenState
import io.github.mickeiik.izle.companion.sync.ListenTarget
import io.github.mickeiik.izle.companion.sync.EndReason
import io.github.mickeiik.izle.companion.sync.PASTED_SOURCE_ID
import io.github.mickeiik.izle.data.api.AdminDevice
import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.data.api.ApiException
import io.github.mickeiik.izle.data.api.CompanionResponse
import io.github.mickeiik.izle.data.api.LinkTiming
import io.github.mickeiik.izle.data.api.LinkUpdate
import io.github.mickeiik.izle.data.api.NowPlaying
import io.github.mickeiik.izle.data.api.Phone
import io.github.mickeiik.izle.data.api.PhoneClaimRequest
import io.github.mickeiik.izle.data.api.ServerUrls
import io.github.mickeiik.izle.data.api.orNullOnFailure
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.io.IOException

/** Why connecting (or listing the TVs or the phones) failed; the screens say it in words. */
sealed interface ConnectError {
    data object InvalidAddress : ConnectError
    data object Unreachable : ConnectError
    /** `404` on a claim: an unknown, used or expired code or invite (the server does not say which). */
    data object CodeNotAccepted : ConnectError
    /** `429` on a claim: too many failed claims from this address. */
    data object TooManyTries : ConnectError
    /** `401` on a typed token (debug builds only). */
    data object TokenNotAccepted : ConnectError
    /** The stored credential was refused: this phone was disconnected (on the admin page or from another phone). */
    data object Disconnected : ConnectError
    /** Any other API error, by its code. */
    data class Server(val code: String) : ConnectError
}

/** What the app shows; [CompanionRoot] switches on it. */
sealed interface CompanionUi {
    /** Reading the stored settings. */
    data object Starting : CompanionUi

    /**
     * Connecting this phone to a TV's server: the server address and the 6-digit code the TV shows (or, from the QR
     * code's link, the invite, with [busy] at once). [initialUrl]: what the address field starts with (the link's or the
     * last server, or the debug build's default).
     */
    data class Connect(val initialUrl: String, val busy: Boolean = false, val error: ConnectError? = null) : CompanionUi

    /** The phones connected to the server ([thisPhoneId]: this one, null with a typed token), oldest first. */
    data class Phones(
        val phones: List<Phone> = emptyList(),
        val thisPhoneId: String? = null,
        val loading: Boolean = true,
        val error: ConnectError? = null,
    ) : CompanionUi

    /** The paired server's TVs (active ones only: a pending TV plays nothing). */
    data class PickTv(
        val server: String,
        val devices: List<AdminDevice> = emptyList(),
        val loading: Boolean = true,
        val error: ConnectError? = null,
    ) : CompanionUi

    /**
     * Listen along for one TV. [loaded]: the first answer arrived; [nowPlaying] null: the TV plays nothing. [chosen] is
     * one of [options]; the two texts are the timing fields ([timingValid]: both parse). [error]: the last refresh
     * failed (the text says why). [foundLink]: the link found on this phone for the `pasted` option (in memory only,
     * dropped when the TV moves to another episode or the link expires); [finderOpen]: the link finder is shown.
     */
    data class Listen(
        val tvId: String,
        val tvName: String? = null,
        val loaded: Boolean = false,
        val nowPlaying: NowPlaying? = null,
        val options: List<CandidateOption> = emptyList(),
        val chosen: CandidateOption? = null,
        val offsetText: String = "",
        val speedText: String = "",
        val timingValid: Boolean = false,
        val applyAllVisible: Boolean = false,
        val session: ListenState = ListenState(),
        val nudgeMs: Long = 0,
        val refreshing: Boolean = false,
        val error: String? = null,
        val foundLink: FoundLink? = null,
        val finderOpen: Boolean = false,
    ) : CompanionUi {
        val isChannel: Boolean get() = nowPlaying?.isLive == true
        val listening: Boolean get() = session.phase != ListenPhase.Idle

        /** Listen needs an episode playing and a source chosen; the `pasted` option, a found link too. */
        val canListen: Boolean
            get() = nowPlaying?.episodeId != null && !isChannel && chosen != null &&
                (chosen.sourceId != PASTED_SOURCE_ID || foundLink != null)
    }
}

/**
 * The companion's state and actions: connecting this phone (claiming the invite a TV shows, by its code or its QR
 * code's link), choosing the TV, the server's phones, and Listen along with
 * the graph's single [ListenSession] (the foreground [ListenService] keeps it playing when the screen is off).
 * Snackbar texts go to [snackbar], so one raised while the screen changes (a revoked token) is still shown. The
 * session belongs to the graph, not to this view model: it keeps playing after the activity is gone.
 */
class CompanionViewModel(app: Application) : AndroidViewModel(app) {
    private val graph: CompanionGraph = (app as CompanionApp).graph
    private val store = graph.store

    private val _ui = MutableStateFlow<CompanionUi>(CompanionUi.Starting)
    val ui: StateFlow<CompanionUi> = _ui.asStateFlow()

    private val _snackbar = MutableStateFlow<String?>(null)
    val snackbar: StateFlow<String?> = _snackbar.asStateFlow()

    /** The link finder's state: what its in-app browser found, confirmed by a fetch from this phone (memory only). */
    val linkFinder = LinkFinder(LinkConfirmer(graph.http)::confirm, viewModelScope)

    private var baseUrl: HttpUrl? = null
    private var api: ApiClient? = null
    private var session: ListenSession? = null
    private var sessionJob: Job? = null
    private var refreshJob: Job? = null

    /** The last `/companion` answer and its identity (as companion.js's `candidatesKey`: unchanged answers are skipped). */
    private var candidates: CompanionResponse? = null
    private var candidatesKey: String? = null

    /** Numbers the `/companion` reads: only the newest one's answer is shown. */
    private var companionReadSeq = 0

    /** The option chosen per item, for this view model's life. */
    private val remembered = mutableMapOf<String, String>()

    /** This phone's id on the paired server; null with a typed token. */
    private var phoneId: String? = null

    /** The screen the Phones screen opened over, to go back to. */
    private var behindPhones: CompanionUi? = null

    /** Reading the stored pairing: a connect link waits for it. */
    private val started: Job = viewModelScope.launch {
        if (!openStored()) _ui.value = CompanionUi.Connect(initialUrl = BuildConfig.DEFAULT_SERVER_URL)
    }

    /** Opens the stored pairing (its TV, or the TV list); false without one. */
    private suspend fun openStored(): Boolean {
        val s = store.current()
        val url = s.serverUrl?.toHttpUrlOrNull()
        if (url == null || s.token == null) return false
        phoneId = s.phoneId
        usePairing(url, s.token)
        if (s.tvId != null) enterListen(s.tvId, name = null) else showPicker()
        return true
    }

    // --- connecting and the TV -------------------------------------------------------------------------------------

    /** Connect with the server address and the 6-digit code the TV shows (spaces ignored). */
    fun connect(url: String, code: String) {
        val current = _ui.value as? CompanionUi.Connect ?: return
        if (current.busy) return
        val digits = normalizeCode(code) ?: return // Connect is disabled until there are 6 digits
        val parsed = ServerUrls.parse(url)
        if (parsed == null) {
            _ui.value = current.copy(error = ConnectError.InvalidAddress)
            return
        }
        _ui.value = current.copy(busy = true, error = null)
        viewModelScope.launch {
            val error = claim(parsed, PhoneClaimRequest(code = digits, name = graph.phoneName())) ?: return@launch
            _ui.value = current.copy(busy = false, error = error)
        }
    }

    /**
     * The QR code's link: claims its invite at once, with the connect screen busy. On failure the connect screen says why,
     * or, when this phone is still connected (a link opened again), the screen it showed comes back with a snackbar.
     * While connected, a link to another server is refused with a snackbar (any web page can open such a link: it must
     * not move this phone to a server of its choosing); disconnecting this phone first allows it.
     */
    fun connectWithLink(link: ConnectLink) {
        viewModelScope.launch {
            started.join()
            val before = _ui.value
            if (before is CompanionUi.Connect && before.busy) return@launch
            val parsed = ServerUrls.parse(link.server)
            val connectedTo = baseUrl?.let(ServerUrls::display)
            if (parsed != null && connectedTo != null && ServerUrls.display(parsed) != connectedTo) {
                _snackbar.value = getApplication<Application>().getString(R.string.error_other_server, connectedTo)
                return@launch
            }
            val shown = CompanionUi.Connect(initialUrl = parsed?.let(ServerUrls::display) ?: link.server, busy = parsed != null)
            val error = if (parsed == null) {
                ConnectError.InvalidAddress
            } else {
                leaveListen()
                _ui.value = shown
                claim(parsed, PhoneClaimRequest(invite = link.invite, name = graph.phoneName())) ?: return@launch
            }
            if (api != null) {
                _snackbar.value = connectErrorText(getApplication<Application>().resources, error)
                restore(before)
            } else {
                _ui.value = shown.copy(busy = false, error = error)
            }
        }
    }

    /**
     * Claims an invite; on success stores the secret, this phone's id and the inviting TV, and opens that TV. A phone
     * connected again deletes its previous self on the server (best effort), or its owner-level secret would stay listed.
     */
    private suspend fun claim(url: HttpUrl, request: PhoneClaimRequest): ConnectError? {
        val claim = try {
            graph.apiClient(url, null).claimPhone(request)
        } catch (e: Exception) {
            return claimError(e) ?: throw e
        }
        val previous = api
        val previousId = phoneId
        if (previous != null && previousId != null && previousId != claim.phone.id) {
            viewModelScope.launch { withTimeoutOrNull(SELF_DELETE_MS) { orNullOnFailure { previous.deletePhone(previousId) } } }
        }
        leaveListen()
        linkFinder.clear()
        behindPhones = null
        store.savePairing(url.toString(), claim.secret, claim.phone.id, claim.deviceId)
        phoneId = claim.phone.id
        usePairing(url, claim.secret)
        val tv = claim.deviceId
        if (tv != null) enterListen(tv, name = null) else showPicker()
        return null
    }

    /** Debug builds only: an access token (the admin token) instead of a code, for development. */
    fun connectWithToken(url: String, token: String) {
        if (!BuildConfig.DEBUG) return
        val current = _ui.value as? CompanionUi.Connect ?: return
        if (current.busy) return
        val parsed = ServerUrls.parse(url)
        if (parsed == null) {
            _ui.value = current.copy(error = ConnectError.InvalidAddress)
            return
        }
        val secret = token.trim()
        _ui.value = current.copy(busy = true, error = null)
        viewModelScope.launch {
            val client = graph.apiClient(parsed, secret)
            val devices = try {
                activeDevices(client)
            } catch (e: Exception) {
                _ui.value = current.copy(busy = false, error = connectError(e) ?: throw e)
                return@launch
            }
            store.savePairing(parsed.toString(), secret)
            phoneId = null
            usePairing(parsed, secret)
            val only = devices.singleOrNull()
            if (only != null) {
                store.setTv(only.id)
                enterListen(only.id, only.name)
            } else {
                _ui.value = CompanionUi.PickTv(ServerUrls.display(parsed), devices, loading = false)
            }
        }
    }

    fun pickTv(id: String) {
        val picker = _ui.value as? CompanionUi.PickTv ?: return
        val name = picker.devices.firstOrNull { it.id == id }?.name
        viewModelScope.launch {
            store.setTv(id)
            enterListen(id, name)
        }
    }

    /** Back to the TV list (listening stops: it follows the TV it started with). */
    fun changeTv() {
        session?.stop()
        leaveListen()
        // The Listen screen and its found link are gone (the picker replaces it); the finder forgets the link too.
        linkFinder.clear()
        viewModelScope.launch {
            store.setTv(null)
            showPicker()
        }
    }

    fun reloadTvs() {
        val picker = _ui.value as? CompanionUi.PickTv ?: return
        if (!picker.loading) viewModelScope.launch { showPicker() }
    }

    /**
     * "Disconnect this phone": deletes this phone on the server (best effort: an unreachable server does not keep it
     * connected here), then forgets the server, the secret and the TV, and stops listening.
     */
    fun forgetPairing() {
        viewModelScope.launch {
            val client = api
            val id = phoneId
            if (client != null && id != null) withTimeoutOrNull(SELF_DELETE_MS) { orNullOnFailure { client.deletePhone(id) } }
            forget()
        }
    }

    /** Back to the connect screen, saying [reason] there. */
    private suspend fun forget(reason: ConnectError? = null) {
        leaveListen()
        linkFinder.clear()
        sessionJob?.cancel()
        session = null
        graph.releaseSession()
        store.forgetPairing()
        val last = baseUrl?.let(ServerUrls::display) ?: BuildConfig.DEFAULT_SERVER_URL
        baseUrl = null
        api = null
        phoneId = null
        behindPhones = null
        _ui.value = CompanionUi.Connect(initialUrl = last, error = reason)
    }

    /** A screen shown again (after the Phones screen, or a connect link that failed): read anew. */
    private fun restore(screen: CompanionUi) {
        when (screen) {
            is CompanionUi.Listen -> {
                // The session's changes were not followed meanwhile.
                _ui.value = screen.copy(session = session?.state?.value ?: screen.session, refreshing = false)
                refresh()
            }
            is CompanionUi.PickTv -> {
                _ui.value = screen.copy(loading = false)
                reloadTvs()
            }
            is CompanionUi.Phones -> {
                _ui.value = screen.copy(loading = false)
                reloadPhones()
            }
            else -> _ui.value = screen
        }
    }

    // --- the server's phones ---------------------------------------------------------------------------------------

    /** From the TV list or Listen along; [closePhones] goes back there. */
    fun openPhones() {
        val current = _ui.value
        if (current !is CompanionUi.Listen && current !is CompanionUi.PickTv) return
        behindPhones = current
        leaveListen()
        _ui.value = CompanionUi.Phones(thisPhoneId = phoneId)
        viewModelScope.launch { loadPhones() }
    }

    fun closePhones() {
        val back = behindPhones ?: return
        behindPhones = null
        if (_ui.value is CompanionUi.Phones) restore(back)
    }

    fun reloadPhones() {
        val phones = _ui.value as? CompanionUi.Phones ?: return
        if (!phones.loading) viewModelScope.launch { loadPhones() }
    }

    /** Disconnects a phone; this one ([CompanionUi.Phones.thisPhoneId]) as "Disconnect this phone" does. */
    fun disconnectPhone(id: String) {
        if (_ui.value !is CompanionUi.Phones) return
        if (id == phoneId) return forgetPairing()
        val client = api ?: return
        viewModelScope.launch {
            updatePhones { it.copy(loading = true) }
            try {
                client.deletePhone(id)
            } catch (e: Exception) {
                if (e !is IOException && e !is ApiException) throw e
                if (isRevoked(e)) return@launch unauthorized()
                // Already gone: the list says so.
                if (!(e is ApiException && e.status == 404)) _snackbar.value = errorText(e)
            }
            loadPhones()
        }
    }

    private suspend fun loadPhones() {
        val client = api ?: return
        updatePhones { it.copy(loading = true, error = null) }
        try {
            val phones = client.phones().phones
            updatePhones { it.copy(phones = phones, loading = false) }
        } catch (e: Exception) {
            if (e !is IOException && e !is ApiException) throw e
            if (isRevoked(e)) return unauthorized()
            updatePhones { it.copy(loading = false, error = connectError(e)) }
        }
    }

    private inline fun updatePhones(change: (CompanionUi.Phones) -> CompanionUi.Phones) {
        _ui.update { if (it is CompanionUi.Phones) change(it) else it }
    }

    private fun usePairing(url: HttpUrl, token: String) {
        baseUrl = url
        api = graph.apiClient(url, token)
        val s = graph.session(url, token)
        if (s === session) return
        session = s
        sessionJob?.cancel()
        sessionJob = viewModelScope.launch {
            var previous = s.state.value.phase
            s.state.collect { state ->
                updateListen { it.copy(session = state) }
                val ended = previous != ListenPhase.Idle && state.phase == ListenPhase.Idle
                previous = state.phase
                if (!ended) return@collect
                // The timing fields stay as typed: only the link is gone.
                if (state.ended == EndReason.LinkExpired) {
                    updateListen { it.copy(foundLink = null) }
                    // Or reopening the finder would offer the expired link again.
                    linkFinder.clear()
                }
                // Not in this collector, which forget() cancels; the connect screen says it.
                if (state.ended == EndReason.Unauthorized) viewModelScope.launch { unauthorized() }
                else endedText(state.ended, state.error)?.let { _snackbar.value = it }
            }
        }
    }

    private suspend fun showPicker() {
        val client = api ?: return
        val server = baseUrl?.let(ServerUrls::display).orEmpty()
        val shown = _ui.value as? CompanionUi.PickTv
        _ui.value = CompanionUi.PickTv(server, shown?.devices.orEmpty(), loading = true)
        try {
            _ui.value = CompanionUi.PickTv(server, activeDevices(client), loading = false)
        } catch (e: Exception) {
            val error = connectError(e) ?: throw e
            if (isRevoked(e)) return unauthorized()
            _ui.value = CompanionUi.PickTv(server, shown?.devices.orEmpty(), loading = false, error = error)
        }
    }

    /** The paired server's active TVs: a pending TV plays nothing. */
    private suspend fun activeDevices(client: ApiClient): List<AdminDevice> =
        client.devices().devices.filter { it.status == "active" }

    private suspend fun enterListen(tvId: String, name: String?) {
        candidates = null
        candidatesKey = null
        val nudge = store.current().nudgeMs
        val sessionState = session?.state?.value ?: ListenState()
        // A new screen over a session still playing a found link: the link it plays.
        val playingLink = sessionState.target?.takeIf { sessionState.phase != ListenPhase.Idle && it.deviceId == tvId }?.foundLink
        _ui.value = CompanionUi.Listen(tvId = tvId, tvName = name, session = sessionState, nudgeMs = nudge, foundLink = playingLink)
        if (name == null) {
            viewModelScope.launch {
                val found = orNullOnFailure { api?.devices() }?.devices?.firstOrNull { it.id == tvId }
                if (found != null) updateListen { if (it.tvId == tvId) it.copy(tvName = found.name) else it }
            }
        }
        load(force = true)
    }

    private fun leaveListen() {
        refreshJob?.cancel()
        refreshJob = null
    }

    // --- Listen along ----------------------------------------------------------------------------------------------

    /** While the Listen screen is shown: what the TV plays, every 10 s (skipped while a read is in flight). */
    fun startRefreshing() {
        if (refreshJob?.isActive == true) return
        refreshJob = viewModelScope.launch {
            while (true) {
                delay(REFRESH_MS)
                load(force = false)
            }
        }
    }

    fun stopRefreshing() {
        leaveListen()
    }

    /** Reads again, unless a read is in flight. */
    fun refresh() {
        viewModelScope.launch { load(force = false) }
    }

    private suspend fun load(force: Boolean) {
        val client = api ?: return
        val listen = _ui.value as? CompanionUi.Listen ?: return
        // One read at a time, or a slower older answer would overwrite a newer one; a forced read (a new TV, a save) runs anyway.
        if (!force && listen.refreshing) return
        updateListen { it.copy(refreshing = true) }
        val my = ++companionReadSeq
        val r = try {
            client.companion(listen.tvId)
        } catch (e: Exception) {
            if (e !is IOException && e !is ApiException) throw e
            if (isRevoked(e)) return unauthorized()
            // A newer read is on its way (a forced one started meanwhile): it shows its answer and clears refreshing.
            if (my != companionReadSeq) return
            updateListen { it.copy(refreshing = false, loaded = true, error = errorText(e)) }
            return
        }
        if (my != companionReadSeq) return
        show(r, force)
    }

    /** companion.js's `refresh` and `renderCandidates`. */
    private fun show(r: CompanionResponse, force: Boolean) {
        val n = r.nowPlaying
        val key = listOf(n?.itemId, n?.episodeId, n?.sourceId, r.candidates.map { listOf(it.sourceId, it.type, it.link) }).toString()
        if (!force && key == candidatesKey) {
            updateListen { it.copy(refreshing = false, loaded = true, error = null) }
            return
        }
        candidatesKey = key
        val previous = candidates?.nowPlaying
        val episodeChanged = previous?.itemId != n?.itemId || previous?.episodeId != n?.episodeId
        candidates = r
        val s = session
        if (n?.isLive == true) {
            if (s != null && s.state.value.phase != ListenPhase.Idle) {
                s.stop()
                _snackbar.value = endedText(EndReason.TvSwitchedToChannel, null)
            }
            updateListen {
                it.copy(loaded = true, refreshing = false, error = null, nowPlaying = n, options = emptyList(), chosen = null, applyAllVisible = false)
            }
            return
        }
        val options = candidateOptions(r.candidates)
        var droppedLink = false
        updateListen { l ->
            // The owner's choice of a link found on this phone, still waiting for one: kept over the session's source.
            val pending = l.chosen?.takeIf { !episodeChanged && it.sourceId == PASTED_SOURCE_ID && l.foundLink == null }
                ?.let { c -> options.firstOrNull { it.key == c.key } }
            val target = l.session.target.takeIf { l.listening && it?.episodeId == n?.episodeId }
            val chosen = pending
                ?: target?.let { t -> options.firstOrNull { it.sourceId == t.sourceId && it.language == t.language } }
                ?: l.chosen?.takeIf { !episodeChanged }?.let { c -> options.firstOrNull { it.key == c.key } }
                ?: n?.itemId?.let { remembered[it] }?.let { k -> options.firstOrNull { it.key == k } }
                ?: options.firstOrNull { it.sourceId != n?.sourceId }
                ?: options.firstOrNull()
            // A found link belongs to the episode it was found for.
            val foundLink = l.foundLink.takeIf { previous == null || !episodeChanged }
            droppedLink = l.foundLink != null && foundLink == null
            val base = l.copy(
                loaded = true, refreshing = false, error = null, nowPlaying = n, options = options, chosen = chosen,
                applyAllVisible = n?.itemKind == "series",
                foundLink = foundLink,
            )
            if (!l.listening || episodeChanged) base.withTiming(linkOf(chosen)) else base
        }
        // The finder forgets it too, or reopening it would offer the other episode's link.
        if (droppedLink) linkFinder.clear()
    }

    fun choose(option: CandidateOption) {
        val listen = _ui.value as? CompanionUi.Listen ?: return
        listen.nowPlaying?.itemId?.let { remembered[it] = option.key }
        val next = listen.copy(chosen = option).withTiming(linkOf(option))
        _ui.value = next
        val s = session ?: return
        val target = next.session.target
        if (next.listening && target != null && (target.sourceId != option.sourceId || target.language != option.language)) {
            // The `pasted` option without a link yet: the stream keeps playing until one is found.
            val link = next.foundLink
            if (option.sourceId == PASTED_SOURCE_ID && link == null) return
            parseTiming(next.offsetText, next.speedText)?.let { s.setTiming(LinkTiming(it.offsetMs, it.rate, option.language)) }
            if (link != null && option.sourceId == PASTED_SOURCE_ID) s.useFoundLink(link) else s.switchSource(option.sourceId, option.language)
        }
    }

    // --- the link finder -------------------------------------------------------------------------------------------

    /** Shows the link finder (for the `pasted` option), starting a fresh search: a link found earlier is not offered again. */
    fun openFinder() {
        linkFinder.clear()
        updateListen { it.copy(finderOpen = true) }
    }

    /** Drops the link found on this phone (and ends listening with it); the next search starts fresh. */
    fun forgetFoundLink() {
        val listen = _ui.value as? CompanionUi.Listen ?: return
        if (listen.listening && listen.session.target?.sourceId == PASTED_SOURCE_ID) session?.stop()
        linkFinder.clear()
        _ui.value = listen.copy(foundLink = null)
    }

    fun closeFinder() {
        updateListen { it.copy(finderOpen = false) }
    }

    /**
     * The finder's "Listen to this": keeps [link] for the `pasted` option (in memory only) and closes the finder; while
     * listening with that option chosen, the session switches to the new link at once, keeping its timing.
     */
    fun useFoundLink(link: FoundLink) {
        val listen = _ui.value as? CompanionUi.Listen ?: return
        val next = listen.copy(foundLink = link, finderOpen = false)
        _ui.value = next
        linkFinder.clear() // the link now lives here; the finder's next search starts fresh
        val s = session ?: return
        val option = next.chosen
        if (!next.listening || option?.sourceId != PASTED_SOURCE_ID) return
        if (next.session.target?.sourceId != PASTED_SOURCE_ID) {
            // From a catalog source: the timing of the `pasted` option, as the fields show it.
            parseTiming(next.offsetText, next.speedText)?.let { s.setTiming(LinkTiming(it.offsetMs, it.rate, null)) }
        }
        s.useFoundLink(link)
    }

    fun setOffsetText(text: String) = editTiming { it.copy(offsetText = text) }

    fun setSpeedText(text: String) = editTiming { it.copy(speedText = text) }

    /** A valid change applies at once while listening; Save keeps it. */
    private fun editTiming(change: (CompanionUi.Listen) -> CompanionUi.Listen) {
        val listen = _ui.value as? CompanionUi.Listen ?: return
        val edited = change(listen)
        val timing = parseTiming(edited.offsetText, edited.speedText)
        _ui.value = edited.copy(timingValid = timing != null)
        if (timing != null && edited.listening) session?.setTiming(LinkTiming(timing.offsetMs, timing.rate, edited.chosen?.language))
    }

    fun saveTiming() {
        val listen = _ui.value as? CompanionUi.Listen ?: return
        val episodeId = listen.nowPlaying?.episodeId ?: return
        val option = listen.chosen ?: return
        val timing = parseTiming(listen.offsetText, listen.speedText) ?: return
        val client = api ?: return
        viewModelScope.launch {
            try {
                client.putLink(episodeId, option.sourceId, LinkUpdate(timing.offsetMs, timing.rate, option.language))
            } catch (e: Exception) {
                return@launch failed(e)
            }
            _snackbar.value = TIMING_SAVED
            load(force = true)
        }
    }

    fun applyToAll() {
        val listen = _ui.value as? CompanionUi.Listen ?: return
        val episodeId = listen.nowPlaying?.episodeId ?: return
        val option = listen.chosen ?: return
        val client = api ?: return
        viewModelScope.launch {
            val r = try {
                client.copyLinkToItem(episodeId, option.sourceId)
            } catch (e: Exception) {
                return@launch failed(e)
            }
            _snackbar.value = copiedText(r.updated)
        }
    }

    fun listen() {
        val listen = _ui.value as? CompanionUi.Listen ?: return
        val s = session ?: return
        if (listen.listening || !listen.canListen) return
        val n = listen.nowPlaying ?: return
        val episodeId = n.episodeId ?: return
        val option = listen.chosen ?: return
        val stored = linkOf(option)
        val typed = parseTiming(listen.offsetText, listen.speedText)
        val timing = LinkTiming(typed?.offsetMs ?: stored.offsetMs, typed?.rate ?: stored.rate, option.language)
        val link = listen.foundLink.takeIf { option.sourceId == PASTED_SOURCE_ID }
        val target = ListenTarget(
            listen.tvId, episodeId, option.sourceId, option.language, n.itemTitle, n.episodeTitle,
            foundLink = link,
            // Also for a catalog source: the owner may switch to a found link while listening.
            episodeDurationMs = n.durationMs,
        )
        s.start(target, timing, listen.nudgeMs)
        ListenService.start(getApplication())
    }

    fun stopListening() {
        session?.stop()
    }

    /** For the earphones' delay, remembered on this phone. */
    fun nudge(deltaMs: Long) {
        val listen = _ui.value as? CompanionUi.Listen ?: return
        val value = listen.nudgeMs + deltaMs
        _ui.value = listen.copy(nudgeMs = value)
        session?.setNudgeMs(value)
        viewModelScope.launch { store.setNudgeMs(value) }
    }

    fun dismissSnackbar() {
        _snackbar.value = null
    }

    // --- helpers ---------------------------------------------------------------------------------------------------

    private fun linkOf(option: CandidateOption?): LinkTiming =
        option?.let { o -> candidates?.candidates?.firstOrNull { it.sourceId == o.sourceId }?.link } ?: LinkTiming()

    private fun CompanionUi.Listen.withTiming(link: LinkTiming): CompanionUi.Listen =
        copy(offsetText = offsetText(link), speedText = speedText(link), timingValid = true)

    private inline fun updateListen(change: (CompanionUi.Listen) -> CompanionUi.Listen) {
        _ui.update { if (it is CompanionUi.Listen) change(it) else it }
    }

    private suspend fun failed(e: Exception) {
        if (e !is IOException && e !is ApiException) throw e
        if (isRevoked(e)) return unauthorized()
        _snackbar.value = errorText(e)
    }

    /**
     * The stored credential no longer works: `401` (this phone was disconnected), or an older install's `companion`
     * access token, a scope the server no longer has.
     */
    private fun isRevoked(e: Exception): Boolean =
        e is ApiException && (e.status == 401 || (e.code == "insufficient_scope" && phoneId == null))

    /**
     * A disconnected phone: forget the pairing at once (every request with it counts as a failed sign-in on the server)
     * and say so on the connect screen.
     */
    private suspend fun unauthorized() {
        forget(ConnectError.Disconnected)
    }

    /** Listing the TVs or the phones, or a typed token. */
    private fun connectError(e: Exception): ConnectError? = when {
        e is IOException -> ConnectError.Unreachable
        e is ApiException && e.status == 401 -> ConnectError.TokenNotAccepted
        e is ApiException -> ConnectError.Server(e.code)
        else -> null
    }

    /** A claim: `404` is an unknown, used or expired code or invite. */
    private fun claimError(e: Exception): ConnectError? = when {
        e is IOException -> ConnectError.Unreachable
        e is ApiException && e.status == 404 -> ConnectError.CodeNotAccepted
        e is ApiException && e.status == 429 -> ConnectError.TooManyTries
        e is ApiException -> ConnectError.Server(e.code)
        else -> null
    }

    companion object {
        private const val REFRESH_MS = 10_000L

        /** Disconnecting this phone waits this long for the server at most. */
        private const val SELF_DELETE_MS = 5_000L

        private val CODE = Regex("^[0-9]{6}$")

        /** The code's 6 digits, spaces ignored; null when it is not 6 digits. */
        fun normalizeCode(text: String): String? = text.filterNot(Char::isWhitespace).takeIf(CODE::matches)
    }
}
