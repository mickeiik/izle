package io.github.mickeiik.izle.domain

import kotlin.math.max

/**
 * When to resolve the playing source again before its stream URL expires (the resolve answer's `expiresAt`), so a
 * signed URL is replaced while it still works instead of failing with 403/410 mid-episode.
 */
object ExpiryPlan {
    /** A stream valid for less than this when it arrives is left to the 403/410 path. */
    const val MIN_VALIDITY_MS = 90_000L

    /** Refresh this long before the expiry. */
    const val REFRESH_LEAD_MS = 60_000L

    /** Never more than one refresh in this time… */
    const val MIN_SPACING_MS = 60_000L

    /** …except the single retry this long after a refresh that failed (network or server error). */
    const val RETRY_DELAY_MS = 30_000L

    /**
     * How long the stream stays valid from the moment the answer arrived. [serverNowMs] is the server's clock then (the
     * `Date` header), so a TV with a wrong clock still schedules correctly; else the TV's own clock ([localNowMs]).
     */
    fun validForMs(expiresAt: String?, serverNowMs: Long?, localNowMs: Long): Long? =
        expiresAt?.let(IsoTime::parseEpochMs)?.let { it - (serverNowMs ?: localNowMs) }

    /**
     * The delay before the next refresh, or null for none. [remainingMs]: how long the current stream stays valid
     * from now; [sinceLastRefreshMs]: how long ago this playback last refreshed (null: never).
     */
    fun refreshDelayMs(remainingMs: Long?, sinceLastRefreshMs: Long?): Long? {
        if (remainingMs == null || remainingMs < MIN_VALIDITY_MS) return null
        val spacing = if (sinceLastRefreshMs == null) 0 else MIN_SPACING_MS - sinceLastRefreshMs
        return max(remainingMs - REFRESH_LEAD_MS, spacing).coerceAtLeast(0)
    }

    /** Network failures (null) and server errors are worth one retry; a 4xx answer will not change in 30 s. */
    fun isRetryable(httpStatus: Int?): Boolean = httpStatus == null || httpStatus >= 500

    /** After a failed refresh: the delay before the one retry, or null to leave the stream to the 403/410 path. */
    fun retryDelayMs(retryable: Boolean, alreadyRetried: Boolean, remainingMs: Long): Long? =
        if (retryable && !alreadyRetried && remainingMs > RETRY_DELAY_MS) RETRY_DELAY_MS else null
}

/**
 * ISO 8601 date-times as the contract writes them (`2026-10-14T12:00:00.000Z`, seconds and fraction optional,
 * `Z` or `±HH:MM`). Hand-written because `java.time` needs API 26 and the app supports API 24.
 */
object IsoTime {
    private val PATTERN = Regex("""^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$""")

    /** Milliseconds since the epoch, or null when [text] is not such a date-time (or not a real calendar date). */
    fun parseEpochMs(text: String): Long? {
        val m = PATTERN.matchEntire(text.trim()) ?: return null
        val g = m.groupValues
        val year = g[1].toInt()
        val month = g[2].toInt()
        val day = g[3].toInt()
        val hour = g[4].toInt()
        val minute = g[5].toInt()
        val second = g[6].ifEmpty { "0" }.toInt()
        val millis = g[7].padEnd(3, '0').take(3).toInt()
        if (month !in 1..12 || day !in 1..daysInMonth(year, month) || hour > 23 || minute > 59 || second > 60) return null
        val offsetMinutes = when (val zone = g[8]) {
            "Z" -> 0
            else -> {
                val hours = zone.substring(1, 3).toInt()
                val minutes = zone.substring(4, 6).toInt()
                if (hours > 23 || minutes > 59) return null
                (hours * 60 + minutes) * if (zone[0] == '-') -1 else 1
            }
        }
        val days = daysFromCivil(year, month, day)
        val local = ((days * 24 + hour) * 60 + minute) * 60_000 + second.coerceAtMost(59) * 1_000L + millis
        return local - offsetMinutes * 60_000L
    }

    private fun isLeap(year: Int) = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0

    private fun daysInMonth(year: Int, month: Int) = when (month) {
        2 -> if (isLeap(year)) 29 else 28
        4, 6, 9, 11 -> 30
        else -> 31
    }

    /** Days since 1970-01-01 of a proleptic Gregorian date (H. Hinnant's `days_from_civil`). */
    private fun daysFromCivil(year: Int, month: Int, day: Int): Long {
        val y = if (month <= 2) year - 1 else year
        val era = (if (y >= 0) y else y - 399) / 400
        val yearOfEra = y - era * 400
        val dayOfYear = (153 * (if (month > 2) month - 3 else month + 9) + 2) / 5 + day - 1
        val dayOfEra = yearOfEra * 365 + yearOfEra / 4 - yearOfEra / 100 + dayOfYear
        return era.toLong() * 146_097 + dayOfEra - 719_468
    }
}
