package io.github.mickeiik.izle.data

import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.data.api.ProblemReport
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import java.util.concurrent.atomic.AtomicLong

class ProblemReporterTest {
    private val server = MockWebServer()
    private val http = OkHttpClient()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val clock = AtomicLong(50_000)

    @Before
    fun setUp() = server.start()

    @After
    fun tearDown() {
        scope.cancel()
        server.close()
    }

    private val report = ProblemReport(kind = "playback", code = "gave_up", episodeId = "e")

    @Test
    fun sendsOnceWithTheAgeAndIgnoresRefusals() = runBlocking {
        server.enqueue(MockResponse.Builder().code(429).body("""{"error":"rate_limited"}""").build())
        server.enqueue(MockResponse.Builder().code(202).body("""{"ok":true}""").build())
        val api = ApiClient(server.url("/"), "device-token", http)
        val reporter = ProblemReporter(scope, { api }, clock::get)
        reporter.send(report, happenedAt = 48_500)
        withTimeout(5_000) { while (server.requestCount < 1) delay(20) }
        assertEquals("""{"kind":"playback","code":"gave_up","ageMs":1500,"episodeId":"e"}""", server.takeRequest().body?.utf8())
        delay(300)
        assertEquals("a 429 is not retried", 1, server.requestCount)
        reporter.send(report)
        withTimeout(5_000) { while (server.requestCount < 2) delay(20) }
        assertEquals("""{"kind":"playback","code":"gave_up","ageMs":0,"episodeId":"e"}""", server.takeRequest().body?.utf8())
    }

    @Test
    fun anUnreachableServerOrNoServerIsNotAProblem() = runBlocking {
        val api = ApiClient(server.url("/"), "device-token", http)
        server.close()
        ProblemReporter(scope, { api }, clock::get).send(report)
        ProblemReporter(scope, { null }, clock::get).send(report)
        delay(300) // nothing thrown, nothing to wait for
    }
}
