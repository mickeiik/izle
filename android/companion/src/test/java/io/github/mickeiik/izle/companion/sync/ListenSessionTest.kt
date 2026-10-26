package io.github.mickeiik.izle.companion.sync

import io.github.mickeiik.izle.data.api.Anchor
import io.github.mickeiik.izle.data.api.ApiException
import io.github.mickeiik.izle.data.api.CandidateLanguages
import io.github.mickeiik.izle.data.api.CompanionCandidate
import io.github.mickeiik.izle.data.api.CompanionResolveRequest
import io.github.mickeiik.izle.data.api.CompanionResolveResponse
import io.github.mickeiik.izle.data.api.CompanionResponse
import io.github.mickeiik.izle.data.api.LinkTiming
import io.github.mickeiik.izle.data.api.Media
import io.github.mickeiik.izle.data.api.NowPlaying
import io.github.mickeiik.izle.data.api.NowResponse
import io.github.mickeiik.izle.player.FakeMediaEngine
import io.github.mickeiik.izle.player.MediaSpec
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.IOException
import java.time.Instant
import kotlin.math.abs
import kotlin.math.min
import kotlin.math.roundToLong

/** A scripted server, a fake decoder whose position the test advances, and virtual time: no network, no sleeps. */
@OptIn(ExperimentalCoroutinesApi::class)
class ListenSessionTest {
    private val dispatcher = StandardTestDispatcher()
    private val engine = FakeMediaEngine()

    @Before
    fun setUp() = Dispatchers.setMain(dispatcher)

    @After
    fun tearDown() = Dispatchers.resetMain()

    @Test
    fun startSamplesTheClockResolvesLoadsAndPlaysThenSyncs() = listen {
        api.tv(600_000)
        session.start(TARGET, LinkTiming(), 0)
        assertEquals(ListenPhase.Starting, state.phase)
        settle()
        assertEquals(listOf<Pair<Long?, Int>>(null to 0, null to 0, null to 0), api.nowCalls.take(3))
        assertEquals(1L to 25, api.nowCalls[3]) // the long-poll on the current seq
        assertEquals(listOf(CompanionResolveRequest("s1e1", "dub", "fr")), api.resolves)
        assertEquals(listOf<Pair<String?, String?>>("fr" to null), engine.preferences)
        val spec = MediaSpec("http://server.test/p/tok/dub/master.m3u8", "hls", emptyList(), mediaId = "s1e1", live = false)
        assertEquals(listOf(FakeMediaEngine.Load(spec, null)), engine.loads)
        assertEquals(listOf("preferences", "load", "play"), engine.calls)
        assertEquals(ListenPhase.Listening, state.phase)
        assertEquals("hls", state.mediaKind)
        assertEquals(0L, state.clockRttMs)

        run(20_000)
        assertEquals("synced", state.syncLabel)
        assertEquals(1f, engine.playbackRate)
        assertEquals(1, engine.calls.count { it == "seek" })
        assertTrue(abs(state.driftMs!!) <= 40)
        assertEquals(620_000.0, state.tvPositionMs!!, 250.0)
        assertTrue(engine.isPlaying)
    }

    @Test
    fun aFarOffPhoneSeeksWithTheLeadAndHolds() = listen {
        listening()
        engine.positionMs -= 5_000
        runUntil { seeks == 2 }
        assertEquals("seeking", state.syncLabel)
        assertEquals((state.tvPositionMs!! + 150).roundToLong(), engine.positionMs)
        engine.positionMs -= 5_000
        run(900)
        assertEquals("held for a second", 2, seeks)
        run(200)
        assertEquals(3, seeks)
    }

    @Test
    fun aNearOffPhoneGetsRateNudgesAndReturnsToTheNominalRate() = listen {
        listening()
        engine.positionMs -= 500
        run(250)
        assertEquals("catching up", state.syncLabel)
        assertEquals(1.05f, engine.playbackRate)
        val rates = mutableSetOf<Float>()
        runUntil(60_000) { rates += engine.playbackRate; state.syncLabel == "synced" }
        assertTrue(rates.toString(), 1.02f in rates)
        assertEquals(1f, engine.playbackRate)
        assertEquals(1, seeks)

        engine.positionMs += 500
        run(250)
        assertEquals("holding back", state.syncLabel)
        assertEquals(0.95f, engine.playbackRate)
    }

    @Test
    fun theTvPausingPausesThePhoneAndResumingResumesIt() = listen {
        listening()
        api.tv(api.tvPosition(), playing = false, state = "paused")
        run(250)
        assertEquals("paused", state.syncLabel)
        assertFalse(engine.playWhenReady)
        val paused = engine.positionMs
        run(5_000)
        assertEquals(paused, engine.positionMs)

        api.tv(api.tvPosition())
        run(250)
        assertTrue(engine.playWhenReady)
        assertTrue(engine.isPlaying)
        runUntil { state.syncLabel == "synced" }
    }

    @Test
    fun aTargetBeforeZeroWaits() = listen {
        api.tv(2_000)
        session.start(TARGET, LinkTiming(offsetMs = -10_000), 0)
        run(250)
        assertEquals("waiting", state.syncLabel)
        assertFalse(engine.playWhenReady)
        assertEquals(0, seeks)
    }

    @Test
    fun pastTheEndPausesWithItsLabel() = listen {
        engine.durationMs = 100_000
        api.tv(120_000)
        session.start(TARGET, LinkTiming(), 0)
        run(250)
        assertEquals("past the end", state.syncLabel)
        assertFalse(engine.playWhenReady)
    }

    @Test
    fun noActiveReportForTwoMinutesEndsTvIdle() = listen {
        api.tv(600_000) // never reported again
        session.start(TARGET, LinkTiming(), 0)
        run(200_000)
        assertEquals(ListenPhase.Listening, state.phase)
        assertEquals("paused", state.syncLabel)
        run(100_000)
        assertEquals(ListenPhase.Idle, state.phase)
        assertEquals(EndReason.TvIdle, state.ended)
        assertEquals("stop", engine.calls.last())
        assertNull(state.syncLabel)
    }

    @Test
    fun aChannelEndsListening() = listen {
        listening()
        api.set(NowPlaying(itemId = "news", itemKind = "live", state = "playing", updatedAt = iso(api.serverNow())), anchor = null)
        settle()
        assertEquals(ListenPhase.Idle, state.phase)
        assertEquals(EndReason.TvSwitchedToChannel, state.ended)
        assertEquals("stop", engine.calls.last())
    }

    @Test
    fun aNewEpisodeIsFollowedWithItsOwnStoredTiming() = listen {
        listening()
        val stored = LinkTiming(offsetMs = 2_000, rate = 1.0427, language = null, updatedAt = "2026-10-20T10:00:00Z")
        api.companionAnswer = CompanionResponse(
            nowPlaying = NowPlaying(itemId = "show", itemKind = "series", episodeId = "s1e2", itemTitle = "Show", episodeTitle = "Two"),
            candidates = listOf(
                CompanionCandidate("orig", current = true, languages = CandidateLanguages(audio = listOf("en"))),
                CompanionCandidate("dub", type = "adapter", languages = CandidateLanguages(audio = listOf("de", "fr")), link = stored),
            ),
        )
        api.tv(5_000, episodeId = "s1e2")
        settle()
        assertEquals(1, api.companionCalls)
        assertEquals(CompanionResolveRequest("s1e2", "dub", "fr"), api.resolves.last())
        assertEquals(stored.copy(language = "fr"), state.timing)
        assertEquals(TARGET.copy(episodeId = "s1e2", episodeTitle = "Two"), state.target)
        assertEquals("s1e2", engine.loads.last().media.mediaId)
        assertNull(engine.loads.last().startAtMs)
        assertEquals(ListenPhase.Listening, state.phase)

        run(30_000)
        assertEquals("synced", state.syncLabel)
        assertEquals(1.0427 * state.tvPositionMs!! + 2_000, state.phonePositionMs!!, 40.0)
        assertEquals(1.0427f, engine.playbackRate)
    }

    @Test
    fun aNextEpisodeWithoutTheSourceEndsListening() = listen {
        listening()
        api.companionAnswer = CompanionResponse(
            candidates = listOf(
                CompanionCandidate("orig"),
                CompanionCandidate("dub", type = "pasted"), // a type the session never follows
                CompanionCandidate("dub", languages = CandidateLanguages(audio = listOf("en"))), // not in French
            ),
        )
        api.tv(5_000, episodeId = "s1e2")
        settle()
        assertEquals(ListenPhase.Idle, state.phase)
        assertEquals(EndReason.NoSuchSourceOnNextEpisode, state.ended)
        assertEquals(1, api.resolves.size)
    }

    @Test
    fun anExpiringStreamIsReResolvedAtItsPositionAtMostOnceAMinute() = listen {
        api.resolveAnswer = { answer(it).copy(expiresAt = iso(api.serverNow() + 30_000)) }
        api.tv(600_000)
        session.start(TARGET, LinkTiming(), 0)
        settle()
        assertEquals(1, api.resolves.size)
        run(250)
        assertEquals(2, api.resolves.size)
        assertEquals(2, engine.loads.size)
        assertEquals("loaded where the phone should be", state.tvPositionMs!!.roundToLong(), engine.loads[1].startAtMs)
        run(59_000)
        assertEquals(2, api.resolves.size)
        run(2_000)
        assertEquals(3, api.resolves.size)
        assertEquals(ListenPhase.Listening, state.phase)
    }

    @Test
    fun aFailingStreamIsRecoveredThreeTimesThenGivenUp() = listen {
        autoReady = false
        listening()
        engine.fail()
        settle()
        assertEquals("ERROR_CODE_DECODING_FAILED", state.error)
        run(1_900)
        assertEquals(1, engine.loads.size)
        repeat(2) {
            run(100)
            engine.fail()
            run(1_900)
        }
        run(100)
        assertEquals("three recoveries", 4, engine.loads.size)
        assertEquals(4, api.resolves.size)
        assertEquals(ListenPhase.Listening, state.phase)
        engine.fail()
        settle()
        assertEquals(ListenPhase.Idle, state.phase)
        assertEquals(EndReason.StreamKeepsFailing, state.ended)
        assertEquals("ERROR_CODE_DECODING_FAILED", state.error)
    }

    @Test
    fun aStreamThatPlaysAgainResetsTheRecoveries() = listen {
        autoReady = false
        listening()
        engine.fail()
        run(2_000)
        engine.ready() // recovered
        assertNull(state.error)
        repeat(3) {
            engine.fail()
            run(2_000)
        }
        assertEquals(5, engine.loads.size)
        assertEquals(ListenPhase.Listening, state.phase)
        engine.fail()
        settle()
        assertEquals(EndReason.StreamKeepsFailing, state.ended)
    }

    @Test
    fun aFailedResolveDuringRecoveryCountsAsAFailure() = listen {
        autoReady = false
        listening()
        api.resolveFailures += List(3) { IOException("unreachable") }
        engine.fail()
        run(2_000 * 3)
        assertEquals(1, engine.loads.size)
        assertEquals(ListenPhase.Idle, state.phase)
        assertEquals(EndReason.StreamKeepsFailing, state.ended)
        assertEquals("IOException", state.error)
    }

    @Test
    fun unauthorizedEndsListeningAndOtherFailuresRetry() = listen {
        listening()
        val calls = api.nowCalls.size
        api.nowFailure = IOException("reset")
        api.bump() // the waiting long-poll returns; the next one fails
        run(2_900)
        assertEquals("the failed call", calls + 1, api.nowCalls.size)
        run(200)
        assertEquals("retried after 3 s", calls + 2, api.nowCalls.size)
        assertEquals(ListenPhase.Listening, state.phase)

        api.nowFailure = ApiException(401, "unauthorized")
        api.bump()
        settle()
        assertEquals(ListenPhase.Idle, state.phase)
        assertEquals(EndReason.Unauthorized, state.ended)
        assertEquals("unauthorized", state.error)
    }

    @Test
    fun aResolveFailureAtStartEndsWithItsCode() = listen {
        api.resolveFailures += ApiException(400, "unsupported_media")
        api.tv(600_000)
        session.start(TARGET, LinkTiming(), 0)
        settle()
        assertEquals(ListenPhase.Idle, state.phase)
        assertEquals(EndReason.Failed, state.ended)
        assertEquals("unsupported_media", state.error)
        assertTrue(engine.loads.isEmpty())

        api.resolveFailures += IOException("http://secret.example/never-shown")
        session.start(TARGET, LinkTiming(), 0)
        assertNull(state.ended)
        assertNull(state.error)
        settle()
        assertEquals(EndReason.Failed, state.ended)
        assertEquals("IOException", state.error)
    }

    @Test
    fun setTimingChangesTheTargetOnTheNextTick() = listen {
        listening()
        val timing = LinkTiming(offsetMs = 5_000, rate = 1.0)
        session.setTiming(timing)
        assertEquals(timing, state.timing)
        runUntil { seeks == 2 }
        assertEquals((state.tvPositionMs!! + 5_000 + 150).roundToLong(), engine.positionMs)

        session.setNudgeMs(80)
        assertEquals(80L, state.nudgeMs)
        run(250)
        assertEquals(state.tvPositionMs!! + 5_080 - state.phonePositionMs!!, state.driftMs!!, 0.0)
    }

    @Test
    fun stopStopsTheEngineAndReportsStopped() = listen {
        api.tv(600_000)
        session.start(TARGET, LinkTiming(), 80)
        run(5_000)
        session.stop()
        assertEquals(ListenPhase.Idle, state.phase)
        assertEquals(EndReason.Stopped, state.ended)
        assertEquals(80L, state.nudgeMs)
        assertNull(state.syncLabel)
        assertEquals("stop", engine.calls.last())
        val calls = api.nowCalls.size
        val engineCalls = engine.calls.size
        run(120_000)
        assertEquals("no more requests", calls, api.nowCalls.size)
        assertEquals("no more engine calls", engineCalls, engine.calls.size)
        session.stop()
        assertEquals("a no-op when idle", engineCalls, engine.calls.size)

        session.release()
        assertEquals("release", engine.calls.last())
    }

    @Test
    fun theTickUsesTheClockOffsetOfTheShortestRoundTrip() = listen {
        api.skewMs = 7_000
        api.tv(600_000) // anchored at server time BASE + 7 s
        // Before and after the server reads its clock: 400 ms (estimate 100 ms off), 40 ms (exact), 500 ms (250 ms off).
        api.latencies += listOf(300L to 100L, 20L to 20L, 0L to 500L)
        session.start(TARGET, LinkTiming(), 0)
        run(940)
        assertEquals(ListenPhase.Listening, state.phase)
        assertEquals(40L, state.clockRttMs)
        run(500) // the second tick, at 1440 ms
        assertEquals(601_440.0, state.tvPositionMs!!, 0.0)
    }

    // --- harness ------------------------------------------------------------------------------------------------

    private fun listen(block: suspend Env.() -> Unit) = runTest(dispatcher) { Env(this).block() }

    private inner class Env(private val scope: TestScope) {
        val wall = { BASE + scope.testScheduler.currentTime }
        val api = FakeCompanionApi(wall)
        val session = ListenSession(api, engine, scope.backgroundScope, { "http://server.test$it" }, wall)
        val state get() = session.state.value
        val seeks get() = engine.calls.count { it == "seek" }

        /** The fake engine becomes ready on the next step after a load. */
        var autoReady = true
        private var phone = 0.0

        /** Runs what is due now. */
        fun settle() = scope.testScheduler.runCurrent()

        /** Lets [ms] pass in 10 ms steps; the phone's position advances at its playback rate while it plays. */
        fun run(ms: Long) {
            var left = ms
            while (left > 0) {
                left -= step(min(STEP_MS, left))
            }
        }

        fun runUntil(maxMs: Long = 10_000, done: () -> Boolean) {
            var spent = 0L
            while (!done()) {
                check(spent < maxMs) { "not within $maxMs ms" }
                spent += step(STEP_MS)
            }
        }

        private fun step(ms: Long): Long {
            if (autoReady && engine.buffering) engine.ready()
            if (engine.positionMs != phone.roundToLong()) phone = engine.positionMs.toDouble() // a seek or a load
            if (engine.isPlaying) {
                phone += ms * engine.playbackRate
                engine.positionMs = phone.roundToLong()
            }
            scope.testScheduler.advanceTimeBy(ms)
            scope.testScheduler.runCurrent()
            return ms
        }

        /** Started on a TV playing at 600 s, then synced. */
        fun listening() {
            api.tv(600_000)
            session.start(TARGET, LinkTiming(), 0)
            settle()
            if (!autoReady) engine.ready()
            run(20_000)
            assertEquals("synced", state.syncLabel)
        }
    }

    /** The server: one now-playing row (bumped on every write) and scripted resolve and companion answers. */
    private class FakeCompanionApi(private val wall: () -> Long) : CompanionApi {
        data class Row(val seq: Long, val nowPlaying: NowPlaying?, val anchor: Anchor?)

        val row = MutableStateFlow(Row(0, null, null))
        /** Server clock minus phone clock. */
        var skewMs = 0L
        /** Per `/now` call: the delay before the server reads its clock and the delay after. */
        val latencies = ArrayDeque<Pair<Long, Long>>()
        val nowCalls = mutableListOf<Pair<Long?, Int>>()
        var nowFailure: Exception? = null
        val resolves = mutableListOf<CompanionResolveRequest>()
        val resolveFailures = ArrayDeque<Exception>()
        var resolveAnswer: (CompanionResolveRequest) -> CompanionResolveResponse = ::answer
        var companionCalls = 0
        var companionAnswer = CompanionResponse()

        fun serverNow() = wall() + skewMs

        fun set(nowPlaying: NowPlaying?, anchor: Anchor?) {
            row.value = Row(row.value.seq + 1, nowPlaying, anchor)
        }

        /** The TV reports [positionMs] now. */
        fun tv(positionMs: Long, playing: Boolean = true, state: String = "playing", episodeId: String = row.value.nowPlaying?.episodeId ?: "s1e1") {
            val now = serverNow()
            set(
                NowPlaying(itemId = "show", itemKind = "series", episodeId = episodeId, sourceId = "orig", state = state, updatedAt = iso(now), playing = playing),
                Anchor(positionMs, now, playing),
            )
        }

        fun tvPosition(): Long = ListenSync.tvPositionAt(row.value.anchor, serverNow())!!.roundToLong()

        /** A write that changes nothing but the seq. */
        fun bump() = set(row.value.nowPlaying, row.value.anchor)

        override suspend fun now(deviceId: String, seq: Long?, waitSec: Int): NowResponse {
            assertEquals(TARGET.deviceId, deviceId)
            nowCalls += seq to waitSec
            nowFailure?.let { nowFailure = null; throw it }
            val (before, after) = latencies.removeFirstOrNull() ?: (0L to 0L)
            delay(before)
            if (seq != null && waitSec > 0) withTimeoutOrNull(waitSec * 1000L) { row.first { it.seq != seq } }
            val r = row.value
            val answer = NowResponse(online = true, serverNowMs = serverNow(), seq = r.seq, nowPlaying = r.nowPlaying, anchor = r.anchor)
            delay(after)
            return answer
        }

        override suspend fun resolve(deviceId: String, request: CompanionResolveRequest): CompanionResolveResponse {
            assertEquals(TARGET.deviceId, deviceId)
            resolves += request
            resolveFailures.removeFirstOrNull()?.let { throw it }
            return resolveAnswer(request)
        }

        override suspend fun companion(deviceId: String): CompanionResponse {
            assertEquals(TARGET.deviceId, deviceId)
            companionCalls++
            return companionAnswer
        }
    }

    private companion object {
        const val BASE = 1_800_000_000_000L
        const val STEP_MS = 10L
        val TARGET = ListenTarget(deviceId = "tv-1", episodeId = "s1e1", sourceId = "dub", language = "fr", itemTitle = "Show", episodeTitle = "One")

        fun iso(ms: Long): String = Instant.ofEpochMilli(ms).toString()

        fun answer(request: CompanionResolveRequest) = CompanionResolveResponse(
            episodeId = request.episodeId,
            sourceId = request.sourceId,
            media = Media(kind = "hls", url = "/p/tok/${request.sourceId}/master.m3u8"),
        )
    }
}
