package io.github.mickeiik.izle.domain

import io.github.mickeiik.izle.data.api.HomeEntry
import io.github.mickeiik.izle.data.api.ProgressStatus
import io.github.mickeiik.izle.data.api.TvState
import kotlinx.coroutines.delay
import kotlin.math.max
import kotlin.math.min

/** The TV's playback rules, free of Android types. See docs/ux/senior-tv.md for the reasoning behind each number. */
object PlaybackPlan {
    const val RESUME_MIN_POSITION_MS = 30_000L

    /** So the viewer finds the thread again. */
    const val RESUME_REWIND_MS = 5_000L

    /** Credits allowance: finished with at most this much left, or [END_FRACTION], whichever is larger… */
    const val END_MIN_REMAINING_MS = 120_000L
    const val END_FRACTION = 0.05

    /** …but never more, so short episodes are not "finished" right after they start. */
    const val END_MAX_FRACTION = 0.10

    const val HEARTBEAT_INTERVAL_MS = 15_000L
    const val AUTO_NEXT_COUNTDOWN_SEC = 10
    const val FINISHED_MESSAGE_MS = 8_000L
    const val FAILED_AUTO_HOME_SEC = 30
    const val INFO_OVERLAY_MS = 4_000L

    /** HTTP 403/410 after this much playback most likely means an expired URL: re-resolve the same source. */
    const val EXPIRED_URL_MIN_PLAYED_MS = 5 * 60_000L

    /** A channel that played this long was working: its same source is resolved again even if it was once already. */
    const val LIVE_STABLE_PLAYED_MS = 60_000L

    /** The server rejects older samples. */
    const val MAX_REPORT_AGE_MS = 60_000L

    fun reportAgeMs(sampledAtMs: Long, nowMs: Long): Long = (nowMs - sampledAtMs).coerceIn(0, MAX_REPORT_AGE_MS)

    /** What the viewer wants, whatever the player does at that instant; a channel is never paused. */
    fun liveStatus(playWhenReady: Boolean, channel: Boolean = false): ProgressStatus =
        if (playWhenReady || channel) ProgressStatus.Playing else ProgressStatus.Paused

    fun endThresholdMs(durationMs: Long): Long {
        if (durationMs <= 0) return 0
        val wanted = max(END_MIN_REMAINING_MS, (durationMs * END_FRACTION).toLong())
        return min(wanted, (durationMs * END_MAX_FRACTION).toLong())
    }

    fun isFinished(positionMs: Long, durationMs: Long?): Boolean =
        durationMs != null && durationMs > 0 && durationMs - positionMs <= endThresholdMs(durationMs)

    /** 0 (from the beginning) or a point a bit before the saved position. */
    fun resumePositionMs(savedPositionMs: Long?, durationMs: Long?): Long {
        if (savedPositionMs == null || savedPositionMs < RESUME_MIN_POSITION_MS) return 0
        if (isFinished(savedPositionMs, durationMs)) return 0
        return max(0, savedPositionMs - RESUME_REWIND_MS)
    }

    fun stopStatus(positionMs: Long, durationMs: Long?): ProgressStatus =
        if (isFinished(positionMs, durationMs)) ProgressStatus.Finished else ProgressStatus.Stopped

    enum class Recovery { RetrySameSource, NextSource, GiveUp }

    /** After a playback error; [playedMs]: how long this source played. */
    fun recovery(httpStatus: Int?, playedMs: Long, retriedSameSource: Boolean, alternativesLeft: Boolean): Recovery = when {
        (httpStatus == 403 || httpStatus == 410) && playedMs > EXPIRED_URL_MIN_PLAYED_MS && !retriedSameSource ->
            Recovery.RetrySameSource
        alternativesLeft -> Recovery.NextSource
        else -> Recovery.GiveUp
    }

    /**
     * A channel's stream ended, fell behind the live window or failed: the same source again at the live edge (an
     * endless stream is restarted, never resumed), once or after [LIVE_STABLE_PLAYED_MS]; then the next alternative.
     */
    fun liveRecovery(playedMs: Long, retriedSameSource: Boolean, alternativesLeft: Boolean): Recovery = when {
        !retriedSameSource || playedMs >= LIVE_STABLE_PLAYED_MS -> Recovery.RetrySameSource
        alternativesLeft -> Recovery.NextSource
        else -> Recovery.GiveUp
    }
}

/** Autoplay on start (an owner setting): on Home, the show watched last starts after a countdown. */
object AutoplayPlan {
    const val COUNTDOWN_SEC = 10

    /** The show played last if it is still on Home, else the first tile; null when the owner has it off. */
    fun offer(state: TvState, lastPlayedItemId: String?): HomeEntry? {
        if (!state.device.autoplayOnStart) return null
        return state.home.firstOrNull { it.item.id == lastPlayedItemId } ?: state.home.firstOrNull()
    }
}

/** [tick] gets the seconds left, [seconds] down to 1; returns a second after the last. Inline, so [tick] may `return`. */
suspend inline fun countDown(seconds: Int, tick: (secondsLeft: Int) -> Unit) {
    for (left in seconds downTo 1) {
        tick(left)
        delay(1_000)
    }
}

/**
 * Left/Right: a press moves 10 s; holding steps four times a second, 10 s, then 30 s after 2 s and 60 s after 4 s.
 * Steps only move a preview target; the player seeks once on release.
 */
class SeekAccumulator(private val stepIntervalMs: Long = 250) {
    var pendingTargetMs: Long? = null
        private set
    private var lastStepAt = 0L

    /** The preview target, or null when this repeat is too soon. */
    fun onKeyDown(direction: Int, eventTimeMs: Long, downTimeMs: Long, repeatCount: Int, positionMs: Long, durationMs: Long?): Long? {
        val base = pendingTargetMs ?: positionMs
        if (repeatCount > 0 && eventTimeMs - lastStepAt < stepIntervalMs) return null
        lastStepAt = eventTimeMs
        val held = eventTimeMs - downTimeMs
        val step = when {
            repeatCount == 0 || held < 2_000 -> 10_000L
            held < 4_000 -> 30_000L
            else -> 60_000L
        }
        val upper = if (durationMs != null && durationMs > 0) max(0, durationMs - 1_000) else Long.MAX_VALUE
        return (base + direction * step).coerceIn(0, upper).also { pendingTargetMs = it }
    }

    fun commit(): Long? = pendingTargetMs.also { pendingTargetMs = null }

    fun cancel() {
        pendingTargetMs = null
    }
}

/**
 * The sources one playback went through: the ones tried (excluded from the next unpinned resolve), the server's
 * fallback order (from the last unpinned resolve: a pinned one returns none), and whether the playing source was
 * already re-resolved after an expired URL (a channel: after any failure).
 */
class SourceAttempts {
    private val tried = linkedSetOf<String>()
    private var live = false
    private var alternatives: List<String> = emptyList()

    /** Re-resolved once (403/410 after a while) and not played since. */
    var retriedSameSource: Boolean = false
        private set

    val triedCount: Int get() = tried.size
    val lastTried: String? get() = tried.lastOrNull()

    fun reset(live: Boolean = false) {
        tried.clear()
        alternatives = emptyList()
        retriedSameSource = false
        this.live = live
    }

    /** An unpinned resolve ([sourceId] null) leaves out the sources tried. */
    fun excludeFor(sourceId: String?): List<String>? = if (sourceId == null) tried.toList().ifEmpty { null } else null

    fun onResolved(sourceId: String?, alternatives: List<String>) {
        if (sourceId == null) this.alternatives = alternatives
    }

    /**
     * Not for a channel, whose first frame after a re-resolve proves little (a stream that keeps breaking off would be
     * resolved again forever): its playing time decides ([PlaybackPlan.liveRecovery]).
     */
    fun onPlaying() {
        if (!live) retriedSameSource = false
    }

    fun alternativesLeft(sourceId: String): Boolean = alternatives.any { it != sourceId && it !in tried }

    /** A resolve failed: true when an unpinned resolve of the remaining alternatives follows ([sourceId] is tried). */
    fun continueAfterFailedResolve(sourceId: String?): Boolean {
        if (sourceId == null || !alternativesLeft(sourceId)) return false
        tried += sourceId
        return true
    }

    /** The playing [sourceId] failed (a channel: or its stream ended): what to do, with the attempt recorded. */
    fun afterPlaybackError(sourceId: String, httpStatus: Int?, playedMs: Long): PlaybackPlan.Recovery {
        val recovery = if (live) {
            PlaybackPlan.liveRecovery(playedMs, retriedSameSource, alternativesLeft(sourceId))
        } else {
            PlaybackPlan.recovery(httpStatus, playedMs, retriedSameSource, alternativesLeft(sourceId))
        }
        if (recovery == PlaybackPlan.Recovery.RetrySameSource) retriedSameSource = true else tried += sourceId
        if (recovery == PlaybackPlan.Recovery.NextSource) retriedSameSource = false
        return recovery
    }
}
