package io.github.mickeiik.izle.companion.finder

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** The link finder's state holder with a fake confirmer: candidates, once per URL, the last found, paste, clear. */
@OptIn(ExperimentalCoroutinesApi::class)
class LinkFinderTest {
    private val page = mapOf("Referer" to "https://page.test/watch/1", "Origin" to "https://page.test", "User-Agent" to "Mozilla/5.0")

    /** Confirms the URLs in [playlists]; every other one is not a playlist. Records each call. */
    private class FakeConfirmer(vararg playlists: String) {
        val playlists = playlists.toMutableSet()
        val calls = Collections.synchronizedList(mutableListOf<Pair<String, Map<String, String>>>())
        var gate: CompletableDeferred<Unit>? = null

        suspend fun confirm(url: String, headers: Map<String, String>): FoundLink? {
            calls += url to headers
            gate?.await()
            return if (url in playlists) FoundLink(url, headers) else null
        }
    }

    // The finder's checks run under a parent job that outlives them, so not in the TestScope itself (runTest would wait
    // for it), nor in backgroundScope (advanceUntilIdle() does not run it); this scope shares the test scheduler.
    private fun TestScope.finder(fake: FakeConfirmer) =
        LinkFinder(fake::confirm, CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler)))

    @Test
    fun aCandidateIsConfirmedWithThePagesHeaders() = runTest {
        val fake = FakeConfirmer("https://cdn.test/a/master.m3u8")
        val finder = finder(fake)

        finder.offer("https://cdn.test/a/master.m3u8", page, "session=s1")
        advanceUntilIdle()

        val headers = mapOf("Referer" to "https://page.test/watch/1", "Origin" to "https://page.test", "Cookie" to "session=s1")
        assertEquals(listOf("https://cdn.test/a/master.m3u8" to headers), fake.calls.toList())
        assertEquals(LinkFinderState(found = FoundLink("https://cdn.test/a/master.m3u8", headers)), finder.state.value)
    }

    @Test
    fun nonCandidatesAreIgnored() = runTest {
        val fake = FakeConfirmer()
        val finder = finder(fake)

        for (url in listOf("https://page.test/watch/1", "https://cdn.test/app.js", "blob:https://page.test/m3u8", "data:text/plain,m3u8")) {
            finder.offer(url, page, "session=s1")
        }
        advanceUntilIdle()

        assertTrue(fake.calls.isEmpty())
        assertEquals(LinkFinderState(), finder.state.value)
    }

    @Test
    fun eachUrlIsConfirmedOnce() = runTest {
        val fake = FakeConfirmer()
        val finder = finder(fake)

        repeat(3) { finder.offer("https://cdn.test/m3u8/abc?payload=1", page, null) }
        finder.offer("https://cdn.test/m3u8/abc?payload=2", page, null)
        advanceUntilIdle()
        finder.offer("https://cdn.test/m3u8/abc?payload=1", page, "late=cookie")
        advanceUntilIdle()

        assertEquals(listOf("https://cdn.test/m3u8/abc?payload=1", "https://cdn.test/m3u8/abc?payload=2"), fake.calls.map { it.first })
        assertNull(finder.state.value.found)
    }

    @Test
    fun checkingWhileAConfirmationRuns() = runTest {
        val fake = FakeConfirmer("https://cdn.test/x.m3u8").apply { gate = CompletableDeferred() }
        val finder = finder(fake)

        finder.offer("https://cdn.test/x.m3u8", page, null)
        finder.offer("https://cdn.test/y.m3u8", page, null)
        runCurrent()
        assertTrue(finder.state.value.checking)

        fake.gate!!.complete(Unit)
        advanceUntilIdle()
        assertFalse(finder.state.value.checking)
        assertEquals("https://cdn.test/x.m3u8", finder.state.value.found?.url)
    }

    @Test
    fun aNewerPlaylistReplacesTheFoundOneAndAFailureKeepsIt() = runTest {
        val fake = FakeConfirmer("https://cdn.test/first.m3u8", "https://cdn.test/second.m3u8")
        val finder = finder(fake)

        finder.offer("https://cdn.test/first.m3u8", page, null)
        advanceUntilIdle()
        finder.offer("https://cdn.test/not-a-playlist.m3u8", page, null)
        advanceUntilIdle()
        assertEquals("https://cdn.test/first.m3u8", finder.state.value.found?.url)

        finder.offer("https://cdn.test/second.m3u8", page, null)
        advanceUntilIdle()
        assertEquals("https://cdn.test/second.m3u8", finder.state.value.found?.url)
    }

    @Test
    fun aPastedLinkIsConfirmedWithoutHeadersEvenWithoutM3u8() = runTest {
        val fake = FakeConfirmer("https://cdn.test/signed/abc?sig=1")
        val finder = finder(fake)

        finder.paste("  https://cdn.test/signed/abc?sig=1\n")
        advanceUntilIdle()

        assertEquals(listOf("https://cdn.test/signed/abc?sig=1" to emptyMap<String, String>()), fake.calls.toList())
        assertEquals(LinkFinderState(found = FoundLink("https://cdn.test/signed/abc?sig=1", emptyMap())), finder.state.value)
    }

    @Test
    fun aPasteThatFailsSaysSoUntilTheNextPaste() = runTest {
        val fake = FakeConfirmer("https://cdn.test/good.m3u8")
        val finder = finder(fake)

        finder.paste("not a link")
        assertTrue(finder.state.value.pasteError)
        assertTrue(fake.calls.isEmpty())

        finder.paste("https://cdn.test/expired.m3u8")
        advanceUntilIdle()
        assertTrue(finder.state.value.pasteError)
        assertNull(finder.state.value.found)

        finder.paste("https://cdn.test/good.m3u8")
        assertFalse(finder.state.value.pasteError)
        advanceUntilIdle()
        assertEquals(LinkFinderState(found = FoundLink("https://cdn.test/good.m3u8", emptyMap())), finder.state.value)
    }

    @Test
    fun clearForgetsTheLinkTheUrlsSeenAndTheChecksInFlight() = runTest {
        val fake = FakeConfirmer("https://cdn.test/a.m3u8", "https://cdn.test/slow.m3u8")
        val finder = finder(fake)
        finder.offer("https://cdn.test/a.m3u8", page, null)
        advanceUntilIdle()

        fake.gate = CompletableDeferred()
        finder.offer("https://cdn.test/slow.m3u8", page, null)
        runCurrent()
        finder.clear()
        assertEquals(LinkFinderState(), finder.state.value)
        fake.gate!!.complete(Unit)
        advanceUntilIdle()
        assertEquals(LinkFinderState(), finder.state.value)

        finder.offer("https://cdn.test/a.m3u8", page, null)
        advanceUntilIdle()
        assertEquals("https://cdn.test/a.m3u8", finder.state.value.found?.url)
        assertEquals(3, fake.calls.size)
    }

    @Test
    fun offersFromManyThreadsConfirmEachUrlOnce() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val confirmations = AtomicInteger()
        val finder = LinkFinder({ url, headers -> confirmations.incrementAndGet(); FoundLink(url, headers) }, scope)
        val start = CountDownLatch(1)
        val threads = List(8) { t ->
            Thread {
                start.await()
                repeat(200) { i -> finder.offer("https://cdn.test/${i % 20}.m3u8", page, "t=$t") }
            }.apply { start() }
        }
        start.countDown()
        threads.forEach { it.join(TimeUnit.SECONDS.toMillis(10)) }

        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (finder.state.value.checking && System.nanoTime() < deadline) Thread.sleep(10)
        assertFalse(finder.state.value.checking)
        assertEquals(20, confirmations.get())
        assertTrue(finder.state.value.found != null)
        scope.cancel()
    }
}
