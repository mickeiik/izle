package io.github.mickeiik.izle.domain

import java.util.Calendar
import java.util.GregorianCalendar
import java.util.TimeZone
import kotlin.math.max

/**
 * When to resolve the playing source again before its stream URL expires (the resolve answer's `expiresAt`), so a
 * signed URL is replaced while it still works instead of failing with 403/410 mid-episode.
 */
object ExpiryPlan {
    /** A stream valid for less than this when it arrives is left to the 403/410 path. */
    const val MIN_VALIDITY_MS = 90_000L
    const val REFRESH_LEAD_MS = 60_000L

    /** Never more than one refresh in this time… */
    const val MIN_SPACING_MS = 60_000L

    /** …except the single retry this long after a refresh that failed (network or server error). */
    const val RETRY_DELAY_MS = 30_000L

    /** From the moment the answer arrived; [serverNowMs] (its `Date`) keeps a TV with a wrong clock on schedule. */
    fun validForMs(expiresAt: String?, serverNowMs: Long?, localNowMs: Long): Long? =
        expiresAt?.let(IsoTime::parseEpochMs)?.let { it - (serverNowMs ?: localNowMs) }

    /** The delay before the next refresh, or null for none; [sinceLastRefreshMs] null: never refreshed. */
    fun refreshDelayMs(remainingMs: Long?, sinceLastRefreshMs: Long?): Long? {
        if (remainingMs == null || remainingMs < MIN_VALIDITY_MS) return null
        val spacing = if (sinceLastRefreshMs == null) 0 else MIN_SPACING_MS - sinceLastRefreshMs
        return max(remainingMs - REFRESH_LEAD_MS, spacing).coerceAtLeast(0)
    }

    /** Network failures (null) and server errors are worth one retry; a 4xx answer will not change in 30 s. */
    fun isRetryable(httpStatus: Int?): Boolean = httpStatus == null || httpStatus >= 500

    /** Null leaves the stream to the 403/410 path. */
    fun retryDelayMs(retryable: Boolean, alreadyRetried: Boolean, remainingMs: Long): Long? =
        if (retryable && !alreadyRetried && remainingMs > RETRY_DELAY_MS) RETRY_DELAY_MS else null
}

/**
 * ISO 8601 date-times as the contract writes them (`2026-10-14T12:00:00.000Z`, seconds and fraction optional, `Z` or
 * `±HH:MM`). Not `java.time`, which needs API 26.
 */
object IsoTime {
    private val PATTERN = Regex("""^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$""")

    /** Null when [text] is not such a date-time (or not a real calendar date). */
    fun parseEpochMs(text: String): Long? {
        val g = PATTERN.matchEntire(text.trim())?.groupValues ?: return null
        val zone = g[8]
        val offsetMinutes = if (zone == "Z") 0 else {
            val hours = zone.substring(1, 3).toInt()
            val minutes = zone.substring(4, 6).toInt()
            if (hours > 23 || minutes > 59) return null
            (hours * 60 + minutes) * if (zone[0] == '-') -1 else 1
        }
        val second = g[6].ifEmpty { "0" }.toInt()
        if (second > 60) return null
        // Not lenient: a field out of range (February 30th, 24:00) makes timeInMillis throw.
        val utc = GregorianCalendar(TimeZone.getTimeZone("UTC")).apply {
            isLenient = false
            clear()
            set(g[1].toInt(), g[2].toInt() - 1, g[3].toInt(), g[4].toInt(), g[5].toInt(), second.coerceAtMost(59))
            set(Calendar.MILLISECOND, g[7].padEnd(3, '0').take(3).toInt())
        }
        val local = try {
            utc.timeInMillis
        } catch (e: IllegalArgumentException) {
            return null
        }
        return local - offsetMinutes * 60_000L
    }
}
