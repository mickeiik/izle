// STUB for compilation; agent C's implementation replaces this file at integration.
package io.github.mickeiik.izle.companion.sync

import java.util.Locale
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.roundToLong

/** The two formatters the status line needs, as server/admin/lib.js has them. */
object ListenSync {
    /** `+600 ms`, `−12 ms` (typographic minus), `+1.5 s`; `–` when unknown. */
    fun formatDrift(ms: Double?): String {
        if (ms == null || !ms.isFinite()) return "–"
        val sign = if (ms < 0) "−" else "+"
        val a = abs(ms)
        return if (a >= 1000) "$sign${String.format(Locale.ROOT, "%.1f", a / 1000)} s" else "$sign${a.roundToLong()} ms"
    }

    /** `1:02:05.4`, `1:05.0`; `–` when unknown or negative. */
    fun formatPosition(ms: Double?): String {
        if (ms == null || !ms.isFinite() || ms < 0) return "–"
        val total = floor(ms / 1000).toLong()
        val h = total / 3600
        val m = (total % 3600) / 60
        val s = total % 60
        val clock = if (h > 0) "$h:${pad(m)}:${pad(s)}" else "$m:${pad(s)}"
        return "$clock.${floor((ms % 1000) / 100).toLong()}"
    }

    private fun pad(n: Long) = n.toString().padStart(2, '0')
}
