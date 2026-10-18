package io.github.mickeiik.izle.data

import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.data.api.ApiException
import io.github.mickeiik.izle.data.api.CommandResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

@OptIn(ExperimentalCoroutinesApi::class)
class CommandResultReporterTest {
    private val http = OkHttpClient()
    private val api = ApiClient("http://tv.test/".toHttpUrl(), "device-token", http)

    private data class Sent(val atMs: Long, val api: ApiClient, val id: Long, val result: CommandResult)

    private val sent = mutableListOf<Sent>()

    /** What each send does in turn; once empty, sends succeed. */
    private val answers = ArrayDeque<() -> Unit>()

    private fun TestScope.reporter() = CommandResultReporter(CoroutineScope(StandardTestDispatcher(testScheduler))) { api, id, result ->
        sent += Sent(testScheduler.currentTime, api, id, result)
        answers.removeFirstOrNull()?.invoke()
    }

    private fun failWith(e: Exception): () -> Unit = { throw e }

    @Test
    fun aResultIsSentOnce() = runTest {
        val reporter = reporter()
        reporter.report(api, 12, CommandResult.Done)
        advanceUntilIdle()
        assertEquals(listOf(Sent(0, api, 12, CommandResult.Done)), sent)
    }

    @Test
    fun networkFailuresAndServerErrorsAreTriedFourTimesTwoFourAndSixSecondsApart() = runTest {
        val reporter = reporter()
        answers += failWith(IOException("unreachable"))
        answers += failWith(ApiException(502, "http_502"))
        answers += failWith(ApiException(503, "http_503"))
        answers += failWith(IOException("unreachable"))
        reporter.report(api, 12, CommandResult.failed(CommandResult.NO_PLAYABLE_SOURCE))
        advanceUntilIdle()
        assertEquals(listOf(0L, 2_000L, 6_000L, 12_000L), sent.map { it.atMs })

        sent.clear()
        answers += failWith(IOException("unreachable"))
        reporter.report(api, 13, CommandResult.Done)
        advanceUntilIdle()
        assertEquals("delivered on the second attempt", listOf(12_000L, 14_000L), sent.map { it.atMs })
    }

    @Test
    fun clientErrorsDropTheResultSilently() = runTest {
        val reporter = reporter()
        answers += failWith(ApiException(404, "unknown_command")) // a server from before results
        answers += failWith(ApiException(409, "already_reported"))
        answers += failWith(ApiException(400, "invalid_request"))
        reporter.report(api, 1, CommandResult.Done)
        reporter.report(api, 2, CommandResult.Done)
        reporter.report(api, 3, CommandResult.ignored("something_new"))
        advanceUntilIdle()
        assertEquals(listOf(1L, 2L, 3L), sent.map { it.id })
    }

    @Test
    fun aResultSentNowThatDidNotArriveLeavesTheCommandOpen() = runTest {
        val reporter = reporter()
        answers += failWith(IOException("unreachable"))
        answers += failWith(IOException("unreachable"))
        assertFalse(reporter.reportNow(api, 12, CommandResult.done(CommandResult.INSTALLING)))
        assertEquals(listOf(0L, 2_000L), sent.map { it.atMs })

        // What became of it after all can still be told.
        reporter.report(api, 12, CommandResult.failed("install_write"))
        advanceUntilIdle()
        assertEquals(CommandResult.failed("install_write"), sent.last().result)
        assertEquals(3, sent.size)
    }

    @Test
    fun aResultSentNowClaimsTheCommand() = runTest {
        val reporter = reporter()
        assertTrue(reporter.reportNow(api, 12, CommandResult.done(CommandResult.INSTALLING)))
        reporter.report(api, 12, CommandResult.failed("install_write"))
        assertFalse("already answered", reporter.reportNow(api, 12, CommandResult.Done))
        advanceUntilIdle()
        assertEquals(listOf(CommandResult.done(CommandResult.INSTALLING)), sent.map { it.result })

        // A command answered before is not sent now.
        reporter.report(api, 13, CommandResult.Done)
        assertFalse(reporter.reportNow(api, 13, CommandResult.done(CommandResult.INSTALLING)))
        advanceUntilIdle()
        assertEquals(listOf(CommandResult.Done), sent.filter { it.id == 13L }.map { it.result })
    }

    @Test
    fun onlyTheFirstResultOfACommandCounts() = runTest {
        val reporter = reporter()
        reporter.report(api, 12, CommandResult.Done)
        reporter.report(api, 12, CommandResult.failed(CommandResult.PLAYBACK_ERROR))
        advanceUntilIdle()
        assertEquals(listOf(CommandResult.Done), sent.map { it.result })

        // Another server (or a new pairing) numbers its commands from 1 again.
        val other = ApiClient("http://other.test/".toHttpUrl(), "device-token", http)
        reporter.report(other, 12, CommandResult.ignored(CommandResult.NOT_READY))
        advanceUntilIdle()
        assertEquals(listOf(api to 12L, other to 12L), sent.map { it.api to it.id })

        // Only recent commands are remembered.
        for (id in 100L until 200L) reporter.report(api, id, CommandResult.Done)
        reporter.report(api, 12, CommandResult.Done)
        advanceUntilIdle()
        assertEquals(api to 12L, sent.last().let { it.api to it.id })
    }
}
