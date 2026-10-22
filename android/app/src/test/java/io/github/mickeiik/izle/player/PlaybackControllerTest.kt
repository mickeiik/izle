package io.github.mickeiik.izle.player

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.emptyPreferences
import io.github.mickeiik.izle.data.CommandResultReporter
import io.github.mickeiik.izle.data.ProblemReporter
import io.github.mickeiik.izle.data.ServerRepository
import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.data.api.ApiJson
import io.github.mickeiik.izle.data.api.CommandResult
import io.github.mickeiik.izle.data.api.EpisodeRef
import io.github.mickeiik.izle.data.api.EventsClient
import io.github.mickeiik.izle.data.api.ItemCard
import io.github.mickeiik.izle.data.api.Media
import io.github.mickeiik.izle.data.api.NextEpisode
import io.github.mickeiik.izle.data.api.ProblemReport
import io.github.mickeiik.izle.data.api.ProgressReport
import io.github.mickeiik.izle.data.api.ProgressStatus
import io.github.mickeiik.izle.data.api.ResolveRequest
import io.github.mickeiik.izle.data.api.ResolveResponse
import io.github.mickeiik.izle.data.api.Resume
import io.github.mickeiik.izle.data.api.SubtitleTrack
import io.github.mickeiik.izle.data.api.Trigger
import io.github.mickeiik.izle.domain.PlayableRef
import io.github.mickeiik.izle.domain.PlaybackOrigin
import io.github.mickeiik.izle.domain.PlaybackPlan
import io.github.mickeiik.izle.domain.RemoteCommand
import io.github.mickeiik.izle.json
import io.github.mickeiik.izle.settings.DeviceStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.KSerializer
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CopyOnWriteArrayList

/** Real API requests, a fake decoder, and virtual time: no Android runtime or media requests. */
@OptIn(ExperimentalCoroutinesApi::class)
class PlaybackControllerTest {
    private val server = MockWebServer()
    private val http = OkHttpClient()
    private val answers = ConcurrentLinkedQueue<MockResponse>()
    private val resolves = CopyOnWriteArrayList<ResolveRequest>()
    private val progress = CopyOnWriteArrayList<ProgressReport>()
    private val problems = CopyOnWriteArrayList<ProblemReport>()
    private val results = CopyOnWriteArrayList<Pair<Long, CommandResult>>()
    private val unexpectedPaths = CopyOnWriteArrayList<String>()
    private val engine = FakeMediaEngine()
    private val started = mutableListOf<ItemCard>()
    private var exits = 0
    private lateinit var scope: CoroutineScope
    private lateinit var controller: PlaybackController

    @Before
    fun setUp() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.url.encodedPath
                val body = request.body?.utf8().orEmpty()
                fun <T> MutableList<T>.record(serializer: KSerializer<T>, code: Int = 200): MockResponse {
                    add(ApiJson.decodeFromString(serializer, body))
                    return json(code, """{"ok":true}""")
                }
                return when {
                    path == "/api/v1/tv/resolve" -> {
                        resolves += ApiJson.decodeFromString(ResolveRequest.serializer(), body)
                        answers.poll() ?: json(500, """{"error":"unscripted_resolve"}""")
                    }
                    path == "/api/v1/tv/progress" -> progress.record(ProgressReport.serializer())
                    path == "/api/v1/tv/problems" -> problems.record(ProblemReport.serializer(), code = 202)
                    path.endsWith("/result") -> {
                        val id = path.substringBeforeLast('/').substringAfterLast('/').toLong()
                        results += id to ApiJson.decodeFromString(CommandResult.serializer(), body)
                        json(200, """{"ok":true}""")
                    }
                    path == "/api/v1/tv/state" -> json(200, STATE)
                    else -> {
                        unexpectedPaths += path
                        json(404, """{"error":"unexpected_request"}""")
                    }
                }
            }
        }
        server.start()
    }

    @After
    fun tearDown() {
        if (::scope.isInitialized) scope.cancel()
        server.close()
        http.dispatcher.executorService.shutdown()
        http.connectionPool.evictAll()
        assertEquals(emptyList<String>(), unexpectedPaths.toList())
    }

    private suspend fun TestScope.createController() {
        scope = backgroundScope
        val store = DeviceStore(object : DataStore<Preferences> {
            override val data = MutableStateFlow(emptyPreferences())
            override suspend fun updateData(transform: suspend (Preferences) -> Preferences): Preferences =
                transform(data.value).also { data.value = it }
        })
        val repository = ServerRepository(scope, store, EventsClient(http))
        val api = ApiClient(server.url("/"), null, http)
        repository.use(api)
        assertTrue(repository.refresh(api))
        controller = PlaybackController(
            engine, scope, scope, repository,
            ProblemReporter(scope, { repository.api }) { testScheduler.currentTime },
            CommandResultReporter(scope) { client, id, result -> client.reportCommandResult(id, result) },
            appVersion = "0.4.0", onExit = { exits++ }, onPlaybackStarted = { started += it },
            clock = { testScheduler.currentTime },
        )
        engine.durationMs = DURATION
    }

    /** Pumps only work due now while OkHttp answers; media timers advance solely at the test's request. */
    private fun TestScope.await(what: String, condition: () -> Boolean) {
        repeat(1_000) {
            runCurrent()
            if (condition()) return
            Thread.sleep(5)
        }
        fail("Timed out waiting for $what; resolves=${resolves.size}, loads=${engine.loads.size}, phase=${controller.ui.value.phase}")
    }

    private fun TestScope.advance(ms: Long) { advanceTimeBy(ms); runCurrent() }

    private fun answer(resolved: ResolveResponse, date: String? = null) {
        val builder = MockResponse.Builder().body(ApiJson.encodeToString(ResolveResponse.serializer(), resolved))
        if (date != null) builder.addHeader("Date", date)
        answers += builder.build()
    }

    private fun resolved(
        source: String = "first", alternatives: List<String> = emptyList(), episode: String = "show.e1",
        next: NextEpisode? = null, live: Boolean = false, kind: String = "mp4", path: String = "/media/one",
        session: String = "session-1", expiresAt: String? = null,
    ) = ResolveResponse(
        session, source, Media(kind, path),
        subtitleTracks = listOf(SubtitleTrack("/captions/one", "tr", "vtt", "Turkish")),
        alternatives = alternatives, next = next,
        item = ItemCard("show", if (live) "live" else "series", "Show"),
        episode = if (live) null else EpisodeRef(episode, durationMs = DURATION),
        resume = if (live) null else Resume(60_000, DURATION), expiresAt = expiresAt,
    )

    private fun play(command: Long? = null, live: Boolean = false) = controller.play(
        if (live) PlayableRef.Channel("show") else PlayableRef.Episode("show.e1"),
        command?.let(PlaybackOrigin::command) ?: PlaybackOrigin.Viewer, playCommand = command != null,
    )

    private fun test(body: suspend TestScope.() -> Unit) = runTest(StandardTestDispatcher()) {
        createController()
        body()
    }

    /** Plays [resolved] (for the owner's `play` command [command], if any) until it is loaded; [ready]: its first frame. */
    private fun TestScope.start(
        resolved: ResolveResponse = resolved(), command: Long? = null, ready: Boolean = true, date: String? = null,
    ) {
        val loads = engine.loads.size
        answer(resolved, date)
        play(command, live = resolved.item.isLive)
        await("load ${loads + 1}") { engine.loads.size == loads + 1 }
        if (ready) engine.ready()
    }

    /** [interrupt] breaks the playback off; the resolve that follows answers [resolved], which is then loaded. */
    private fun TestScope.reload(resolved: ResolveResponse, interrupt: () -> Unit) {
        val loads = engine.loads.size
        answer(resolved)
        interrupt()
        await("load ${loads + 1}") { engine.loads.size == loads + 1 }
    }

    /** A viewer's resolve of the episode, or of the channel when [live]. */
    private fun request(sourceId: String? = null, exclude: List<String>? = null, live: Boolean = false) =
        ResolveRequest(if (live) null else "show.e1", if (live) "show" else null, sourceId, exclude, Trigger.Viewer)

    @Test
    fun readyStartsPlaybackOnceAndHeartbeatsOnlyWhilePlaying() = test {
        start(command = 1, ready = false)
        assertEquals(PlayerPhase.Loading, controller.ui.value.phase)
        val subtitles = listOf(SubtitleSpec(server.url("/captions/one").toString(), "tr", "vtt", "Turkish"))
        val media = MediaSpec(server.url("/media/one").toString(), "mp4", subtitles, "show.e1", live = false)
        assertEquals(FakeMediaEngine.Load(media, 55_000), engine.loads.single())
        assertEquals(listOf("pt-BR" to "tr"), engine.preferences)
        assertEquals(listOf("preferences", "load"), engine.calls.take(2))
        assertTrue(results.isEmpty())
        assertNull(controller.player.value)

        engine.ready()
        engine.ready()
        await("the first-frame result and anchor") { results.size == 1 && progress.size == 1 }
        assertEquals(PlayerPhase.Playing, controller.ui.value.phase)
        assertEquals(listOf(ItemCard("show", "series", "Show")), started)
        assertEquals(listOf(1L to CommandResult.Done), results.toList())
        advance(PlaybackPlan.HEARTBEAT_INTERVAL_MS - 1)
        assertEquals(1, progress.size)
        engine.advancePosition(PlaybackPlan.HEARTBEAT_INTERVAL_MS)
        advance(1)
        await("the heartbeat") { progress.size == 2 }
        val heartbeat = ProgressReport("session-1", "show.e1", null, 70_000, DURATION, ProgressStatus.Playing, playing = true, ageMs = 0)
        assertEquals(heartbeat, progress.last())

        engine.buffer(true)
        await("the stall anchor") { progress.size == 3 }
        assertTrue(controller.ui.value.buffering)
        assertEquals(false, progress.last().playing)
        advance(PlaybackPlan.HEARTBEAT_INTERVAL_MS)
        assertEquals(3, progress.size)
        engine.buffer(false)
        await("the recovery anchor") { progress.size == 4 }
        assertFalse(controller.ui.value.buffering)
        assertEquals(1, started.size)
        assertEquals(1, results.size)
    }

    @Test
    fun aDecoderErrorTriesTheNextSourceAtThePositionAndReportsTheProblem() = test {
        start(resolved(alternatives = listOf("second")), command = 2)
        engine.positionMs = 123_000
        controller.pause()
        reload(resolved(source = "second", session = "session-2")) { engine.fail() }
        assertEquals(ResolveRequest("show.e1", exclude = listOf("first"), trigger = Trigger.Command, commandId = 2), resolves.last())
        assertEquals(123_000L, engine.loads.last().startAtMs)
        assertFalse(engine.playWhenReady)
        engine.ready()
        await("the problem and the command result") { problems.isNotEmpty() && results.isNotEmpty() }
        val problem = ProblemReport(
            "playback", "ERROR_CODE_DECODING_FAILED", ageMs = 0, episodeId = "show.e1", sourceId = "first", sessionId = "session-1",
            positionMs = 123_000, detail = "IOException", appVersion = "0.4.0",
        )
        assertEquals(problem, problems.single())
        assertEquals(2L to CommandResult.Done, results.single())
    }

    @Test
    fun anExpiredUrlRetriesItsPinnedSourceThenFallsBackAfterAShortRun() = test {
        start(resolved(alternatives = listOf("second")))
        advance(PlaybackPlan.EXPIRED_URL_MIN_PLAYED_MS + 1)
        engine.positionMs = 400_000
        // Pinned responses carry no alternatives.
        reload(resolved(session = "session-2")) { engine.fail("ERROR_CODE_IO_BAD_HTTP_STATUS", 403) }
        assertEquals(request(sourceId = "first"), resolves.last())
        assertEquals(400_000L, engine.loads.last().startAtMs)
        engine.ready()
        // Another 403 before five minutes of playback falls back instead of retrying the same source.
        advance(PlaybackPlan.EXPIRED_URL_MIN_PLAYED_MS - 1)
        engine.positionMs = 459_000
        reload(resolved(source = "second")) { engine.fail("ERROR_CODE_IO_BAD_HTTP_STATUS", 403) }
        assertEquals(request(exclude = listOf("first")), resolves.last())
        assertEquals(459_000L, engine.loads.last().startAtMs)
        await("both HTTP problems") { problems.size == 2 }
        assertTrue(problems.all { it.httpStatus == 403 })
    }

    @Test
    fun exhaustedSourcesStopAtThePositionAndFailOnlyACommandStillWaiting() = test {
        start(resolved(alternatives = listOf("second")), command = 3)
        engine.positionMs = 90_000
        reload(resolved(source = "second")) { engine.fail() }
        engine.ready()
        engine.positionMs = 95_000
        engine.fail()
        await("stopped and gave up") { progress.any { it.status == ProgressStatus.Stopped } && problems.any { it.code == "gave_up" } }
        assertEquals(PlayerPhase.Failed(PlaybackPlan.FAILED_AUTO_HOME_SEC), controller.ui.value.phase)
        assertEquals(95_000L, progress.single { it.status == ProgressStatus.Stopped }.positionMs)
        assertEquals("tried 2 sources", problems.single { it.code == "gave_up" }.detail)
        await("the started command's single result") { results.size == 1 }
        assertEquals(3L to CommandResult.Done, results.single())
        advance(PlaybackPlan.FAILED_AUTO_HOME_SEC * 1_000L - 1)
        assertEquals(0, exits)
        advance(1)
        assertEquals(PlayerPhase.Idle, controller.ui.value.phase)
        assertEquals(1, exits)

        // Before a first frame the same ladder must fail the command, never answer it again on retry or exit.
        start(resolved(alternatives = listOf("second")), command = 4, ready = false)
        reload(resolved(source = "second")) { engine.fail() }
        engine.fail()
        await("the waiting command's failure") { results.size == 2 }
        assertEquals(4L to CommandResult.failed(CommandResult.PLAYBACK_ERROR), results.last())
        assertEquals(1, progress.count { it.status == ProgressStatus.Stopped })
        answers += json(404, """{"error":"no_playable_source"}""")
        controller.retry()
        await("retry's error screen") { controller.ui.value.phase is PlayerPhase.Failed && resolves.size == 5 }
        advance(PlaybackPlan.FAILED_AUTO_HOME_SEC * 1_000L)
        assertEquals(2, exits)
        assertEquals(2, results.size)
    }

    @Test
    fun aChannelsErrorScreenStillZapsAnEpisodesDoesNot() = test {
        // A channel whose only source fails before a first frame: "Can't play right now", with CH+/CH− still live.
        start(resolved(live = true, kind = "ts"), ready = false)
        assertEquals("show", controller.zappableChannelId)
        engine.fail()
        await("the error screen") { controller.ui.value.phase is PlayerPhase.Failed }
        assertTrue(controller.ui.value.live)
        assertEquals("show", controller.zappableChannelId)
        advance(PlaybackPlan.FAILED_AUTO_HOME_SEC * 1_000L)
        assertEquals(PlayerPhase.Idle, controller.ui.value.phase)
        assertNull("nothing to zap from on Home", controller.zappableChannelId)

        // An episode's error screen offers Try again and Home only.
        start(ready = false)
        engine.fail()
        await("its error screen") { controller.ui.value.phase is PlayerPhase.Failed }
        assertNull(controller.zappableChannelId)
    }

    @Test
    fun expiryRefreshPinsTheSourceSwapsOnlyChangedMediaAndReanchorsEachSession() = test {
        start(resolved(expiresAt = "2026-10-21T12:02:00Z"), date = DATE)
        controller.pause()
        engine.positionMs = 80_000
        answer(resolved(session = "session-2", expiresAt = "2026-10-21T12:04:00Z"), "Wed, 21 Oct 2026 12:01:00 GMT")
        advance(59_999)
        assertEquals(1, resolves.size)
        advance(1)
        await("the unchanged URL's anchor") { progress.any { it.sessionId == "session-2" } }
        assertEquals(1, engine.loads.size)
        assertEquals(request(sourceId = "first"), resolves.last())
        assertEquals(80_000L, progress.last().positionMs)
        assertEquals(ProgressStatus.Paused, progress.last().status)

        answer(resolved(session = "session-3", path = "/media/two"), "Wed, 21 Oct 2026 12:03:00 GMT")
        advance(119_999)
        assertEquals(2, resolves.size)
        advance(1)
        await("the changed URL's load and anchor") { engine.loads.size == 2 && progress.any { it.sessionId == "session-3" } }
        assertEquals(server.url("/media/two").toString(), engine.loads.last().media.url)
        assertEquals(80_000L, engine.loads.last().startAtMs)
        assertFalse(engine.playWhenReady)
        assertEquals(80_000L, progress.last().positionMs)
        assertEquals(ProgressStatus.Paused, progress.last().status)
        assertEquals(1, engine.preferences.size)
    }

    @Test
    fun anEpisodeEndsWithAutoNextOrTheEndThenHome() = test {
        val next = NextEpisode("show.e2", number = 2)
        start(resolved(next = next))
        engine.ended()
        await("finished and Up next") { progress.any { it.status == ProgressStatus.Finished } && controller.ui.value.phase is PlayerPhase.UpNext }
        assertEquals(PlayerPhase.UpNext(next, PlaybackPlan.AUTO_NEXT_COUNTDOWN_SEC), controller.ui.value.phase)
        assertEquals(DURATION, progress.single { it.status == ProgressStatus.Finished }.positionMs)
        answer(resolved(episode = "show.e2", session = "session-2"))
        advance(PlaybackPlan.AUTO_NEXT_COUNTDOWN_SEC * 1_000L - 1)
        assertEquals(1, resolves.size)
        advance(1)
        await("the next episode") { engine.loads.size == 2 }
        assertEquals(ResolveRequest("show.e2", trigger = Trigger.Next), resolves.last())
        engine.ready()
        engine.ended()
        await("the last finished report") { progress.count { it.status == ProgressStatus.Finished } == 2 }
        assertEquals(PlayerPhase.Finished, controller.ui.value.phase)
        advance(PlaybackPlan.FINISHED_MESSAGE_MS - 1)
        assertEquals(0, exits)
        advance(1)
        assertEquals(1, exits)
        assertEquals(PlayerPhase.Idle, controller.ui.value.phase)
    }

    @Test
    fun aChannelNeverPausesAndRestartsAtTheLiveEdgeBeforeTryingAlternatives() = test {
        start(resolved(live = true, kind = "ts", alternatives = listOf("second")))
        assertTrue(controller.ui.value.live)
        assertNull(controller.ui.value.durationMs)
        assertEquals("show", controller.zappableChannelId)
        val load = engine.loads.single()
        assertEquals(Triple("ts", true, null), Triple(load.media.kind, load.media.live, load.startAtMs))
        val calls = engine.calls.toList()
        controller.pause()
        controller.togglePause()
        controller.startOver()
        controller.seekRemote(RemoteCommand.Seek(30_000, null))
        controller.onSeekKeyDown(1, 0, 0, 0)
        controller.onSeekKeyUp()
        assertEquals(calls, engine.calls)
        assertTrue(engine.playWhenReady)

        reload(resolved(live = true, kind = "ts")) { engine.ended() }
        assertEquals(request(sourceId = "first", live = true), resolves.last())
        assertNull(engine.loads.last().startAtMs)
        assertTrue(engine.playWhenReady)
        assertEquals(0, problems.size)
        engine.ready()
        advance(59_999)
        reload(resolved(live = true, kind = "ts", source = "second")) { engine.fail() }
        assertEquals(request(exclude = listOf("first"), live = true), resolves.last())
        assertNull(engine.loads.last().startAtMs)
        assertTrue(progress.all { it.itemId == "show" && it.episodeId == null && it.positionMs == null && it.durationMs == null })
        assertTrue(progress.all { it.status == ProgressStatus.Playing })

        // A stable run earns another same-source attempt, even after that source has already been retried.
        engine.ready()
        reload(resolved(live = true, source = "second")) { engine.ended() }
        engine.ready()
        advance(PlaybackPlan.LIVE_STABLE_PLAYED_MS)
        reload(resolved(live = true, source = "second")) { engine.ended() }
        assertEquals(request(sourceId = "second", live = true), resolves.last())
    }

    @Test
    fun stopAndReplacementAnswerWaitingCommandsOnceAndReportPlayingVisitsOnce() = test {
        start(command = 5)
        engine.positionMs = 100_000
        controller.stop()
        controller.stop()
        await("the stopped report") { progress.any { it.status == ProgressStatus.Stopped } }
        assertEquals(100_000L, progress.single { it.status == ProgressStatus.Stopped }.positionMs)
        assertEquals(PlayerPhase.Idle, controller.ui.value.phase)
        assertNull(controller.player.value)
        assertEquals(1, engine.calls.count { it == "release" })

        start(command = 6, ready = false)
        assertEquals(listOf("preferences", "load"), engine.calls.dropWhile { it != "release" }.drop(1).take(2))
        controller.stop()
        engine.ready() // detached callbacks cannot finish the waiting command
        await("ignored stopped") { results.any { it.first == 6L } }
        assertEquals(1, progress.count { it.status == ProgressStatus.Stopped })

        start(command = 7, ready = false)
        answer(resolved(episode = "show.e2"))
        controller.play(PlayableRef.Episode("show.e2"), PlaybackOrigin.command(8), playCommand = true)
        await("its replacement") { engine.loads.size == 4 && results.any { it.first == 7L } }
        engine.ready()
        engine.ready()
        await("the replacement's done") { results.size == 4 }
        assertEquals(listOf(5L to CommandResult.Done, 6L to CommandResult.ignored(CommandResult.STOPPED),
            7L to CommandResult.ignored(CommandResult.SUPERSEDED), 8L to CommandResult.Done), results.sortedBy { it.first })
    }

    @Test
    fun tracksAndSelectionsPassThroughAndDisablingSubtitlesClearsCues() = test {
        assertEquals(emptyList<TrackOption>(), controller.audioTracks())
        start(ready = false)
        val audio = TrackOption(0, 1, "tr", "Turkish", false)
        val text = TrackOption(1, 0, "en", "English", true)
        engine.audio = listOf(audio)
        engine.text = listOf(text)
        assertEquals(listOf(audio), controller.audioTracks())
        assertEquals(listOf(text), controller.textTracks())
        controller.selectAudio(audio)
        controller.selectAudio(null)
        controller.selectText(text)
        engine.cues("Caption")
        assertEquals("Caption", controller.ui.value.cues)
        controller.selectText(null)
        assertNull(controller.ui.value.cues)
        assertEquals(listOf(audio, null), engine.audioSelections)
        assertEquals(listOf(text, null), engine.textSelections)
    }

    private companion object {
        const val DURATION = 1_200_000L
        const val DATE = "Wed, 21 Oct 2026 12:00:00 GMT"
        const val STATE = """{"version":1,"device":{"id":"tv","name":"TV","preferredAudioLanguage":"pt-BR","subtitlesLanguage":"tr"},"catalog":{"id":"sample","buildId":"b1","name":"Sample"}}"""
    }
}
