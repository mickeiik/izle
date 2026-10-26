package io.github.mickeiik.izle.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.OffsetDateTime

class ExpiryPlanTest {
    @Test
    fun refreshesAMinuteBeforeTheExpiryAtMostOnceAMinute() {
        assertEquals(40_000L, ExpiryPlan.refreshDelayMs(remainingMs = 100_000, sinceLastRefreshMs = null))
        assertEquals(30_000L, ExpiryPlan.refreshDelayMs(remainingMs = 90_000, sinceLastRefreshMs = null))
        assertEquals(6 * 3_600_000L - 60_000, ExpiryPlan.refreshDelayMs(remainingMs = 6 * 3_600_000L, sinceLastRefreshMs = null))
        // A stream valid for less than 90 s is left to the 403/410 path.
        assertNull(ExpiryPlan.refreshDelayMs(remainingMs = 89_999, sinceLastRefreshMs = null))
        assertNull(ExpiryPlan.refreshDelayMs(remainingMs = -5_000, sinceLastRefreshMs = null))
        assertNull(ExpiryPlan.refreshDelayMs(remainingMs = null, sinceLastRefreshMs = null))
        // Just refreshed and the new URL again lives 100 s: wait for the minute to pass (40 s before the expiry).
        assertEquals(60_000L, ExpiryPlan.refreshDelayMs(remainingMs = 100_000, sinceLastRefreshMs = 0))
        assertEquals(40_000L, ExpiryPlan.refreshDelayMs(remainingMs = 100_000, sinceLastRefreshMs = 20_000))
        assertEquals(40_000L, ExpiryPlan.refreshDelayMs(remainingMs = 100_000, sinceLastRefreshMs = 600_000))
    }

    @Test
    fun oneRetryThirtySecondsLaterForNetworkAndServerErrors() {
        assertEquals(listOf(true, true, false, false), listOf(null, 502, 403, 404).map(ExpiryPlan::isRetryable))
        assertEquals(30_000L, ExpiryPlan.retryDelayMs(retryable = true, alreadyRetried = false, remainingMs = 60_000))
        assertNull(ExpiryPlan.retryDelayMs(retryable = true, alreadyRetried = true, remainingMs = 60_000))
        assertNull(ExpiryPlan.retryDelayMs(retryable = false, alreadyRetried = false, remainingMs = 60_000))
        // It would have expired by then: the 403/410 path takes over.
        assertNull(ExpiryPlan.retryDelayMs(retryable = true, alreadyRetried = false, remainingMs = 30_000))
    }

    @Test
    fun validityIsMeasuredOnTheServersClockWhenKnown() {
        val expires = "2026-10-14T12:01:40.000Z"
        val serverNow = OffsetDateTime.parse("2026-10-14T12:00:00Z").toInstant().toEpochMilli()
        // The TV's clock is 10 minutes behind; the server's Date header keeps the schedule right.
        assertEquals(100_000L, ExpiryPlan.validForMs(expires, serverNowMs = serverNow, localNowMs = serverNow - 600_000))
        assertEquals(700_000L, ExpiryPlan.validForMs(expires, serverNowMs = null, localNowMs = serverNow - 600_000))
        assertNull(ExpiryPlan.validForMs(null, serverNow, serverNow))
        assertNull(ExpiryPlan.validForMs("tomorrow", serverNow, serverNow))
    }

    @Test
    fun parsesTheContractsIso8601Forms() {
        for (text in listOf(
            "2026-10-14T12:00:00.000Z",
            "2026-10-14T12:00:00Z",
            "2026-10-14T12:00Z",
            "2026-10-14T14:30:15.5+02:30",
            "2026-10-14T01:02:03.123456789-07:00",
            "1970-01-01T00:00:00Z",
            "2000-02-29T23:59:59.999Z",
            "2400-12-31T23:59:59Z",
            "1969-07-20T20:17:40Z",
        )) {
            // java.time (API 26+, so only in tests) is the reference.
            assertEquals(text, OffsetDateTime.parse(text).toInstant().toEpochMilli(), IsoTime.parseEpochMs(text))
        }
    }

    @Test
    fun rejectsWhatIsNotADateTime() {
        for (text in listOf("", "2026-10-14", "2026-10-14T12:00:00", "2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z", "2026-10-14T24:00:00Z", "2026-10-14T12:00:00+25:00", "now")) {
            assertNull(text, IsoTime.parseEpochMs(text))
        }
    }
}
