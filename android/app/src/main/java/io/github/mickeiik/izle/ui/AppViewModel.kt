package io.github.mickeiik.izle.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.github.mickeiik.izle.AppGraph
import io.github.mickeiik.izle.BuildConfig
import io.github.mickeiik.izle.data.api.ApiException
import io.github.mickeiik.izle.data.api.EpisodeDetails
import io.github.mickeiik.izle.data.api.HomeEntry
import io.github.mickeiik.izle.data.api.ItemCard
import io.github.mickeiik.izle.data.api.ItemDetailsResponse
import io.github.mickeiik.izle.data.api.ServerEvent
import io.github.mickeiik.izle.data.api.ServerUrls
import io.github.mickeiik.izle.data.api.TvState
import io.github.mickeiik.izle.player.PlaybackController
import io.github.mickeiik.izle.player.PlayerPhase
import io.github.mickeiik.izle.player.TrackOption
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.io.IOException
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

enum class PairingProblem { Unreachable, RateLimited }

data class PairingUi(val server: String = "", val code: String? = null, val problem: PairingProblem? = null)

enum class HomeMessage { NoConnection }

enum class RootEntry { Episodes, StartOver, Audio, Subtitles, Settings, About }

enum class SettingsEntry { ServerAddress, Language, PairAgain }

sealed interface MenuPage {
    /** [focused]: the entry that opened the page above, so Back returns to it. */
    data class Root(val entries: List<RootEntry>, val focused: Int = 0) : MenuPage
    data class Episodes(val details: ItemDetailsResponse?, val failed: Boolean = false) : MenuPage
    data class Audio(val options: List<TrackOption>) : MenuPage
    data class Subtitles(val options: List<TrackOption>) : MenuPage
    data object Settings : MenuPage
    data object About : MenuPage
}

/** The hidden menu: a stack of pages; Back pops one, the last one closes the menu. */
data class MenuUi(val pages: List<MenuPage>, val item: ItemCard?, val fromPlayer: Boolean, val playingEpisodeId: String? = null) {
    val page: MenuPage get() = pages.last()
}

data class AboutInfo(val appVersion: String, val server: String?, val deviceName: String?, val catalogName: String?, val catalogBuild: String?)

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

    private val _homeMessage = MutableStateFlow<HomeMessage?>(null)
    val homeMessage: StateFlow<HomeMessage?> = _homeMessage.asStateFlow()

    val state: StateFlow<TvState?> = repository.state
    val online: StateFlow<Boolean> = repository.online

    private val systemLanguage = if (Locale.getDefault().language == "tr") "tr" else "en"

    /** Local override from the hidden menu, else the server's (owner-controlled) setting, else the system's. */
    val uiLanguage: StateFlow<String> = combine(store.settings, repository.state) { settings, state ->
        settings.uiLanguageOverride ?: state?.device?.uiLanguage ?: systemLanguage
    }.stateIn(viewModelScope, SharingStarted.Eagerly, systemLanguage)

    val uiLanguageOverride: StateFlow<String?> = combine(store.settings, repository.state) { s, _ -> s.uiLanguageOverride }
        .stateIn(viewModelScope, SharingStarted.Eagerly, null)

    val player = PlaybackController(
        context = graph.context,
        scope = viewModelScope,
        reportScope = graph.appScope,
        mediaHttp = graph.http,
        repository = repository,
        userAgent = graph.userAgent,
        capVideoTo720p = BuildConfig.DEBUG,
        onExit = ::onPlayerExit,
    )

    /** The tile that should take focus when Home appears (the last one played, else the last focused). */
    var homeFocusItemId: String? = null
        private set

    private var serverUrl: HttpUrl? = null
    private var foreground = false
    private var initialized = false
    private var pendingLaunchServer: String? = null
    private var pairingJob: Job? = null
    private var messageJob: Job? = null
    private var resumeAfterMenu = false

    init {
        viewModelScope.launch {
            val settings = store.current()
            serverUrl = settings.serverUrl?.toHttpUrlOrNull()
            _setup.value = SetupUi(address = settings.serverUrl ?: BuildConfig.DEFAULT_SERVER_URL)
            val token = settings.deviceToken
            val url = serverUrl
            when {
                url == null -> _screen.value = Screen.Setup(canGoBack = false)
                token == null -> showPairing()
                else -> {
                    repository.use(graph.apiClient(url, token))
                    showHome()
                }
            }
            initialized = true
            pendingLaunchServer?.let { pendingLaunchServer = null; applyLaunchServer(it) }
        }
        viewModelScope.launch { repository.commands.collect(::onCommand) }
        viewModelScope.launch { repository.unauthorized.collect { onUnauthorized() } }
    }

    // --- lifecycle -----------------------------------------------------------------------------------------------

    fun onForeground() {
        foreground = true
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
        if (_screen.value == Screen.Player || player.isActive) {
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

    /** Back: closes the menu, leaves the player, steps back from pairing. Never leaves the app from Home. */
    fun onBack() {
        val menu = _menu.value
        if (menu != null) {
            if (menu.pages.size > 1) _menu.value = menu.copy(pages = menu.pages.dropLast(1)) else closeMenu(resume = true)
            return
        }
        when (val screen = _screen.value) {
            Screen.Player -> player.exit()
            Screen.Pairing -> {
                pairingJob?.cancel()
                _setup.update { it.copy(busy = false, error = null) }
                _screen.value = Screen.Setup(canGoBack = false)
            }
            is Screen.Setup -> if (screen.canGoBack) showHome()
            Screen.Home, Screen.Starting -> Unit
        }
    }

    /** Whether the player takes the remote's keys directly (no menu, no overlay buttons). */
    val playerHasKeys: Boolean
        get() = _screen.value == Screen.Player && _menu.value == null &&
            player.ui.value.phase.let { it == PlayerPhase.Playing || it == PlayerPhase.Loading }

    /** Whether a long press / Menu key may open the hidden menu here. */
    val menuAvailable: Boolean
        get() = _menu.value == null && (_screen.value == Screen.Home ||
            (_screen.value == Screen.Player && player.ui.value.phase == PlayerPhase.Playing))

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
            val reachable = try {
                graph.apiClient(url, null).healthz()
                true
            } catch (e: IOException) {
                false
            } catch (e: ApiException) {
                false
            }
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
        _menu.value = null
        store.setServer(url.toString())
        serverUrl = url
        _setup.update { it.copy(address = ServerUrls.display(url)) }
        val settings = store.current()
        val token = settings.deviceToken
        if (token != null) {
            repository.use(graph.apiClient(url, token))
            showHome()
        } else {
            repository.use(null)
            showPairing()
        }
    }

    /** Every way to Home goes through here so live updates run whenever the app is in front. */
    private fun showHome() {
        _screen.value = Screen.Home
        if (foreground) repository.start()
    }

    private fun showPairing() {
        _screen.value = Screen.Pairing
        _pairing.value = PairingUi(server = serverUrl?.let(ServerUrls::display).orEmpty())
        startPairing()
    }

    /** Shows a code, long-polls for the owner's approval, starts over when the code expires. */
    private fun startPairing() {
        pairingJob?.cancel()
        val url = serverUrl ?: return
        val api = graph.apiClient(url, null)
        pairingJob = viewModelScope.launch {
            while (isActive) {
                val start = try {
                    api.pairStart()
                } catch (e: ApiException) {
                    _pairing.update { it.copy(code = null, problem = PairingProblem.RateLimited) }
                    delay(((e.retryAfterSec ?: 30L).coerceIn(5L, 600L)) * 1_000)
                    continue
                } catch (e: IOException) {
                    _pairing.update { it.copy(code = null, problem = PairingProblem.Unreachable) }
                    delay(10_000)
                    continue
                }
                _pairing.update { it.copy(code = start.code, problem = null) }
                while (isActive) {
                    val wait = try {
                        api.pairWait(start.code, start.pairToken)
                    } catch (e: IOException) {
                        _pairing.update { it.copy(problem = PairingProblem.Unreachable) }
                        delay(5_000)
                        continue
                    } catch (e: ApiException) {
                        break // unknown code (server restarted): new code
                    }
                    _pairing.update { it.copy(problem = null) }
                    if (wait.status == "approved" && wait.deviceId != null && wait.deviceToken != null) {
                        // The server hands the token out once: keep it even if the screen goes away right now.
                        withContext(NonCancellable) {
                            store.savePairing(wait.deviceId, wait.deviceToken)
                            repository.use(graph.apiClient(url, wait.deviceToken))
                            homeFocusItemId = null
                            showHome()
                        }
                        return@launch
                    }
                    if (wait.status != "pending") break
                }
            }
        }
    }

    private suspend fun onUnauthorized() {
        if (serverUrl == null || _screen.value == Screen.Pairing) return
        player.stop()
        _menu.value = null
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

    private fun showHomeMessage(message: HomeMessage) {
        _homeMessage.value = message
        messageJob?.cancel()
        messageJob = viewModelScope.launch {
            delay(5_000)
            _homeMessage.value = null
        }
    }

    private fun focusedEntry(): HomeEntry? {
        val home = state.value?.home ?: return null
        return home.firstOrNull { it.item.id == homeFocusItemId } ?: home.firstOrNull()
    }

    // --- player --------------------------------------------------------------------------------------------------

    private fun startPlayback(episodeId: String, startAtMs: Long?, hint: ItemCard?) {
        _menu.value = null
        _screen.value = Screen.Player
        player.play(episodeId, startAtMs, hint)
    }

    private fun onPlayerExit() {
        _menu.value = null
        if (_screen.value == Screen.Player) _screen.value = Screen.Home
        repository.refreshSoon()
    }

    private fun onCommand(command: ServerEvent.Command) {
        val screen = _screen.value
        if (screen != Screen.Home && screen != Screen.Player) return
        when (command.type) {
            "play" -> {
                val episodeId = command.episodeId ?: return
                command.itemId?.let { homeFocusItemId = it }
                val hint = state.value?.home?.firstOrNull { it.item.id == command.itemId }?.item
                startPlayback(episodeId, startAtMs = null, hint = hint)
            }
            "stop" -> if (screen == Screen.Player) player.exit()
        }
    }

    // --- hidden menu ---------------------------------------------------------------------------------------------

    fun openMenu() {
        if (!menuAvailable) return
        val fromPlayer = _screen.value == Screen.Player
        val item = if (fromPlayer) player.ui.value.item else focusedEntry()?.item
        val entries = buildList {
            if (item != null) {
                if (item.kind == "series") add(RootEntry.Episodes)
                add(RootEntry.StartOver)
            }
            if (fromPlayer) {
                if (player.audioTracks().size > 1) add(RootEntry.Audio)
                add(RootEntry.Subtitles)
            }
            add(RootEntry.Settings)
            add(RootEntry.About)
        }
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
        _menu.update { it?.copy(pages = it.pages + page) }
    }

    fun onRootEntry(entry: RootEntry) {
        val menu = _menu.value ?: return
        _menu.value = menu.copy(pages = menu.pages.map { if (it is MenuPage.Root) it.copy(focused = it.entries.indexOf(entry)) else it })
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
            val page = try {
                MenuPage.Episodes(api?.item(itemId), failed = api == null)
            } catch (e: IOException) {
                MenuPage.Episodes(null, failed = true)
            } catch (e: ApiException) {
                MenuPage.Episodes(null, failed = true)
            }
            _menu.update { m ->
                if (m == null || m.page !is MenuPage.Episodes) m else m.copy(pages = m.pages.dropLast(1) + page)
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
                _setup.update { it.copy(address = serverUrl?.let(ServerUrls::display) ?: it.address, busy = false, error = null) }
                _screen.value = Screen.Setup(canGoBack = true)
            }
            SettingsEntry.Language -> viewModelScope.launch {
                val next = when (uiLanguageOverride.value) {
                    null -> "tr"
                    "tr" -> "en"
                    else -> null
                }
                store.setUiLanguageOverride(next)
            }
            SettingsEntry.PairAgain -> viewModelScope.launch {
                closeMenu(resume = false)
                player.stop()
                store.forgetPairing()
                repository.use(null)
                showPairing()
            }
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
