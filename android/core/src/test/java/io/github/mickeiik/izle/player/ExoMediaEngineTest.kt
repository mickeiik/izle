package io.github.mickeiik.izle.player

import android.Manifest
import android.app.Application
import android.os.Looper
import androidx.media3.common.C
import androidx.test.core.app.ApplicationProvider
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowPowerManager
import java.net.InetAddress
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

/** The real adapter's decoder lifecycle needs Android services; transport is answered in memory. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class ExoMediaEngineTest {
    private val http = OkHttpClient.Builder().addInterceptor { chain ->
        Response.Builder().request(chain.request()).protocol(okhttp3.Protocol.HTTP_1_1)
            .code(404).message("fixture").body(ByteArray(0).toResponseBody()).build()
    }.build()
    private val media = MediaSpec("http://media.test/one", "mp4", emptyList(), "episode", live = false)

    /**
     * Every request of [hlsServer], which answers a tiny AES-128 HLS stream under any directory. An in-process server,
     * not an interceptor answering in memory: the found link's headers are added on the way to the network.
     */
    private val requests = CopyOnWriteArrayList<RecordedRequest>()
    private val hlsServer = MockWebServer().apply {
        dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                val body = when (request.url.pathSegments.last()) {
                    "master" -> "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n" +
                        "#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXTINF:4,\nseg0.ts\n#EXT-X-ENDLIST\n"
                    "key.bin" -> String(CharArray(16) { 'k' })
                    "seg0.ts" -> String(CharArray(4 * 188) { 'G' })
                    else -> null
                }
                return MockResponse.Builder().code(if (body == null) 404 else 200).body(body ?: "").build()
            }
        }
    }
    private val hlsHttp = OkHttpClient()

    @Before
    fun setUp() = hlsServer.start()

    @After
    fun tearDown() {
        hlsServer.close()
        for (client in listOf(http, hlsHttp)) {
            client.dispatcher.executorService.shutdown()
            client.connectionPool.evictAll()
        }
    }

    /** Waits (driving the main looper) until a request for each of [paths] was made; the requests, by path. */
    private fun awaitRequests(vararg paths: String): Map<String, RecordedRequest> {
        val deadline = System.currentTimeMillis() + 10_000
        fun seen() = requests.associateBy { it.url.encodedPath }.filterKeys { it in paths }
        while (seen().size < paths.size && System.currentTimeMillis() < deadline) {
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(10)
        }
        return seen().also { assertEquals(paths.toSet(), it.keys) }
    }

    @Test
    fun aStreamsHeadersGoWithEveryOneOfItsRequests() {
        val headers = mapOf("Referer" to "https://page.test/", "Origin" to "https://page.test", "Cookie" to "a=b")
        val found = MediaSpec(
            hlsServer.url("/found/master?payload=abc").toString(), "hls", emptyList(), "found", live = false, headers = headers,
        )
        assertEquals(
            "the values stay out of logs",
            "MediaSpec(kind=hls, mediaId=found, live=false, subtitles=0, headers=[Referer, Origin, Cookie])",
            found.toString(),
        )
        val engine = ExoMediaEngine(ApplicationProvider.getApplicationContext(), hlsHttp, "izle-test", capVideoTo720p = false)
        try {
            engine.load(found, 0)
            // No .m3u8 in the URL: the kind makes it HLS, so the key and the segment are asked for too.
            val seen = awaitRequests("/found/master", "/found/key.bin", "/found/seg0.ts")
            assertEquals("abc", seen.getValue("/found/master").url.queryParameter("payload"))
            for (request in requests) {
                val path = request.url.encodedPath
                for ((name, value) in headers) assertEquals("$path $name", value, request.headers[name])
                assertEquals("$path User-Agent", "izle-test", request.headers["User-Agent"])
            }
            // A stream without headers (everything the TV plays) sends none of them.
            engine.load(MediaSpec(hlsServer.url("/plain/master").toString(), "hls", emptyList(), "plain", live = false), null)
            val plain = awaitRequests("/plain/master").getValue("/plain/master")
            for (name in headers.keys) assertNull(name, plain.headers[name])
            assertEquals("izle-test", plain.headers["User-Agent"])
        } finally {
            engine.release()
        }
    }

    @Test
    fun aRedirectToAnotherHostGetsNoneOfTheStreamsHeaders() {
        val headers = mapOf("Referer" to "https://page.test/", "Origin" to "https://page.test", "Cookie" to "a=b")
        val linkHost = MockWebServer()
        val otherHost = MockWebServer()
        val loopback = OkHttpClient()
        linkHost.start()
        otherHost.start(InetAddress.getByName("127.0.0.1"), 0)
        // The key moves on the same host; the segment moves to another host name.
        linkHost.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.url.encodedPath) {
                "/found/master" -> MockResponse.Builder().code(200).body(
                    "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n" +
                        "#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXTINF:4,\nseg0.ts\n#EXT-X-ENDLIST\n",
                ).build()
                "/found/key.bin" -> MockResponse.Builder().code(302).addHeader("Location", "/keys/real.bin").build()
                "/keys/real.bin" -> MockResponse.Builder().code(200).body(String(CharArray(16) { 'k' })).build()
                "/found/seg0.ts" -> MockResponse.Builder().code(302)
                    .addHeader("Location", "http://127.0.0.1:${otherHost.port}/cdn/seg0.ts").build()
                else -> MockResponse.Builder().code(404).build()
            }
        }
        otherHost.enqueue(MockResponse.Builder().code(200).body(String(CharArray(4 * 188) { 'G' })).build())
        val url = linkHost.url("/found/master")
        assertNotEquals("two host names", "127.0.0.1", url.host)
        val found = MediaSpec(url.toString(), "hls", emptyList(), "found", live = false, headers = headers)
        val engine = ExoMediaEngine(ApplicationProvider.getApplicationContext(), loopback, "izle-test", capVideoTo720p = false)
        try {
            engine.load(found, 0)
            val deadline = System.currentTimeMillis() + 10_000
            while (otherHost.requestCount < 1 && System.currentTimeMillis() < deadline) {
                shadowOf(Looper.getMainLooper()).idle()
                Thread.sleep(10)
            }
            val segment = otherHost.takeRequest(1, TimeUnit.SECONDS)
            assertNotNull("the stream still plays: the segment arrives", segment)
            assertEquals("/cdn/seg0.ts", segment!!.url.encodedPath)
            for (name in headers.keys) assertNull("other host $name", segment.headers[name])
            assertEquals("izle-test", segment.headers["User-Agent"])

            val linkRequests = generateSequence { linkHost.takeRequest(0, TimeUnit.SECONDS) }.toList()
            assertEquals(
                setOf("/found/master", "/found/key.bin", "/keys/real.bin", "/found/seg0.ts"),
                linkRequests.map { it.url.encodedPath }.toSet(),
            )
            for (request in linkRequests) {
                val path = request.url.encodedPath
                for ((name, value) in headers) assertEquals("$path $name", value, request.headers[name])
            }
        } finally {
            engine.release()
            linkHost.close()
            otherHost.close()
            loopback.dispatcher.executorService.shutdown()
            loopback.connectionPool.evictAll()
        }
    }

    @Test
    fun audioOnlyDisablesVideoAndKeepsTheNetworkAwake() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        shadowOf(app).grantPermissions(Manifest.permission.WAKE_LOCK) // the companion app's manifest asks for it
        val engine = ExoMediaEngine(app, http, "izle-test", capVideoTo720p = false, audioOnly = true)
        try {
            engine.applyPreferences("de", null)
            engine.load(media, 0)
            val first = engine.surface!!
            assertTrue(C.TRACK_TYPE_VIDEO in first.trackSelectionParameters.disabledTrackTypes)
            assertEquals(listOf("de"), first.trackSelectionParameters.preferredAudioLanguages)
            // The wake mode: the player creates its wake lock (on its own thread) only when a wake mode is set.
            val deadline = System.currentTimeMillis() + 5_000
            while (ShadowPowerManager.getLatestWakeLock() == null && System.currentTimeMillis() < deadline) Thread.sleep(10)
            assertEquals("ExoPlayer:WakeLockManager", shadowOf(ShadowPowerManager.getLatestWakeLock()).tag)
            // Also on a decoder created later.
            engine.release()
            engine.applyPreferences("en", null)
            engine.load(media, 0)
            assertTrue(C.TRACK_TYPE_VIDEO in engine.surface!!.trackSelectionParameters.disabledTrackTypes)
        } finally {
            engine.release()
        }
    }

    @Test
    fun playbackRateIsThePlayersSpeed() {
        val engine = ExoMediaEngine(ApplicationProvider.getApplicationContext(), http, "izle-test", capVideoTo720p = false)
        try {
            assertEquals("nominal without a decoder", 1f, engine.playbackRate)
            engine.load(media, 0)
            assertEquals(1f, engine.playbackRate)
            engine.playbackRate = 1.05f
            assertEquals(1.05f, engine.surface!!.playbackParameters.speed)
            assertEquals(1.05f, engine.playbackRate)
            engine.playbackRate = 0.98f
            assertEquals(0.98f, engine.playbackRate)
        } finally {
            engine.release()
        }
    }

    @Test
    fun theDecoderIsLazyReusedAndRecreatedWithPreferencesAfterRelease() {
        val engine = ExoMediaEngine(ApplicationProvider.getApplicationContext(), http, "izle-test", capVideoTo720p = true)
        try {
            engine.applyPreferences("pt-BR", "tr")
            assertNull(engine.surface)
            engine.load(media, 55_000)
            val first = engine.surface!!
            assertEquals(55_000L, engine.positionMs)
            assertEquals(listOf("pt-br", "pt"), first.trackSelectionParameters.preferredAudioLanguages)
            assertEquals(listOf("tr"), first.trackSelectionParameters.preferredTextLanguages)
            assertFalse(C.TRACK_TYPE_TEXT in first.trackSelectionParameters.disabledTrackTypes)
            assertEquals(1280, first.trackSelectionParameters.maxVideoWidth)
            assertEquals(720, first.trackSelectionParameters.maxVideoHeight)
            assertFalse("the TV shows the picture", C.TRACK_TYPE_VIDEO in first.trackSelectionParameters.disabledTrackTypes)
            engine.load(media, 80_000)
            assertSame(first, engine.surface)
            engine.release()
            assertNull(engine.surface)
            engine.applyPreferences("en", null)
            engine.load(media, 90_000)
            assertNotSame(first, engine.surface)
            assertEquals(90_000L, engine.positionMs)
            assertEquals(listOf("en"), engine.surface!!.trackSelectionParameters.preferredAudioLanguages)
            assertTrue(C.TRACK_TYPE_TEXT in engine.surface!!.trackSelectionParameters.disabledTrackTypes)
        } finally {
            engine.release()
        }
    }
}
