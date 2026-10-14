package io.github.mickeiik.izle.domain

/**
 * The sources one playback went through, for the fallback after errors: the ones tried (excluded from the next
 * unpinned resolve), the server's fallback order, and whether the playing source was already re-resolved after an
 * expired URL. A pinned re-resolve returns no alternatives, so the fallback order of the last unpinned resolve is kept
 * and playback continues with it if the pinned source fails again.
 */
class SourceAttempts {
    private val tried = linkedSetOf<String>()

    /** The server's fallback order from the last unpinned resolve. */
    private var alternatives: List<String> = emptyList()

    /** The playing source was re-resolved once (403/410 after a while) and has not played since. */
    var retriedSameSource: Boolean = false
        private set

    val triedCount: Int get() = tried.size

    /** The source tried last, if any. */
    val lastTried: String? get() = tried.lastOrNull()

    /** A new episode (or Try again): nothing tried yet. */
    fun reset() {
        tried.clear()
        alternatives = emptyList()
        retriedSameSource = false
    }

    /** What a resolve for [sourceId] (null: unpinned) leaves out: the sources tried, or null; a pinned one nothing. */
    fun excludeFor(sourceId: String?): List<String>? = if (sourceId == null) tried.toList().ifEmpty { null } else null

    /** A resolve for [sourceId] (null: unpinned) answered with these [alternatives]; only an unpinned one counts. */
    fun onResolved(sourceId: String?, alternatives: List<String>) {
        if (sourceId == null) this.alternatives = alternatives
    }

    /** The source plays (again): a later expiry may be re-resolved the same way. */
    fun onPlaying() {
        retriedSameSource = false
    }

    /** Whether a source other than [sourceId] and not tried yet remains in the fallback order. */
    fun alternativesLeft(sourceId: String): Boolean = alternatives.any { it != sourceId && it !in tried }

    /**
     * A resolve for [sourceId] failed: true when playback continues with an unpinned resolve of the remaining
     * alternatives ([sourceId] is then tried), false when nothing is left (an unpinned resolve already had them all).
     */
    fun continueAfterFailedResolve(sourceId: String?): Boolean {
        if (sourceId == null || !alternativesLeft(sourceId)) return false
        tried += sourceId
        return true
    }

    /**
     * The playing [sourceId] failed after [playedMs] of playback with [httpStatus]: what to do (see
     * [PlaybackPlan.recovery]), with the attempt recorded — re-resolving the same source is remembered, moving on or
     * giving up marks it tried.
     */
    fun afterPlaybackError(sourceId: String, httpStatus: Int?, playedMs: Long): PlaybackPlan.Recovery {
        val recovery = PlaybackPlan.recovery(httpStatus, playedMs, retriedSameSource, alternativesLeft(sourceId))
        when (recovery) {
            PlaybackPlan.Recovery.RetrySameSource -> retriedSameSource = true
            PlaybackPlan.Recovery.NextSource -> {
                tried += sourceId
                retriedSameSource = false
            }
            PlaybackPlan.Recovery.GiveUp -> tried += sourceId
        }
        return recovery
    }
}
