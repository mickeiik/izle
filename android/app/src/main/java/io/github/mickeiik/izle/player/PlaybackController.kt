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
import io.github.mickeiik.izle.data.api.ProgressReport
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

    /** "Can't play right now", then Home on its own after [secondsLeft]. */
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
    /** A channel (decided by the item's kind, never by the stream's format): its name and "Live", no pause. */
    val live: Boolean = false,
)

/**
 * Plays one episode or channel at a time: resolve → play → heartbeat → auto-next, with source fallback, a refresh of
 * expiring stream URLs and CH+/CH− episode steps. A channel is never paused, sought or finished: when its stream ends
 * or fails it is resolved again at the live edge before the source fallback (docs/ux/senior-tv.md, "Live channels").
 * Main thread; progress reports go through one ordered queue in [reportScope], which outlives the screen.
 */
class PlaybackController(
    private val engine: MediaEngine,
    private val scope: CoroutineScope,
    reportScope: CoroutineScope,
    private val repository: ServerRepository,
    private val problems: ProblemReporter,
    private val commandResults: CommandResultReporter,
    private val appVersion: String,
    private val onExit: () -> Unit,
    private val onPlaybackStarted: (ItemCard) -> Unit,
    private val clock: () -> Long = SystemClock::elapsedRealtime,
) {
    private val _ui = MutableStateFlow(PlayerUi())
    val ui: StateFlow<PlayerUi> = _ui.asStateFlow()

    private val _player = MutableStateFlow<Player?>(null)
    val player: StateFlow<Player?> = _player.asStateFlow()

    /** Loaded for this visit, whether or not the engine has a renderable surface. */
    private var activeEngine: MediaEngine? = null

    private class Session(val api: ApiClient, val resolved: ResolveResponse) {
        val live: Boolean get() = resolved.item.isLive
    }

    private class PendingCommand(val api: ApiClient, val id: Long)

    private var session: Session? = null
    private var target: PlayableRef? = null

    /** Goes with every resolve made for this playback (fallback, expiry refresh, Try again). */
    private var origin = PlaybackOrigin.Viewer

    /** The owner's `play` command this playback answers once it runs or fails. */
    private var playCommand: PendingCommand? = null
    private val attempts = SourceAttempts()
    private var readyAt: Long? = null
    private var reported = false

    /** Where Try again restarts; null = under the resume rules (a channel: always). */
    private var lastPositionMs: Long? = null
    private val seek = SeekAccumulator()

    private var resolveJob: Job? = null
    private var overlayJob: Job? = null
    private var heartbeatJob: Job? = null
    private var infoJob: Job? = null
    private var expiryJob: Job? = null
    private var stepJob: Job? = null

    /** For the 60 s spacing of refreshes ahead of the expiry. */
    private var lastRefreshAt: Long? = null

    /** CH+/CH−: the items' episode lists, kept for this player visit. */
    private val episodeLists = mutableMapOf<String, List<EpisodeDetails>>()

    private val reporter = ProgressReporter(reportScope, { api, report -> api.progress(report) }, repository::refreshSoon, clock)

    val inUse: Boolean get() = _ui.value.phase != PlayerPhase.Idle

    /** The channel CH+/CH− zap from: loading, playing or on its error screen (a dead channel is left by zapping). */
    val zappableChannelId: String?
        get() = (target as? PlayableRef.Channel)?.itemId?.takeIf {
            _ui.value.phase.let { it == PlayerPhase.Playing || it == PlayerPhase.Loading || it is PlayerPhase.Failed }
        }

    /**
     * Plays [ref]: an episode from [startAtMs] (null: under the resume rules), a channel at its live edge. [hint] and
     * [episodeHint] show while resolving. With [playCommand], [origin]'s command gets this playback's result: `done`
     * at its first frame, `failed` on "Can't play right now", `ignored` when left or replaced first.
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

    /** Reports where the viewer stopped, releases the decoder, goes Home. */
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
        activeEngine?.setListener(null)
        activeEngine?.release()
        activeEngine = null
        _player.value = null
        target = null
        episodeLists.clear()
        _ui.value = PlayerUi()
    }

    /** Try again, with the same origin (a `play` command's result was already sent). */
    fun retry() {
        val ref = target ?: return exit()
        play(ref, origin, startAtMs = lastPositionMs)
    }

    fun playNextNow() {
        val phase = _ui.value.phase as? PlayerPhase.UpNext ?: return
        play(PlayableRef.Episode(phase.next.episodeId), PlaybackOrigin.Next)
    }

    /** OK while an episode plays (a channel has [showChannelInfo]). */
    fun togglePause() {
        val p = activeEngine ?: return
        if (_ui.value.phase == PlayerPhase.Playing) setPlaying(!p.playWhenReady)
    }

    fun pause() = setPlaying(false)

    /** On a channel only a pause the system made (lost audio focus) has anything to undo. */
    fun resume() = setPlaying(true)

    /** OK on a channel: the information, and the picture goes on if the system paused it. */
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

    /** The hidden menu's Start over, never over a channel. */
    fun startOver() {
        val p = activeEngine ?: return
        if (_ui.value.live) return
        seek.cancel()
        p.seekTo(0)
        p.play()
        reportCurrent(ProgressStatus.Playing)
        showInfo()
    }

    /** The engine while an episode (never a channel) plays and can be sought. */
    private fun seekable(): MediaEngine? = activeEngine?.takeIf { _ui.value.phase == PlayerPhase.Playing && !_ui.value.live }

    /** Left/Right DOWN (first press or key repeat). */
    fun onSeekKeyDown(direction: Int, eventTimeMs: Long, downTimeMs: Long, repeatCount: Int) {
        val p = seekable() ?: return
        val preview = seek.onKeyDown(direction, eventTimeMs, downTimeMs, repeatCount, p.positionMs, p.durationMs) ?: return
        _ui.update { it.copy(seekPreviewMs = preview) }
        showInfo()
    }

    fun onSeekKeyUp() {
        val p = activeEngine ?: return
        seekNow(p, seek.commit() ?: return)
    }

    /** The owner's seek command, shown like a key press. */
    fun seekRemote(command: RemoteCommand.Seek) {
        val p = seekable() ?: return
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
     * CH+/CH− (also |◀◀ ▶▶| and the owner's next/previous): ends the episode as Back does and plays the nearest playable
     * one after ([direction] > 0) or before it, as [origin]; at either end only the info overlay appears. Presses while
     * the episode list is being fetched are ignored. [onResult] gets, maybe later, `done` or why not.
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
        activeEngine?.selectText(option) ?: return
        if (option == null) _ui.update { it.copy(cues = null) }
    }

    /**
     * [sourceId] pins one source (an expired URL, or a channel's stream that broke off); when that fails the remaining
     * alternatives are tried unpinned.
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

    /** With server-relative addresses made absolute. */
    private fun mediaSpecFor(api: ApiClient, resolved: ResolveResponse): MediaSpec? {
        val mediaUrl = api.resolve(resolved.media.url) ?: return null
        val subtitles = resolved.subtitleTracks.mapNotNull { track ->
            api.resolve(track.url)?.let { SubtitleSpec(it.toString(), track.language, track.format, track.label) }
        }
        val mediaId = resolved.episode?.id ?: resolved.item.id
        return MediaSpec(mediaUrl.toString(), resolved.media.kind, subtitles, mediaId, live = resolved.item.isLive)
    }

    /** Re-resolves the playing source shortly before its URL expires (see [ExpiryPlan]); one loop per session. */
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

    private fun expiryDeadline(resolved: ResolveResponse, receivedAt: Long): Long? =
        ExpiryPlan.validForMs(resolved.expiresAt, resolved.serverDateMs, System.currentTimeMillis())?.let { receivedAt + it }

    /**
     * Resolves the same source again (pinned) while playing or paused, with one retry after a network or server
     * failure. Returns the new expiry, or null to stop: the 403/410 path takes over when the URL expires.
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
     * untouched. The last unpinned resolve's fallback order stays.
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

        // A stall, its end, a pause or a resume: "Listen along" follows this anchor (a stall is "playing", playing=false).
        override fun onIsPlayingChanged(isPlaying: Boolean) { activeEngine?.let(::reportLive) }

        override fun onStateChanged() { activeEngine?.let(::syncFlags) }

        override fun onError(error: MediaError) = this@PlaybackController.onError(error)

        override fun onCues(text: String?) = _ui.update { it.copy(cues = text) }
    }

    private fun syncFlags(p: MediaEngine) = _ui.update {
        // A live stream's duration is its window, nothing to show.
        it.copy(playWhenReady = p.playWhenReady, buffering = p.buffering, durationMs = if (it.live) null else p.durationMs ?: it.durationMs)
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
        val s = session
        val position = activeEngine?.positionMs?.coerceAtLeast(0) ?: lastPositionMs ?: 0
        val problem = Problems.playbackError(
            error.cause, error.codeName, error.httpStatus, target, s?.resolved?.sourceId, s?.resolved?.sessionId,
            position.takeIf { !_ui.value.live }, appVersion,
        )
        problems.send(problem, api = s?.api)
        if (s == null || target == null) return showFailed()
        recover(s, error.httpStatus, position)
    }

    /**
     * The playing source failed (a channel: or its stream ended): the same source again, the next alternative or "Can't
     * play right now" ([SourceAttempts.afterPlaybackError]). An episode goes on at [positionMs], a channel at its live edge.
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

    /** Re-resolves silently (the last frame or the spinner stays), paused if it was. */
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

    /** The information for a few seconds (as after a key press). */
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

    /** Reports where the viewer left the episode (stopped, or finished within the end threshold), or the channel. */
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

    /** A command gets one result. */
    private fun answerPlayCommand(result: CommandResult) {
        val command = playCommand ?: return
        playCommand = null
        commandResults.report(command.api, command.id, result)
    }

    private fun report(s: Session, status: ProgressStatus, positionMs: Long, durationMs: Long?, playing: Boolean) {
        val episode = s.resolved.episode
        val report = if (s.live || episode == null) {
            ProgressReport.channel(s.resolved.sessionId, s.resolved.item.id, status, playing)
        } else {
            ProgressReport.episode(s.resolved.sessionId, episode.id, status, positionMs, durationMs, playing)
        }
        reporter.enqueue(s.api, report)
    }

    /** Up next's countdown, "The end"'s pause or the error screen's countdown, replacing the one before. */
    private fun launchOverlay(block: suspend CoroutineScope.() -> Unit) {
        overlayJob?.cancel()
        overlayJob = scope.launch(block = block)
    }

    private fun stopSessionLoops() {
        heartbeatJob?.cancel()
        expiryJob?.cancel()
    }

    private fun cancelOverlays() {
        overlayJob?.cancel()
        infoJob?.cancel()
    }
}
