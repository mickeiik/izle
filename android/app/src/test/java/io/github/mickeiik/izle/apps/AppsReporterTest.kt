package io.github.mickeiik.izle.apps

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.data.api.InstalledApp
import io.github.mickeiik.izle.json
import io.github.mickeiik.izle.settings.DeviceStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.job
import kotlinx.coroutines.runBlocking
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
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList

/** The installed-apps report against an in-process server: when it is sent, which pictures follow, what is remembered. */
class AppsReporterTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private val server = MockWebServer()
    private val requests = CopyOnWriteArrayList<RecordedRequest>()
    private lateinit var storeScope: CoroutineScope
    private lateinit var store: DeviceStore

    /** What `PUT /tv/apps` answers as missing, and the status of the image uploads. */
    @Volatile private var missing = listOf<String>()
    @Volatile private var uploadCode = 204
    @Volatile private var reportCode = 200

    private var now = 1_000_000L
    private var apps = listOf(app("com.example.weather", "Weather", 1), app("org.example.music", "Music", 2))
    private var api: ApiClient? = null

    private fun app(appId: String, label: String, picture: Int?): ReportedApp {
        val png = picture?.let { byteArrayOf(-119, 80, 78, 71, it.toByte()) }
        return ReportedApp(InstalledApp(appId, label, png?.let(AppsReport::sha256)), png)
    }

    @Before
    fun setUp() {
        storeScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        store = DeviceStore(PreferenceDataStoreFactory.create(scope = storeScope) { File(tmp.root, "izle.preferences_pb") })
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                return when {
                    request.url.encodedPath == "/api/v1/tv/apps" ->
                        if (reportCode != 200) json(reportCode, """{"error":"not_found"}""")
                        else json(200, """{"missingImages":[${missing.joinToString(",") { "\"$it\"" }}]}""")
                    else -> MockResponse.Builder().code(uploadCode).build()
                }
            }
        }
        server.start()
        api = ApiClient(server.url("/"), "device-token", OkHttpClient())
    }

    @After
    fun tearDown() {
        storeScope.cancel()
        server.close()
    }

    /** One report as [AppsReporter.reportSoon] starts it, waited for. */
    private fun report() = runBlocking {
        val scope = CoroutineScope(coroutineContext + Job())
        AppsReporter(scope, store, { api }, { apps }, clock = { now }, delayMs = 0).reportSoon()
        scope.coroutineContext.job.children.forEach { it.join() }
    }

    private fun paths() = requests.map { it.method + " " + it.url.encodedPath }

    @Test
    fun theFirstReportSendsTheListThenOnlyThePicturesTheServerMisses() {
        val music = apps[1].app.image!!
        missing = listOf(music)
        report()
        assertEquals(listOf("PUT /api/v1/tv/apps", "PUT /api/v1/tv/apps/images/$music"), paths())
        assertEquals("image/png", requests[1].headers["Content-Type"])
        assertEquals(apps[1].png!!.toList(), requests[1].body!!.toByteArray().toList())
        val stored = runBlocking { store.current() }
        assertEquals(AppsReport.hash(apps.map { it.app }), stored.appsReportHash)
        assertEquals(now, stored.appsReportedAt)
    }

    @Test
    fun anUnchangedListIsNotSentAgainUntilADayLater() {
        report()
        report()
        assertEquals(1, requests.size)
        now += AppsReport.RESEND_MS - 1
        report()
        assertEquals(1, requests.size)
        // A server that lost its pictures asks for them again.
        now += 1
        missing = listOf(apps[0].app.image!!)
        report()
        assertEquals(listOf("PUT /api/v1/tv/apps", "PUT /api/v1/tv/apps", "PUT /api/v1/tv/apps/images/${apps[0].app.image}"), paths())
    }

    @Test
    fun anotherNameOrPictureIsAnotherList() {
        report()
        apps = listOf(app("com.example.weather", "Weather", 1), app("org.example.music", "Music", 3))
        report()
        apps = listOf(app("com.example.weather", "Météo", 1), app("org.example.music", "Music", 3))
        report()
        apps = apps.take(1)
        report()
        assertEquals(4, requests.size)
    }

    @Test
    fun aFailedUploadOrAServerWithoutTheRouteLeavesTheReportToBeSentAgain() {
        missing = listOf(apps[0].app.image!!)
        uploadCode = 500
        report()
        assertNull(runBlocking { store.current() }.appsReportHash)
        uploadCode = 204
        report()
        assertEquals(4, requests.size)
        assertTrue(runBlocking { store.current() }.appsReportHash != null)

        requests.clear()
        runBlocking { store.forgetPairing() }
        reportCode = 404
        report()
        report()
        assertEquals(2, requests.size)
        assertNull(runBlocking { store.current() }.appsReportHash)
    }

    @Test
    fun nothingWithoutAPairedServer() {
        api = null
        report()
        assertTrue(requests.isEmpty())
    }

    @Test
    fun theListHasValidAppIdsOnceInNameOrderWithoutIzle() {
        val big = ByteArray(AppsReport.MAX_IMAGE_BYTES + 1)
        val list = AppsReport.list(
            listOf(
                app("org.example.music", "  music ", 1),
                app("io.github.mickeiik.izle", "izle", 2),
                app("com.example.weather", "Weather", 3),
                app("com.example.weather", "Weather again", 4),
                app("nodots", "No dots", 5),
                app("com.example.blank", "   ", null),
                app("com.example.long", "x".repeat(150), null),
                ReportedApp(InstalledApp("com.example.big", "Big", AppsReport.sha256(big)), big),
            ),
            ownAppId = "io.github.mickeiik.izle",
        )
        assertEquals(
            listOf("com.example.big", "com.example.blank", "org.example.music", "com.example.weather", "com.example.long"),
            list.map { it.app.appId },
        )
        assertEquals(listOf("Big", "com.example.blank", "music", "Weather", "x".repeat(100)), list.map { it.app.label })
        // A picture over 256 KiB is not sent: no picture.
        assertNull(list[0].app.image)
        assertNull(list[0].png)
        // A name is never cut inside a surrogate pair.
        val emoji = AppsReport.list(listOf(app("com.example.emoji", "x".repeat(99) + "\uD83C\uDFAC more", null)), "x.y")
        assertEquals("x".repeat(99), emoji.single().app.label)
        assertEquals(AppsReport.MAX_APPS, AppsReport.list((1..250).map { app("com.example.a$it", "App $it", null) }, "x.y").size)
    }

    @Test
    fun dueWhenTheListChangedNeverAcceptedOrADayOld() {
        assertTrue(AppsReport.due("h1", null, null, now = 5))
        assertTrue(AppsReport.due("h2", "h1", 0, now = 5))
        assertFalse(AppsReport.due("h1", "h1", 0, now = AppsReport.RESEND_MS - 1))
        assertTrue(AppsReport.due("h1", "h1", 0, now = AppsReport.RESEND_MS))
        // The clock went back: no telling how long ago.
        assertTrue(AppsReport.due("h1", "h1", 100, now = 5))
    }
}
