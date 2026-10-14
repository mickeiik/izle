package io.github.mickeiik.izle.domain

import io.github.mickeiik.izle.data.api.ProgressStatus
import kotlin.math.max
import kotlin.math.min

/**
 * The TV's playback rules, kept free of Android types so they are unit-tested on the JVM.
 * See docs/ux/senior-tv.md for the reasoning behind each number.
 */
object PlaybackPlan {
    /** Saved positions earlier than this start the episode from the beginning. */
    const val RESUME_MIN_POSITION_MS = 30_000L

    /** Resuming rewinds this much so the viewer finds the thread again. */
    const val RESUME_REWIND_MS = 5_000L

    /** Credits allowance: an episode counts as finished when at most this much is left… */
    const val END_MIN_REMAINING_MS = 120_000L

    /** …or this fraction of its duration, whichever is larger… */
    const val END_FRACTION = 0.05

    /** …but never more than this fraction, so short episodes are not "finished" right after they start. */
    const val END_MAX_FRACTION = 0.10

    const val HEARTBEAT_INTERVAL_MS = 15_000L
    const val AUTO_NEXT_COUNTDOWN_SEC = 10
    const val FINISHED_MESSAGE_MS = 8_000L
    const val FAILED_AUTO_HOME_SEC = 30
    const val INFO_OVERLAY_MS = 4_000L

    /** HTTP 403/410 after this much playback most likely means an expired URL: re-resolve the same source. */
    const val EXPIRED_URL_MIN_PLAYED_MS = 5 * 60_000L

    /** Largest sample age a progress report may carry (the server rejects more). */
    const val MAX_REPORT_AGE_MS = 60_000L

    /** How old a queued report's position sample is when it is finally sent. */
    fun reportAgeMs(sampledAtMs: Long, nowMs: Long): Long = (nowMs - sampledAtMs).coerceIn(0, MAX_REPORT_AGE_MS)

    /** The status of a live report: what the viewer wants, whatever the player is doing at that instant. */
    fun liveStatus(playWhenReady: Boolean): ProgressStatus = if (playWhenReady) ProgressStatus.Playing else ProgressStatus.Paused

    /** Remaining time at or below which an episode counts as finished. */
    fun endThresholdMs(durationMs: Long): Long {
        if (durationMs <= 0) return 0
        val wanted = max(END_MIN_REMAINING_MS, (durationMs * END_FRACTION).toLong())
        return min(wanted, (durationMs * END_MAX_FRACTION).toLong())
    }

    fun isFinished(positionMs: Long, durationMs: Long?): Boolean {
        if (durationMs == null || durationMs <= 0) return false
        return durationMs - positionMs <= endThresholdMs(durationMs)
    }

    /** Where to start an episode with this saved position: 0 (from the beginning) or a point a bit before it. */
    fun resumePositionMs(savedPositionMs: Long?, durationMs: Long?): Long {
        if (savedPositionMs == null || savedPositionMs < RESUME_MIN_POSITION_MS) return 0
        if (isFinished(savedPositionMs, durationMs)) return 0
        return max(0, savedPositionMs - RESUME_REWIND_MS)
    }

    /** The status to report when the viewer leaves the player at this position. */
    fun stopStatus(positionMs: Long, durationMs: Long?): ProgressStatus =
        if (isFinished(positionMs, durationMs)) ProgressStatus.Finished else ProgressStatus.Stopped

    enum class Recovery { RetrySameSource, NextSource, GiveUp }

    /**
     * What to do after a playback error. [httpStatus] is the upstream HTTP status when the error was an HTTP
     * response, [playedMs] how long this source has been playing.
     */
    fun recovery(httpStatus: Int?, playedMs: Long, retriedSameSource: Boolean, alternativesLeft: Boolean): Recovery = when {
        (httpStatus == 403 || httpStatus == 410) && playedMs > EXPIRED_URL_MIN_PLAYED_MS && !retriedSameSource ->
            Recovery.RetrySameSource
        alternativesLeft -> Recovery.NextSource
        else -> Recovery.GiveUp
    }
}

/**
 * Left/Right seeking: a press moves 10 s; holding the key keeps stepping four times a second, 10 s at first,
 * then 30 s after 2 s and 60 s after 4 s. Steps only move a preview target; the player seeks once on release.
 */
class SeekAccumulator(private val stepIntervalMs: Long = 250) {
    private var targetMs: Long? = null
    private var lastStepAt = 0L

    val pendingTargetMs: Long? get() = targetMs

    /**
     * A key DOWN (first or repeat) in [direction] (-1 or +1). Returns the new preview target, or null when this
     * repeat is too soon after the last step.
     */
    fun onKeyDown(direction: Int, eventTimeMs: Long, downTimeMs: Long, repeatCount: Int, positionMs: Long, durationMs: Long?): Long? {
        val base = targetMs ?: positionMs
        if (repeatCount > 0 && eventTimeMs - lastStepAt < stepIntervalMs) return null
        lastStepAt = eventTimeMs
        val held = eventTimeMs - downTimeMs
        val step = when {
            repeatCount == 0 || held < 2_000 -> 10_000L
            held < 4_000 -> 30_000L
            else -> 60_000L
        }
        val upper = if (durationMs != null && durationMs > 0) max(0, durationMs - 1_000) else Long.MAX_VALUE
        val next = (base + direction * step).coerceIn(0, upper)
        targetMs = next
        return next
    }

    /** The key was released: the position to seek to, if any. */
    fun commit(): Long? = targetMs.also { targetMs = null }

    fun cancel() {
        targetMs = null
    }
}
