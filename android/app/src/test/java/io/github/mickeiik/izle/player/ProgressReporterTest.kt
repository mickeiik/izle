package io.github.mickeiik.izle.player

import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.data.api.ApiException
import io.github.mickeiik.izle.data.api.ProgressReport
import io.github.mickeiik.izle.data.api.ProgressStatus
import io.github.mickeiik.izle.data.api.ProgressStatus.Finished
import io.github.mickeiik.izle.data.api.ProgressStatus.Paused
import io.github.mickeiik.izle.data.api.ProgressStatus.Playing
import io.github.mickeiik.izle.data.api.ProgressStatus.Stopped
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.IOException

@OptIn(ExperimentalCoroutinesApi::class)
class ProgressReporterTest {
    private val api = ApiClient("http://tv.test/".toHttpUrl(), "device-token", OkHttpClient())

    private data class Sent(val atMs: Long, val report: ProgressReport)

    private val sent = mutableListOf<Sent>()

    /** What each send does in turn (throw, take time); once empty, sends succeed at once. */
    private val answers = ArrayDeque<suspend () -> Unit>()
    private var finalsDelivered = 0

    /** The queue runs on the test's virtual clock, outside the test's job (like the application scope it stands for). */
    private fun TestScope.reporter() = ProgressReporter(
        CoroutineScope(StandardTestDispatcher(testScheduler)),
        send = { _, report ->
            sent += Sent(testScheduler.currentTime, report)
            answers.removeFirstOrNull()?.invoke()
        },
        onFinalDelivered = { finalsDelivered++ },
        clock = { testScheduler.currentTime },
    )

    private fun failWith(e: Exception): suspend () -> Unit = { throw e }

    private fun ProgressReporter.report(status: ProgressStatus, positionMs: Long = 60_000, playing: Boolean = status == Playing) =
        report(api, "session-1", "show.e1", status, positionMs, durationMs = 1_200_000, playing = playing)

    @Test
    fun aHeartbeatIsTriedOnce() = runTest {
        val reporter = reporter()
        answers += failWith(IOException("unreachable"))
        answers += failWith(ApiException(503, "http_503"))
        reporter.report(Playing)
        reporter.report(Paused)
        advanceUntilIdle()
        assertEquals(listOf(0L to Playing, 0L to Paused), sent.map { it.atMs to it.report.status })
        assertEquals(0, finalsDelivered)
    }

    @Test
    fun stoppedAndFinishedAreTriedFourTimesTwoFourAndSixSecondsApart() = runTest {
        val reporter = reporter()
        repeat(4) { answers += failWith(IOException("unreachable")) }
        reporter.report(Stopped)
        advanceUntilIdle()
        assertEquals(listOf(0L, 2_000L, 6_000L, 12_000L), sent.map { it.atMs })
        assertEquals("given up: Home is not refreshed", 0, finalsDelivered)

        sent.clear()
        answers += failWith(ApiException(502, "http_502"))
        answers += failWith(IOException("unreachable"))
        reporter.report(Finished)
        advanceUntilIdle()
        assertEquals(listOf(12_000L, 14_000L, 18_000L), sent.map { it.atMs })
        assertEquals(1, finalsDelivered)
    }

    @Test
    fun otherClientErrorsDropTheReport() = runTest {
        val reporter = reporter()
        answers += failWith(ApiException(404, "unknown_episode"))
        answers += failWith(ApiException(401, "unauthorized"))
        reporter.report(Stopped)
        reporter.report(Finished)
        advanceUntilIdle()
        assertEquals(2, sent.size)
        assertEquals(0, finalsDelivered)
        // Nothing was learnt about the server: the next report still carries the anchor fields.
        reporter.report(Playing)
        advanceUntilIdle()
        assertEquals(true, sent.last().report.playing)
        assertEquals(0L, sent.last().report.ageMs)
    }

    @Test
    fun aServerThatRejectsTheAnchorGetsReportsWithoutIt() = runTest {
        val reporter = reporter()
        answers += failWith(ApiException(400, "bad_request"))
        reporter.report(Playing)
        advanceUntilIdle()
        assertEquals(2, sent.size)
        assertEquals(true, sent[0].report.playing)
        assertEquals(0L, sent[0].report.ageMs)
        assertEquals("sent again at once", 0L, sent[1].atMs)
        assertEquals(sent[0].report.copy(playing = null, ageMs = null), sent[1].report)

        // From then on every report leaves them out; a final one still gets its four attempts.
        repeat(3) { answers += failWith(IOException("unreachable")) }
        reporter.report(Stopped)
        advanceUntilIdle()
        assertEquals(6, sent.size)
        sent.drop(2).forEach {
            assertNull(it.report.playing)
            assertNull(it.report.ageMs)
        }
        assertEquals(1, finalsDelivered)

        // A 400 without anchor fields is like any other 4xx: dropped.
        answers += failWith(ApiException(400, "bad_request"))
        reporter.report(Finished)
        advanceUntilIdle()
        assertEquals(7, sent.size)
        assertEquals(1, finalsDelivered)
    }

    @Test
    fun theAgeIsMeasuredWhenTheReportIsSent() = runTest {
        val reporter = reporter()
        answers += failWith(IOException("unreachable"))
        reporter.report(Stopped)
        reporter.report(Playing) // queued behind the stopped report's retry
        advanceUntilIdle()
        assertEquals(listOf(Triple(0L, Stopped, 0L), Triple(2_000L, Stopped, 2_000L), Triple(2_000L, Playing, 2_000L)), sent.map { Triple(it.atMs, it.report.status, it.report.ageMs) })

        // A sample older than the server accepts is sent with the largest age it takes.
        sent.clear()
        answers += { delay(70_000) }
        reporter.report(Paused)
        reporter.report(Paused, positionMs = 61_000)
        advanceUntilIdle()
        assertEquals(listOf(0L, 60_000L), sent.map { it.report.ageMs })
    }

    @Test
    fun reportsLeaveInTheOrderTheyWereMade() = runTest {
        val reporter = reporter()
        answers += failWith(IOException("unreachable"))
        answers += failWith(IOException("unreachable"))
        reporter.report(Finished, positionMs = 1_200_000, playing = false)
        reporter.report(Playing, positionMs = 1_199_000) // a late heartbeat never overtakes `finished`
        advanceUntilIdle()
        assertEquals(listOf(Finished, Finished, Finished, Playing), sent.map { it.report.status })
    }

    @Test
    fun aReportCarriesThePlaybackAndNeverANegativePosition() = runTest {
        val reporter = reporter()
        reporter.report(api, "session-1", "show.e1", Paused, positionMs = -40, durationMs = null, playing = false)
        advanceUntilIdle()
        assertEquals(ProgressReport("session-1", "show.e1", 0, null, Paused, playing = false, ageMs = 0), sent.single().report)
        assertEquals("only a final report refreshes Home", 0, finalsDelivered)
    }

    @Test
    fun aNewResolveWaitsForQueuedReportsAtMostThreeSeconds() = runTest {
        val reporter = reporter()
        var waitedUntil = -1L
        val awaitDelivered = { launch { reporter.awaitDelivered(); waitedUntil = testScheduler.currentTime } }
        awaitDelivered()
        runCurrent()
        assertEquals("nothing queued: no wait", 0L, waitedUntil)

        answers += { delay(1_000) }
        reporter.report(Stopped)
        awaitDelivered()
        advanceUntilIdle()
        assertEquals(1_000L, waitedUntil)

        answers += { delay(10_000) }
        reporter.report(Stopped)
        val from = testScheduler.currentTime
        awaitDelivered()
        advanceUntilIdle()
        assertEquals(from + ProgressReporter.MAX_WAIT_MS, waitedUntil)
    }
}
