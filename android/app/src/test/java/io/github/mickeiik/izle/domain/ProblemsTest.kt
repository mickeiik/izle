package io.github.mickeiik.izle.domain

import android.os.Bundle
import androidx.annotation.OptIn
import androidx.media3.common.PlaybackException
import androidx.media3.common.util.UnstableApi
import io.github.mickeiik.izle.data.api.ApiException
import io.github.mickeiik.izle.data.api.ApiJson
import io.github.mickeiik.izle.data.api.ProblemReport
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.IOException
import java.net.SocketTimeoutException

class ProblemsTest {
    /** A made-up signed URL (nothing real): what a hostile exception message may contain. */
    private val signedUrl = "https://cdn.example.net/s/eyJhbGciOiJIUzI1NiJ9.c2VjcmV0/seg042.ts?token=SECRET-TOKEN-123&sig=abcdef0123456789" // gitleaks:allow

    private val show = PlayableRef.Episode("show.e1")

    private fun json(report: ProblemReport?) = ApiJson.encodeToString(ProblemReport.serializer(), report!!)

    private fun assertNothingSecret(body: String) {
        for (secret in listOf("https://", "cdn.example.net", "SECRET-TOKEN-123", "token=", "sig=", "eyJhbGciOiJIUzI1NiJ9", "seg042")) {
            assertFalse("$secret leaked into $body", body.contains(secret))
        }
    }

    @Test
    fun aHostilePlayerErrorReportsClassNamesAndCodesOnly() {
        // Media3 and OkHttp put the request URL (with its signature and token) into exception messages.
        val cause = IOException("Response code: 403 for $signedUrl", SocketTimeoutException("timeout reading $signedUrl"))
        val error = HostilePlaybackException("Source error: $signedUrl", cause)
        val report = Problems.playbackError(
            error, error.errorCodeName, httpStatus = 403, ref = PlayableRef.Episode("film.film"), sourceId = "signed-hls",
            sessionId = "Q8mQ8mQ8mQ8mQ8mQ", positionMs = 61_000, appVersion = "0.2.0",
        )
        val body = json(report)
        assertNothingSecret(body)
        assertEquals(
            """{"kind":"playback","code":"ERROR_CODE_IO_BAD_HTTP_STATUS","episodeId":"film.film","sourceId":"signed-hls",""" +
                """"sessionId":"Q8mQ8mQ8mQ8mQ8mQ","positionMs":61000,"httpStatus":403,""" +
                """"detail":"HostilePlaybackException < IOException < SocketTimeoutException","appVersion":"0.2.0"}""",
            body,
        )
    }

    @Test
    fun aFailedResolveCarriesTheServersCodeOrNetwork() {
        val api = Problems.resolveFailure(ApiException(502, "no_playable_source"), show, null, "0.2.0")
        assertEquals(ProblemReport("resolve", "no_playable_source", episodeId = "show.e1", httpStatus = 502, appVersion = "0.2.0"), api)
        assertEquals("http_403", Problems.resolveFailure(ApiException(403, "http_403"), show, "a", "0.2.0")!!.code)
        val network = Problems.resolveFailure(IOException("failed to connect to $signedUrl"), show, "a", "0.2.0")
        assertEquals(Triple("network", "IOException", null), network?.let { Triple(it.code, it.detail, it.httpStatus) })
        assertNothingSecret(json(network))
        // A removed device is told so elsewhere; its report would be refused anyway.
        assertNull(Problems.resolveFailure(ApiException(401, "unauthorized"), show, null, "0.2.0"))
    }

    @Test
    fun givingUpSaysHowManySourcesWereTried() {
        assertEquals("tried 3 sources", Problems.gaveUp(show, "c", 5_000, 3, "0.2.0").detail)
        assertEquals("tried 1 source", Problems.gaveUp(show, "c", 5_000, 1, "0.2.0").detail)
        val r = Problems.gaveUp(show, null, null, 0, "0.2.0", reason = "then resolve failed: no_playable_source")
        assertEquals("playback" to "gave_up", r.kind to r.code)
        assertEquals("tried 0 sources, then resolve failed: no_playable_source", r.detail)
    }

    @Test
    fun aChannelIsNamedByItsItemWithoutAPosition() {
        val channel = PlayableRef.Channel("news-24")
        assertEquals(
            """{"kind":"playback","code":"gave_up","itemId":"news-24","sourceId":"main","detail":"tried 2 sources","appVersion":"0.3.0"}""",
            json(Problems.gaveUp(channel, "main", positionMs = null, sourcesTried = 2, appVersion = "0.3.0")),
        )
        assertEquals(
            """{"kind":"resolve","code":"no_playable_source","itemId":"news-24","httpStatus":502,"appVersion":"0.3.0"}""",
            json(Problems.resolveFailure(ApiException(502, "no_playable_source"), channel, null, "0.3.0")),
        )
        val behind = Problems.playbackError(IOException(), "ERROR_CODE_BEHIND_LIVE_WINDOW", null, channel, "main", "Q8m", null, "0.3.0")
        assertEquals(Triple("news-24", null, null), Triple(behind.itemId, behind.episodeId, behind.positionMs))
        // An episode is named by its id alone.
        assertNull(Problems.gaveUp(show, "c", 5_000, 1, "0.2.0").itemId)
    }

    @Test
    fun anOutageIsReportedWithItsLength() {
        val outage = ProblemReport("network", "server_unreachable", detail = "unreachable for 7 min 5 s", appVersion = "0.2.0")
        assertEquals(outage, Problems.serverUnreachable(7 * 60_000L + 5_000, "0.2.0"))
        assertEquals("unreachable for 2 h 3 min", Problems.serverUnreachable(2 * 3_600_000L + 3 * 60_000L, "0.2.0").detail)
    }

    @Test
    fun fieldsStayWithinTheServersLimits() {
        assertEquals("invalid_error_code", Problems.code("invalid error code"))
        assertEquals("a_b_c", Problems.code("a/b?c"))
        assertEquals("unknown", Problems.code("  "))
        assertEquals(64, Problems.code("x".repeat(100)).length)
        val long = Problems.playbackError(IOException(), "E", null, null, null, null, -5, "1".repeat(80))
        assertEquals(40, long.appVersion!!.length)
        assertEquals(0L, long.positionMs)
        assertNull(Problems.playbackError(IOException(), "E", 99, null, null, null, null, "v").httpStatus)
        val report = ProblemReport(kind = "other", code = "x")
        assertEquals(0L, Problems.aged(report, -3).ageMs)
        assertEquals(1_500L, Problems.aged(report, 1_500).ageMs)
        assertEquals(Problems.MAX_AGE_MS, Problems.aged(report, 3 * Problems.MAX_AGE_MS).ageMs)
    }

    /** A real PlaybackException; the protected constructor only stores its fields, so it works on the JVM. */
    @OptIn(UnstableApi::class)
    private class HostilePlaybackException(message: String, cause: Throwable) :
        PlaybackException(message, cause, ERROR_CODE_IO_BAD_HTTP_STATUS, Bundle.EMPTY, 0L)
}
