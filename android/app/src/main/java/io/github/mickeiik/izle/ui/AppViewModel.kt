package io.github.mickeiik.izle.ui

import android.os.Build
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.github.mickeiik.izle.AppGraph
import io.github.mickeiik.izle.BuildConfig
import io.github.mickeiik.izle.data.api.EpisodeDetails
import io.github.mickeiik.izle.data.api.HomeEntry
import io.github.mickeiik.izle.data.api.ItemCard
import io.github.mickeiik.izle.data.api.ServerEvent
import io.github.mickeiik.izle.data.api.ServerUrls
import io.github.mickeiik.izle.data.api.TvState
import io.github.mickeiik.izle.data.api.orNullOnFailure
import io.github.mickeiik.izle.domain.AutoplayPlan
import io.github.mickeiik.izle.domain.Problems
import io.github.mickeiik.izle.domain.RemoteCommand
import io.github.mickeiik.izle.domain.countDown
import io.github.mickeiik.izle.player.PlaybackController
import io.github.mickeiik.izle.player.PlayerPhase
import io.github.mickeiik.izle.player.TrackOption
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.util.Locale

/** The single screen stack: no navigation library, so Back and focus stay fully under control. */
sealed interface Screen {
    data object Starting : Screen

    /** Server address entry (first run, or "Server address" from the hidden menu). */
    data class Setup(val canGoBack: Boolean) : Screen

    data object Pairing : Screen
    data object Home : Screen
    data object Player : Screen
}

enum class SetupError { Invalid, Unreachable }

data class SetupUi(val address: String = "", val busy: Boolean = false, val error: SetupError? = null)

enum class HomeMessage { NoConnection }

data class AboutInfo(val appVersion: String, val server: String?, val deviceName: String?, val catalogName: String?, val catalogBuild: String?)

/** "Autoplay on start": the show about to start over Home, and the seconds left before it does. */
data class AutoplayUi(val entry: HomeEntry, val secondsLeft: Int)

class AppViewModel(private val graph: AppGraph) : ViewModel() {
    private val store = graph.deviceStore
    private val repository = graph.repository

    private val _screen = MutableStateFlow<Screen>(Screen.Starting)
    val screen: StateFlow<Screen> = _screen.asStateFlow()

    private val _setup = MutableStateFlow(SetupUi())
    val setup: StateFlow<SetupUi> = _setup.asStateFlow()

    private val _pairing = MutableStateFlow(PairingUi())
    val pairing: StateFlow<PairingUi> = _pairing.asStateFlow()

    private val _menu = MutableStateFlow<MenuUi?>(null)
    val menu: StateFlow<MenuUi?> = _menu.asStateFlow()

    private val homeMessages = TimedValue<HomeMessage>(viewModelScope)
    val homeMessage: StateFlow<HomeMessage?> = homeMessages.value

    /** The autoplay-on-start countdown over Home, or null. */
    private val _autoplay = MutableStateFlow<AutoplayUi?>(null)
    val autoplay: StateFlow<AutoplayUi?> = _autoplay.asStateFlow()

    /** The owner's message banner (Home and player), or null. */
    private val banners = TimedValue<String>(viewModelScope)
    val banner: StateFlow<String?> = banners.value

    val state: StateFlow<TvState?> = repository.state
    val online: StateFlow<Boolean> = repository.online

    private val systemLanguage = if (Locale.getDefault().language == "tr") "tr" else "en"

    /** Local override from the hidden menu, else the server's (owner-controlled) setting, else the system's. */
    val uiLanguage: StateFlow<String> = combine(store.settings, repository.state) { settings, state ->
        settings.uiLanguageOverride ?: state?.device?.uiLanguage ?: systemLanguage
    }.stateIn(viewModelScope, SharingStarted.Eagerly, systemLanguage)

    val uiLanguageOverride: StateFlow<String?> = store.settings.map { it.uiLanguageOverride }
        .stateIn(viewModelScope, SharingStarted.Eagerly, null)

    val player = PlaybackController(
        context = graph.context,
        scope = viewModelScope,
        reportScope = graph.appScope,
        mediaHttp = graph.http,
        repository = repository,
        problems = graph.problems,
        userAgent = graph.userAgent,
        appVersion = BuildConfig.VERSION_NAME,
        // The emulator decodes H.264 in software; real TVs, debug build or not, get full resolution.
        capVideoTo720p = BuildConfig.DEBUG && isEmulator(),
        onExit = ::onPlayerExit,
        onPlaybackStarted = ::onPlaybackStarted,
    )

    /** The tile that should take focus when Home appears (the last one played, else the last focused). */
    var homeFocusItemId: String? = null
        private set

    private var serverUrl: HttpUrl? = null
    private var foreground = false
    private var initialized = false
    private var pendingLaunchServer: String? = null
    private var pairingJob: Job? = null
    private var autoplayJob: Job? = null
    private var resumeAfterMenu = false

    /**
     * Autoplay on start is armed when the app comes to the foreground on Home (or starts): the first state fetched
     * from the server afterwards decides. Anything the viewer does first — a key, the menu, playing — disarms it.
     */
    private var autoplayArmed = false

    /** Key presses so far, to notice one that happens while autoplay reads the last played show. */
    private var keyPresses = 0L

    init {
        viewModelScope.launch {
            val settings = store.current()
            serverUrl = settings.serverUrl?.toHttpUrlOrNull()
            _setup.value = SetupUi(address = settings.serverUrl ?: BuildConfig.DEFAULT_SERVER_URL)
            val url = serverUrl
            if (url == null) showSetup(canGoBack = false) else enter(url, settings.deviceToken)
            initialized = true
            pendingLaunchServer?.let { pendingLaunchServer = null; applyLaunchServer(it) }
        }
        viewModelScope.launch { repository.commands.collect(::onCommand) }
        viewModelScope.launch { repository.unauthorized.collect { onUnauthorized() } }
        viewModelScope.launch { repository.fetched.collect(::onFreshState) }
        viewModelScope.launch {
            repository.outages.collect { lengthMs ->
                // Sent now that the server answers again; it happened when the outage began.
                graph.problems.send(Problems.serverUnreachable(lengthMs, BuildConfig.VERSION_NAME), happenedAt = graph.problems.now() - lengthMs)
            }
        }
    }

    // --- lifecycle -----------------------------------------------------------------------------------------------

    fun onForeground() {
        foreground = true
        // Autoplay on start: the app starts, or comes back from the launcher / standby, on Home.
        autoplayArmed = _screen.value == Screen.Home || _screen.value == Screen.Starting
        when (_screen.value) {
            // On the server address screen too: Back from there returns to a live Home.
            Screen.Home, Screen.Player, is Screen.Setup -> repository.start()
            Screen.Pairing -> if (pairingJob?.isActive != true) startPairing()
            Screen.Starting -> Unit
        }
    }

    /** HOME was pressed or the TV went to standby: save progress, release the player; we come back on Home. */
    fun onBackground() {
        foreground = false
        clearAutoplay()
        banners.clear()
        if (_screen.value == Screen.Player || player.inUse) {
            player.stop()
            _screen.value = Screen.Home
        }
        _menu.value = null
        repository.stop()
        pairingJob?.cancel()
    }

    /** Debug builds: `am start … --es izle.server <url>` points the TV at a server without typing. */
    fun onLaunchServer(address: String) {
        if (!initialized) pendingLaunchServer = address else viewModelScope.launch { applyLaunchServer(address) }
    }

    private suspend fun applyLaunchServer(address: String) {
        val url = ServerUrls.parse(address) ?: return
        if (url == serverUrl && store.current().isPaired) return
        useServer(url)
    }

    // --- keys ----------------------------------------------------------------------------------------------------

    /** Every key press (DOWN) reaching the app: the viewer is doing something, so autoplay on start stands down. */
    fun onKeyDown() {
        keyPresses++
        autoplayArmed = false
    }

    /** CH+/CH− and |◀◀ ▶▶|: switch episodes while video is showing; everywhere else they do nothing (but are consumed). */
    fun onEpisodeKey(direction: Int) {
        if (_screen.value == Screen.Player && _menu.value == null) player.stepEpisode(direction)
    }

    /** Back: closes the menu, leaves the player, steps back from pairing. Never leaves the app from Home. */
    fun onBack() {
        autoplayArmed = false
        if (_autoplay.value != null) {
            cancelAutoplay()
            return
        }
        val menu = _menu.value
        if (menu != null) {
            val back = menu.pop()
            if (back != null) _menu.value = back else closeMenu(resume = true)
            return
        }
        when (val screen = _screen.value) {
            Screen.Player -> player.exit()
            Screen.Pairing -> {
                pairingJob?.cancel()
                showSetup(canGoBack = false)
            }
            is Screen.Setup -> if (screen.canGoBack) showHome()
            Screen.Home, Screen.Starting -> Unit
        }
    }

    /** Whether the player takes the remote's keys directly (no menu, no overlay buttons). */
    val playerHasKeys: Boolean
        get() = _screen.value == Screen.Player && _menu.value == null &&
            player.ui.value.phase.let { it == PlayerPhase.Playing || it == PlayerPhase.Loading }

    /** Whether a long press / Menu key may open the hidden menu here (not during the autoplay countdown). */
    private val menuAvailable: Boolean
        get() = _menu.value == null && _autoplay.value == null && (_screen.value == Screen.Home ||
            (_screen.value == Screen.Player && player.ui.value.phase == PlayerPhase.Playing))

    /** The autoplay countdown is showing: OK presses its button, Back and any other key cancel it. */
    val autoplayShowing: Boolean get() = _autoplay.value != null

    // --- setup and pairing ---------------------------------------------------------------------------------------

    fun onAddressChange(text: String) {
        _setup.update { it.copy(address = text, error = null) }
    }

    fun onConnect() {
        if (_setup.value.busy) return
        val url = ServerUrls.parse(_setup.value.address)
        if (url == null) {
            _setup.update { it.copy(error = SetupError.Invalid) }
            return
        }
        _setup.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            val reachable = orNullOnFailure { graph.apiClient(url, null).healthz() } != null
            if (!reachable) {
                _setup.update { it.copy(busy = false, error = SetupError.Unreachable) }
                return@launch
            }
            _setup.update { it.copy(busy = false, address = ServerUrls.display(url)) }
            val settings = store.current()
            if (url == serverUrl && settings.isPaired) {
                showHome()
            } else {
                useServer(url)
            }
        }
    }

    private suspend fun useServer(url: HttpUrl) {
        player.stop()
        clearAutoplay()
        _menu.value = null
        store.setServer(url.toString())
        serverUrl = url
        _setup.update { it.copy(address = ServerUrls.display(url)) }
        enter(url, store.current().deviceToken)
    }

    /** With this device's token for [url]: its Home; without one: a pairing code. */
    private suspend fun enter(url: HttpUrl, token: String?) {
        if (token != null) {
            repository.use(graph.apiClient(url, token))
            showHome()
        } else {
            repository.use(null)
            showPairing()
        }
    }

    /** The server address screen; [canGoBack] to a working Home when the hidden menu opened it. */
    private fun showSetup(canGoBack: Boolean) {
        clearAutoplay()
        _setup.update { it.copy(busy = false, error = null) }
        _screen.value = Screen.Setup(canGoBack)
    }

    /** Every way to Home goes through here so live updates run whenever the app is in front. */
    private fun showHome() {
        _screen.value = Screen.Home
        if (foreground) repository.start()
    }

    private fun showPairing() {
        clearAutoplay()
        _screen.value = Screen.Pairing
        _pairing.value = PairingUi(adminUrl = serverUrl?.let(ServerUrls::adminPage).orEmpty())
        startPairing()
    }

    /** Shows a code until the owner approves this TV (see [PairingLoop]), then Home. */
    private fun startPairing() {
        pairingJob?.cancel()
        val url = serverUrl ?: return
        val api = graph.apiClient(url, null).pairingApi()
        pairingJob = viewModelScope.launch {
            PairingLoop.run(api, _pairing) { deviceId, deviceToken ->
                store.savePairing(deviceId, deviceToken)
                homeFocusItemId = null
                enter(url, deviceToken)
            }
        }
    }

    private suspend fun onUnauthorized() {
        if (serverUrl == null || _screen.value == Screen.Pairing) return
        pairAgain()
    }

    /** The server no longer knows this TV, or the owner chose "Pair again": the token goes, a new code shows. */
    private suspend fun pairAgain() {
        closeMenu(resume = false)
        player.stop()
        store.forgetPairing()
        repository.use(null)
        showPairing()
    }

    // --- home ----------------------------------------------------------------------------------------------------

    fun onTileFocused(itemId: String) {
        homeFocusItemId = itemId
    }

    fun onTileClicked(entry: HomeEntry) {
        if (!online.value) {
            showHomeMessage(HomeMessage.NoConnection)
            repository.refreshSoon()
            return
        }
        homeFocusItemId = entry.item.id
        startPlayback(entry.playNext.episodeId, startAtMs = null, hint = entry.item)
    }

    private fun showHomeMessage(message: HomeMessage) = homeMessages.show(message, forMs = 5_000)

    /** The show [itemId] on Home in the latest state, if it is there. */
    private fun homeEntry(itemId: String?): HomeEntry? = state.value?.home?.firstOrNull { it.item.id == itemId }

    private fun focusedEntry(): HomeEntry? = homeEntry(homeFocusItemId) ?: state.value?.home?.firstOrNull()

    // --- autoplay on start ---------------------------------------------------------------------------------------

    /** A state fetched from the server (never the offline cache): the first one after coming to the front decides. */
    private fun onFreshState(state: TvState) {
        if (!autoplayArmed) return
        autoplayArmed = false
        if (!canOfferAutoplay()) return
        val pressesBefore = keyPresses
        viewModelScope.launch {
            val entry = AutoplayPlan.offer(state, store.current().lastPlayedItemId) ?: return@launch
            // The viewer may have pressed something while the last played show was read.
            if (keyPresses != pressesBefore || !canOfferAutoplay()) return@launch
            startAutoplay(entry)
        }
    }

    /** Home is showing with nothing on top and nothing playing. */
    private fun canOfferAutoplay(): Boolean =
        foreground && _screen.value == Screen.Home && _menu.value == null && !player.inUse && _autoplay.value == null

    private fun startAutoplay(offered: HomeEntry) {
        val itemId = offered.item.id
        homeFocusItemId = itemId
        autoplayJob?.cancel()
        autoplayJob = viewModelScope.launch {
            countDown(AutoplayPlan.COUNTDOWN_SEC) { left ->
                // The latest state's entry: a live update may have moved its `continue` or removed the show.
                val entry = homeEntry(itemId)
                if (entry == null) {
                    _autoplay.value = null
                    return@launch
                }
                _autoplay.value = AutoplayUi(entry, left)
            }
            onAutoplayPlayNow()
        }
    }

    /** "Play now", or the end of the countdown: the show's `continue` episode under the normal resume rules. */
    fun onAutoplayPlayNow() {
        val itemId = endAutoplay() ?: return
        val entry = homeEntry(itemId) ?: return
        onTileClicked(entry)
    }

    /** Back, "Not now" or any other key: the viewer stays on Home, with the focus on the offered show. */
    fun cancelAutoplay() {
        homeFocusItemId = endAutoplay() ?: return
    }

    /** Stops the countdown that is showing and takes it away: the offered show's id, or null when none shows. */
    private fun endAutoplay(): String? {
        val shown = _autoplay.value ?: return null
        autoplayJob?.cancel()
        _autoplay.value = null
        return shown.entry.item.id
    }

    /** Leaving Home some other way (playing, pairing, server address, the background): no autoplay this time. */
    private fun clearAutoplay() {
        autoplayArmed = false
        autoplayJob?.cancel()
        _autoplay.value = null
    }

    // --- player --------------------------------------------------------------------------------------------------

    private fun startPlayback(episodeId: String, startAtMs: Long?, hint: ItemCard?) {
        clearAutoplay()
        _menu.value = null
        _screen.value = Screen.Player
        player.play(episodeId, startAtMs, hint)
    }

    /** Remembered for "autoplay on start" (outlives the screen: the application scope). */
    private fun onPlaybackStarted(item: ItemCard) {
        graph.appScope.launch { store.setLastPlayedItem(item.id) }
    }

    private fun onPlayerExit() {
        _menu.value = null
        if (_screen.value == Screen.Player) _screen.value = Screen.Home
        repository.refreshSoon()
    }

    /** The owner's commands, as [CommandPlan] routes them. */
    private fun onCommand(command: ServerEvent.Command) {
        val actions = CommandPlan.actions(RemoteCommand.of(command), _screen.value, player.ui.value.phase, menuOpen = _menu.value != null)
        for (action in actions) {
            when (action) {
                is CommandPlan.Action.Play -> {
                    action.itemId?.let { homeFocusItemId = it }
                    startPlayback(action.episodeId, startAtMs = null, hint = homeEntry(action.itemId)?.item)
                }
                CommandPlan.Action.Exit -> player.exit()
                CommandPlan.Action.Pause -> player.pause()
                CommandPlan.Action.Resume -> player.resume()
                is CommandPlan.Action.Seek -> player.seekRemote(action.command)
                is CommandPlan.Action.Step -> player.stepEpisode(action.direction)
                is CommandPlan.Action.CloseMenu -> closeMenu(action.resume)
                CommandPlan.Action.StayPausedAfterMenu -> resumeAfterMenu = false
                is CommandPlan.Action.ShowMessage -> banners.show(action.message.text, forMs = action.message.durationSec * 1_000L)
            }
        }
    }

    // --- hidden menu ---------------------------------------------------------------------------------------------

    fun openMenu() {
        if (!menuAvailable) return
        autoplayArmed = false
        val fromPlayer = _screen.value == Screen.Player
        val item = if (fromPlayer) player.ui.value.item else focusedEntry()?.item
        val entries = MenuPlan.rootEntries(item?.kind, fromPlayer, audioTrackCount = if (fromPlayer) player.audioTracks().size else 0)
        if (fromPlayer) {
            resumeAfterMenu = player.ui.value.playWhenReady
            player.pause()
        }
        val playing = if (fromPlayer) player.ui.value.episode?.id else null
        _menu.value = MenuUi(listOf(MenuPage.Root(entries)), item, fromPlayer, playing)
    }

    fun closeMenu(resume: Boolean) {
        val menu = _menu.value ?: return
        _menu.value = null
        if (resume && menu.fromPlayer && resumeAfterMenu && _screen.value == Screen.Player) player.resume()
        resumeAfterMenu = false
    }

    private fun push(page: MenuPage) {
        _menu.update { it?.push(page) }
    }

    fun onRootEntry(entry: RootEntry) {
        val menu = _menu.value ?: return
        _menu.value = menu.focusingRoot(entry)
        when (entry) {
            RootEntry.Episodes -> {
                val item = menu.item ?: return
                push(MenuPage.Episodes(details = null))
                loadEpisodes(item.id)
            }
            RootEntry.StartOver -> {
                if (menu.fromPlayer) {
                    closeMenu(resume = false)
                    player.startOver()
                } else {
                    val home = focusedEntry() ?: return
                    startPlayback(home.playNext.episodeId, startAtMs = 0, hint = home.item)
                }
            }
            RootEntry.Audio -> push(MenuPage.Audio(player.audioTracks()))
            RootEntry.Subtitles -> push(MenuPage.Subtitles(player.textTracks()))
            RootEntry.Settings -> push(MenuPage.Settings)
            RootEntry.About -> push(MenuPage.About)
        }
    }

    private fun loadEpisodes(itemId: String) {
        val api = repository.api
        viewModelScope.launch {
            val page = orNullOnFailure { MenuPage.Episodes(api?.item(itemId), failed = api == null) } ?: MenuPage.Episodes(null, failed = true)
            _menu.update { m ->
                if (m == null || m.page !is MenuPage.Episodes) m else m.replaceTop(page)
            }
        }
    }

    fun onEpisodeChosen(episode: EpisodeDetails) {
        val menu = _menu.value ?: return
        if (!episode.playbackAllowed) return
        menu.item?.let { homeFocusItemId = it.id }
        startPlayback(episode.id, startAtMs = null, hint = menu.item)
    }

    fun onAudioChosen(option: TrackOption?) {
        player.selectAudio(option)
        closeMenu(resume = true)
    }

    fun onSubtitlesChosen(option: TrackOption?) {
        player.selectText(option)
        closeMenu(resume = true)
    }

    fun onSettingsEntry(entry: SettingsEntry) {
        when (entry) {
            SettingsEntry.ServerAddress -> {
                closeMenu(resume = false)
                player.stop()
                _setup.update { it.copy(address = serverUrl?.let(ServerUrls::display) ?: it.address) }
                showSetup(canGoBack = true)
            }
            SettingsEntry.Language -> viewModelScope.launch {
                val next = when (uiLanguageOverride.value) {
                    null -> "tr"
                    "tr" -> "en"
                    else -> null
                }
                store.setUiLanguageOverride(next)
            }
            SettingsEntry.PairAgain -> viewModelScope.launch { pairAgain() }
        }
    }

    fun aboutInfo(): AboutInfo {
        val s = state.value
        return AboutInfo(
            appVersion = BuildConfig.VERSION_NAME,
            server = serverUrl?.let(ServerUrls::display),
            deviceName = s?.device?.name,
            catalogName = s?.catalog?.name,
            catalogBuild = s?.catalog?.buildId,
        )
    }

    /** Server-relative poster/media URLs made absolute for Coil. */
    fun absoluteUrl(reference: String?): String? {
        val base = serverUrl ?: return null
        return reference?.let { ServerUrls.resolve(base, it)?.toString() }
    }

    override fun onCleared() {
        player.stop()
        repository.stop()
    }
}

/** The Android emulator's virtual board ("ranchu"; "goldfish" on old images). */
private fun isEmulator(): Boolean = Build.HARDWARE == "ranchu" || Build.HARDWARE == "goldfish"
