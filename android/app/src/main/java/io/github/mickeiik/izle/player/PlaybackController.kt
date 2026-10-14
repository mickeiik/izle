package io.github.mickeiik.izle.player

import android.content.Context
import android.net.Uri
import android.os.SystemClock
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.text.CueGroup
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.HttpDataSource
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
import io.github.mickeiik.izle.data.api.ProgressReport
import io.github.mickeiik.izle.data.api.ProgressStatus
import io.github.mickeiik.izle.data.api.ResolveRequest
import io.github.mickeiik.izle.data.api.ResolveResponse
import io.github.mickeiik.izle.domain.EpisodeSteps
import io.github.mickeiik.izle.domain.ExpiryPlan
import io.github.mickeiik.izle.domain.PlaybackPlan
import io.github.mickeiik.izle.domain.Problems
import io.github.mickeiik.izle.domain.RemoteCommand
import io.github.mickeiik.izle.domain.SeekAccumulator
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.OkHttpClient
import java.io.IOException

sealed interface PlayerPhase {
    data object Idle : PlayerPhase

    /** Resolving or buffering before the first frame. */
    data object Loading : PlayerPhase

    data object Playing : PlayerPhase

    /** The episode ended and the next one starts after the countdown. */
    data class UpNext(val next: NextEpisode, val secondsLeft: Int) : PlayerPhase

    /** The item ended (or auto-advance stops here): "The end", then Home. */
    data object Finished : PlayerPhase

    /** Nothing could be played: "Can't play right now" with Try again / Home, then Home on its own after [secondsLeft]. */
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
 * expiring stream URLs and CH+/CH− episode steps. All methods run on the main thread. Progress reports go through
 * one ordered queue in [reportScope] so they outlive the screen and a late heartbeat can never overwrite a
 * `finished`. Problems (player errors, failed resolves, giving up) are reported to the owner through [problems].
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
    /** A playback reached its first frame (the item is the one being played). */
    private val onPlaybackStarted: (ItemCard) -> Unit = {},
) {
    private val _ui = MutableStateFlow(PlayerUi())
    val ui: StateFlow<PlayerUi> = _ui.asStateFlow()

    private val _player = MutableStateFlow<ExoPlayer?>(null)
    val player: StateFlow<ExoPlayer?> = _player.asStateFlow()

    private class Session(val api: ApiClient, val resolved: ResolveResponse)

    private var session: Session? = null
    private var episodeId: String? = null
    private val tried = mutableSetOf<String>()

    /** The server's fallback order from the last unpinned resolve (a pinned re-resolve returns none). */
    private var alternatives: List<String> = emptyList()
    private var retriedSameSource = false
    private var readyAt: Long? = null
    private var reported = false

    /** Where Try again restarts; null = from the server's saved position under the resume rules. */
    private var lastPositionMs: Long? = null
    private val seek = SeekAccumulator()

    private var resolveJob: Job? = null
    private var overlayJob: Job? = null
    private var heartbeatJob: Job? = null
    private var infoJob: Job? = null

    /** The refresh of the playing stream before its URL expires (one loop per resolved session). */
    private var expiryJob: Job? = null

    /** When this playback last re-resolved its stream ahead of the expiry (elapsedRealtime), for the 60 s spacing. */
    private var lastRefreshAt: Long? = null

    /** CH+/CH−: the items' episode lists, fetched on first use and kept for this player visit. */
    private val episodeLists = mutableMapOf<String, List<EpisodeDetails>>()
    private var stepJob: Job? = null

    /** A report with the moment its position was sampled, so its age is known when it is finally sent. */
    private class QueuedReport(val api: ApiClient, val report: ProgressReport, val sampledAt: Long = SystemClock.elapsedRealtime())

    private val reports = Channel<QueuedReport>(Channel.UNLIMITED)

    /** The server rejected the anchor fields (it predates "Listen along"): send reports without them. */
    private var legacyProgress = false

    /** Reports queued or in flight; a new resolve waits for them so `resume` and the cursor are current. */
    private val pendingReports = MutableStateFlow(0)

    init {
        reportScope.launch {
            for (queued in reports) {
                deliver(queued)
                pendingReports.update { it - 1 }
            }
        }
    }

    /**
     * Heartbeats are best effort (the next one carries the position again); `stopped` and `finished` are the last
     * word on an episode, so they are retried a few times and then refresh Home, whose tile depends on them.
     */
    private suspend fun deliver(q: QueuedReport) {
        val terminal = q.report.status.isFinal
        val attempts = if (terminal) TERMINAL_REPORT_ATTEMPTS else 1
        var attempt = 0
        var retriedWithoutAnchor = false
        while (attempt < attempts) {
            if (attempt > 0) delay(2_000L * attempt)
            val report = stamp(q)
            try {
                q.api.progress(report)
                if (terminal) repository.refreshSoon()
                return
            } catch (e: IOException) {
                attempt++ // retried for terminal reports
            } catch (e: ApiException) {
                if (e.status == 400 && !retriedWithoutAnchor && (report.playing != null || report.ageMs != null)) {
                    // A server from before "Listen along" rejects the anchor fields: resend without them, from now on.
                    legacyProgress = true
                    retriedWithoutAnchor = true
                    continue
                }
                if (e.status < 500) return // unknown episode after a catalog change: nothing to save
                attempt++
            }
        }
    }

    /** The report as sent now: with the sample's age at send time (retries carry the grown age), or without the anchor fields for an old server. */
    private fun stamp(q: QueuedReport): ProgressReport =
        if (legacyProgress) q.report.copy(playing = null, ageMs = null)
        else q.report.copy(ageMs = PlaybackPlan.reportAgeMs(q.sampledAt, SystemClock.elapsedRealtime()))

    val isActive: Boolean get() = _ui.value.phase != PlayerPhase.Idle

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
        tried.clear()
        alternatives = emptyList()
        retriedSameSource = false
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
        if (api == null) {
            showFailed()
            return
        }
        resolveJob = scope.launch { resolveAndStart(api, episodeId, sourceId = null, startAtMs = startAtMs) }
    }

    /** Leaves the player: reports where the viewer stopped, releases the decoder, goes Home. */
    fun exit() {
        stop()
        onExit()
    }

    /** Like [exit] without navigating (the app went to the background). Ends the player visit. */
    fun stop() {
        resolveJob?.cancel()
        stepJob?.cancel()
        cancelOverlays()
        endSession()
        releasePlayer()
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
        if (_ui.value.phase != PlayerPhase.Playing) return
        if (p.playWhenReady) pause() else resume()
    }

    fun pause() {
        val p = _player.value ?: return
        if (!p.playWhenReady) return
        p.pause()
        reportCurrent(ProgressStatus.Paused)
        showInfo()
    }

    fun resume() {
        val p = _player.value ?: return
        if (p.playWhenReady) return
        p.play()
        reportCurrent(ProgressStatus.Playing)
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
        val target = seek.commit() ?: return
        p.seekTo(target)
        _ui.update { it.copy(seekPreviewMs = null, positionMs = target) }
        reportCurrent(PlaybackPlan.liveStatus(p.playWhenReady))
        showInfo()
    }

    /** The owner's seek command: relative or absolute, clamped to the episode, shown like a key press. */
    fun seekRemote(command: RemoteCommand.Seek) {
        val p = _player.value ?: return
        if (_ui.value.phase != PlayerPhase.Playing) return
        seek.cancel()
        val target = command.targetMs(p.currentPosition.coerceAtLeast(0), durationOf(p) ?: _ui.value.durationMs)
        p.seekTo(target)
        _ui.update { it.copy(seekPreviewMs = null, positionMs = target) }
        reportCurrent(PlaybackPlan.liveStatus(p.playWhenReady))
        showInfo()
    }

    /**
     * CH+/CH− (also |◀◀ ▶▶| and the owner's next/previous commands) while an episode is showing: ends it the way
     * Back does (stopped/finished is reported) and plays the nearest playable episode after ([direction] > 0) or
     * before it in the same player visit, under the normal resume rules. At either end only the info overlay
     * appears. Further presses while the episode list is being fetched are ignored.
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
            val episodes = try {
                s.api.item(item.id).episodes
            } catch (e: IOException) {
                null
            } catch (e: ApiException) {
                null
            }
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

    // --- tracks for the hidden menu ------------------------------------------------------------------------------

    fun audioTracks(): List<TrackOption> = tracksOf(C.TRACK_TYPE_AUDIO)

    fun textTracks(): List<TrackOption> = tracksOf(C.TRACK_TYPE_TEXT)

    /** null = automatic (the server's preferred audio language). */
    fun selectAudio(option: TrackOption?) {
        val p = _player.value ?: return
        val builder = p.trackSelectionParameters.buildUpon().clearOverridesOfType(C.TRACK_TYPE_AUDIO)
        if (option != null) {
            val group = p.currentTracks.groups.getOrNull(option.groupIndex) ?: return
            builder.setOverrideForType(TrackSelectionOverride(group.mediaTrackGroup, option.trackIndex))
        }
        p.trackSelectionParameters = builder.build()
    }

    /** null = subtitles off. */
    fun selectText(option: TrackOption?) {
        val p = _player.value ?: return
        val builder = p.trackSelectionParameters.buildUpon().clearOverridesOfType(C.TRACK_TYPE_TEXT)
        if (option == null) {
            builder.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
        } else {
            val group = p.currentTracks.groups.getOrNull(option.groupIndex) ?: return
            builder.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
                .setOverrideForType(TrackSelectionOverride(group.mediaTrackGroup, option.trackIndex))
        }
        p.trackSelectionParameters = builder.build()
        if (option == null) _ui.update { it.copy(cues = null) }
    }

    private fun tracksOf(type: Int): List<TrackOption> {
        val p = _player.value ?: return emptyList()
        val textDisabled = type == C.TRACK_TYPE_TEXT && C.TRACK_TYPE_TEXT in p.trackSelectionParameters.disabledTrackTypes
        val out = mutableListOf<TrackOption>()
        p.currentTracks.groups.forEachIndexed { g, group ->
            if (group.type != type) return@forEachIndexed
            for (t in 0 until group.length) {
                if (!group.isTrackSupported(t)) continue
                val format = group.getTrackFormat(t)
                out += TrackOption(g, t, format.language, format.label, selected = !textDisabled && group.isTrackSelected(t))
            }
        }
        // Adaptive audio renditions repeat the same language: one entry per language/label is enough.
        return out.distinctBy { it.language to it.label }
    }

    // --- internals -----------------------------------------------------------------------------------------------

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
        withTimeoutOrNull(3_000) { pendingReports.first { it <= 0 } }
        val resolved = try {
            api.resolve(ResolveRequest(episodeId, sourceId, exclude = if (sourceId == null) tried.toList().ifEmpty { null } else null))
        } catch (e: Exception) {
            if (e !is ApiException && e !is IOException) throw e
            currentCoroutineContext().ensureActive() // the viewer left meanwhile: nothing to report
            problems.send(Problems.resolveFailure(e, episodeId, sourceId, appVersion), api = api)
            if (e is ApiException && e.status == 401) repository.refreshSoon()
            if (sourceId != null && alternatives.any { it != sourceId && it !in tried }) {
                tried += sourceId
                resolveAndStart(api, episodeId, sourceId = null, startAtMs, playWhenReady)
            } else {
                showFailed(reason = "then resolve failed: " + Problems.code(if (e is ApiException) e.code else "network"))
            }
            return
        }
        val receivedAt = SystemClock.elapsedRealtime()
        if (sourceId == null) alternatives = resolved.alternatives
        val item = mediaItemFor(api, resolved)
        if (item == null) {
            showFailed(reason = "then the media address was unusable")
            return
        }
        val start = startAtMs ?: PlaybackPlan.resumePositionMs(
            resolved.resume?.positionMs,
            resolved.resume?.durationMs ?: resolved.episode.durationMs,
        )
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

    // --- refreshing an expiring stream ---------------------------------------------------------------------------

    /**
     * Re-resolves the playing source shortly before its URL expires (see [ExpiryPlan]) and keeps doing so after each
     * refresh. One loop per resolved session: a new resolve, an episode change, the end or leaving cancels it.
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
     * network or server failure. Returns the new stream's expiry to schedule the next refresh from, or null to stop
     * (the session changed, no expiry, or it failed for good: the 403/410 path takes over when the URL expires).
     */
    private suspend fun refreshBeforeExpiry(api: ApiClient, deadline: Long): Long? {
        var retried = false
        while (true) {
            val s = session ?: return null
            val episodeId = this.episodeId ?: return null
            val phase = _ui.value.phase
            if (phase != PlayerPhase.Playing && phase != PlayerPhase.Loading) return null
            val sourceId = s.resolved.sourceId
            lastRefreshAt = SystemClock.elapsedRealtime()
            val resolved = try {
                api.resolve(ResolveRequest(episodeId, sourceId = sourceId))
            } catch (e: Exception) {
                if (e !is ApiException && e !is IOException) throw e
                currentCoroutineContext().ensureActive()
                problems.send(Problems.resolveFailure(e, episodeId, sourceId, appVersion), api = api)
                if (e is ApiException && e.status == 401) repository.refreshSoon()
                if (session !== s) return null
                val status = (e as? ApiException)?.status
                val retry = ExpiryPlan.retryDelayMs(ExpiryPlan.isRetryable(status), retried, deadline - SystemClock.elapsedRealtime())
                    ?: return null
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
     * Continues with a re-resolved answer for the same source: progress goes to the new session; the media is swapped
     * at the current position only when its URL changed (`playWhenReady` untouched: a paused player stays paused, a
     * short spinner while it buffers). The fallback order of the last unpinned resolve stays (a pinned answer has no
     * alternatives).
     */
    private fun adoptRefreshed(api: ApiClient, old: Session, resolved: ResolveResponse) {
        session = Session(api, resolved)
        val p = _player.value ?: return
        if (resolved.media.url != old.resolved.media.url) {
            val item = mediaItemFor(api, resolved)
            if (item != null) {
                val position = p.currentPosition.coerceAtLeast(0)
                p.setMediaItem(item, position)
                p.prepare()
                lastPositionMs = position
                _ui.update { it.copy(cues = null) }
            }
        }
        // A resolve resets the server's "now playing" to the saved position: re-anchor it now (Listen along).
        reportCurrent(PlaybackPlan.liveStatus(p.playWhenReady))
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
                    // The re-resolved source plays again: a later expiry may be retried the same way.
                    retriedSameSource = false
                    if (_ui.value.phase == PlayerPhase.Loading) _ui.update { it.copy(phase = PlayerPhase.Playing) }
                }
                Player.STATE_ENDED -> onEnded(p)
            }
            syncFlags(p)
        }

        override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
            _player.value?.let { syncFlags(it) }
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            // A rebuffer stall, its end, a pause or a resume: the phone's "Listen along" follows this anchor, so
            // report at once (a stall is status "playing" with playing=false).
            val p = _player.value ?: return
            reportCurrent(PlaybackPlan.liveStatus(p.playWhenReady))
        }

        override fun onPlayerError(error: PlaybackException) {
            onError(error)
        }

        override fun onCues(cueGroup: CueGroup) {
            val text = cueGroup.cues.mapNotNull { it.text?.toString()?.trim() }.filter { it.isNotEmpty() }.joinToString("\n")
            _ui.update { it.copy(cues = text.ifEmpty { null }) }
        }

        override fun onTracksChanged(tracks: Tracks) {
            // The hidden menu reads tracks on demand; nothing to cache.
        }
    }

    private fun syncFlags(p: ExoPlayer) {
        _ui.update {
            it.copy(
                playWhenReady = p.playWhenReady,
                buffering = p.playbackState == Player.STATE_BUFFERING,
                durationMs = durationOf(p) ?: it.durationMs,
            )
        }
    }

    private fun onEnded(p: ExoPlayer) {
        val s = session ?: return
        if (reported) return
        reported = true
        val duration = durationOf(p) ?: s.resolved.episode.durationMs
        report(s, ProgressStatus.Finished, duration ?: p.currentPosition, duration, playing = false)
        heartbeatJob?.cancel()
        expiryJob?.cancel()
        lastPositionMs = 0
        val next = s.resolved.next
        if (next != null) startUpNext(next) else showFinished()
    }

    private fun onError(error: PlaybackException) {
        val p = _player.value
        val current = session
        val position = p?.currentPosition?.coerceAtLeast(0) ?: lastPositionMs ?: 0
        problems.send(
            Problems.playbackError(
                error, error.errorCodeName, error.httpStatus(), episodeId, current?.resolved?.sourceId,
                current?.resolved?.sessionId, position, appVersion,
            ),
            api = current?.api,
        )
        val s = current ?: return showFailed()
        lastPositionMs = position
        val played = readyAt?.let { SystemClock.elapsedRealtime() - it } ?: 0
        val sourceId = s.resolved.sourceId
        val alternativesLeft = alternatives.any { it != sourceId && it !in tried }
        val episodeId = this.episodeId ?: return showFailed()
        when (PlaybackPlan.recovery(error.httpStatus(), played, retriedSameSource, alternativesLeft)) {
            PlaybackPlan.Recovery.RetrySameSource -> {
                retriedSameSource = true
                relaunch(s.api, episodeId, sourceId = sourceId, position)
            }
            PlaybackPlan.Recovery.NextSource -> {
                tried += sourceId
                retriedSameSource = false
                relaunch(s.api, episodeId, sourceId = null, position)
            }
            PlaybackPlan.Recovery.GiveUp -> {
                tried += sourceId
                if (readyAt != null) report(s, ProgressStatus.Stopped, position, p?.let { durationOf(it) }, playing = false)
                reported = true
                showFailed()
            }
        }
    }

    /**
     * Re-resolves silently and continues at [positionMs] (the screen keeps showing the last frame/spinner), paused
     * if the viewer had paused.
     */
    private fun relaunch(api: ApiClient, episodeId: String, sourceId: String?, positionMs: Long) {
        val playWhenReady = _player.value?.playWhenReady ?: true
        resolveJob?.cancel()
        expiryJob?.cancel()
        resolveJob = scope.launch { resolveAndStart(api, episodeId, sourceId, positionMs, playWhenReady) }
    }

    private fun startUpNext(next: NextEpisode) {
        overlayJob?.cancel()
        overlayJob = scope.launch {
            for (left in PlaybackPlan.AUTO_NEXT_COUNTDOWN_SEC downTo 1) {
                _ui.update { it.copy(phase = PlayerPhase.UpNext(next, left), showInfo = false, cues = null) }
                delay(1_000)
            }
            play(next.episodeId)
        }
    }

    private fun showFinished() {
        _ui.update { it.copy(phase = PlayerPhase.Finished, showInfo = false, cues = null) }
        overlayJob?.cancel()
        overlayJob = scope.launch {
            delay(PlaybackPlan.FINISHED_MESSAGE_MS)
            exit()
        }
    }

    /** "Can't play right now". [reason] completes the problem report's "tried N sources". */
    private fun showFailed(reason: String? = null) {
        heartbeatJob?.cancel()
        expiryJob?.cancel()
        _player.value?.stop()
        episodeId?.let { id ->
            problems.send(Problems.gaveUp(id, session?.resolved?.sourceId ?: tried.lastOrNull(), lastPositionMs, tried.size, appVersion, reason))
        }
        val seconds = (PlaybackPlan.FAILED_AUTO_HOME_MS / 1_000).toInt()
        _ui.update { it.copy(phase = PlayerPhase.Failed(seconds), showInfo = false, buffering = false, cues = null) }
        overlayJob?.cancel()
        overlayJob = scope.launch {
            for (left in seconds downTo 1) {
                _ui.update { it.copy(phase = PlayerPhase.Failed(left)) }
                delay(1_000)
            }
            exit()
        }
    }

    private fun showInfo() {
        val p = _player.value
        _ui.update { it.copy(showInfo = true, positionMs = p?.currentPosition ?: it.positionMs) }
        infoJob?.cancel()
        infoJob = scope.launch {
            var shownFor = 0L
            while (isActive) {
                delay(250)
                shownFor += 250
                val player = _player.value
                val hide = shownFor >= PlaybackPlan.INFO_OVERLAY_MS && seek.pendingTargetMs == null
                _ui.update { it.copy(positionMs = player?.currentPosition ?: it.positionMs, showInfo = !hide) }
                if (hide) break
            }
        }
    }

    private fun startHeartbeat() {
        heartbeatJob?.cancel()
        heartbeatJob = scope.launch {
            while (isActive) {
                delay(PlaybackPlan.HEARTBEAT_INTERVAL_MS)
                val p = _player.value ?: continue
                if (p.isPlaying) reportCurrent(ProgressStatus.Playing)
            }
        }
    }

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
        heartbeatJob?.cancel()
        expiryJob?.cancel()
        seek.cancel()
    }

    private fun report(s: Session, status: ProgressStatus, positionMs: Long, durationMs: Long?, playing: Boolean) {
        pendingReports.update { it + 1 }
        val report = ProgressReport(s.resolved.sessionId, s.resolved.episode.id, positionMs.coerceAtLeast(0), durationMs, status, playing = playing)
        reports.trySend(QueuedReport(s.api, report))
    }

    private fun cancelOverlays() {
        overlayJob?.cancel()
        infoJob?.cancel()
    }

    private fun ensurePlayer(): ExoPlayer {
        _player.value?.let { return it }
        val http = OkHttpDataSource.Factory(mediaHttp).setUserAgent(userAgent)
        val player = ExoPlayer.Builder(context)
            .setRenderersFactory(DefaultRenderersFactory(context).setEnableDecoderFallback(true))
            .setMediaSourceFactory(DefaultMediaSourceFactory(DefaultDataSource.Factory(context, http)))
            .setAudioAttributes(
                AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(),
                /* handleAudioFocus = */ true,
            )
            .setHandleAudioBecomingNoisy(true)
            .build()
        player.addListener(listener)
        _player.value = player
        return player
    }

    private fun releasePlayer() {
        val p = _player.value ?: return
        p.removeListener(listener)
        p.release()
        _player.value = null
    }

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

    companion object {
        private const val TERMINAL_REPORT_ATTEMPTS = 4

        fun languagePreference(tag: String?): Array<String> {
            if (tag.isNullOrBlank()) return emptyArray()
            return listOf(tag, tag.substringBefore('-').lowercase()).distinct().toTypedArray()
        }

        fun mediaMimeType(kind: String): String = when (kind) {
            "hls" -> MimeTypes.APPLICATION_M3U8
            "dash" -> MimeTypes.APPLICATION_MPD
            else -> MimeTypes.VIDEO_MP4
        }

        fun subtitleMimeType(format: String): String = when (format) {
            "srt" -> MimeTypes.APPLICATION_SUBRIP
            "ttml" -> MimeTypes.APPLICATION_TTML
            else -> MimeTypes.TEXT_VTT
        }

        private fun PlaybackException.httpStatus(): Int? {
            var cause: Throwable? = this
            while (cause != null) {
                if (cause is HttpDataSource.InvalidResponseCodeException) return cause.responseCode
                cause = cause.cause
            }
            return null
        }
    }
}
