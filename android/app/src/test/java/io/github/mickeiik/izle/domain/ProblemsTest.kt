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
            error, error.errorCodeName, httpStatus = 403, episodeId = "film.film", sourceId = "signed-hls",
            sessionId = "Q8mQ8mQ8mQ8mQ8mQ", positionMs = 61_000, appVersion = "0.2.0",
        )
        assertEquals("playback", report.kind)
        assertEquals("ERROR_CODE_IO_BAD_HTTP_STATUS", report.code)
        assertEquals(403, report.httpStatus)
        assertEquals("HostilePlaybackException < IOException < SocketTimeoutException", report.detail)
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
        val api = Problems.resolveFailure(ApiException(502, "no_playable_source"), "show.e1", null, "0.2.0")!!
        assertEquals("resolve", api.kind)
        assertEquals("no_playable_source", api.code)
        assertEquals(502, api.httpStatus)
        assertEquals("http_403", Problems.resolveFailure(ApiException(403, "http_403"), "show.e1", "a", "0.2.0")!!.code)
        val network = Problems.resolveFailure(IOException("failed to connect to $signedUrl"), "show.e1", "a", "0.2.0")!!
        assertEquals("network", network.code)
        assertEquals("IOException", network.detail)
        assertNull(network.httpStatus)
        assertNothingSecret(json(network))
        // A removed device is told so elsewhere; its report would be refused anyway.
        assertNull(Problems.resolveFailure(ApiException(401, "unauthorized"), "show.e1", null, "0.2.0"))
    }

    @Test
    fun givingUpSaysHowManySourcesWereTried() {
        assertEquals("tried 3 sources", Problems.gaveUp("show.e1", "c", 5_000, 3, "0.2.0").detail)
        assertEquals("tried 1 source", Problems.gaveUp("show.e1", "c", 5_000, 1, "0.2.0").detail)
        val r = Problems.gaveUp("show.e1", null, null, 0, "0.2.0", reason = "then resolve failed: no_playable_source")
        assertEquals("gave_up", r.code)
        assertEquals("playback", r.kind)
        assertEquals("tried 0 sources, then resolve failed: no_playable_source", r.detail)
    }

    @Test
    fun anOutageIsReportedWithItsLength() {
        val r = Problems.serverUnreachable(7 * 60_000L + 5_000, "0.2.0")
        assertEquals("network", r.kind)
        assertEquals("server_unreachable", r.code)
        assertEquals("unreachable for 7 min 5 s", r.detail)
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
