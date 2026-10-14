package io.github.mickeiik.izle.player

import android.content.Context
import android.net.Uri
import android.os.SystemClock
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.text.CueGroup
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import io.github.mickeiik.izle.data.ProblemReporter
import io.github.mickeiik.izle.data.ServerRepository
import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.data.api.ApiException
import io.github.mickeiik.izle.data.api.EpisodeDetails
import io.github.mickeiik.izle.data.api.EpisodeRef
import io.github.mickeiik.izle.data.api.ItemCard
import io.github.mickeiik.izle.data.api.NextEpisode
import io.github.mickeiik.izle.data.api.ProgressStatus
import io.github.mickeiik.izle.data.api.ResolveRequest
import io.github.mickeiik.izle.data.api.ResolveResponse
import io.github.mickeiik.izle.data.api.orNullOnFailure
import io.github.mickeiik.izle.domain.EpisodeSteps
import io.github.mickeiik.izle.domain.ExpiryPlan
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
import okhttp3.OkHttpClient
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
)

/** An audio or text track of the current media, for the hidden menu. */
data class TrackOption(val groupIndex: Int, val trackIndex: Int, val language: String?, val label: String?, val selected: Boolean)

/**
 * Plays one episode at a time: resolve → play → heartbeat → auto-next, with source fallback on errors, a refresh of
 * expiring stream URLs and CH+/CH− episode steps. All methods run on the main thread. Progress reports go through one
 * ordered queue in [reportScope], which outlives the screen.
 */
@OptIn(UnstableApi::class)
class PlaybackController(
    private val context: Context,
    private val scope: CoroutineScope,
    reportScope: CoroutineScope,
    private val mediaHttp: OkHttpClient,
    private val repository: ServerRepository,
    private val problems: ProblemReporter,
    private val userAgent: String,
    private val appVersion: String,
    private val capVideoTo720p: Boolean,
    private val onExit: () -> Unit,
    /** A playback reached its first frame. */
    private val onPlaybackStarted: (ItemCard) -> Unit,
) {
    private val _ui = MutableStateFlow(PlayerUi())
    val ui: StateFlow<PlayerUi> = _ui.asStateFlow()

    private val _player = MutableStateFlow<ExoPlayer?>(null)
    val player: StateFlow<ExoPlayer?> = _player.asStateFlow()

    private class Session(val api: ApiClient, val resolved: ResolveResponse)

    private var session: Session? = null
    private var episodeId: String? = null
    private val attempts = SourceAttempts()
    private var readyAt: Long? = null
    private var reported = false

    /** Where Try again restarts; null = from the server's saved position under the resume rules. */
    private var lastPositionMs: Long? = null
    private val seek = SeekAccumulator()

    private var resolveJob: Job? = null
    private var overlayJob: Job? = null
    private var heartbeatJob: Job? = null
    private var infoJob: Job? = null
    private var expiryJob: Job? = null
    private var stepJob: Job? = null

    /** When this playback last re-resolved its stream ahead of the expiry (elapsedRealtime), for the 60 s spacing. */
    private var lastRefreshAt: Long? = null

    /** CH+/CH−: the items' episode lists, fetched on first use and kept for this player visit. */
    private val episodeLists = mutableMapOf<String, List<EpisodeDetails>>()

    private val reporter = ProgressReporter(
        reportScope,
        send = { api, report -> api.progress(report) },
        onFinalDelivered = repository::refreshSoon,
        clock = SystemClock::elapsedRealtime,
    )

    /** A player visit is on (loading, playing or one of its end screens). */
    val inUse: Boolean get() = _ui.value.phase != PlayerPhase.Idle

    /**
     * Plays [episodeId] from [startAtMs], or from the server's saved position under the resume rules when null.
     * [hint] (the home tile's item) and [episodeHint] are shown while the stream is being resolved.
     */
    fun play(episodeId: String, startAtMs: Long? = null, hint: ItemCard? = null, episodeHint: EpisodeRef? = null) {
        val api = repository.api
        resolveJob?.cancel()
        endSession()
        cancelOverlays()
        _player.value?.stop()
        this.episodeId = episodeId
        attempts.reset()
        lastRefreshAt = null
        lastPositionMs = startAtMs
        val keep = _ui.value
        _ui.value = PlayerUi(
            phase = PlayerPhase.Loading,
            item = hint ?: keep.item?.takeIf { keep.phase != PlayerPhase.Idle },
            episode = episodeHint,
            posterUrl = hint?.posterUrl?.let { api?.resolve(it)?.toString() } ?: keep.posterUrl,
            playWhenReady = true,
        )
        if (api == null) return showFailed()
        resolveJob = scope.launch { resolveAndStart(api, episodeId, sourceId = null, startAtMs = startAtMs) }
    }

    /** Leaves the player: reports where the viewer stopped, releases the decoder, goes Home. */
    fun exit() {
        stop()
        onExit()
    }

    /** Like [exit] without navigating (the app went to the background). */
    fun stop() {
        resolveJob?.cancel()
        stepJob?.cancel()
        cancelOverlays()
        endSession()
        _player.value?.let {
            it.removeListener(listener)
            it.release()
        }
        _player.value = null
        episodeId = null
        episodeLists.clear()
        _ui.value = PlayerUi()
    }

    fun retry() {
        val id = episodeId ?: return exit()
        play(id, startAtMs = lastPositionMs)
    }

    fun playNextNow() {
        val phase = _ui.value.phase as? PlayerPhase.UpNext ?: return
        play(phase.next.episodeId)
    }

    fun togglePause() {
        val p = _player.value ?: return
        if (_ui.value.phase == PlayerPhase.Playing) setPlaying(!p.playWhenReady)
    }

    fun pause() = setPlaying(false)

    fun resume() = setPlaying(true)

    private fun setPlaying(play: Boolean) {
        val p = _player.value ?: return
        if (p.playWhenReady == play) return
        if (play) p.play() else p.pause()
        reportCurrent(PlaybackPlan.liveStatus(play))
        showInfo()
    }

    fun startOver() {
        val p = _player.value ?: return
        seek.cancel()
        p.seekTo(0)
        p.play()
        reportCurrent(ProgressStatus.Playing)
        showInfo()
    }

    /** Left/Right DOWN (first press or key repeat). */
    fun onSeekKeyDown(direction: Int, eventTimeMs: Long, downTimeMs: Long, repeatCount: Int) {
        val p = _player.value ?: return
        if (_ui.value.phase != PlayerPhase.Playing) return
        val target = seek.onKeyDown(direction, eventTimeMs, downTimeMs, repeatCount, p.currentPosition, durationOf(p)) ?: return
        _ui.update { it.copy(seekPreviewMs = target) }
        showInfo()
    }

    fun onSeekKeyUp() {
        val p = _player.value ?: return
        seekNow(p, seek.commit() ?: return)
    }

    /** The owner's seek command, shown like a key press. */
    fun seekRemote(command: RemoteCommand.Seek) {
        val p = _player.value ?: return
        if (_ui.value.phase != PlayerPhase.Playing) return
        seek.cancel()
        seekNow(p, command.targetMs(p.currentPosition.coerceAtLeast(0), durationOf(p) ?: _ui.value.durationMs))
    }

    private fun seekNow(p: ExoPlayer, target: Long) {
        p.seekTo(target)
        _ui.update { it.copy(seekPreviewMs = null, positionMs = target) }
        reportLive(p)
        showInfo()
    }

    /**
     * CH+/CH− (also |◀◀ ▶▶| and the owner's next/previous): ends the episode as Back does and plays the nearest
     * playable one after ([direction] > 0) or before it, under the normal resume rules. At either end only the info
     * overlay appears. Presses while the episode list is being fetched are ignored.
     */
    fun stepEpisode(direction: Int) {
        if (_ui.value.phase != PlayerPhase.Playing || stepJob?.isActive == true) return
        val s = session ?: return
        val current = episodeId ?: return
        val item = s.resolved.item
        val ref = s.resolved.episode
        if (!EpisodeSteps.mayHaveNeighbour(ref.index, ref.count, direction)) return showInfo()
        episodeLists[item.id]?.let { return stepTo(it, current, direction, item) }
        stepJob = scope.launch {
            val episodes = orNullOnFailure { s.api.item(item.id).episodes }
            if (episodes != null) episodeLists[item.id] = episodes
            // Auto-next, Back or a command may have changed things meanwhile.
            if (episodeId != current || _ui.value.phase != PlayerPhase.Playing) return@launch
            if (episodes == null) showInfo() else stepTo(episodes, current, direction, item)
        }
    }

    private fun stepTo(episodes: List<EpisodeDetails>, current: String, direction: Int, item: ItemCard) {
        val target = EpisodeSteps.neighbour(episodes, current, direction) ?: return showInfo()
        val hint = EpisodeRef(target.id, target.index, episodes.size, target.season, target.number, target.title, target.label, target.durationMs)
        play(target.id, startAtMs = null, hint = item, episodeHint = hint)
    }

    fun audioTracks(): List<TrackOption> = tracksOf(C.TRACK_TYPE_AUDIO)

    fun textTracks(): List<TrackOption> = tracksOf(C.TRACK_TYPE_TEXT)

    /** null = automatic (the server's preferred audio language). */
    fun selectAudio(option: TrackOption?) = selectTrack(C.TRACK_TYPE_AUDIO, option)

    /** null = subtitles off. */
    fun selectText(option: TrackOption?) = selectTrack(C.TRACK_TYPE_TEXT, option)

    private fun selectTrack(type: Int, option: TrackOption?) {
        val p = _player.value ?: return
        val builder = p.trackSelectionParameters.buildUpon().clearOverridesOfType(type)
        if (option != null) {
            val group = p.currentTracks.groups.getOrNull(option.groupIndex) ?: return
            builder.setOverrideForType(TrackSelectionOverride(group.mediaTrackGroup, option.trackIndex))
        }
        if (type == C.TRACK_TYPE_TEXT) builder.setTrackTypeDisabled(type, option == null)
        p.trackSelectionParameters = builder.build()
        if (type == C.TRACK_TYPE_TEXT && option == null) _ui.update { it.copy(cues = null) }
    }

    private fun tracksOf(type: Int): List<TrackOption> {
        val p = _player.value ?: return emptyList()
        val textDisabled = type == C.TRACK_TYPE_TEXT && type in p.trackSelectionParameters.disabledTrackTypes
        return p.currentTracks.groups.withIndex().filter { it.value.type == type }.flatMap { (g, group) ->
            (0 until group.length).filter { group.isTrackSupported(it) }.map { t ->
                val format = group.getTrackFormat(t)
                TrackOption(g, t, format.language, format.label, selected = !textDisabled && group.isTrackSelected(t))
            }
        }.distinctBy { it.language to it.label } // adaptive audio renditions repeat the same language
    }

    /**
     * Resolves and starts playback. [sourceId] pins one source (re-resolving an expired URL); when that fails the
     * remaining alternatives are tried unpinned.
     */
    private suspend fun resolveAndStart(
        api: ApiClient,
        episodeId: String,
        sourceId: String?,
        startAtMs: Long?,
        playWhenReady: Boolean = true,
    ) {
        // A stopped/finished report still on its way would make `resume` and the cursor stale.
        reporter.awaitDelivered()
        val resolved = try {
            api.resolve(ResolveRequest(episodeId, sourceId, exclude = attempts.excludeFor(sourceId)))
        } catch (e: Exception) {
            onResolveFailure(e, api, episodeId, sourceId)
            if (attempts.continueAfterFailedResolve(sourceId)) {
                resolveAndStart(api, episodeId, sourceId = null, startAtMs, playWhenReady)
            } else {
                showFailed(reason = "then resolve failed: " + Problems.code(if (e is ApiException) e.code else "network"))
            }
            return
        }
        val receivedAt = SystemClock.elapsedRealtime()
        attempts.onResolved(sourceId, resolved.alternatives)
        val item = mediaItemFor(api, resolved) ?: return showFailed(reason = "then the media address was unusable")
        val resume = resolved.resume
        val start = startAtMs
            ?: PlaybackPlan.resumePositionMs(resume?.positionMs, resume?.durationMs ?: resolved.episode.durationMs)
        session = Session(api, resolved)
        readyAt = null
        reported = false
        lastPositionMs = start
        _ui.update {
            it.copy(
                item = resolved.item,
                episode = resolved.episode,
                posterUrl = api.resolve(resolved.item.posterUrl)?.toString(),
                durationMs = resolved.episode.durationMs,
                positionMs = start,
                cues = null,
            )
        }
        val p = ensurePlayer()
        applyTrackPreferences(p)
        p.setMediaItem(item, start)
        p.prepare()
        p.playWhenReady = playWhenReady
        startHeartbeat()
        watchExpiry(api, resolved, receivedAt)
    }

    /** Rethrows anything but a network failure or an error answer; else reports it (unless the viewer left). */
    private suspend fun onResolveFailure(e: Exception, api: ApiClient, episodeId: String, sourceId: String?) {
        if (e !is ApiException && e !is IOException) throw e
        currentCoroutineContext().ensureActive()
        problems.send(Problems.resolveFailure(e, episodeId, sourceId, appVersion), api = api)
        if (e is ApiException && e.status == 401) repository.refreshSoon() // the next state fetch notices the removal
    }

    /** The media item for a resolve answer (server-relative URLs made absolute), or null when its URL is unusable. */
    private fun mediaItemFor(api: ApiClient, resolved: ResolveResponse): MediaItem? {
        val mediaUrl = api.resolve(resolved.media.url) ?: return null
        val subtitles = resolved.subtitleTracks.mapNotNull { track ->
            val url = api.resolve(track.url) ?: return@mapNotNull null
            MediaItem.SubtitleConfiguration.Builder(Uri.parse(url.toString()))
                .setMimeType(subtitleMimeType(track.format))
                .setLanguage(track.language)
                .setLabel(track.label)
                .build()
        }
        return MediaItem.Builder()
            .setUri(Uri.parse(mediaUrl.toString()))
            .setMimeType(mediaMimeType(resolved.media.kind))
            .setSubtitleConfigurations(subtitles)
            .setMediaId(resolved.episode.id)
            .build()
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
                val now = SystemClock.elapsedRealtime()
                val wait = ExpiryPlan.refreshDelayMs(deadline - now, lastRefreshAt?.let { now - it }) ?: return@launch
                delay(wait)
                deadline = refreshBeforeExpiry(api, deadline) ?: return@launch
            }
        }
    }

    /** When the answer's stream expires, on the elapsedRealtime clock; null without (a readable) `expiresAt`. */
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
            val episodeId = this.episodeId ?: return null
            if (_ui.value.phase != PlayerPhase.Playing && _ui.value.phase != PlayerPhase.Loading) return null
            val sourceId = s.resolved.sourceId
            lastRefreshAt = SystemClock.elapsedRealtime()
            val resolved = try {
                api.resolve(ResolveRequest(episodeId, sourceId = sourceId))
            } catch (e: Exception) {
                onResolveFailure(e, api, episodeId, sourceId)
                if (session !== s) return null
                val retryable = ExpiryPlan.isRetryable((e as? ApiException)?.status)
                val retry = ExpiryPlan.retryDelayMs(retryable, retried, deadline - SystemClock.elapsedRealtime()) ?: return null
                retried = true
                delay(retry)
                continue
            }
            if (session !== s) return null
            val receivedAt = SystemClock.elapsedRealtime()
            adoptRefreshed(api, s, resolved)
            return expiryDeadline(resolved, receivedAt)
        }
    }

    /**
     * Progress goes to the re-resolved session; the media is swapped at the current position only when its URL
     * changed, `playWhenReady` untouched. The last unpinned resolve's fallback order stays.
     */
    private fun adoptRefreshed(api: ApiClient, old: Session, resolved: ResolveResponse) {
        session = Session(api, resolved)
        val p = _player.value ?: return
        if (resolved.media.url != old.resolved.media.url) {
            mediaItemFor(api, resolved)?.let { item ->
                val position = p.currentPosition.coerceAtLeast(0)
                p.setMediaItem(item, position)
                p.prepare()
                lastPositionMs = position
                _ui.update { it.copy(cues = null) }
            }
        }
        // A resolve resets the server's "now playing" to the saved position: re-anchor it now (Listen along).
        reportLive(p)
    }

    private val listener = object : Player.Listener {
        override fun onPlaybackStateChanged(playbackState: Int) {
            val p = _player.value ?: return
            when (playbackState) {
                Player.STATE_READY -> {
                    if (readyAt == null) {
                        readyAt = SystemClock.elapsedRealtime()
                        session?.resolved?.item?.let(onPlaybackStarted)
                    }
                    attempts.onPlaying()
                    if (_ui.value.phase == PlayerPhase.Loading) _ui.update { it.copy(phase = PlayerPhase.Playing) }
                }
                Player.STATE_ENDED -> onEnded(p)
            }
            syncFlags(p)
        }

        override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
            _player.value?.let(::syncFlags)
        }

        // A rebuffer stall, its end, a pause or a resume: the phone's "Listen along" follows this anchor, so report
        // at once (a stall is status "playing" with playing=false).
        override fun onIsPlayingChanged(isPlaying: Boolean) {
            _player.value?.let(::reportLive)
        }

        override fun onPlayerError(error: PlaybackException) = onError(error)

        override fun onCues(cueGroup: CueGroup) {
            val text = cueGroup.cues.mapNotNull { it.text?.toString()?.trim() }.filter { it.isNotEmpty() }.joinToString("\n")
            _ui.update { it.copy(cues = text.ifEmpty { null }) }
        }
    }

    private fun syncFlags(p: ExoPlayer) = _ui.update {
        it.copy(
            playWhenReady = p.playWhenReady,
            buffering = p.playbackState == Player.STATE_BUFFERING,
            durationMs = durationOf(p) ?: it.durationMs,
        )
    }

    private fun onEnded(p: ExoPlayer) {
        val s = session ?: return
        if (reported) return
        reported = true
        val duration = durationOf(p) ?: s.resolved.episode.durationMs
        report(s, ProgressStatus.Finished, duration ?: p.currentPosition, duration, playing = false)
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
                play(next.episodeId)
            }
        }
    }

    private fun onError(error: PlaybackException) {
        val p = _player.value
        val s = session
        val position = p?.currentPosition?.coerceAtLeast(0) ?: lastPositionMs ?: 0
        val httpStatus = error.httpStatus()
        problems.send(
            Problems.playbackError(
                error, error.errorCodeName, httpStatus, episodeId, s?.resolved?.sourceId, s?.resolved?.sessionId,
                position, appVersion,
            ),
            api = s?.api,
        )
        val episodeId = this.episodeId
        if (s == null || episodeId == null) return showFailed()
        lastPositionMs = position
        val played = readyAt?.let { SystemClock.elapsedRealtime() - it } ?: 0
        val sourceId = s.resolved.sourceId
        when (attempts.afterPlaybackError(sourceId, httpStatus, played)) {
            PlaybackPlan.Recovery.RetrySameSource -> relaunch(s.api, episodeId, sourceId, position)
            PlaybackPlan.Recovery.NextSource -> relaunch(s.api, episodeId, sourceId = null, position)
            PlaybackPlan.Recovery.GiveUp -> {
                if (readyAt != null) report(s, ProgressStatus.Stopped, position, p?.let(::durationOf), playing = false)
                reported = true
                showFailed()
            }
        }
    }

    /** Re-resolves silently (the last frame or the spinner stays) and goes on at [positionMs], paused if it was. */
    private fun relaunch(api: ApiClient, episodeId: String, sourceId: String?, positionMs: Long) {
        val playWhenReady = _player.value?.playWhenReady ?: true
        resolveJob?.cancel()
        expiryJob?.cancel()
        resolveJob = scope.launch { resolveAndStart(api, episodeId, sourceId, positionMs, playWhenReady) }
    }

    /** "Can't play right now". [reason] completes the problem report's "tried N sources". */
    private fun showFailed(reason: String? = null) {
        stopSessionLoops()
        _player.value?.stop()
        episodeId?.let { id ->
            problems.send(Problems.gaveUp(id, session?.resolved?.sourceId ?: attempts.lastTried, lastPositionMs, attempts.triedCount, appVersion, reason))
        }
        val seconds = PlaybackPlan.FAILED_AUTO_HOME_SEC
        _ui.update { it.copy(phase = PlayerPhase.Failed(seconds), showInfo = false, buffering = false, cues = null) }
        launchOverlay {
            countDown(seconds) { left -> _ui.update { it.copy(phase = PlayerPhase.Failed(left)) } }
            exit()
        }
    }

    private fun showInfo() {
        _ui.update { it.copy(showInfo = true, positionMs = _player.value?.currentPosition ?: it.positionMs) }
        infoJob?.cancel()
        infoJob = scope.launch {
            var shownFor = 0L
            while (isActive) {
                delay(250)
                shownFor += 250
                val hide = shownFor >= PlaybackPlan.INFO_OVERLAY_MS && seek.pendingTargetMs == null
                _ui.update { it.copy(positionMs = _player.value?.currentPosition ?: it.positionMs, showInfo = !hide) }
                if (hide) break
            }
        }
    }

    private fun startHeartbeat() {
        heartbeatJob?.cancel()
        heartbeatJob = scope.launch {
            while (isActive) {
                delay(PlaybackPlan.HEARTBEAT_INTERVAL_MS)
                if (_player.value?.isPlaying == true) reportCurrent(ProgressStatus.Playing)
            }
        }
    }

    /** Reports the position with the status the viewer wants: playing, or paused. */
    private fun reportLive(p: ExoPlayer) = reportCurrent(PlaybackPlan.liveStatus(p.playWhenReady))

    private fun reportCurrent(status: ProgressStatus) {
        val s = session ?: return
        val p = _player.value ?: return
        if (reported || readyAt == null) return
        lastPositionMs = p.currentPosition
        report(s, status, p.currentPosition, durationOf(p) ?: _ui.value.durationMs, playing = p.isPlaying)
    }

    /** Reports where the viewer left the current episode (stopped, or finished within the end threshold). */
    private fun endSession() {
        val s = session
        val p = _player.value
        if (s != null && p != null && !reported && readyAt != null) {
            val position = p.currentPosition
            val duration = durationOf(p) ?: s.resolved.episode.durationMs
            report(s, PlaybackPlan.stopStatus(position, duration), position, duration, playing = false)
        }
        reported = true
        session = null
        stopSessionLoops()
        seek.cancel()
    }

    private fun report(s: Session, status: ProgressStatus, positionMs: Long, durationMs: Long?, playing: Boolean) =
        reporter.report(s.api, s.resolved.sessionId, s.resolved.episode.id, status, positionMs, durationMs, playing)

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

    private fun ensurePlayer(): ExoPlayer = _player.value ?: ExoPlayer.Builder(context)
        .setRenderersFactory(DefaultRenderersFactory(context).setEnableDecoderFallback(true))
        .setMediaSourceFactory(
            DefaultMediaSourceFactory(
                DefaultDataSource.Factory(context, OkHttpDataSource.Factory(mediaHttp).setUserAgent(userAgent)),
            ),
        )
        .setAudioAttributes(
            AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(),
            /* handleAudioFocus = */ true,
        )
        .setHandleAudioBecomingNoisy(true)
        .build()
        .apply { addListener(listener) }
        .also { _player.value = it }

    /** Preferred audio from the server (owner-controlled); subtitles off unless the owner chose a language. */
    private fun applyTrackPreferences(p: ExoPlayer) {
        val device = repository.state.value?.device
        val subtitles = device?.subtitlesLanguage
        val builder = p.trackSelectionParameters.buildUpon()
            .clearOverrides()
            .setPreferredAudioLanguages(*languagePreference(device?.preferredAudioLanguage))
            .setPreferredTextLanguages(*languagePreference(subtitles))
            .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, subtitles == null)
        if (capVideoTo720p) builder.setMaxVideoSize(1280, 720)
        p.trackSelectionParameters = builder.build()
    }

    private fun durationOf(p: ExoPlayer): Long? = p.duration.takeIf { it != C.TIME_UNSET && it > 0 }
}
