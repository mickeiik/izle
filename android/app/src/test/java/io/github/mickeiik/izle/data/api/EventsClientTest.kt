package io.github.mickeiik.izle.data.api

import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.IOException

class EventsClientTest {
    private val server = MockWebServer()
    private val http = OkHttpClient()

    @Before
    fun setUp() = server.start()

    @After
    fun tearDown() = server.close()

    @Test
    fun streamsStateAndCommandEvents() = runBlocking {
        server.enqueue(
            MockResponse.Builder()
                .addHeader("Content-Type", "text/event-stream")
                .body(
                    "retry: 5000\nevent: state\nid: s4\ndata: {\"version\":4}\n\n" +
                        ": ping\n\n" +
                        "event: command\nid: c7\ndata: {\"id\":7,\"type\":\"play\",\"payload\":{\"itemId\":\"show\",\"episodeId\":\"show.e1\"}}\n\n" +
                        "event: future\ndata: {}\n\n",
                )
                .build(),
        )
        val api = ApiClient(server.url("/"), "device-token", http)
        var failure: Throwable? = null
        val events = withTimeout(5_000) {
            EventsClient(http).events(api).catch { failure = it }.toList()
        }
        assertEquals(listOf(ServerEvent.Open, ServerEvent.State(4), ServerEvent.Command(7, "play", "show", "show.e1")), events)
        assertTrue("the end of the stream is a failure to reconnect from", failure is IOException)
        val request = server.takeRequest()
        assertEquals("/api/v1/tv/events", request.url.encodedPath)
        assertEquals("Bearer device-token", request.headers["Authorization"])
    }

    @Test
    fun aRemovedDeviceGets401() = runBlocking {
        server.enqueue(MockResponse.Builder().code(401).body("""{"error":"unauthorized"}""").build())
        var failure: Throwable? = null
        withTimeout(5_000) {
            EventsClient(http).events(ApiClient(server.url("/"), "old", http)).catch { failure = it }.toList()
        }
        assertEquals(401, (failure as ApiException).status)
    }
}
