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
import org.junit.After
import org.junit.Before
import org.junit.Test
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** The link finder's state holder with a fake confirmer: candidates, once per URL and page, the first found, paste, navigation, clear. */
@OptIn(ExperimentalCoroutinesApi::class)
class LinkFinderTest {
    private val page = mapOf("Referer" to "https://page.test/watch/1", "Origin" to "https://page.test", "User-Agent" to "Mozilla/5.0")

    // android.util.Log is a stub here: the diagnostics are recorded instead.
    private val logged = Collections.synchronizedList(mutableListOf<String>())
    private lateinit var logSink: (String) -> Unit

    @Before
    fun recordTheDiagnostics() {
        logSink = FinderLog.sink
        FinderLog.sink = { logged += it }
    }

    @After
    fun restoreTheDiagnostics() {
        FinderLog.sink = logSink
    }

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
    fun aCandidateWithoutRefererOrOriginTakesThemFromThePage() = runTest {
        val fake = FakeConfirmer("https://cdn.test/a/master.m3u8")
        val finder = finder(fake)

        finder.offer("https://cdn.test/a/master.m3u8", mapOf("User-Agent" to "Mozilla/5.0"), "session=s1", "https://page.test:8443/watch/1?ep=2")
        advanceUntilIdle()

        val headers = mapOf("Referer" to "https://page.test:8443/watch/1?ep=2", "Origin" to "https://page.test:8443", "Cookie" to "session=s1")
        assertEquals(listOf("https://cdn.test/a/master.m3u8" to headers), fake.calls.toList())
        assertEquals(listOf("candidate offered (referer: yes, origin: yes, cookie: yes, fallback: yes)"), logged.toList())
    }

    @Test
    fun theDiagnosticsSayWhichStepButNeverAUrlOrAHeaderValue() = runTest {
        val finder = LinkFinder(
            { url, _ -> if (url.contains("boom")) throw IllegalStateException("https://cdn.test/boom.m3u8 failed") else null },
            CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler)),
        )

        finder.offer("https://cdn.test/s3cr3t.m3u8?token=t0k3n", page, "session=c00k1e", "https://page.test/watch/1")
        finder.offer("https://cdn.test/s3cr3t.m3u8?token=t0k3n", page, "session=c00k1e", "https://page.test/watch/1")
        finder.offer("https://cdn.test/boom.m3u8", emptyMap(), null)
        advanceUntilIdle()

        assertEquals(
            listOf(
                "candidate offered (referer: yes, origin: yes, cookie: yes, fallback: no)",
                "candidate skipped: seen before",
                "candidate offered (referer: no, origin: no, cookie: no, fallback: no)",
                "confirm: failed (IllegalStateException)",
            ),
            logged.toList(),
        )
        for (line in logged) {
            assertFalse(line, listOf("cdn.test", "page.test", "s3cr3t", "t0k3n", "c00k1e", "boom").any { line.contains(it) })
        }
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
    fun onceALinkIsFoundFurtherCandidatesAreNotFetched() = runTest {
        val fake = FakeConfirmer("https://cdn.test/first.m3u8", "https://cdn.test/s3cr3t.m3u8?token=t0k3n")
        val finder = finder(fake)

        finder.offer("https://cdn.test/not-a-playlist.m3u8", page, null)
        advanceUntilIdle()
        assertNull(finder.state.value.found)
        finder.offer("https://cdn.test/first.m3u8", page, null)
        advanceUntilIdle()
        assertEquals("https://cdn.test/first.m3u8", finder.state.value.found?.url)

        logged.clear()
        finder.offer("https://cdn.test/s3cr3t.m3u8?token=t0k3n", page, "session=c00k1e", "https://page.test/watch/1")
        finder.offer("https://cdn.test/m3u8/seg-1?payload=2", page, null)
        advanceUntilIdle()

        assertEquals(listOf("https://cdn.test/not-a-playlist.m3u8", "https://cdn.test/first.m3u8"), fake.calls.map { it.first })
        assertEquals("https://cdn.test/first.m3u8", finder.state.value.found?.url)
        assertEquals(List(2) { "candidate skipped: a link is already found" }, logged.toList())
        for (line in logged) {
            assertFalse(line, listOf("cdn.test", "page.test", "s3cr3t", "t0k3n", "c00k1e", "Mozilla", "payload").any { line.contains(it) })
        }
    }

    @Test
    fun theFirstConfirmationWinsWhenTwoAreInFlight() = runTest {
        val fake = FakeConfirmer("https://cdn.test/master.m3u8", "https://cdn.test/variant.m3u8").apply { gate = CompletableDeferred() }
        val finder = finder(fake)

        finder.offer("https://cdn.test/master.m3u8", page, null)
        finder.offer("https://cdn.test/variant.m3u8", page, null)
        runCurrent()
        assertEquals(2, fake.calls.size)

        fake.gate!!.complete(Unit)
        advanceUntilIdle()
        assertEquals("https://cdn.test/master.m3u8", finder.state.value.found?.url)
        assertFalse(finder.state.value.checking)
    }

    @Test
    fun aNavigationForgetsTheUrlsSeenAndKeepsTheFoundLink() = runTest {
        val fake = FakeConfirmer("https://cdn.test/a.m3u8")
        val finder = finder(fake)
        finder.offer("https://cdn.test/a.m3u8", page, null)
        advanceUntilIdle()
        val found = finder.state.value.found
        assertEquals("https://cdn.test/a.m3u8", found?.url)

        finder.pageNavigated()
        assertEquals(LinkFinderState(found = found), finder.state.value)
    }

    @Test
    fun aNavigationLetsAUrlSeenBeforeBeConfirmedAgain() = runTest {
        val fake = FakeConfirmer()
        val finder = finder(fake)
        finder.offer("https://cdn.test/a.m3u8", page, null)
        advanceUntilIdle()
        finder.offer("https://cdn.test/a.m3u8", page, null)
        advanceUntilIdle()
        assertEquals(1, fake.calls.size)

        // Now a playlist (a new episode on the same page, say): after the navigation it is checked again and found.
        fake.playlists += "https://cdn.test/a.m3u8"
        finder.pageNavigated()
        finder.offer("https://cdn.test/a.m3u8", page, null)
        advanceUntilIdle()
        assertEquals(2, fake.calls.size)
        assertEquals("https://cdn.test/a.m3u8", finder.state.value.found?.url)
    }

    @Test
    fun aNavigationDropsThePagesChecksInFlightButNotAPastedLinks() = runTest {
        val fake = FakeConfirmer("https://cdn.test/slow.m3u8", "https://cdn.test/pasted/abc").apply { gate = CompletableDeferred() }
        val finder = finder(fake)

        finder.offer("https://cdn.test/slow.m3u8", page, null)
        runCurrent()
        finder.pageNavigated()
        assertFalse(finder.state.value.checking)
        fake.gate!!.complete(Unit)
        advanceUntilIdle()
        assertEquals(LinkFinderState(), finder.state.value)

        fake.gate = CompletableDeferred()
        finder.paste("https://cdn.test/pasted/abc")
        runCurrent()
        finder.pageNavigated()
        assertTrue(finder.state.value.checking)
        fake.gate!!.complete(Unit)
        advanceUntilIdle()
        assertEquals(LinkFinderState(found = FoundLink("https://cdn.test/pasted/abc", emptyMap())), finder.state.value)
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
        val fake = FakeConfirmer("https://cdn.test/a.m3u8", "https://cdn.test/slow.m3u8", "https://cdn.test/pasted/abc")
        val finder = finder(fake)
        finder.offer("https://cdn.test/a.m3u8", page, null)
        advanceUntilIdle()
        finder.clear()
        assertEquals(LinkFinderState(), finder.state.value)

        fake.gate = CompletableDeferred()
        finder.offer("https://cdn.test/slow.m3u8", page, null)
        finder.paste("https://cdn.test/pasted/abc")
        runCurrent()
        finder.clear()
        assertEquals(LinkFinderState(), finder.state.value)
        fake.gate!!.complete(Unit)
        advanceUntilIdle()
        assertEquals(LinkFinderState(), finder.state.value)

        finder.offer("https://cdn.test/a.m3u8", page, null)
        advanceUntilIdle()
        assertEquals("https://cdn.test/a.m3u8", finder.state.value.found?.url)
        assertEquals(4, fake.calls.size)
    }

    @Test
    fun offersFromManyThreadsConfirmEachUrlOnce() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val confirmations = AtomicInteger()
        // Nothing is a playlist: a found link would stop the checks.
        val finder = LinkFinder({ _, _ -> confirmations.incrementAndGet(); null }, scope)
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
        assertNull(finder.state.value.found)
        scope.cancel()
    }
}
