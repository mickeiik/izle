package io.github.mickeiik.izle.ui

import io.github.mickeiik.izle.data.api.ApiException
import io.github.mickeiik.izle.data.api.InvitedPhone
import io.github.mickeiik.izle.data.api.PhoneInvite
import io.github.mickeiik.izle.data.api.PhoneInviteStatus
import io.github.mickeiik.izle.data.api.ServerUrls
import io.nayuki.qrcodegen.QrCode
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

@OptIn(ExperimentalCoroutinesApi::class)
class PhoneConnectLoopTest {
    private val server = ServerUrls.parse("http://192.168.1.10:8787/izle")!!
    private val shown = mutableListOf<Pair<Long, PhoneConnectUi>>()

    private val showing = PhoneConnectUi.Showing("483920", "http://192.168.1.10:8787/izle/connect#inv-1", "http://192.168.1.10:8787/izle")

    /** The server's answers in turn; then long polls that never answer. */
    private inner class FakeServer(private val scope: TestScope) : PhoneInviteApi {
        var create: () -> PhoneInvite = { PhoneInvite("483920", "inv-1", "2026-10-26T10:05:00.000Z") }
        val waits = ArrayDeque<() -> PhoneInviteStatus>()
        val calls = mutableListOf<Pair<Long, String>>()

        override suspend fun create(): PhoneInvite {
            calls += scope.testScheduler.currentTime to "create"
            return create.invoke()
        }

        override suspend fun wait(): PhoneInviteStatus {
            calls += scope.testScheduler.currentTime to "wait"
            val answer = waits.removeFirstOrNull() ?: awaitCancellation()
            return answer()
        }
    }

    private fun TestScope.connect(api: PhoneInviteApi?) =
        launch { PhoneConnectLoop.run(api, server) { shown += testScheduler.currentTime to it } }

    private fun status(status: String) = { PhoneInviteStatus(status) }

    @Test
    fun theQrCodeOpensTheServersConnectPageWithTheInviteInItsFragment() {
        assertEquals("http://192.168.1.10:8787/izle/connect#inv-1", PhoneConnectLoop.link(server, "inv-1"))
        assertEquals("https://tv.example/connect#a_b-C", PhoneConnectLoop.link(ServerUrls.parse("https://tv.example:443/")!!, "a_b-C"))
        assertEquals("483 920", PhoneConnectLoop.spaced("483920"))
        // A real invite (43 base64url characters) behind a long address still makes a code a phone reads from a sofa.
        val link = PhoneConnectLoop.link(ServerUrls.parse("http://192.168.100.200:8787/izle")!!, "A".repeat(43))
        val qr = QrCode.encodeText(link, QrCode.Ecc.MEDIUM)
        assertTrue("version ${qr.version}", qr.version <= 6)
    }

    @Test
    fun aClaimedInviteSaysWhichPhoneConnectedForThreeSecondsThenEnds() = runTest {
        val api = FakeServer(this)
        api.waits += status(PhoneInviteStatus.OPEN)
        api.waits += { PhoneInviteStatus(PhoneInviteStatus.CLAIMED, phone = InvitedPhone("abcdefabcdef", "Pixel 8")) }
        val job = connect(api)
        runCurrent()
        assertTrue("ends only after the message", job.isCompleted.not())
        advanceTimeBy(PhoneConnectLoop.CONNECTED_MS - 1)
        assertFalse(job.isCompleted)
        advanceUntilIdle()
        assertTrue(job.isCompleted)
        assertEquals(
            listOf(0L to PhoneConnectUi.Starting, 0L to showing, 0L to PhoneConnectUi.Connected("Pixel 8")),
            shown,
        )
        assertEquals(PhoneConnectLoop.CONNECTED_MS, testScheduler.currentTime)
        assertEquals(listOf(0L to "create", 0L to "wait", 0L to "wait"), api.calls)
    }

    @Test
    fun anExpiredOrUnknownInviteEndsAtOnce() = runTest {
        for (gone in listOf(PhoneInviteStatus.EXPIRED, PhoneInviteStatus.NOT_FOUND, "something-new")) {
            shown.clear()
            val api = FakeServer(this)
            api.waits += status(gone)
            val start = testScheduler.currentTime
            connect(api).join()
            assertEquals(gone, start, testScheduler.currentTime)
            assertEquals(gone, listOf(PhoneConnectUi.Starting, showing), shown.map { it.second })
        }
    }

    @Test
    fun withoutAnAnswerTheInviteEndsAfterFiveMinutes() = runTest {
        val api = FakeServer(this)
        connect(api).join()
        assertEquals(PhoneConnectLoop.INVITE_MS, testScheduler.currentTime)
        assertEquals(showing, shown.last().second)
    }

    @Test
    fun aLostLongPollIsTriedAgainWithTheSameInvite() = runTest {
        val api = FakeServer(this)
        api.waits += { throw IOException("reset") }
        api.waits += { PhoneInviteStatus(PhoneInviteStatus.CLAIMED, phone = InvitedPhone("p", "Tab")) }
        connect(api).join()
        assertEquals(listOf(0L to "create", 0L to "wait", PhoneConnectLoop.WAIT_RETRY_MS to "wait"), api.calls)
        assertEquals(PhoneConnectUi.Connected("Tab"), shown.last().second)
    }

    @Test
    fun aFailureShowsItsMessageForFiveSecondsThenEnds() = runTest {
        val cases = listOf(
            { api: FakeServer -> api.create = { throw IOException("down") } } to PhoneConnectProblem.Unreachable,
            { api: FakeServer -> api.create = { throw ApiException(429, "rate_limited", 60) } } to PhoneConnectProblem.Refused,
            { api: FakeServer -> api.waits += { throw ApiException(401, "unauthorized") } } to PhoneConnectProblem.Refused,
        )
        for ((setUp, problem) in cases) {
            shown.clear()
            val api = FakeServer(this).also(setUp)
            val start = testScheduler.currentTime
            connect(api).join()
            assertEquals(PhoneConnectUi.Failed(problem), shown.last().second)
            assertEquals(PhoneConnectLoop.FAILED_MS, testScheduler.currentTime - start)
        }
    }

    @Test
    fun withoutAServerToAskItSaysSoAndEnds() = runTest {
        connect(null).join()
        assertEquals(listOf(PhoneConnectUi.Starting, PhoneConnectUi.Failed(PhoneConnectProblem.Unreachable)), shown.map { it.second })
    }

    @Test
    fun cancellingStopsTheLongPoll() = runTest {
        val api = FakeServer(this)
        val job = connect(api)
        advanceTimeBy(60_000)
        job.cancel()
        advanceUntilIdle()
        assertEquals(listOf(0L to "create", 0L to "wait"), api.calls)
        assertEquals(60_000L, testScheduler.currentTime)
    }
}
