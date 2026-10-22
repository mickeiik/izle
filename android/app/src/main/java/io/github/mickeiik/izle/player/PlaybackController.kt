package io.github.mickeiik.izle.player

import android.os.SystemClock
import androidx.media3.common.Player
import io.github.mickeiik.izle.data.CommandResultReporter
import io.github.mickeiik.izle.data.ProblemReporter
import io.github.mickeiik.izle.data.ServerRepository
import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.data.api.ApiException
import io.github.mickeiik.izle.data.api.CommandResult
import io.github.mickeiik.izle.data.api.EpisodeDetails
import io.github.mickeiik.izle.data.api.EpisodeRef
import io.github.mickeiik.izle.data.api.ItemCard
import io.github.mickeiik.izle.data.api.NextEpisode
import io.github.mickeiik.izle.data.api.ProgressStatus
import io.github.mickeiik.izle.data.api.ResolveResponse
import io.github.mickeiik.izle.data.api.orNullOnFailure
import io.github.mickeiik.izle.domain.EpisodeSteps
import io.github.mickeiik.izle.domain.ExpiryPlan
import io.github.mickeiik.izle.domain.PlayableRef
import io.github.mickeiik.izle.domain.PlaybackOrigin
import io.github.mickeiik.izle.domain.PlaybackPlan
import io.github.mickeiik.izle.domain.Problems
import io.github.mickeiik.izle.domain.RemoteCommand
import io.github.mickeiik.izle.domain.SeekAccumulator
import io.github.mickeiik.izle.domain.SourceAttempts
import io.github.mickeiik.izle.domain.countDown
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.IOException

sealed interface PlayerPhase {
    data object Idle : PlayerPhase

    /** Resolving or buffering before the first frame. */
    data object Loading : PlayerPhase
    data object Playing : PlayerPhase
    data class UpNext(val next: NextEpisode, val secondsLeft: Int) : PlayerPhase

    /** "The end", then Home. */
    data object Finished : PlayerPhase

    /** "Can't play right now" with Try again / Home, then Home on its own after [secondsLeft]. */
    data class Failed(val secondsLeft: Int) : PlayerPhase
}

data class PlayerUi(
    val phase: PlayerPhase = PlayerPhase.Idle,
    val item: ItemCard? = null,
    val episode: EpisodeRef? = null,
    val posterUrl: String? = null,
    /** The viewer wants playback to run (false = paused). */
    val playWhenReady: Boolean = false,
    val buffering: Boolean = false,
    val showInfo: Boolean = false,
    val positionMs: Long = 0,
    val durationMs: Long? = null,
    val seekPreviewMs: Long? = null,
    val cues: String? = null,
    /**
     * A channel: its name and "Live" instead of the episode, position and times; no pause. Decided by the item's kind
     * (the home tile's, then the resolve answer's), never by the stream's format.
     */
    val live: Boolean = false,
)

/**
 * Plays one episode or channel at a time: resolve → play → heartbeat → auto-next, with source fallback on errors, a
 * refresh of expiring stream URLs and CH+/CH− episode steps. A channel (docs/ux/senior-tv.md, "Live channels") starts
 * at its live edge, is never paused, sought or finished, and when its stream ends or fails it is resolved again and
 * restarted at the live edge before the source fallback. All methods run on the main thread. Progress reports go
 * through one ordered queue in [reportScope], which outlives the screen.
 */
class PlaybackController(
    private val engine: MediaEngine,
    private val scope: CoroutineScope,
    reportScope: CoroutineScope,
    private val repository: ServerRepository,
    private val problems: ProblemReporter,
    /** The owner's `play` commands report once their playback runs or fails. */
    private val commandResults: CommandResultReporter,
    private val appVersion: String,
    private val onExit: () -> Unit,
    /** A playback reached its first frame. */
    private val onPlaybackStarted: (ItemCard) -> Unit,
    private val clock: () -> Long = SystemClock::elapsedRealtime,
) {
    private val _ui = MutableStateFlow(PlayerUi())
    val ui: StateFlow<PlayerUi> = _ui.asStateFlow()

    private val _player = MutableStateFlow<Player?>(null)
    val player: StateFlow<Player?> = _player.asStateFlow()

    /** Loaded for this visit, independently of whether the engine has a renderable surface. */
    private var activeEngine: MediaEngine? = null

    private class Session(val api: ApiClient, val resolved: ResolveResponse) {
        /** A channel's session: its reports name the item and carry no position. */
        val live: Boolean get() = resolved.item.isLive
    }

    /** An owner command [id] from [api]'s server, waiting for its result. */
    private class PendingCommand(val api: ApiClient, val id: Long)

    private var session: Session? = null

    /** The episode or channel this player visit plays (loading, playing or on its end screens). */
    private var target: PlayableRef? = null

    /** Who started this playback: every resolve made for it (fallback, expiry refresh, Try again) says so. */
    private var origin = PlaybackOrigin.Viewer

    /** The owner's `play` command this playback answers once it runs or fails; null when none, or answered. */
    private var playCommand: PendingCommand? = null
    private val attempts = SourceAttempts()
    private var readyAt: Long? = null
    private var reported = false

    /** Where Try again restarts; null = from the server's saved position under the resume rules (a channel: always). */
    private var lastPositionMs: Long? = null
    private val seek = SeekAccumulator()

    private var resolveJob: Job? = null
    private var overlayJob: Job? = null
    private var heartbeatJob: Job? = null
    private var infoJob: Job? = null
    private var expiryJob: Job? = null
    private var stepJob: Job? = null

    /** When this playback last re-resolved its stream ahead of the expiry on [clock], for the 60 s spacing. */
    private var lastRefreshAt: Long? = null

    /** CH+/CH−: the items' episode lists, fetched on first use and kept for this player visit. */
    private val episodeLists = mutableMapOf<String, List<EpisodeDetails>>()

    private val reporter = ProgressReporter(
        reportScope,
        send = { api, report -> api.progress(report) },
        onFinalDelivered = repository::refreshSoon,
        clock = clock,
    )

    /** A player visit is on (loading, playing or one of its end screens). */
    val inUse: Boolean get() = _ui.value.phase != PlayerPhase.Idle

    /**
     * The channel loading, playing or on its error screen, which CH+/CH− zap from (a dead channel is left like any
     * other, by changing channels); null otherwise (an episode, Idle, nothing).
     */
    val zappableChannelId: String?
        get() = (target as? PlayableRef.Channel)?.itemId?.takeIf {
            _ui.value.phase.let { it == PlayerPhase.Playing || it == PlayerPhase.Loading || it is PlayerPhase.Failed }
        }

    /**
     * Plays [ref]: an episode from [startAtMs], or from the server's saved position under the resume rules when null;
     * a channel at its live edge ([startAtMs] does not apply). [hint] (the home tile's item) and [episodeHint] are
     * shown while the stream is being resolved. [origin] goes with every resolve of this playback; with [playCommand],
     * it is the owner's `play` command whose result this playback reports: `done` at its first frame, `failed` on
     * "Can't play right now", `ignored` when left or replaced first.
     */
    fun play(
        ref: PlayableRef,
        origin: PlaybackOrigin,
        startAtMs: Long? = null,
        hint: ItemCard? = null,
        episodeHint: EpisodeRef? = null,
        playCommand: Boolean = false,
    ) {
        val api = repository.api
        resolveJob?.cancel()
        endSession()
        cancelOverlays()
        activeEngine?.stop()
        answerPlayCommand(CommandResult.ignored(CommandResult.SUPERSEDED))
        val commandId = origin.commandId
        this.playCommand = if (playCommand && api != null && commandId != null) PendingCommand(api, commandId) else null
        this.origin = origin
        this.target = ref
        // Only a channel is resolved by its item id: it is live until the answer says otherwise.
        val live = ref is PlayableRef.Channel
        val start = if (live) null else startAtMs
        attempts.reset(live)
        lastRefreshAt = null
        lastPositionMs = start
        val keep = _ui.value
        // Without a hint the item on screen stays (Try again, an episode step), unless another channel is starting.
        val kept = keep.item?.takeIf { keep.phase != PlayerPhase.Idle && (ref !is PlayableRef.Channel || it.id == ref.itemId) }
        _ui.value = PlayerUi(
            phase = PlayerPhase.Loading,
            item = hint ?: kept,
            episode = episodeHint,
            posterUrl = hint?.posterUrl?.let { api?.resolve(it)?.toString() } ?: keep.posterUrl.takeIf { kept != null },
            playWhenReady = true,
            live = live,
        )
        if (api == null) return showFailed()
        resolveJob = scope.launch { resolveAndStart(api, ref, origin, sourceId = null, startAtMs = start) }
    }

    /** Leaves the player: reports where the viewer stopped, releases the decoder, goes Home. */
    fun exit() {
        stop()
        onExit()
    }

    /** Like [exit] without navigating (the app went to the background). */
    fun stop() {
        answerPlayCommand(CommandResult.ignored(CommandResult.STOPPED))
        resolveJob?.cancel()
        stepJob?.cancel()
        cancelOverlays()
        endSession()
        activeEngine?.let {
            it.setListener(null)
            it.release()
        }
        activeEngine = null
        _player.value = null
        target = null
        episodeLists.clear()
        _ui.value = PlayerUi()
    }

    /**
     * Try again: continues the failed playback, with its origin (a `play` command's result was already sent); a channel
     * restarts at its live edge.
     */
    fun retry() {
        val ref = target ?: return exit()
        play(ref, origin, startAtMs = lastPositionMs)
    }

    fun playNextNow() {
        val phase = _ui.value.phase as? PlayerPhase.UpNext ?: return
        play(PlayableRef.Episode(phase.next.episodeId), PlaybackOrigin.Next)
    }

    /** OK while an episode plays. A channel has no pause: see [showChannelInfo]. */
    fun togglePause() {
        val p = activeEngine ?: return
        if (_ui.value.phase == PlayerPhase.Playing) setPlaying(!p.playWhenReady)
    }

    /** Never on a channel. */
    fun pause() = setPlaying(false)

    /** Plays on; on a channel only a pause the system made (lost audio focus) has anything to undo. */
    fun resume() = setPlaying(true)

    /**
     * OK on a channel: the information (its name and "Live"), and the picture goes on if the system paused it (a
     * channel has no pause the viewer could undo otherwise).
     */
    fun showChannelInfo() {
        resume()
        showInfo()
    }

    private fun setPlaying(play: Boolean) {
        val p = activeEngine ?: return
        if (p.playWhenReady == play || (!play && _ui.value.live)) return
        if (play) p.play() else p.pause()
        reportCurrent(PlaybackPlan.liveStatus(play))
        showInfo()
    }

    /** Start over (the hidden menu, never over a channel). */
    fun startOver() {
        val p = activeEngine ?: return
        if (_ui.value.live) return
        seek.cancel()
        p.seekTo(0)
        p.play()
        reportCurrent(ProgressStatus.Playing)
        showInfo()
    }

    /** Left/Right DOWN (first press or key repeat); a channel is not sought. */
    fun onSeekKeyDown(direction: Int, eventTimeMs: Long, downTimeMs: Long, repeatCount: Int) {
        val p = activeEngine ?: return
        if (_ui.value.phase != PlayerPhase.Playing || _ui.value.live) return
        val preview = seek.onKeyDown(direction, eventTimeMs, downTimeMs, repeatCount, p.positionMs, p.durationMs) ?: return
        _ui.update { it.copy(seekPreviewMs = preview) }
        showInfo()
    }

    fun onSeekKeyUp() {
        val p = activeEngine ?: return
        seekNow(p, seek.commit() ?: return)
    }

    /** The owner's seek command, shown like a key press (never on a channel). */
    fun seekRemote(command: RemoteCommand.Seek) {
        val p = activeEngine ?: return
        if (_ui.value.phase != PlayerPhase.Playing || _ui.value.live) return
        seek.cancel()
        seekNow(p, command.targetMs(p.positionMs.coerceAtLeast(0), p.durationMs ?: _ui.value.durationMs))
    }

    private fun seekNow(p: MediaEngine, toMs: Long) {
        p.seekTo(toMs)
        _ui.update { it.copy(seekPreviewMs = null, positionMs = toMs) }
        reportLive(p)
        showInfo()
    }

    /**
     * CH+/CH− (also |◀◀ ▶▶| and the owner's next/previous): ends the episode as Back does and plays the nearest
     * playable one after ([direction] > 0) or before it, under the normal resume rules, as [origin]. At either end only
     * the info overlay appears. Presses while the episode list is being fetched are ignored. [onResult] says, once
     * and maybe later, whether it stepped (`done`) or why not: an owner command's result.
     */
    fun stepEpisode(direction: Int, origin: PlaybackOrigin, onResult: (CommandResult) -> Unit = {}) {
        val notInPlayer = CommandResult.ignored(CommandResult.NOT_IN_PLAYER)
        if (_ui.value.phase != PlayerPhase.Playing) return onResult(notInPlayer)
        if (stepJob?.isActive == true) return onResult(CommandResult.ignored(CommandResult.BUSY))
        val s = session ?: return onResult(notInPlayer)
        val current = (target as? PlayableRef.Episode)?.episodeId ?: return onResult(notInPlayer)
        val item = s.resolved.item
        val ref = s.resolved.episode ?: return onResult(notInPlayer)
        if (!EpisodeSteps.mayHaveNeighbour(ref.index, ref.count, direction)) {
            showInfo()
            return onResult(CommandResult.ignored(CommandResult.NO_EPISODE))
        }
        episodeLists[item.id]?.let { return onResult(stepTo(it, current, direction, item, origin)) }
        stepJob = scope.launch {
            // Unless set below, auto-next, Back or a command changed things meanwhile (or leaving cancelled the step).
            var result = CommandResult.ignored(CommandResult.SUPERSEDED)
            try {
                val episodes = orNullOnFailure { s.api.item(item.id).episodes }
                if (episodes != null) episodeLists[item.id] = episodes
                if ((target as? PlayableRef.Episode)?.episodeId != current || _ui.value.phase != PlayerPhase.Playing) return@launch
                result = if (episodes == null) {
                    showInfo()
                    CommandResult.failed(CommandResult.EPISODES_UNAVAILABLE)
                } else {
                    stepTo(episodes, current, direction, item, origin)
                }
            } finally {
                onResult(result)
            }
        }
    }

    /** Plays the neighbour of [current] in [direction] (`done`); without one, shows the info overlay (`no_episode`). */
    private fun stepTo(episodes: List<EpisodeDetails>, current: String, direction: Int, item: ItemCard, origin: PlaybackOrigin): CommandResult {
        val next = EpisodeSteps.neighbour(episodes, current, direction) ?: run {
            showInfo()
            return CommandResult.ignored(CommandResult.NO_EPISODE)
        }
        val hint = EpisodeRef(next.id, next.index, episodes.size, next.season, next.number, next.title, next.label, next.durationMs)
        play(PlayableRef.Episode(next.id), origin, startAtMs = null, hint = item, episodeHint = hint)
        return CommandResult.Done
    }

    fun audioTracks(): List<TrackOption> = activeEngine?.audioTracks().orEmpty()

    fun textTracks(): List<TrackOption> = activeEngine?.textTracks().orEmpty()

    /** null = automatic (the server's preferred audio language). */
    fun selectAudio(option: TrackOption?) { activeEngine?.selectAudio(option) }

    /** null = subtitles off. */
    fun selectText(option: TrackOption?) {
        val p = activeEngine ?: return
        p.selectText(option)
        if (option == null) _ui.update { it.copy(cues = null) }
    }

    /**
     * Resolves and starts playback: an episode at [startAtMs] (null: under the resume rules), a channel at its live
     * edge. [sourceId] pins one source (re-resolving an expired URL, or a channel's stream that ended or failed); when
     * that fails the remaining alternatives are tried unpinned.
     */
    private suspend fun resolveAndStart(
        api: ApiClient,
        ref: PlayableRef,
        origin: PlaybackOrigin,
        sourceId: String?,
        startAtMs: Long?,
        playWhenReady: Boolean = true,
    ) {
        // A stopped/finished report still on its way would make `resume` and the cursor stale.
        reporter.awaitDelivered()
        val resolved = try {
            api.resolve(origin.request(ref, sourceId, exclude = attempts.excludeFor(sourceId)))
        } catch (e: Exception) {
            onResolveFailure(e, api, ref, sourceId)
            if (attempts.continueAfterFailedResolve(sourceId)) {
                resolveAndStart(api, ref, origin, sourceId = null, startAtMs, playWhenReady)
            } else {
                showFailed(reason = "then resolve failed: " + Problems.code(if (e is ApiException) e.code else "network"), resolveFailed = true)
            }
            return
        }
        val receivedAt = clock()
        attempts.onResolved(sourceId, resolved.alternatives)
        val live = resolved.item.isLive
        val episode = resolved.episode
        if (!live && episode == null) return showFailed(reason = "then the answer named no episode")
        val media = mediaSpecFor(api, resolved) ?: return showFailed(reason = "then the media address was unusable")
        val resume = resolved.resume
        // A channel: no position, the live edge.
        val start = if (live) null else startAtMs ?: PlaybackPlan.resumePositionMs(resume?.positionMs, resume?.durationMs ?: episode?.durationMs)
        session = Session(api, resolved)
        readyAt = null
        reported = false
        lastPositionMs = start
        _ui.update {
            it.copy(
                item = resolved.item,
                episode = episode,
                posterUrl = api.resolve(resolved.item.posterUrl)?.toString(),
                durationMs = episode?.durationMs,
                positionMs = start ?: 0,
                cues = null,
                live = live,
            )
        }
        activeEngine = engine
        engine.setListener(listener)
        val device = repository.state.value?.device
        engine.applyPreferences(device?.preferredAudioLanguage, device?.subtitlesLanguage)
        engine.load(media, start)
        _player.value = engine.surface
        // Nothing pauses a channel: a re-resolve after its stream broke off plays on.
        engine.playWhenReady = playWhenReady || live
        startHeartbeat()
        watchExpiry(api, resolved, receivedAt)
    }

    /** Rethrows anything but a network failure or an error answer; else reports it (unless the viewer left). */
    private suspend fun onResolveFailure(e: Exception, api: ApiClient, ref: PlayableRef, sourceId: String?) {
        if (e !is ApiException && e !is IOException) throw e
        currentCoroutineContext().ensureActive()
        problems.send(Problems.resolveFailure(e, ref, sourceId, appVersion), api = api)
        if (e is ApiException && e.status == 401) repository.refreshSoon() // the next state fetch notices the removal
    }

    /** The engine's media specification, with server-relative addresses made absolute. */
    private fun mediaSpecFor(api: ApiClient, resolved: ResolveResponse): MediaSpec? {
        val mediaUrl = api.resolve(resolved.media.url) ?: return null
        val subtitles = resolved.subtitleTracks.mapNotNull { track ->
            val url = api.resolve(track.url) ?: return@mapNotNull null
            SubtitleSpec(url.toString(), track.language, track.format, track.label)
        }
        return MediaSpec(
            mediaUrl.toString(), resolved.media.kind, subtitles, resolved.episode?.id ?: resolved.item.id,
            live = resolved.item.isLive,
        )
    }

    /**
     * Re-resolves the playing source shortly before its URL expires (see [ExpiryPlan]), again after each refresh.
     * One loop per resolved session: a new resolve, an episode change, the end or leaving cancels it.
     */
    private fun watchExpiry(api: ApiClient, resolved: ResolveResponse, receivedAt: Long) {
        expiryJob?.cancel()
        val first = expiryDeadline(resolved, receivedAt) ?: return
        expiryJob = scope.launch {
            var deadline = first
            while (true) {
                val now = clock()
                val wait = ExpiryPlan.refreshDelayMs(deadline - now, lastRefreshAt?.let { now - it }) ?: return@launch
                delay(wait)
                deadline = refreshBeforeExpiry(api, deadline) ?: return@launch
            }
        }
    }

    /** When the answer's stream expires, on [clock]; null without (a readable) `expiresAt`. */
    private fun expiryDeadline(resolved: ResolveResponse, receivedAt: Long): Long? =
        ExpiryPlan.validForMs(resolved.expiresAt, resolved.serverDateMs, System.currentTimeMillis())?.let { receivedAt + it }

    /**
     * Resolves the same source again (pinned, no `exclude`) while playing or paused, with one retry 30 s after a
     * network or server failure. Returns the new stream's expiry, or null to stop (the session changed, no expiry, or
     * it failed for good: the 403/410 path takes over when the URL expires).
     */
    private suspend fun refreshBeforeExpiry(api: ApiClient, deadline: Long): Long? {
        var retried = false
        while (true) {
            val s = session ?: return null
            val ref = this.target ?: return null
            if (_ui.value.phase != PlayerPhase.Playing && _ui.value.phase != PlayerPhase.Loading) return null
            val sourceId = s.resolved.sourceId
            lastRefreshAt = clock()
            val resolved = try {
                api.resolve(origin.request(ref, sourceId = sourceId))
            } catch (e: Exception) {
                onResolveFailure(e, api, ref, sourceId)
                if (session !== s) return null
                val retryable = ExpiryPlan.isRetryable((e as? ApiException)?.status)
                val retry = ExpiryPlan.retryDelayMs(retryable, retried, deadline - clock()) ?: return null
                retried = true
                delay(retry)
                continue
            }
            if (session !== s) return null
            val receivedAt = clock()
            adoptRefreshed(api, s, resolved)
            return expiryDeadline(resolved, receivedAt)
        }
    }

    /**
     * Progress goes to the re-resolved session; the media is swapped only when its URL changed, `playWhenReady`
     * untouched: at the current position, or for a channel at the live edge. The last unpinned resolve's fallback order
     * stays.
     */
    private fun adoptRefreshed(api: ApiClient, old: Session, resolved: ResolveResponse) {
        session = Session(api, resolved)
        val p = activeEngine ?: return
        if (resolved.media.url != old.resolved.media.url) {
            mediaSpecFor(api, resolved)?.let { media ->
                val position = if (resolved.item.isLive) null else p.positionMs.coerceAtLeast(0)
                p.load(media, position)
                lastPositionMs = position
                _ui.update { it.copy(cues = null) }
            }
        }
        // A resolve resets the server's "now playing" to the saved position: re-anchor it now (Listen along).
        reportLive(p)
    }

    private val listener = object : MediaEngine.Listener {
        override fun onReady() {
            if (activeEngine == null) return
            if (readyAt == null) {
                readyAt = clock()
                session?.resolved?.item?.let(onPlaybackStarted)
                answerPlayCommand(CommandResult.Done)
            }
            attempts.onPlaying()
            if (_ui.value.phase == PlayerPhase.Loading) _ui.update { it.copy(phase = PlayerPhase.Playing) }
        }

        override fun onEnded() { activeEngine?.let(this@PlaybackController::onEnded) }

        override fun onPlayWhenReadyChanged(playWhenReady: Boolean) {
            activeEngine?.let(::syncFlags)
        }

        // A rebuffer stall, its end, a pause or a resume: the phone's "Listen along" follows this anchor, so report
        // at once (a stall is status "playing" with playing=false).
        override fun onIsPlayingChanged(isPlaying: Boolean) {
            activeEngine?.let(::reportLive)
        }

        override fun onStateChanged() {
            activeEngine?.let(::syncFlags)
        }

        override fun onError(error: MediaError) = this@PlaybackController.onError(error)

        override fun onCues(text: String?) {
            _ui.update { it.copy(cues = text) }
        }
    }

    private fun syncFlags(p: MediaEngine) = _ui.update {
        it.copy(
            playWhenReady = p.playWhenReady,
            buffering = p.buffering,
            // A live stream's duration is its window, nothing to show.
            durationMs = if (it.live) null else p.durationMs ?: it.durationMs,
        )
    }

    private fun onEnded(p: MediaEngine) {
        val s = session ?: return
        if (reported) return
        // A channel never ends: its stream is resolved again at the live edge (or the next source, or the error screen).
        if (s.live) return recover(s, httpStatus = null, positionMs = 0)
        reported = true
        val duration = p.durationMs ?: s.resolved.episode?.durationMs
        report(s, ProgressStatus.Finished, duration ?: p.positionMs, duration, playing = false)
        stopSessionLoops()
        lastPositionMs = 0
        val next = s.resolved.next
        if (next == null) {
            _ui.update { it.copy(phase = PlayerPhase.Finished, showInfo = false, cues = null) }
            launchOverlay {
                delay(PlaybackPlan.FINISHED_MESSAGE_MS)
                exit()
            }
        } else {
            launchOverlay {
                countDown(PlaybackPlan.AUTO_NEXT_COUNTDOWN_SEC) { left ->
                    _ui.update { it.copy(phase = PlayerPhase.UpNext(next, left), showInfo = false, cues = null) }
                }
                play(PlayableRef.Episode(next.episodeId), PlaybackOrigin.Next)
            }
        }
    }

    private fun onError(error: MediaError) {
        val p = activeEngine
        val s = session
        val live = _ui.value.live
        val position = p?.positionMs?.coerceAtLeast(0) ?: lastPositionMs ?: 0
        val httpStatus = error.httpStatus
        problems.send(
            Problems.playbackError(
                error.cause, error.codeName, httpStatus, target, s?.resolved?.sourceId, s?.resolved?.sessionId,
                position.takeIf { !live }, appVersion,
            ),
            api = s?.api,
        )
        if (s == null || target == null) return showFailed()
        recover(s, httpStatus, position)
    }

    /**
     * The playing source failed (a channel: or its stream ended or fell behind the live window): the same source
     * again, the next alternative or "Can't play right now" ([SourceAttempts.afterPlaybackError]). An episode goes on
     * at [positionMs]; a channel restarts at its live edge.
     */
    private fun recover(s: Session, httpStatus: Int?, positionMs: Long) {
        val ref = target ?: return showFailed()
        val start = if (s.live) null else positionMs
        lastPositionMs = start
        val played = readyAt?.let { clock() - it } ?: 0
        val sourceId = s.resolved.sourceId
        when (attempts.afterPlaybackError(sourceId, httpStatus, played)) {
            PlaybackPlan.Recovery.RetrySameSource -> relaunch(s.api, ref, sourceId, start)
            PlaybackPlan.Recovery.NextSource -> relaunch(s.api, ref, sourceId = null, start)
            PlaybackPlan.Recovery.GiveUp -> {
                if (readyAt != null) report(s, ProgressStatus.Stopped, positionMs, activeEngine?.durationMs, playing = false)
                reported = true
                showFailed()
            }
        }
    }

    /**
     * Re-resolves silently (the last frame or the spinner stays) and goes on at [positionMs], paused if it was; a
     * channel (no position) starts again at its live edge.
     */
    private fun relaunch(api: ApiClient, ref: PlayableRef, sourceId: String?, positionMs: Long?) {
        val playWhenReady = activeEngine?.playWhenReady ?: true
        resolveJob?.cancel()
        expiryJob?.cancel()
        resolveJob = scope.launch { resolveAndStart(api, ref, origin, sourceId, positionMs, playWhenReady) }
    }

    /**
     * "Can't play right now". [reason] completes the problem report's "tried N sources"; [resolveFailed]: no resolve
     * found anything to play (else the player failed, or the media address was unusable).
     */
    private fun showFailed(reason: String? = null, resolveFailed: Boolean = false) {
        answerPlayCommand(CommandResult.failed(if (resolveFailed) CommandResult.NO_PLAYABLE_SOURCE else CommandResult.PLAYBACK_ERROR))
        stopSessionLoops()
        activeEngine?.stop()
        target?.let { ref ->
            problems.send(Problems.gaveUp(ref, session?.resolved?.sourceId ?: attempts.lastTried, lastPositionMs, attempts.triedCount, appVersion, reason))
        }
        val seconds = PlaybackPlan.FAILED_AUTO_HOME_SEC
        _ui.update { it.copy(phase = PlayerPhase.Failed(seconds), showInfo = false, buffering = false, cues = null) }
        launchOverlay {
            countDown(seconds) { left -> _ui.update { it.copy(phase = PlayerPhase.Failed(left)) } }
            exit()
        }
    }

    /** The information for a few seconds (as after a key press); at the first or last channel or episode, only this. */
    fun showInfo() {
        _ui.update { it.copy(showInfo = true, positionMs = activeEngine?.positionMs ?: it.positionMs) }
        infoJob?.cancel()
        infoJob = scope.launch {
            var shownFor = 0L
            while (isActive) {
                delay(250)
                shownFor += 250
                val hide = shownFor >= PlaybackPlan.INFO_OVERLAY_MS && seek.pendingTargetMs == null
                _ui.update { it.copy(positionMs = activeEngine?.positionMs ?: it.positionMs, showInfo = !hide) }
                if (hide) break
            }
        }
    }

    private fun startHeartbeat() {
        heartbeatJob?.cancel()
        heartbeatJob = scope.launch {
            while (isActive) {
                delay(PlaybackPlan.HEARTBEAT_INTERVAL_MS)
                if (activeEngine?.isPlaying == true) reportCurrent(ProgressStatus.Playing)
            }
        }
    }

    /** Reports the position with the status the viewer wants: playing, or paused (a channel: always playing). */
    private fun reportLive(p: MediaEngine) = reportCurrent(PlaybackPlan.liveStatus(p.playWhenReady, channel = _ui.value.live))

    private fun reportCurrent(status: ProgressStatus) {
        val s = session ?: return
        val p = activeEngine ?: return
        if (reported || readyAt == null) return
        if (!s.live) lastPositionMs = p.positionMs
        report(s, status, p.positionMs, p.durationMs ?: _ui.value.durationMs, playing = p.isPlaying)
    }

    /**
     * Reports where the viewer left the current episode (stopped, or finished within the end threshold), or that the
     * channel was left (stopped).
     */
    private fun endSession() {
        val s = session
        val p = activeEngine
        if (s != null && p != null && !reported && readyAt != null) {
            val position = p.positionMs
            val duration = p.durationMs ?: s.resolved.episode?.durationMs
            val status = if (s.live) ProgressStatus.Stopped else PlaybackPlan.stopStatus(position, duration)
            report(s, status, position, duration, playing = false)
        }
        reported = true
        session = null
        stopSessionLoops()
        seek.cancel()
    }

    /** Sends the waiting `play` command's [result], if any; a command gets one result. */
    private fun answerPlayCommand(result: CommandResult) {
        val command = playCommand ?: return
        playCommand = null
        commandResults.report(command.api, command.id, result)
    }

    /** An episode's report carries [positionMs] and [durationMs]; a channel's only its item and [status]. */
    private fun report(s: Session, status: ProgressStatus, positionMs: Long, durationMs: Long?, playing: Boolean) {
        val episode = s.resolved.episode
        if (s.live || episode == null) {
            reporter.reportChannel(s.api, s.resolved.sessionId, s.resolved.item.id, status, playing)
        } else {
            reporter.report(s.api, s.resolved.sessionId, episode.id, status, positionMs, durationMs, playing)
        }
    }

    /** Up next's countdown, "The end"'s pause or the error screen's countdown, replacing the one before. */
    private fun launchOverlay(block: suspend CoroutineScope.() -> Unit) {
        overlayJob?.cancel()
        overlayJob = scope.launch(block = block)
    }

    /** The heartbeat and the refresh before the stream expires belong to one resolved session. */
    private fun stopSessionLoops() {
        heartbeatJob?.cancel()
        expiryJob?.cancel()
    }

    private fun cancelOverlays() {
        overlayJob?.cancel()
        infoJob?.cancel()
    }
}
