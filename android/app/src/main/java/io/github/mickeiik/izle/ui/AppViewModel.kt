package io.github.mickeiik.izle.ui

import android.content.Intent
import android.os.Build
import android.os.SystemClock
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.github.mickeiik.izle.AppGraph
import io.github.mickeiik.izle.BuildConfig
import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.data.api.CommandResult
import io.github.mickeiik.izle.data.api.EpisodeDetails
import io.github.mickeiik.izle.data.api.HomeEntry
import io.github.mickeiik.izle.data.api.ItemCard
import io.github.mickeiik.izle.data.api.ServerEvent
import io.github.mickeiik.izle.data.api.ServerUrls
import io.github.mickeiik.izle.data.api.TvState
import io.github.mickeiik.izle.data.api.orNullOnFailure
import io.github.mickeiik.izle.domain.AutoplayPlan
import io.github.mickeiik.izle.domain.ChannelZap
import io.github.mickeiik.izle.domain.PlayableRef
import io.github.mickeiik.izle.domain.PlaybackOrigin
import io.github.mickeiik.izle.domain.Problems
import io.github.mickeiik.izle.domain.RemoteCommand
import io.github.mickeiik.izle.domain.countDown
import io.github.mickeiik.izle.player.PlaybackController
import io.github.mickeiik.izle.player.PlayerPhase
import io.github.mickeiik.izle.player.TrackOption
import io.github.mickeiik.izle.update.AvailableUpdate
import io.github.mickeiik.izle.update.InstallStatus
import io.github.mickeiik.izle.update.UpdatePlan
import io.github.mickeiik.izle.update.UpdateRun
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.receiveAsFlow
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

    /** A new version of the app: "press OK", "Updating…" or "Could not update" (docs/ux/senior-tv.md, "Update"). */
    data class Update(val ui: UpdateUi) : Screen
}

/** The update screen's moment: the guided "press OK" (counting down to Home), the install under way, or its failure. */
sealed interface UpdatePhase {
    data class Prompt(val secondsLeft: Int) : UpdatePhase
    data object Installing : UpdatePhase
    data class Failed(val secondsLeft: Int) : UpdatePhase
}

data class UpdateUi(val versionName: String, val phase: UpdatePhase)

enum class SetupError { Invalid, Unreachable }

data class SetupUi(val address: String = "", val busy: Boolean = false, val error: SetupError? = null)

enum class HomeMessage { NoConnection }

/** [updateVersion]: the newer version the server offers, if any. */
data class AboutInfo(
    val appVersion: String,
    val server: String?,
    val deviceName: String?,
    val catalogName: String?,
    val catalogBuild: String?,
    val updateVersion: String? = null,
)

/** "Autoplay on start": the show or channel about to start over Home, and the seconds left before it does. */
data class AutoplayUi(val entry: HomeEntry, val secondsLeft: Int)

class AppViewModel(private val graph: AppGraph) : ViewModel() {
    private val store = graph.deviceStore
    private val repository = graph.repository
    private val updater = graph.updater

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

    private val _autoplay = MutableStateFlow<AutoplayUi?>(null)
    val autoplay: StateFlow<AutoplayUi?> = _autoplay.asStateFlow()

    /** The owner's message banner (Home and player). */
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
        commandResults = graph.commandResults,
        userAgent = graph.userAgent,
        appVersion = BuildConfig.VERSION_NAME,
        // The emulator decodes H.264 in software; real TVs, debug build or not, get full resolution.
        capVideoTo720p = BuildConfig.DEBUG && Build.HARDWARE in setOf("ranchu", "goldfish"),
        onExit = ::onPlayerExit,
        // Remembered for "autoplay on start" (outlives the screen: the application scope).
        onPlaybackStarted = { item -> graph.appScope.launch { store.setLastPlayedItem(item.id) } },
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

    /** The last key press, coming to the front or end of playback (uptime ms): how long the TV has been idle. */
    private var lastActivityAt = SystemClock.uptimeMillis()

    /** The guided "press OK" showing, with the command it answers (null: the hidden menu's "Install update"). */
    private var prompt: UpdateRequest? = null

    /** The update being downloaded or installed, if any. */
    private var updateRun: UpdateRequest? = null
    private var updateRunJob: Job? = null

    /** The update screen's countdown, or its "Updating…" time limit. */
    private var updateScreenJob: Job? = null

    /**
     * The system's Install dialog of a guided update was started and has not answered yet: it covers the app (which
     * stops), and leaving "Updating…" for Home then would undo what the viewer is in the middle of.
     */
    private var confirming = false
    private var autoUpdateJob: Job? = null

    private val _launchIntents = Channel<Intent>(Channel.BUFFERED)

    /** Activities to start (the system's Install dialog of a guided update); the activity collects them. */
    val launchIntents: Flow<Intent> = _launchIntents.receiveAsFlow()

    /** An update and whom to tell what became of it. */
    private class UpdateRequest(val update: AvailableUpdate, val commandId: Long?, val api: ApiClient?, val report: (CommandResult) -> Unit) {
        /** The command's result went out and the session is about to be (or was) committed: no backing out. */
        var committing = false
    }

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
        viewModelScope.launch {
            repository.unauthorized.collect { if (serverUrl != null && _screen.value != Screen.Pairing) pairAgain() }
        }
        viewModelScope.launch { repository.fetched.collect(::onFreshState) }
        viewModelScope.launch { updater.installStatus.collect(::onInstallStatusEvent) }
        viewModelScope.launch {
            repository.outages.collect { lengthMs ->
                // Sent now that the server answers again; it happened when the outage began.
                graph.problems.send(Problems.serverUnreachable(lengthMs, BuildConfig.VERSION_NAME), happenedAt = graph.problems.now() - lengthMs)
            }
        }
    }

    fun onForeground() {
        foreground = true
        lastActivityAt = SystemClock.uptimeMillis()
        // The "install unknown apps" grant may have changed while the app was away.
        updater.refreshCapability()
        startAutoUpdates()
        // Autoplay on start: the app starts, or comes back from the launcher / standby, on Home (not from the
        // system's Install dialog).
        autoplayArmed = !confirming && (_screen.value == Screen.Home || _screen.value == Screen.Starting)
        when (_screen.value) {
            // On the server address screen too: Back from there returns to a live Home.
            Screen.Home, Screen.Player, is Screen.Setup, is Screen.Update -> repository.start()
            Screen.Pairing -> if (pairingJob?.isActive != true) startPairing()
            Screen.Starting -> Unit
        }
    }

    /**
     * HOME was pressed or the TV went to standby: save progress, release the player; we come back on Home. Not while
     * the system's Install dialog is over the app: "Updating…" waits for its answer.
     */
    fun onBackground() {
        foreground = false
        autoUpdateJob?.cancel()
        if (!confirming) leaveUpdateScreen()
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
        if (url != serverUrl || !store.current().isPaired) useServer(url)
    }

    /** Every key press (DOWN) reaching the app: the viewer is doing something, so autoplay on start stands down. */
    fun onKeyDown() {
        keyPresses++
        lastActivityAt = SystemClock.uptimeMillis()
        autoplayArmed = false
    }

    /**
     * CH+/CH− and |◀◀ ▶▶|: switch episodes while video is showing, or channels while one plays or loads; everywhere
     * else they do nothing (but are consumed).
     */
    fun onChannelKey(direction: Int) {
        if (_screen.value != Screen.Player || _menu.value != null) return
        if (player.ui.value.live) zap(direction, PlaybackOrigin.Next) else player.stepEpisode(direction, PlaybackOrigin.Next)
    }

    /**
     * To the channel after (+1) or before (−1) the one playing, among the channels of the latest home state, in Home
     * order ([ChannelZap]): it starts in the same player at its live edge (the one left is reported stopped), its name
     * showing while it loads. At the first or last channel only the information shows. The result is an owner's
     * `next`/`previous` command's.
     */
    private fun zap(direction: Int, origin: PlaybackOrigin): CommandResult {
        val current = player.zappableChannelId ?: return CommandResult.ignored(CommandResult.NOT_IN_PLAYER)
        val next = ChannelZap.neighbour(state.value?.home.orEmpty(), current, direction) ?: run {
            player.showInfo()
            return CommandResult.ignored(CommandResult.NO_CHANNEL)
        }
        homeFocusItemId = next.item.id
        player.play(PlayableRef.Channel(next.item.id), origin, hint = next.item)
        return CommandResult.Done
    }

    /** Back: closes the menu, leaves the player, steps back from pairing. Never leaves the app from Home. */
    fun onBack() {
        autoplayArmed = false
        if (_autoplay.value != null) return cancelAutoplay()
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
            is Screen.Update -> leaveUpdateScreen()
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

    fun onAddressChange(text: String) = _setup.update { it.copy(address = text, error = null) }

    fun onConnect() {
        if (_setup.value.busy) return
        val url = ServerUrls.parse(_setup.value.address) ?: return _setup.update { it.copy(error = SetupError.Invalid) }
        _setup.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            if (orNullOnFailure { graph.apiClient(url, null).healthz() } == null) {
                _setup.update { it.copy(busy = false, error = SetupError.Unreachable) }
                return@launch
            }
            _setup.update { it.copy(busy = false, address = ServerUrls.display(url)) }
            if (url == serverUrl && store.current().isPaired) showHome() else useServer(url)
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
        repository.use(token?.let { graph.apiClient(url, it) })
        if (token != null) showHome() else showPairing()
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
        endUpdateScreen()
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

    /** The server no longer knows this TV, or the owner chose "Pair again": the token goes, a new code shows. */
    private suspend fun pairAgain() {
        closeMenu(resume = false)
        player.stop()
        store.forgetPairing()
        repository.use(null)
        showPairing()
    }

    fun onTileFocused(itemId: String) {
        homeFocusItemId = itemId
    }

    fun onTileClicked(entry: HomeEntry) = playTile(entry, PlaybackOrigin.Viewer)

    /**
     * OK on a tile, or autoplay on start: the show's `continue` episode under the normal resume rules, or the channel
     * at its live edge (resolved by its item id).
     */
    private fun playTile(entry: HomeEntry, origin: PlaybackOrigin) {
        if (!online.value) {
            homeMessages.show(HomeMessage.NoConnection, forMs = 5_000)
            repository.refreshSoon()
            return
        }
        val ref = PlayableRef.of(entry) ?: return
        homeFocusItemId = entry.item.id
        startPlayback(ref, origin, startAtMs = null, hint = entry.item)
    }

    /** The show or channel [itemId] on Home in the latest state, if it is there. */
    private fun homeEntry(itemId: String?): HomeEntry? = state.value?.home?.firstOrNull { it.item.id == itemId }

    private fun focusedEntry(): HomeEntry? = homeEntry(homeFocusItemId) ?: state.value?.home?.firstOrNull()

    /** A state fetched from the server (never the offline cache): the first one after coming to the front decides. */
    private fun onFreshState(state: TvState) {
        if (!autoplayArmed) return
        autoplayArmed = false
        if (!canOfferAutoplay()) return
        val pressesBefore = keyPresses
        viewModelScope.launch {
            val entry = AutoplayPlan.offer(state, store.current().lastPlayedItemId) ?: return@launch
            // The viewer may have pressed something while the last played show was read.
            if (keyPresses == pressesBefore && canOfferAutoplay()) startAutoplay(entry)
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
                _autoplay.value = homeEntry(itemId)?.let { AutoplayUi(it, left) }
                if (_autoplay.value == null) return@launch
            }
            onAutoplayPlayNow()
        }
    }

    /**
     * "Play now", or the end of the countdown: the show's `continue` episode under the normal resume rules, or the
     * channel at its live edge. Both are autoplay's playback (the viewer only confirmed what autoplay offered).
     */
    fun onAutoplayPlayNow() {
        val itemId = endAutoplay() ?: return
        playTile(homeEntry(itemId) ?: return, PlaybackOrigin.Autoplay)
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

    private fun startPlayback(ref: PlayableRef, origin: PlaybackOrigin, startAtMs: Long?, hint: ItemCard?, playCommand: Boolean = false) {
        clearAutoplay()
        _menu.value = null
        _screen.value = Screen.Player
        player.play(ref, origin, startAtMs, hint, playCommand = playCommand)
    }

    private fun onPlayerExit() {
        lastActivityAt = SystemClock.uptimeMillis()
        _menu.value = null
        if (_screen.value == Screen.Player) _screen.value = Screen.Home
        repository.refreshSoon()
    }

    private fun onCommand(command: ServerEvent.Command) {
        val playing = player.ui.value
        val actions = CommandPlan.actions(RemoteCommand.of(command), _screen.value, playing.phase, menuOpen = _menu.value != null, live = playing.live)
        // The server the command came from (the repository acknowledged it there).
        val api = repository.api
        val report = { result: CommandResult -> if (api != null) graph.commandResults.report(api, command.id, result) }
        val origin = PlaybackOrigin.command(command.id)
        for (action in actions) {
            when (action) {
                is CommandPlan.Action.Play -> {
                    action.itemId?.let { homeFocusItemId = it }
                    startPlayback(action.ref, origin, action.positionMs, homeEntry(action.itemId)?.item, playCommand = true)
                }
                CommandPlan.Action.Exit -> player.exit()
                CommandPlan.Action.Pause -> player.pause()
                CommandPlan.Action.Resume -> player.resume()
                is CommandPlan.Action.Seek -> player.seekRemote(action.command)
                is CommandPlan.Action.Step -> player.stepEpisode(action.direction, origin, report)
                is CommandPlan.Action.Zap -> report(zap(action.direction, origin))
                is CommandPlan.Action.CloseMenu -> closeMenu(action.resume)
                CommandPlan.Action.StayPausedAfterMenu -> resumeAfterMenu = false
                is CommandPlan.Action.ShowMessage -> banners.show(action.message.text, forMs = action.message.durationSec * 1_000L)
                is CommandPlan.Action.Report -> report(action.result)
                is CommandPlan.Action.Update -> onUpdate(action.command.versionCode, command.id, api, report)
            }
        }
    }

    /**
     * The owner's `update` ([commandId]), or the hidden menu's "Install update" (null): what the server offers now,
     * installed silently or behind the guided "press OK" ([UpdatePlan.onCommand]).
     */
    private fun onUpdate(versionCode: Long?, commandId: Long?, api: ApiClient?, report: (CommandResult) -> Unit) {
        if (api == null) return report(CommandResult.ignored(CommandResult.NOT_READY))
        viewModelScope.launch {
            // The latest offer: the command may name a version this TV has not heard of yet.
            if (versionCode == null || updater.available.value?.versionCode != versionCode) updater.check(api)
            for (action in UpdatePlan.onCommand(updater.available.value, versionCode, updateContext())) {
                when (action) {
                    is UpdatePlan.Action.Report -> report(action.result)
                    is UpdatePlan.Action.ShowGuided -> showUpdatePrompt(UpdateRequest(action.update, commandId, api, report))
                    is UpdatePlan.Action.Install -> runUpdate(UpdateRequest(action.update, commandId, api, report), silent = true, auto = false)
                }
            }
        }
    }

    /** The live facts [UpdatePlan] decides on; the grant is re-read each time (a Settings page over the app does not stop it). */
    private fun updateContext(): UpdatePlan.Context {
        updater.refreshCapability()
        return UpdatePlan.Context(
        capability = updater.capability.value,
        installedVersionCode = updater.installedVersionCode,
        screen = _screen.value,
        menuOpen = _menu.value != null,
        autoplayShowing = _autoplay.value != null,
        playerInUse = player.inUse,
        online = online.value,
        idleMs = SystemClock.uptimeMillis() - lastActivityAt,
        lastFailureAt = updater.lastFailureAt,
        now = System.currentTimeMillis(),
        busy = updater.busy,
    )
    }

    /** While in front: every 30 s, whether a silent TV installs the offered version by itself ([UpdatePlan.autoInstall]). */
    private fun startAutoUpdates() {
        autoUpdateJob?.cancel()
        autoUpdateJob = viewModelScope.launch {
            while (true) {
                delay(UpdatePlan.AUTO_TICK_MS)
                val update = updater.available.value ?: continue
                if (UpdatePlan.autoInstall(update, updateContext())) {
                    runUpdate(UpdateRequest(update, commandId = null, api = repository.api, report = {}), silent = true, auto = true)
                }
            }
        }
    }

    /** The guided "New version — press OK": OK installs, Back is `declined`, 60 s without an answer `timeout`. */
    private fun showUpdatePrompt(request: UpdateRequest) {
        closeMenu(resume = false)
        clearAutoplay()
        prompt = request
        updateScreenJob?.cancel()
        updateScreenJob = viewModelScope.launch {
            countDown(UpdatePlan.GUIDED_TIMEOUT_SEC) { left ->
                // Something else took the screen meanwhile: it stays.
                if (left < UpdatePlan.GUIDED_TIMEOUT_SEC && _screen.value !is Screen.Update) {
                    if (prompt === request) {
                        prompt = null
                        request.report(CommandResult.ignored(CommandResult.DECLINED))
                    }
                    return@launch
                }
                _screen.value = Screen.Update(UpdateUi(request.update.versionName, UpdatePhase.Prompt(left)))
            }
            endPrompt(CommandResult.TIMEOUT)
        }
    }

    /** Install on the "press OK" screen. */
    fun onUpdateInstall() {
        val request = prompt ?: return
        prompt = null
        updateScreenJob?.cancel()
        runUpdate(request, silent = false, auto = false)
    }

    /** Not now on the "press OK" screen, or Home on "Could not update": as Back. */
    fun onUpdateHome() = leaveUpdateScreen()

    private fun endPrompt(reason: String) {
        val request = prompt ?: return
        prompt = null
        updateScreenJob?.cancel()
        request.report(CommandResult.ignored(reason))
        if (_screen.value is Screen.Update) showHome()
    }

    /**
     * Back (or the app going to the background) on the update screen: Home. The "press OK" is `declined`, and so is
     * a guided install still downloading; one already handed to the system goes on.
     */
    private fun leaveUpdateScreen() {
        endUpdateScreen()
        if (_screen.value is Screen.Update) showHome()
    }

    /** What the update screen was doing ends as [leaveUpdateScreen] ends it, for a screen that takes its place. */
    private fun endUpdateScreen() {
        updateScreenJob?.cancel()
        prompt?.let { request ->
            prompt = null
            request.report(CommandResult.ignored(CommandResult.DECLINED))
        }
        val run = updateRun
        if (run != null && !run.committing && updateRunJob?.isActive == true && _screen.value is Screen.Update) {
            updateRunJob?.cancel()
            updateRun = null
            run.report(CommandResult.ignored(CommandResult.DECLINED))
        }
    }

    private fun showUpdatePhase(versionName: String, phase: UpdatePhase) {
        _screen.value = Screen.Update(UpdateUi(versionName, phase))
    }

    private fun showInstalling(versionName: String) {
        updateScreenJob?.cancel()
        showUpdatePhase(versionName, UpdatePhase.Installing)
    }

    /** Once committed, "Updating…" stays until the system answers (the app usually restarts as the new version), at most 2 min. */
    private fun limitInstalling() {
        updateScreenJob?.cancel()
        updateScreenJob = viewModelScope.launch {
            delay(UpdatePlan.INSTALLING_MAX_MS)
            confirming = false
            if ((_screen.value as? Screen.Update)?.ui?.phase == UpdatePhase.Installing) showHome()
        }
    }

    /** "Could not update", then Home by itself. */
    private fun showUpdateFailed(versionName: String) {
        updateScreenJob?.cancel()
        updateScreenJob = viewModelScope.launch {
            countDown(UpdatePlan.FAILED_HOME_SEC) { left ->
                // Something else took the screen meanwhile: it stays.
                if (left < UpdatePlan.FAILED_HOME_SEC && _screen.value !is Screen.Update) return@launch
                showUpdatePhase(versionName, UpdatePhase.Failed(left))
            }
            if (_screen.value is Screen.Update) showHome()
        }
    }

    /**
     * Downloads, checks and installs [request]'s update. Silent: Home stays usable meanwhile, "Updating…" only comes
     * once the archive checked out, and only if nothing started meanwhile ([auto]: the TV is still idle). Guided:
     * "Updating…" from OK on, then the system's Install dialog. The command's result goes out (and is waited for)
     * right before the session is committed: a successful install ends this process.
     */
    private fun runUpdate(request: UpdateRequest, silent: Boolean, auto: Boolean) {
        val api = request.api ?: return request.report(CommandResult.ignored(CommandResult.NOT_READY))
        val versionName = request.update.versionName
        if (!silent) showInstalling(versionName)
        updateRun = request
        updateRunJob = viewModelScope.launch {
            val run = updater.run(api, request.update, silent, request.commandId) {
                val ready = when {
                    !silent -> (_screen.value as? Screen.Update)?.ui?.phase == UpdatePhase.Installing
                    !foreground -> false
                    auto -> UpdatePlan.autoInstall(request.update, updateContext().copy(busy = false))
                    else -> !player.inUse && (_screen.value == Screen.Home || _screen.value is Screen.Update)
                }
                if (ready) {
                    request.committing = true
                    if (silent) {
                        closeMenu(resume = false)
                        clearAutoplay()
                        showInstalling(versionName)
                    }
                    val result = CommandResult.done(if (silent) CommandResult.INSTALLING else CommandResult.PROMPTED)
                    if (request.commandId != null) graph.commandResults.reportNow(api, request.commandId, result)
                }
                ready
            }
            if (updateRun === request) updateRun = null
            when (run) {
                UpdateRun.Committed -> limitInstalling()
                is UpdateRun.Ignored -> {
                    request.report(CommandResult.ignored(run.reason))
                    if (_screen.value is Screen.Update) showHome()
                }
                is UpdateRun.Failed -> {
                    request.report(CommandResult.failed(run.reason))
                    if (_screen.value is Screen.Update) showUpdateFailed(versionName)
                }
            }
        }
    }

    /** `ACTION_INSTALL_STATUS` reached the activity: the system's answer about an install session. */
    fun onInstallStatus(intent: Intent) = updater.onInstallStatus(intent)

    private fun onInstallStatusEvent(status: InstallStatus) {
        val showing = (_screen.value as? Screen.Update)?.ui
        // Any later answer means the dialog is gone (or never came).
        confirming = status is InstallStatus.NeedsConfirmation
        when (status) {
            is InstallStatus.NeedsConfirmation -> _launchIntents.trySend(status.intent)
            InstallStatus.SilentRefused, InstallStatus.Succeeded -> if (showing != null) showHome()
            is InstallStatus.Failed -> if (showing != null) {
                if (status.aborted) showHome() else showUpdateFailed(showing.versionName)
            }
        }
    }

    /** The system's Install dialog could not be opened. */
    fun onLaunchFailed() {
        confirming = false
        val showing = (_screen.value as? Screen.Update)?.ui ?: return
        showUpdateFailed(showing.versionName)
    }

    fun openMenu() {
        if (!menuAvailable) return
        autoplayArmed = false
        val fromPlayer = _screen.value == Screen.Player
        val item = if (fromPlayer) player.ui.value.item else focusedEntry()?.item
        val entries = MenuPlan.rootEntries(item?.kind, fromPlayer, audioTrackCount = if (fromPlayer) player.audioTracks().size else 0)
        // Over a show the video pauses; a channel plays on (it has no pause), and closing the menu has nothing to resume.
        if (fromPlayer) {
            val live = player.ui.value.live
            resumeAfterMenu = !live && player.ui.value.playWhenReady
            if (!live) player.pause()
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

    private fun push(page: MenuPage) = _menu.update { it?.push(page) }

    fun onRootEntry(entry: RootEntry) {
        val menu = _menu.value ?: return
        _menu.value = menu.focusingRoot(entry)
        when (entry) {
            RootEntry.Episodes -> {
                val item = menu.item ?: return
                push(MenuPage.Episodes(details = null))
                val api = repository.api
                viewModelScope.launch {
                    val page = orNullOnFailure { MenuPage.Episodes(api?.item(item.id), failed = api == null) }
                        ?: MenuPage.Episodes(null, failed = true)
                    _menu.update { m -> if (m == null || m.page !is MenuPage.Episodes) m else m.replaceTop(page) }
                }
            }
            RootEntry.StartOver -> {
                if (menu.fromPlayer) {
                    closeMenu(resume = false)
                    player.startOver()
                } else {
                    // Never offered for a channel, which has no beginning.
                    val home = focusedEntry() ?: return
                    val episodeId = home.playNext?.episodeId?.takeIf { !home.item.isLive } ?: return
                    startPlayback(PlayableRef.Episode(episodeId), PlaybackOrigin.Viewer, startAtMs = 0, hint = home.item)
                }
            }
            RootEntry.Audio -> push(MenuPage.Audio(player.audioTracks()))
            RootEntry.Subtitles -> push(MenuPage.Subtitles(player.textTracks()))
            RootEntry.Settings -> push(MenuPage.Settings)
            RootEntry.About -> push(MenuPage.About)
        }
    }

    fun onEpisodeChosen(episode: EpisodeDetails) {
        val menu = _menu.value ?: return
        if (!episode.playbackAllowed) return
        menu.item?.let { homeFocusItemId = it.id }
        startPlayback(PlayableRef.Episode(episode.id), PlaybackOrigin.Viewer, startAtMs = null, hint = menu.item)
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
            SettingsEntry.InstallUpdate -> {
                // Never over the player (the row is not offered there): the video goes on.
                if (_screen.value == Screen.Player || player.inUse) return closeMenu(resume = true)
                closeMenu(resume = false)
                onUpdate(versionCode = null, commandId = null, api = repository.api, report = {})
            }
        }
    }

    fun aboutInfo(): AboutInfo = state.value.let { s ->
        val server = serverUrl?.let(ServerUrls::display)
        AboutInfo(BuildConfig.VERSION_NAME, server, s?.device?.name, s?.catalog?.name, s?.catalog?.buildId, updater.newer()?.versionName)
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
