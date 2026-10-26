package io.github.mickeiik.izle.companion.sync

import io.github.mickeiik.izle.data.api.Anchor
import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.data.api.ApiException
import io.github.mickeiik.izle.data.api.CompanionResolveRequest
import io.github.mickeiik.izle.data.api.CompanionResolveResponse
import io.github.mickeiik.izle.data.api.CompanionResponse
import io.github.mickeiik.izle.data.api.LinkTiming
import io.github.mickeiik.izle.data.api.NowResponse
import io.github.mickeiik.izle.domain.IsoTime
import io.github.mickeiik.izle.player.MediaEngine
import io.github.mickeiik.izle.player.MediaError
import io.github.mickeiik.izle.player.MediaSpec
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableJob
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.roundToLong

/** What the session needs from the server (an [ApiClient] in the app, a fake in tests). */
interface CompanionApi {
    suspend fun now(deviceId: String, seq: Long?, waitSec: Int): NowResponse
    suspend fun resolve(deviceId: String, request: CompanionResolveRequest): CompanionResolveResponse
    suspend fun companion(deviceId: String): CompanionResponse
}

class ApiClientCompanionApi(private val api: ApiClient) : CompanionApi {
    override suspend fun now(deviceId: String, seq: Long?, waitSec: Int): NowResponse = api.now(deviceId, seq, waitSec)
    override suspend fun resolve(deviceId: String, request: CompanionResolveRequest): CompanionResolveResponse =
        api.companionResolve(deviceId, request)
    override suspend fun companion(deviceId: String): CompanionResponse = api.companion(deviceId)
}

/** What to listen to: a source (and audio language) of the episode a TV plays. */
data class ListenTarget(
    val deviceId: String,
    val episodeId: String,
    val sourceId: String,
    val language: String?,
    val itemTitle: String?,
    val episodeTitle: String?,
)

enum class ListenPhase { Idle, Starting, Listening }

/** Why the last session ended. */
enum class EndReason {
    Stopped, TvIdle, TvSwitchedToChannel, NoSuchSourceOnNextEpisode, StreamKeepsFailing, Unauthorized, Failed,

    /** The engine paused itself: earphones unplugged or another app took the audio. */
    Interrupted,
}

data class ListenState(
    val phase: ListenPhase = ListenPhase.Idle,
    val target: ListenTarget? = null,
    /** In use now (live edits from the screen). */
    val timing: LinkTiming = LinkTiming(),
    val nudgeMs: Long = 0,
    val tvPositionMs: Double? = null,
    val phonePositionMs: Double? = null,
    val driftMs: Double? = null,
    /** "synced", "catching up", …, "past the end"; null while idle. */
    val syncLabel: String? = null,
    /** The best round trip so far. */
    val clockRttMs: Long? = null,
    /** hls, dash, mp4, ts. */
    val mediaKind: String? = null,
    /** The last error's text (an API code, a player error code or a class name), null when none. */
    val error: String? = null,
    /** Why the last session ended; cleared by [ListenSession.start]. */
    val ended: EndReason? = null,
)

/**
 * Listen along on this phone: the port of `server/admin/companion.js`'s loop. Three quick clock samples, resolve and
 * load the source, then three loops while listening: the `/now` long-poll that follows the TV (its anchor, the next
 * episode, a channel, idleness), a clock sample every minute, and the tick that seeks, nudges the playback rate or
 * pauses the [engine] to keep the phone at `rate · tv + offset + nudge`.
 *
 * Every engine call and every state change happens on [scope] (Main-dispatched in the app), so the session needs no
 * locks. A generation counter, bumped by every stop, and a load counter drop the results of work overtaken by a stop
 * or a newer load. Errors carry API codes, player error codes or class names: never messages, URLs or headers.
 */
class ListenSession(
    private val api: CompanionApi,
    private val engine: MediaEngine,
    private val scope: CoroutineScope,
    private val absoluteUrl: (String) -> String?,
    private val wallClock: () -> Long = System::currentTimeMillis,
    private val timing: Timing = Timing(),
) {
    /** The loop's tuning (companion.js's constants); tests shorten nothing, they drive virtual time. */
    data class Timing(
        val tickMs: Long = 250,
        val longPollSec: Int = 25,
        val clockSampleMs: Long = 60_000,
        val idleStopMs: Long = 120_000,
        val seekHoldMs: Long = 1000,
        val seekLeadMs: Long = 150,
        val reResolveBeforeExpiryMs: Long = 60_000,
        val maxRecoveries: Int = 3,
        val retryMs: Long = 3000,
        val recoverDelayMs: Long = 2000,
    )

    /** The stream now loaded; null between sessions and while following the TV to its next episode. */
    private data class Playing(val episodeId: String, val sourceId: String, val language: String?, val expiresAtMs: Long?)

    private val _state = MutableStateFlow(ListenState())
    val state: StateFlow<ListenState> = _state.asStateFlow()

    private val phase get() = _state.value.phase

    /** The current session's coroutines, cancelled together by a stop. */
    private var work: CompletableJob? = null
    private var recoverJob: Job? = null
    private var deviceId = ""
    private var playing: Playing? = null
    private var anchor: Anchor? = null
    private var tvActive = false
    private var lastActiveAt = 0L
    private var seq = 0L
    private var samples = emptyList<ListenSync.ClockSample>()
    private var offset: Long? = null
    private var bestRtt: Long? = null
    private var seekHoldUntil = 0L
    private var recoveries = 0
    private var lastReResolveAt: Long? = null
    private var generation = 0
    private var loadSeq = 0
    /** Whether the engine's pause is the tick's own; any other pause while listening ends the session. */
    private var pausedBySync = false

    private val listener = object : MediaEngine.Listener {
        override fun onReady() {
            // The stream plays again: a later failure starts a fresh count.
            if (phase == ListenPhase.Listening && recoveries > 0) {
                recoveries = 0
                _state.update { it.copy(error = null) }
            }
        }

        override fun onEnded() = Unit
        override fun onError(error: MediaError) {
            if (phase != ListenPhase.Listening) return
            _state.update { it.copy(error = error.codeName) }
            recover()
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) = Unit
        override fun onStateChanged() {
            // Earphones unplugged or a lost audio focus: the tick would play again, out of the speaker.
            if (phase == ListenPhase.Listening && playing != null && !engine.playWhenReady && !pausedBySync) {
                end(EndReason.Interrupted)
            }
        }
        override fun onCues(text: String?) = Unit
    }

    /** Starts listening to [target] with [timing] (the link's stored timing or the screen's edits) and [nudgeMs]. */
    fun start(target: ListenTarget, timing: LinkTiming, nudgeMs: Long) {
        if (phase != ListenPhase.Idle) teardown()
        val gen = ++generation
        deviceId = target.deviceId
        anchor = null
        tvActive = false
        lastActiveAt = wallClock()
        seq = 0
        samples = emptyList()
        offset = null
        bestRtt = null
        seekHoldUntil = 0
        recoveries = 0
        lastReResolveAt = null
        pausedBySync = false
        _state.value = ListenState(phase = ListenPhase.Starting, target = target, timing = timing, nudgeMs = nudgeMs)
        engine.setListener(listener)
        val job = SupervisorJob(scope.coroutineContext[Job]).also { work = it }
        scope.launch(job) {
            try {
                // Three quick clock samples, then the stream.
                repeat(3) {
                    readNow(wait = false)
                    if (gen != generation) return@launch
                }
                if (!load(target.episodeId, target.sourceId, target.language, startAt = { null }) || gen != generation) return@launch
                _state.update { it.copy(phase = ListenPhase.Listening) }
                launch { followLoop() }
                launch {
                    while (true) {
                        delay(this@ListenSession.timing.tickMs)
                        try {
                            tick()
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            fail(e, EndReason.Failed)
                            break
                        }
                    }
                }
                launch {
                    while (true) {
                        delay(this@ListenSession.timing.clockSampleMs)
                        try {
                            readNow(wait = false)
                        } catch (e: CancellationException) {
                            throw e
                        } catch (_: Exception) {
                            // the next sample tries again
                        }
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (gen == generation) fail(e, EndReason.Failed)
            }
        }
    }

    /** Ends listening with [EndReason.Stopped]; a no-op when idle. */
    fun stop() {
        if (phase == ListenPhase.Idle) return
        end(EndReason.Stopped)
    }

    /** Applies at once: the next tick aims at the new target. */
    fun setTiming(timing: LinkTiming) {
        _state.update { it.copy(timing = timing) }
    }

    fun setNudgeMs(ms: Long) {
        _state.update { it.copy(nudgeMs = ms) }
    }

    /** While listening: resolves and loads another candidate at the current position, keeping the timing. */
    fun switchSource(sourceId: String, language: String?) {
        if (phase != ListenPhase.Listening) return
        val p = playing ?: return
        if (p.sourceId == sourceId && p.language == language) return
        val job = work ?: return
        val gen = generation
        scope.launch(job) {
            try {
                load(p.episodeId, sourceId, language) { currentTarget() }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // The previous source keeps playing.
                if (gen == generation && !endIfUnauthorized(e)) _state.update { it.copy(error = errorText(e)) }
            }
        }
    }

    /** [stop] and frees the engine. */
    fun release() {
        stop()
        engine.setListener(null)
        engine.release()
    }

    private fun serverNow(): Long = wallClock() + (offset ?: 0)

    /** One `/now` call (with [wait], a long-poll on `seq`), which keeps the clock offset fresh. */
    private suspend fun readNow(wait: Boolean): NowResponse {
        val sentAt = wallClock()
        val r = if (wait) api.now(deviceId, seq, timing.longPollSec) else api.now(deviceId, null, 0)
        val receivedAt = wallClock()
        val rtt = receivedAt - sentAt
        if (!wait || rtt <= ListenSync.SAMPLE_MAX_RTT_MS) {
            samples = (samples + ListenSync.ClockSample(sentAt, receivedAt, r.serverNowMs)).takeLast(8)
            offset = ListenSync.clockOffset(samples)
            bestRtt = bestRtt?.let { minOf(it, rtt) } ?: rtt
            _state.update { it.copy(clockRttMs = bestRtt) }
        }
        // Answers can cross (a clock sample next to the long-poll): only a newer row replaces the anchor.
        if (r.seq >= seq) {
            seq = r.seq
            anchor = r.anchor
            tvActive = ListenSync.isActive(r.nowPlaying, serverNow())
            if (tvActive) lastActiveAt = wallClock()
        }
        return r
    }

    private suspend fun followLoop() {
        while (true) {
            try {
                val r = readNow(wait = true)
                val n = r.nowPlaying
                val p = playing
                if (p != null && n?.isLive == true) return end(EndReason.TvSwitchedToChannel)
                val next = n?.episodeId
                if (p != null && next != null && next != p.episodeId) follow(next)
                else if (wallClock() - lastActiveAt > timing.idleStopMs) return end(EndReason.TvIdle)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (endIfUnauthorized(e)) return
                delay(timing.retryMs)
            }
        }
    }

    /**
     * Resolves and loads [sourceId] of [episodeId] at [startAt] (evaluated once the answer is in); whether it took
     * effect, not overtaken by a stop or a newer load.
     */
    private suspend fun load(episodeId: String, sourceId: String, language: String?, startAt: () -> Long?): Boolean {
        if (phase == ListenPhase.Idle) return false
        val my = ++loadSeq
        val gen = generation
        val r = api.resolve(deviceId, CompanionResolveRequest(episodeId, sourceId, language))
        if (my != loadSeq || gen != generation || phase == ListenPhase.Idle) return false
        val url = absoluteUrl(r.media.url) ?: throw UnusableMediaUrl()
        // Only now: after a failed resolve the previous stream keeps playing in its own language.
        engine.applyPreferences(language, null)
        engine.load(MediaSpec(url = url, kind = r.media.kind, subtitles = emptyList(), mediaId = episodeId, live = false), startAt())
        playing = Playing(episodeId, sourceId, language, r.expiresAt?.let(IsoTime::parseEpochMs))
        seekHoldUntil = 0
        pausedBySync = false
        engine.play()
        _state.update {
            it.copy(target = it.target?.copy(episodeId = episodeId, sourceId = sourceId, language = language), mediaKind = r.media.kind)
        }
        return true
    }

    /** After a stream error: wait, resolve and load again, up to [Timing.maxRecoveries] times in a row. */
    private fun recover() {
        if (phase != ListenPhase.Listening || playing == null) return
        if (recoverJob?.isActive == true) return // a recovery is already on its way
        val job = work ?: return
        recoverJob = scope.launch(job) { recoverNow() }
    }

    private suspend fun recoverNow() {
        while (true) {
            if (phase != ListenPhase.Listening || playing == null) return
            if (++recoveries > timing.maxRecoveries) return end(EndReason.StreamKeepsFailing, _state.value.error)
            delay(timing.recoverDelayMs)
            val p = playing ?: return
            if (phase != ListenPhase.Listening) return
            try {
                load(p.episodeId, p.sourceId, p.language) { currentTarget() }
                return
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (endIfUnauthorized(e)) return
                _state.update { it.copy(error = errorText(e)) }
            }
        }
    }

    /** The TV moved to another episode: the same source and language there, with that episode's own timing. */
    private suspend fun follow(episodeId: String) {
        val wanted = playing ?: return
        try {
            val r = api.companion(deviceId)
            if (phase != ListenPhase.Listening) return
            val language = wanted.language
            val candidate = r.candidates.find { c ->
                c.sourceId == wanted.sourceId && (c.type == TYPE_DIRECT || c.type == TYPE_ADAPTER) &&
                    (language == null || c.languages.audio?.contains(language) == true)
            } ?: return end(EndReason.NoSuchSourceOnNextEpisode)
            val n = r.nowPlaying
            _state.update {
                it.copy(
                    timing = candidate.link.copy(language = candidate.link.language ?: language),
                    target = it.target?.let { t ->
                        t.copy(itemTitle = n?.itemTitle ?: t.itemTitle, episodeTitle = n?.takeIf { n.episodeId == episodeId }?.episodeTitle)
                    },
                )
            }
            playing = null // the tick waits for the new stream
            if (load(episodeId, wanted.sourceId, language, startAt = { null })) recoveries = 0
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            fail(e, EndReason.Failed)
        }
    }

    /** Where the phone should be now, never before 0; null before the TV's first anchor. */
    private fun currentTarget(): Long? {
        val tv = ListenSync.tvPositionAt(anchor, serverNow()) ?: return null
        val s = _state.value
        return max(0.0, ListenSync.companionTarget(tv, s.timing, s.nudgeMs)).roundToLong()
    }

    private fun tick() {
        val p = playing ?: return
        if (phase != ListenPhase.Listening) return
        val now = serverNow()
        val a = anchor
        val tv = ListenSync.tvPositionAt(a, now) ?: return
        val s = _state.value
        val target = ListenSync.companionTarget(tv, s.timing, s.nudgeMs)
        val actual = engine.positionMs.toDouble()
        // The companion is shorter than the TV's cut: stay silent at its end instead of restarting from 0 on play.
        val pastEnd = engine.durationMs?.let { target >= it } == true
        val d = ListenSync.syncDecision(target, actual, a?.playing == true && tvActive && !pastEnd, s.timing.rate)
        val settled = wallClock() >= seekHoldUntil
        when {
            settled && d.action == ListenSync.Action.Seek -> {
                engine.seekTo(max(0.0, (d.toMs ?: target) + timing.seekLeadMs).roundToLong())
                seekHoldUntil = wallClock() + timing.seekHoldMs
                if (!engine.playWhenReady) {
                    pausedBySync = false
                    engine.play()
                }
            }
            settled && d.action == ListenSync.Action.Play -> {
                if (!engine.playWhenReady) {
                    pausedBySync = false
                    engine.play()
                }
                if (abs(engine.playbackRate - d.rate) > RATE_EPSILON) engine.playbackRate = d.rate.toFloat()
            }
            settled && engine.playWhenReady -> {
                pausedBySync = true
                engine.pause()
            }
        }
        _state.update {
            it.copy(
                tvPositionMs = tv,
                phonePositionMs = actual,
                driftMs = d.errorMs,
                syncLabel = if (pastEnd) PAST_THE_END else d.state.label,
                clockRttMs = bestRtt,
            )
        }
        // Re-resolve shortly before the stream's URL expires, at most once a minute (an adapter may always answer
        // with a short validity).
        val last = lastReResolveAt
        if (p.expiresAtMs != null && p.expiresAtMs - now < timing.reResolveBeforeExpiryMs &&
            (last == null || wallClock() - last > timing.reResolveBeforeExpiryMs)
        ) {
            lastReResolveAt = wallClock()
            val job = work ?: return
            val gen = generation
            scope.launch(job) {
                try {
                    load(p.episodeId, p.sourceId, p.language) { currentTarget() }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    if (gen != generation || endIfUnauthorized(e)) return@launch
                    _state.update { it.copy(error = errorText(e)) }
                    recover()
                }
            }
        }
    }

    /** A `401` ends listening as [EndReason.Unauthorized]; whether it did. */
    private fun endIfUnauthorized(e: Exception): Boolean {
        if (e !is ApiException || e.status != 401) return false
        end(EndReason.Unauthorized, e.code)
        return true
    }

    private fun fail(e: Exception, reason: EndReason) {
        if (!endIfUnauthorized(e)) end(reason, errorText(e))
    }

    /** Stops everything and reports [reason]; [error] replaces the last error when given. */
    private fun end(reason: EndReason, error: String? = null) {
        if (phase == ListenPhase.Idle) return
        // Idle first: a callback the engine raises while stopping finds the session ended.
        _state.update {
            it.copy(
                phase = ListenPhase.Idle,
                tvPositionMs = null,
                phonePositionMs = null,
                driftMs = null,
                syncLabel = null,
                mediaKind = null,
                error = error ?: it.error,
                ended = reason,
            )
        }
        teardown()
    }

    /** Cancels the session's coroutines (possibly the caller's own) and stops the engine; the state is the caller's. */
    private fun teardown() {
        generation++
        work?.cancel()
        work = null
        recoverJob = null
        playing = null
        anchor = null
        engine.stop()
    }

    /** The answer's media URL could not be made absolute. */
    private class UnusableMediaUrl : Exception()

    private companion object {
        const val TYPE_DIRECT = "direct"
        const val TYPE_ADAPTER = "adapter"
        const val PAST_THE_END = "past the end"
        /** The playback rate is set only when it changes by more than this (as the admin page does). */
        const val RATE_EPSILON = 0.0005

        /** An API error code, else the exception's class name: never a message (it may carry a URL). */
        fun errorText(e: Exception): String = (e as? ApiException)?.code ?: e::class.simpleName ?: "Exception"
    }
}
