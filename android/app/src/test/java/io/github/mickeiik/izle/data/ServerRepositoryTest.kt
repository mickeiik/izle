package io.github.mickeiik.izle.data

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.data.api.EventsClient
import io.github.mickeiik.izle.data.api.ServerEvent
import io.github.mickeiik.izle.settings.DeviceStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicLong

class ServerRepositoryTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private val server = MockWebServer()
    private val http = OkHttpClient()
    private lateinit var scope: CoroutineScope
    private lateinit var store: DeviceStore
    private val paths = CopyOnWriteArrayList<String>()

    @Volatile
    private var stateCode = 200

    @Volatile
    private var eventsBody = ""

    @Before
    fun setUp() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.url.encodedPath
                paths += path
                return when {
                    path == "/api/v1/tv/state" ->
                        if (stateCode == 200) MockResponse.Builder().body(STATE).build()
                        else MockResponse.Builder().code(stateCode).body("""{"error":"unauthorized"}""").build()
                    path == "/api/v1/tv/events" && stateCode >= 500 -> MockResponse.Builder().code(stateCode).body("down").build()
                    path == "/api/v1/tv/events" ->
                        MockResponse.Builder().addHeader("Content-Type", "text/event-stream").body(eventsBody).build()
                    path.endsWith("/ack") -> MockResponse.Builder().body("""{"ok":true}""").build()
                    else -> MockResponse.Builder().code(404).body("""{"error":"not_found"}""").build()
                }
            }
        }
        server.start()
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        store = DeviceStore(PreferenceDataStoreFactory.create(scope = scope) { File(tmp.root, "test.preferences_pb") })
    }

    @After
    fun tearDown() {
        scope.cancel()
        server.close()
    }

    private fun repository(clock: () -> Long = { System.nanoTime() / 1_000_000 }) = ServerRepository(
        scope, store, EventsClient(http),
        timing = ServerRepository.Timing(pollMs = 60_000, offlinePollMs = 60_000, minBackoffMs = 50, maxBackoffMs = 100, clock = clock),
    )

    private fun api() = ApiClient(server.url("/"), "device-token", http)

    @Test
    fun refreshShowsAndCachesTheState() = runBlocking {
        val repo = repository()
        val api = api()
        repo.use(api)
        assertTrue(repo.refresh(api))
        assertEquals(5L, repo.state.value?.version)
        assertTrue(repo.online.value)
        assertNotNull(store.cachedState())

        // A restart without the server still shows the last home screen.
        val again = repository()
        again.use(ApiClient(server.url("/"), "device-token", http))
        assertEquals("caminandes", again.state.value?.home?.single()?.item?.id)
    }

    @Test
    fun unreachableServerMeansOffline() = runBlocking {
        val repo = repository()
        val api = api()
        repo.use(api)
        server.close()
        assertFalse(repo.refresh(api))
        assertFalse(repo.online.value)
    }

    @Test
    fun aRemovedDeviceMustPairAgain() = runBlocking {
        stateCode = 401
        val repo = repository()
        val api = api()
        repo.use(api)
        val signal = async { withTimeoutOrNull(5_000) { repo.unauthorized.first() } }
        delay(50)
        assertFalse(repo.refresh(api))
        assertNotNull(signal.await())
        assertNull(repo.state.value)
    }

    @Test
    fun commandsAreDeliveredOnceAndAcknowledged() = runBlocking {
        // The stream ends after each delivery, so the command is replayed on every reconnect until acknowledged.
        eventsBody = "event: state\ndata: {\"version\":5}\n\n" +
            "event: command\ndata: {\"id\":7,\"type\":\"stop\",\"payload\":{}}\n\n"
        val repo = repository()
        repo.use(api())
        val first = async { withTimeout(5_000) { repo.commands.first() } }
        delay(50)
        repo.start()
        assertEquals(ServerEvent.Command(7, "stop", null, null), first.await())
        val more = withTimeoutOrNull(600) { repo.commands.take(1).toList() }
        assertNull("replays of an already handled command are not delivered again", more)
        repo.stop()
        assertTrue(paths.count { it == "/api/v1/tv/events" } >= 2)
        assertTrue(paths.contains("/api/v1/tv/commands/7/ack"))
    }

    @Test
    fun commandsOfUnknownTypesAreAcknowledgedToo() = runBlocking {
        // A newer server's command (odd payload included): handed on (the app ignores it) and acknowledged, so it
        // is not replayed on every reconnect.
        eventsBody = "event: command\ndata: {\"id\":9,\"type\":\"dance\",\"payload\":{\"style\":[1,2]}}\n\n"
        val repo = repository()
        repo.use(api())
        val first = async { withTimeout(5_000) { repo.commands.first() } }
        delay(50)
        repo.start()
        assertEquals(ServerEvent.Command(9, "dance"), first.await())
        withTimeout(5_000) { while (!paths.contains("/api/v1/tv/commands/9/ack")) delay(20) }
        repo.stop()
    }

    @Test
    fun onlyStatesFromTheServerAreFresh() = runBlocking {
        val api = api()
        val first = repository()
        first.use(api)
        assertTrue(first.refresh(api)) // caches it

        val repo = repository()
        val fromCache = async { withTimeoutOrNull(500) { repo.fetched.first() } }
        delay(50)
        repo.use(api)
        assertEquals("the cached home shows at once", 5L, repo.state.value?.version)
        assertNull("but it is not a fresh state", fromCache.await())

        val fresh = async { withTimeout(5_000) { repo.fetched.first() } }
        delay(50)
        assertTrue(repo.refresh(api))
        assertEquals(5L, fresh.await().version)
    }

    @Test
    fun aLongOutageIsAnnouncedOnceTheServerAnswersAgain() = runBlocking {
        val now = AtomicLong(1_000_000L)
        val repo = repository(clock = { now.get() })
        val api = api()
        repo.use(api)
        val outages = CopyOnWriteArrayList<Long>()
        val collector = scope.launch { repo.outages.collect { outages += it } }
        delay(50)
        repo.start()
        withTimeout(5_000) { while (repo.state.value == null) delay(20) }

        // Two minutes down: too short to report. (The clock moves before the server comes back, so a refresh
        // from the background loops measures the same length as this one.)
        stateCode = 503
        assertFalse(repo.refresh(api))
        now.addAndGet(2 * 60_000L)
        stateCode = 200
        assertTrue(repo.refresh(api))
        delay(100)
        assertEquals(emptyList<Long>(), outages.toList())

        // Seven minutes down: reported once, with its length.
        stateCode = 503
        assertFalse(repo.refresh(api))
        now.addAndGet(7 * 60_000L)
        stateCode = 200
        assertTrue(repo.refresh(api))
        withTimeout(5_000) { while (outages.isEmpty()) delay(20) }
        delay(100)
        assertEquals(listOf(7 * 60_000L), outages.toList())

        // Time in the background does not count: stopped while down, started again much later, back soon after.
        stateCode = 503
        assertFalse(repo.refresh(api))
        repo.stop()
        now.addAndGet(60 * 60_000L)
        repo.start()
        now.addAndGet(60_000L)
        stateCode = 200
        assertTrue(repo.refresh(api))
        delay(100)
        assertEquals(listOf(7 * 60_000L), outages.toList())
        repo.stop()
        collector.cancel()
    }

    private companion object {
        val STATE = """
            {"version":5,"device":{"id":"abcdefabcdef","name":"TV","uiLanguage":"en","preferredAudioLanguage":"en","subtitlesLanguage":null},
             "catalog":{"id":"izle-sample","buildId":"b","name":"n"},
             "home":[{"item":{"id":"caminandes","kind":"series","title":"Caminandes","year":2013,"posterUrl":"/assets/x.jpg"},
                      "continue":{"episodeId":"caminandes.s01e01","season":1,"number":1,"title":"Llama Drama","label":null,
                                  "index":0,"count":3,"positionMs":0,"durationMs":90000,"status":"new"}}]}
        """.trimIndent()
    }
}
