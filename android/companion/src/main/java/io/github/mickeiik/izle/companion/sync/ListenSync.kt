package io.github.mickeiik.izle.companion.sync

import io.github.mickeiik.izle.data.api.Anchor
import io.github.mickeiik.izle.data.api.LinkTiming
import io.github.mickeiik.izle.data.api.NowPlaying
import io.github.mickeiik.izle.domain.IsoTime
import java.util.Locale
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToLong
import kotlin.math.sign

/**
 * The Listen along maths, ported 1:1 from `server/admin/lib.js` (section "Listen along"): where the TV is, where this
 * phone should be, and what its player should do about the difference. Same thresholds as the admin page.
 */
object ListenSync {
    const val SEEK_MS = 1500
    const val COARSE_MS = 300
    const val FINE_MS = 40
    const val COARSE_ADJ = 0.05
    const val FINE_ADJ = 0.02
    const val MIN_RATE = 0.9
    const val MAX_RATE = 1.1
    const val SAMPLE_MAX_RTT_MS = 1000L

    /** A playback report counts as active for this long (lib.js `isActive`). */
    private const val ACTIVE_MS = 2 * 60_000L
    private val ACTIVE_STATES = setOf("starting", "playing", "paused")

    /** One `/now` call: the phone's clock around it and the server's clock in its answer. */
    data class ClockSample(val sentAt: Long, val receivedAt: Long, val serverNowMs: Long)

    enum class Action { Pause, Seek, Play }

    enum class SyncState(val label: String) {
        Paused("paused"), Waiting("waiting"), Seeking("seeking"), Synced("synced"), CatchingUp("catching up"), HoldingBack("holding back")
    }

    /** [toMs]: where to seek, for [Action.Seek] only; [errorMs] = target − actual. */
    data class Decision(val action: Action, val rate: Double, val state: SyncState, val errorMs: Double, val toMs: Double? = null)

    /** Where the TV is at [serverNowMs]; never before the anchor. Null without an anchor. */
    fun tvPositionAt(anchor: Anchor?, serverNowMs: Long): Double? {
        if (anchor == null) return null
        return anchor.positionMs + if (anchor.playing) max(0L, serverNowMs - anchor.atMs) * anchor.rate else 0.0
    }

    /** `rate · tv + offset`, plus this phone's nudge for its output latency. */
    fun companionTarget(tvPositionMs: Double, link: LinkTiming, nudgeMs: Long = 0): Double =
        link.rate * tvPositionMs + link.offsetMs + nudgeMs

    /**
     * What the phone's player should do: pause with the TV, seek when far off, else play a little faster or slower
     * than the nominal rate until the error is within [FINE_MS].
     */
    fun syncDecision(targetMs: Double, actualMs: Double, tvPlaying: Boolean, nominalRate: Double): Decision {
        val errorMs = targetMs - actualMs
        if (!tvPlaying) return Decision(Action.Pause, nominalRate, SyncState.Paused, errorMs)
        if (targetMs < 0) return Decision(Action.Pause, nominalRate, SyncState.Waiting, errorMs)
        if (abs(errorMs) > SEEK_MS) return Decision(Action.Seek, nominalRate, SyncState.Seeking, errorMs, toMs = targetMs)
        val adj = if (abs(errorMs) > COARSE_MS) COARSE_ADJ else if (abs(errorMs) > FINE_MS) FINE_ADJ else 0.0
        val rate = min(MAX_RATE, max(MIN_RATE, nominalRate * (1 + sign(errorMs) * adj)))
        val state = if (adj == 0.0) SyncState.Synced else if (errorMs > 0) SyncState.CatchingUp else SyncState.HoldingBack
        return Decision(Action.Play, rate, state, errorMs)
    }

    /**
     * Server clock minus phone clock: the sample with the shortest round trip wins; long ones (a long-poll that
     * waited) are ignored. Null without a usable sample. Rounded to the millisecond (lib.js keeps the half).
     */
    fun clockOffset(samples: List<ClockSample>): Long? {
        var best: ClockSample? = null
        for (s in samples) {
            val rtt = s.receivedAt - s.sentAt
            if (rtt in 0..SAMPLE_MAX_RTT_MS && (best == null || rtt < best.receivedAt - best.sentAt)) best = s
        }
        return best?.let { (it.serverNowMs - (it.sentAt + it.receivedAt) / 2.0).roundToLong() }
    }

    /** lib.js isActive: a state in starting/playing/paused reported within 2 min of `nowMs`. */
    fun isActive(nowPlaying: NowPlaying?, nowMs: Long): Boolean {
        if (nowPlaying == null || nowPlaying.state !in ACTIVE_STATES) return false
        val updatedAt = nowPlaying.updatedAt?.let(IsoTime::parseEpochMs) ?: return false
        return nowMs - updatedAt < ACTIVE_MS
    }

    /** `+600 ms`, `−12 ms`, `+1.5 s`; `–` when unknown. */
    fun formatDrift(ms: Double?): String {
        if (ms == null || !ms.isFinite()) return "–"
        val sign = if (ms < 0) "−" else "+"
        val abs = abs(ms)
        return if (abs >= 1000) "$sign${String.format(Locale.ROOT, "%.1f", abs / 1000)} s" else "$sign${Math.round(abs)} ms"
    }

    /** `1:02:05.4`, `1:05.0`, for the sync status line; `–` when unknown. */
    fun formatPosition(ms: Double?): String {
        if (ms == null || !ms.isFinite() || ms < 0) return "–"
        return "${formatClock(ms)}.${floor((ms % 1000) / 100).toLong()}"
    }

    /** lib.js formatClock: `1:02:03` or `12:34`. */
    private fun formatClock(ms: Double): String {
        val total = floor(ms / 1000).toLong()
        val h = total / 3600
        val m = (total % 3600) / 60
        val s = total % 60
        fun pad(n: Long) = n.toString().padStart(2, '0')
        return if (h > 0) "$h:${pad(m)}:${pad(s)}" else "$m:${pad(s)}"
    }
}
