package io.github.mickeiik.izle.companion.sync

import kotlin.math.abs

/**
 * Timing by ear (issue #34), ported 1:1 from `server/admin/lib.js` so that the admin card and the app say and compute
 * the same: the offset readout, the two-tap mark, the offset nudges and the speed choices.
 */
object ListenTiming {
    /** The offset nudges, in the order they are shown: the back row, then the forward row. */
    val OFFSET_NUDGES_MS: List<Long> = listOf(-30_000, -5_000, -500, 500, 5_000, 30_000)

    /** One speed choice: companion seconds per TV second. */
    data class SpeedPreset(val id: String, val label: String, val rate: Double)

    /** The speed choices; [OTHER] is the decimal field. */
    val SPEED_PRESETS: List<SpeedPreset> = listOf(
        SpeedPreset("same", "Same speed", 1.0),
        SpeedPreset("pal-film", "PAL vs film", 1.0427),
        SpeedPreset("film-pal", "Film vs PAL", 0.9591),
    )

    const val OTHER = "other"

    /** `+1:23.5`, `−0:04.0`: an offset to 0.1 s (minutes may exceed 59; a zero result is `+0:00.0`). */
    fun formatOffset(ms: Long): String {
        val tenths = Math.round(abs(ms) / 100.0)
        val sign = if (ms < 0 && tenths > 0) "−" else "+"
        val seconds = tenths % 600
        return "$sign${tenths / 600}:${(seconds / 10).toString().padStart(2, '0')}.${seconds % 10}"
    }

    /** The offset that puts the companion at [phoneMs] when the TV is at [tvMs] (`rate · tv + offset = phone`). */
    fun markOffset(tvMs: Double, phoneMs: Double, rate: Double): Long = Math.round(phoneMs - rate * tvMs)

    /** `+5 s`, `−0.5 s`: a nudge button's label. */
    fun nudgeLabel(ms: Long): String {
        val seconds = abs(ms) / 1000.0
        val text = if (seconds % 1.0 == 0.0) seconds.toLong().toString() else seconds.toString()
        return "${if (ms < 0) "−" else "+"}$text s"
    }

    /** Which speed choice [rate] is: the preset within 0.00005, else [OTHER]. */
    fun speedPreset(rate: Double): String = SPEED_PRESETS.firstOrNull { abs(it.rate - rate) < 0.00005 }?.id ?: OTHER
}
