package io.github.mickeiik.izle.update

import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.data.api.ApiException
import io.github.mickeiik.izle.data.api.CommandResult
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.SocketEffect
import okhttp3.OkHttpClient
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.security.MessageDigest

class ApkDownloaderTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private val server = MockWebServer()
    private val http = OkHttpClient()
    private val bytes = ByteArray(200_000) { (it * 31 % 251).toByte() }
    private val sha = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private val update = AvailableUpdate("0.3.0", 300, sha, bytes.size.toLong(), auto = true)

    @Before
    fun setUp() = server.start()

    @After
    fun tearDown() = server.close()

    private fun api() = ApiClient(server.url("/"), "device-token", http, userAgent = { "izle-tv/0.2.0 (Android 25; 200; guided)" })

    private fun downloader(maxBytes: Long = ApkDownloader.MAX_BYTES) = ApkDownloader(http, tmp.root, maxBytes)

    private fun apk(body: ByteArray = bytes) = MockResponse.Builder()
        .addHeader("Content-Type", "application/vnd.android.package-archive")
        .addHeader("ETag", "\"$sha\"")
        .body(Buffer().write(body))
        .build()

    private fun failure(downloader: ApkDownloader, update: AvailableUpdate = this.update): String =
        assertThrows(UpdateException::class.java) { runBlocking { downloader.download(api(), update) } }.reason

    @Test
    fun aVerifiedDownloadIsKeptWithItsBytes() = runBlocking {
        server.enqueue(apk())
        val file = downloader().download(api(), update)
        assertEquals(ApkDownloader.FILE_NAME, file.name)
        assertArrayEquals(bytes, file.readBytes())
        val request = server.takeRequest()
        assertEquals("/api/v1/tv/app/apk", request.url.encodedPath)
        assertEquals("Bearer device-token", request.headers["Authorization"])
        assertEquals("izle-tv/0.2.0 (Android 25; 200; guided)", request.headers["User-Agent"])
    }

    @Test
    fun anotherHashIsRejectedAndNothingKept() {
        server.enqueue(apk(bytes.copyOf().also { it[10] = (it[10] + 1).toByte() }))
        val downloader = downloader()
        assertEquals(CommandResult.VERIFY, failure(downloader))
        assertFalse(downloader.file.exists())
    }

    @Test
    fun tooLargeIsRefusedBeforeReading() {
        val downloader = downloader(maxBytes = 1_000)
        assertEquals("the announced size", CommandResult.TOO_LARGE, failure(downloader))
        assertEquals("nothing was requested", 0, server.requestCount)
        server.enqueue(apk())
        assertEquals("the Content-Length", CommandResult.TOO_LARGE, failure(downloader, update.copy(size = 500)))
        assertFalse(downloader.file.exists())
    }

    @Test
    fun aTruncatedBodyIsADownloadFailure() {
        // The connection drops halfway through the body.
        server.enqueue(apk().newBuilder().onResponseBody(SocketEffect.ShutdownConnection).build())
        val downloader = downloader()
        assertEquals(CommandResult.DOWNLOAD, failure(downloader))
        assertFalse(downloader.file.exists())
    }

    @Test
    fun noApkIsAnApiError() {
        server.enqueue(MockResponse.Builder().code(404).addHeader("Content-Type", "application/json").body("""{"error":"no_apk"}""").build())
        val e = assertThrows(ApiException::class.java) { runBlocking { downloader().download(api(), update) } }
        assertEquals(404, e.status)
        assertEquals("no_apk", e.code)
    }
}
