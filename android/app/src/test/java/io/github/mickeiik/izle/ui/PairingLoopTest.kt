package io.github.mickeiik.izle.ui

import io.github.mickeiik.izle.data.api.ApiException
import io.github.mickeiik.izle.data.api.PairStart
import io.github.mickeiik.izle.data.api.PairWait
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

@OptIn(ExperimentalCoroutinesApi::class)
class PairingLoopTest {
    private val ui = MutableStateFlow(PairingUi(adminUrl = "http://tv.test/admin"))
    private val approvals = mutableListOf<Pair<String, String>>()

    /** The server's answers in turn; then a fresh code, and long polls that never answer. */
    private inner class FakeServer(private val scope: TestScope) : PairingApi {
        val starts = ArrayDeque<() -> PairStart>()
        val waits = ArrayDeque<() -> PairWait>()

        /** (virtual time, call) for every call. */
        val calls = mutableListOf<Pair<Long, String>>()

        override suspend fun start(): PairStart {
            calls += scope.testScheduler.currentTime to "start"
            return starts.removeFirstOrNull()?.invoke() ?: PairStart("999999", "pt-9")
        }

        override suspend fun wait(code: String, pairToken: String): PairWait {
            calls += scope.testScheduler.currentTime to "wait $code $pairToken"
            val answer = waits.removeFirstOrNull() ?: awaitCancellation()
            return answer()
        }
    }

    private fun code(code: String) = { PairStart(code, "pt-$code") }

    private fun TestScope.pair(server: FakeServer, onApproved: suspend (String, String) -> Unit = { id, token -> approvals += id to token }) =
        launch { PairingLoop.run(server, ui, onApproved) }

    @Test
    fun showsTheCodeAndHandsTheTokenOverOnce() = runTest {
        val server = FakeServer(this)
        server.starts += code("111111")
        server.waits += { PairWait("pending") }
        server.waits += { PairWait("approved", deviceId = "tv-9", deviceToken = "tok-9") }
        val job = pair(server)
        advanceUntilIdle()
        assertEquals(listOf("tv-9" to "tok-9"), approvals)
        assertTrue("the loop ends with the approval", job.isCompleted)
        assertEquals(PairingUi(adminUrl = "http://tv.test/admin", code = "111111"), ui.value)
        assertEquals(listOf(0L to "start", 0L to "wait 111111 pt-111111", 0L to "wait 111111 pt-111111"), server.calls)
    }

    @Test
    fun aRefusedStartWaitsRetryAfterBetweenFiveSecondsAndTenMinutes() = runTest {
        val server = FakeServer(this)
        server.starts += { throw ApiException(429, "rate_limited", retryAfterSec = 2) }
        server.starts += { throw ApiException(429, "rate_limited") }
        server.starts += { throw ApiException(429, "rate_limited", retryAfterSec = 900) }
        server.starts += { throw ApiException(503, "http_503", retryAfterSec = 60) }
        server.starts += code("111111")
        val job = pair(server)
        runCurrent()
        assertEquals(PairingUi(adminUrl = "http://tv.test/admin", problem = PairingProblem.RateLimited), ui.value)
        advanceUntilIdle()
        assertEquals(listOf(0L, 5_000L, 35_000L, 635_000L, 695_000L), server.calls.filter { it.second == "start" }.map { it.first })
        assertEquals(PairingUi(adminUrl = "http://tv.test/admin", code = "111111"), ui.value)
        job.cancel() // still waiting for the owner
    }

    @Test
    fun retryAfterIsKeptWithinFiveSecondsAndTenMinutes() {
        assertEquals(5_000L, PairingLoop.retryAfterMs(0))
        assertEquals(5_000L, PairingLoop.retryAfterMs(5))
        assertEquals(42_000L, PairingLoop.retryAfterMs(42))
        assertEquals(600_000L, PairingLoop.retryAfterMs(3_600))
        assertEquals(30_000L, PairingLoop.retryAfterMs(null))
    }

    @Test
    fun anUnreachableServerIsTriedAgainEveryTenSeconds() = runTest {
        val server = FakeServer(this)
        server.starts += code("111111")
        server.waits += { throw IOException("unreachable") } // the code is shown, then the server goes away…
        server.waits += { PairWait("expired") }
        server.starts += { throw IOException("unreachable") }
        server.starts += { throw IOException("unreachable") }
        val job = pair(server)
        runCurrent()
        assertEquals(PairingUi(adminUrl = "http://tv.test/admin", code = "111111", problem = PairingProblem.Unreachable), ui.value)
        advanceTimeBy(5_001)
        // …a new code is asked for, and the old one is no longer shown while the server cannot be reached.
        assertEquals(PairingUi(adminUrl = "http://tv.test/admin", problem = PairingProblem.Unreachable), ui.value)
        advanceUntilIdle()
        assertEquals(listOf(0L, 5_000L, 15_000L, 25_000L), server.calls.filter { it.second == "start" }.map { it.first })
        assertEquals(PairingUi(adminUrl = "http://tv.test/admin", code = "999999"), ui.value)
        job.cancel() // still waiting for the owner
    }

    @Test
    fun aLostLongPollIsRetriedWithTheSameCodeAfterFiveSeconds() = runTest {
        val server = FakeServer(this)
        server.starts += code("111111")
        server.waits += { throw IOException("unreachable") }
        server.waits += { throw IOException("unreachable") }
        server.waits += { PairWait("pending") }
        val job = pair(server)
        runCurrent()
        assertEquals(PairingUi(adminUrl = "http://tv.test/admin", code = "111111", problem = PairingProblem.Unreachable), ui.value)
        advanceUntilIdle()
        assertEquals(
            listOf(0L to "start", 0L to "wait 111111 pt-111111", 5_000L to "wait 111111 pt-111111", 10_000L to "wait 111111 pt-111111", 10_000L to "wait 111111 pt-111111"),
            server.calls,
        )
        assertEquals(PairingUi(adminUrl = "http://tv.test/admin", code = "111111"), ui.value)
        job.cancel() // still waiting for the owner
    }

    @Test
    fun anUnknownExpiredOrUnusableCodeIsReplacedAtOnce() = runTest {
        val server = FakeServer(this)
        listOf("111111", "222222", "333333", "444444").forEach { server.starts += code(it) }
        server.waits += { throw ApiException(404, "not_found") } // the server restarted and forgot the code
        server.waits += { PairWait("expired") } // 410 included (the client answers `expired` for it)
        server.waits += { PairWait("approved", deviceId = "tv-9") } // no token: not usable
        server.waits += { PairWait("something-new") }
        val job = pair(server)
        advanceUntilIdle()
        assertEquals(List(5) { 0L to "start" }, server.calls.filter { it.second == "start" })
        assertEquals(PairingUi(adminUrl = "http://tv.test/admin", code = "999999"), ui.value)
        assertEquals(emptyList<Pair<String, String>>(), approvals)
        job.cancel() // still waiting for the owner
    }

    @Test
    fun theTokenIsKeptEvenIfPairingIsCancelledMeanwhile() = runTest {
        val server = FakeServer(this)
        server.waits += { PairWait("approved", deviceId = "tv-9", deviceToken = "tok-9") }
        var saved = false
        val job = pair(server) { _, _ ->
            delay(1_000) // writing the settings
            saved = true
        }
        runCurrent()
        job.cancel() // the screen went away while the token was being saved
        advanceUntilIdle()
        assertTrue(saved)
        assertTrue(job.isCompleted)
    }

    @Test
    fun cancellingStopsPairing() = runTest {
        val server = FakeServer(this)
        server.starts += { throw IOException("unreachable") }
        val job = pair(server)
        runCurrent()
        job.cancel()
        advanceTimeBy(60_000)
        assertEquals(listOf(0L to "start"), server.calls)

        val waiting = FakeServer(this)
        val second = pair(waiting)
        runCurrent()
        second.cancel() // during the long poll
        advanceUntilIdle()
        assertEquals(listOf("start", "wait 999999 pt-9"), waiting.calls.map { it.second })
        assertEquals(emptyList<Pair<String, String>>(), approvals)
    }
}
