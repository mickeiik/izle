package io.github.mickeiik.izle.data

import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.data.api.ApiException
import io.github.mickeiik.izle.data.api.ApiJson
import io.github.mickeiik.izle.data.api.EventsClient
import io.github.mickeiik.izle.data.api.ServerEvent
import io.github.mickeiik.izle.data.api.TvState
import io.github.mickeiik.izle.data.api.orNullOnFailure
import io.github.mickeiik.izle.domain.Problems
import io.github.mickeiik.izle.settings.DeviceStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.IOException

/**
 * The TV's view of the server: the home state (also cached for offline starts), whether the server is reachable,
 * and the owner's commands. While started it keeps the event stream open (reconnecting with backoff) and polls
 * `/tv/state` every 60 s — every 10 s while the server is unreachable.
 */
class ServerRepository(
    private val scope: CoroutineScope,
    private val store: DeviceStore,
    private val events: EventsClient,
    private val timing: Timing = Timing(),
    /** `GET /tv/app`: when the event stream opens, on its `app` events and every [Timing.appCheckMs] while started. */
    private val onAppCheck: suspend (ApiClient) -> Unit = {},
) {
    /** [clock]: monotonic, in milliseconds. */
    data class Timing(
        val pollMs: Long = 60_000,
        val offlinePollMs: Long = 10_000,
        val minBackoffMs: Long = 1_000,
        val maxBackoffMs: Long = 30_000,
        val appCheckMs: Long = 6 * 3_600_000L,
        val clock: () -> Long = { System.nanoTime() / 1_000_000 },
    )

    private val _state = MutableStateFlow<TvState?>(null)
    val state: StateFlow<TvState?> = _state.asStateFlow()

    private val _online = MutableStateFlow(true)
    val online: StateFlow<Boolean> = _online.asStateFlow()

    private val _commands = MutableSharedFlow<ServerEvent.Command>(extraBufferCapacity = 16)
    val commands: SharedFlow<ServerEvent.Command> = _commands.asSharedFlow()

    /** Never the offline cache. */
    private val _fetched = MutableSharedFlow<TvState>(extraBufferCapacity = 4)
    val fetched: SharedFlow<TvState> = _fetched.asSharedFlow()

    /**
     * The length of an outage worth reporting ([Problems.SERVER_UNREACHABLE_MIN_MS]), once the server answers again.
     * Time in the background does not count: the TV was not trying then.
     */
    private val _outages = MutableSharedFlow<Long>(extraBufferCapacity = 4)
    val outages: SharedFlow<Long> = _outages.asSharedFlow()

    /** While started. */
    @Volatile
    private var offlineSince: Long? = null

    /** The owner deleted this device: it has to pair again. */
    private val _unauthorized = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    val unauthorized: SharedFlow<Unit> = _unauthorized.asSharedFlow()

    var api: ApiClient? = null
        private set

    private var connection: Job? = null
    private val refreshLock = Mutex()
    private val handledCommands = ArrayDeque<Long>()

    /** Switches to another server/device (or none) and shows that device's cached state, if any. */
    suspend fun use(api: ApiClient?) {
        stop()
        this.api = api
        _state.value = null
        _online.value = true
        handledCommands.clear()
        if (api != null) loadCached()
    }

    fun start() {
        val api = api ?: return
        if (connection?.isActive == true) return
        // Already known to be unreachable: the outage (as far as this TV can tell) starts now.
        if (!_online.value) offlineSince = timing.clock()
        connection = scope.launch {
            launch { pollLoop(api) }
            launch { eventsLoop(api) }
            launch { appCheckLoop(api) }
        }
    }

    fun stop() {
        connection?.cancel()
        connection = null
        offlineSince = null
    }

    /** E.g. when the TV returns to Home after playback. */
    fun refreshSoon() {
        val api = api ?: return
        scope.launch { refresh(api) }
    }

    suspend fun refresh(api: ApiClient): Boolean = refreshLock.withLock {
        try {
            val state = api.state()
            if (this.api !== api) return false
            _state.value = state
            setOnline(true)
            _fetched.tryEmit(state)
            store.saveCachedState(ApiJson.encodeToString(TvState.serializer(), state))
            true
        } catch (e: ApiException) {
            if (this.api === api) {
                if (e.status == 401) _unauthorized.tryEmit(Unit)
                if (isUnreachable(e)) setOnline(false)
            }
            false
        } catch (e: IOException) {
            if (this.api === api) setOnline(false)
            false
        }
    }

    private fun setOnline(online: Boolean) {
        _online.value = online
        val now = timing.clock()
        if (!online) {
            if (offlineSince == null && connection?.isActive == true) offlineSince = now
            return
        }
        val since = offlineSince ?: return
        offlineSince = null
        if (now - since >= Problems.SERVER_UNREACHABLE_MIN_MS) _outages.tryEmit(now - since)
    }

    private suspend fun loadCached() {
        val text = store.cachedState() ?: return
        _state.value = runCatching { ApiJson.decodeFromString(TvState.serializer(), text) }.getOrNull()
    }

    private suspend fun pollLoop(api: ApiClient) {
        while (scope.isActive) {
            refresh(api)
            delay(if (_online.value) timing.pollMs else timing.offlinePollMs)
        }
    }

    private suspend fun appCheckLoop(api: ApiClient) {
        while (scope.isActive) {
            delay(timing.appCheckMs)
            checkApp(api)
        }
    }

    /** One check at a time; a failing hook never breaks the stream. */
    private val appCheckLock = Mutex()

    private fun checkApp(api: ApiClient) {
        if (appCheckLock.isLocked) return
        scope.launch {
            appCheckLock.withLock {
                if (this@ServerRepository.api === api) orNullOnFailure { onAppCheck(api) }
            }
        }
    }

    private suspend fun eventsLoop(api: ApiClient) {
        var backoff = timing.minBackoffMs
        while (scope.isActive) {
            try {
                events.events(api).collect { event ->
                    when (event) {
                        ServerEvent.Open -> {
                            backoff = timing.minBackoffMs
                            if (!_online.value) refresh(api)
                            checkApp(api)
                        }
                        is ServerEvent.App -> checkApp(api)
                        is ServerEvent.State -> if (event.version != _state.value?.version) refresh(api)
                        is ServerEvent.Command -> dispatch(api, event)
                    }
                }
            } catch (e: ApiException) {
                if (e.status == 401) {
                    _unauthorized.tryEmit(Unit)
                    return
                }
                if (_online.value && isUnreachable(e)) refresh(api)
            } catch (e: IOException) {
                // A broken stream is the first sign of an unreachable server: check now rather than at the next poll.
                if (_online.value) refresh(api)
            }
            delay(backoff)
            backoff = (backoff * 2).coerceAtMost(timing.maxBackoffMs)
        }
    }

    /** Behind a reverse proxy a stopped server answers 502/503/504 instead of refusing the connection. */
    private fun isUnreachable(e: ApiException) = e.status >= 500 || e.status == 408

    /** Hands a command to the app once (commands are replayed until acknowledged) and acknowledges it. */
    private fun dispatch(api: ApiClient, command: ServerEvent.Command) {
        if (command.id !in handledCommands) {
            handledCommands.addLast(command.id)
            while (handledCommands.size > 64) handledCommands.removeFirst()
            _commands.tryEmit(command)
        }
        // A failed ack is replayed on the next connection and acknowledged then; unknown_command needs nothing.
        scope.launch { orNullOnFailure { api.ackCommand(command.id) } }
    }
}
