package io.github.mickeiik.izle.data.api

import io.github.mickeiik.izle.json
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** A TV's settings, problems, pairing and the status in [ApiClient] against an in-process MockWebServer (no network). */
class DeviceApiTest {
    private val server = MockWebServer()
    private val http = OkHttpClient()

    @Before
    fun setUp() = server.start()

    @After
    fun tearDown() = server.close()

    private fun client() = ApiClient(server.url("/izle/"), "izph_secret", http)

    /** The next request, checked to be [method] [path] with the phone secret. */
    private fun takeRequest(method: String, path: String): RecordedRequest = server.takeRequest().also {
        assertEquals(method, it.method)
        assertEquals(path, it.url.encodedPath)
        assertEquals("Bearer izph_secret", it.headers["Authorization"])
    }

    private fun noContent() = MockResponse.Builder().code(204).build()

    @Test
    fun aDeviceCarriesItsStoredSettingsCreationAndApp() = runBlocking {
        server.enqueue(json(200, """{"device":$DEVICE}"""))
        val device = client().device("tv-1").device
        assertEquals("2026-10-01T10:00:00.000Z", device.createdAt)
        assertEquals(DeviceSettings(uiLanguage = null, preferredAudioLanguage = "tr", subtitlesLanguage = null, autoplayOnStart = false, homeColumns = 5, homeRows = null), device.settings)
        assertEquals(DeviceEffective("tr", "tr", null, false, 5, 2), device.effective)
        assertEquals(
            DeviceApp("0.6.0", 600, 28, DeviceApp.CAPABILITY_GUIDED, "2026-10-20T10:00:00.000Z", DeviceApp.UPDATE_NEEDS_INSTALL_NOW),
            device.app,
        )
    }

    @Test
    fun aDeviceThatNeverReportedItsAppDecodes() = runBlocking {
        server.enqueue(
            json(200, """{"devices":[{"id":"tv-2","name":"TV","status":"pending","online":false,"createdAt":"2026-10-27T10:00:00.000Z","lastSeenAt":null,
                "app":{"version":null,"versionCode":null,"androidSdk":null,"capability":null,"reportedAt":null,"update":"unknown"}}]}"""),
        )
        val device = client().devices().devices.single()
        assertEquals(DeviceApp(), device.app)
        assertNull(device.settings)
    }

    @Test
    fun aChangeSendsOnlyItsFieldsWithExplicitNulls() = runBlocking {
        repeat(3) { server.enqueue(json(200, """{"device":$DEVICE}""")) }
        val api = client()
        // Subtitles off, the server's default audio, the default UI language.
        val device = api.updateDevice(
            "tv-1",
            DeviceChange(uiLanguage = SetTo(null), preferredAudioLanguage = SetTo(null), subtitlesLanguage = SetTo(null)),
        )
        assertEquals("Salon", device.name)
        val off = takeRequest("PATCH", "/izle/api/v1/admin/devices/tv-1")
        assertEquals("""{"uiLanguage":null,"preferredAudioLanguage":null,"subtitlesLanguage":null}""", off.body?.utf8())
        assertEquals("application/json", off.headers["Content-Type"]?.substringBefore(";"))

        api.updateDevice("tv-1", DeviceChange(name = "Salon", subtitlesLanguage = SetTo("tr"), autoplayOnStart = true))
        assertEquals(
            """{"name":"Salon","subtitlesLanguage":"tr","autoplayOnStart":true}""",
            takeRequest("PATCH", "/izle/api/v1/admin/devices/tv-1").body?.utf8(),
        )

        api.updateDevice("tv-1", DeviceChange(uiLanguage = SetTo("en"), homeColumns = 6, homeRows = 3))
        assertEquals("""{"uiLanguage":"en","homeColumns":6,"homeRows":3}""", takeRequest("PATCH", "/izle/api/v1/admin/devices/tv-1").body?.utf8())
    }

    @Test
    fun forgetDeletesTheDeviceAndKeepsTheErrorCode() = runBlocking {
        server.enqueue(noContent())
        server.enqueue(json(404, """{"error":"unknown_device","message":"no such device"}"""))
        val api = client()
        api.forgetDevice("tv/1")
        takeRequest("DELETE", "/izle/api/v1/admin/devices/tv%2F1")
        val gone = assertThrows(ApiException::class.java) { runBlocking { api.forgetDevice("tv-1") } }
        assertEquals(404, gone.status)
        assertEquals("unknown_device", gone.code)
    }

    @Test
    fun problemsAreReadNewestFirstAndCleared() = runBlocking {
        server.enqueue(json(200, PROBLEMS))
        server.enqueue(noContent())
        val api = client()
        val (playback, proxy, gone) = api.problems("tv-1", limit = 100)
        val list = takeRequest("GET", "/izle/api/v1/admin/devices/tv-1/problems")
        assertEquals("100", list.url.queryParameter("limit"))
        assertEquals(
            Problem(
                id = 42, at = "2026-10-27T09:00:00.000Z", origin = Problem.ORIGIN_TV, kind = "playback", code = "ERROR_CODE_IO_BAD_HTTP_STATUS",
                itemId = "show-1", itemTitle = "Caminandes", itemKind = "series", episodeId = "show-1.e2", episodeTitle = "Gran Dillama",
                season = 1, number = 2, sourceId = "tr-dub", positionMs = 754_000, httpStatus = 403,
                detail = "InvalidResponseCodeException: Response code: 403", appVersion = "0.6.1", missing = false,
            ),
            playback,
        )
        assertEquals(Problem.ORIGIN_SERVER, proxy.origin)
        assertEquals("upstream_unreachable", proxy.code)
        assertNull(proxy.positionMs)
        assertNull(proxy.appVersion)
        assertTrue(gone.missing)
        assertNull(gone.itemTitle)
        assertEquals("old.e1", gone.episodeId)

        api.clearProblems("tv-1")
        takeRequest("DELETE", "/izle/api/v1/admin/devices/tv-1/problems")
        Unit
    }

    @Test
    fun problemsAskForFiftyByDefault() = runBlocking {
        server.enqueue(json(200, """{"problems":[]}"""))
        assertTrue(client().problems("tv-1").isEmpty())
        assertEquals("50", takeRequest("GET", "/izle/api/v1/admin/devices/tv-1/problems").url.queryParameter("limit"))
    }

    @Test
    fun statusListsEveryActiveTvWithWhatItPlays() = runBlocking {
        server.enqueue(json(200, STATUS))
        val status = client().status()
        takeRequest("GET", "/izle/api/v1/admin/status")
        assertEquals(1_793_000_000_000L, status.serverNowMs)
        assertEquals("0.6.1", status.server?.version)
        assertEquals(StatusCatalog("sample", "b-7"), status.catalog)
        assertEquals(1, status.pairing.pending)
        assertEquals(9001L, status.lastEventId)
        val (salon, kitchen) = status.devices
        assertEquals("Salon", salon.name)
        assertTrue(salon.online)
        assertEquals("show-1", salon.nowPlaying?.itemId)
        assertEquals("Gran Dillama", salon.nowPlaying?.episodeTitle)
        assertEquals("playing", salon.nowPlaying?.state)
        assertFalse(kitchen.online)
        assertEquals("2026-10-26T20:00:00.000Z", kitchen.lastSeenAt)
        assertNull(kitchen.nowPlaying)
    }

    @Test
    fun pendingCodesAreListed() = runBlocking {
        server.enqueue(
            json(200, """{"codes":[{"code":"483920","createdAt":"2026-10-27T10:00:00.000Z","expiresAt":"2026-10-27T10:10:00.000Z","approved":false},
                {"code":"120034","createdAt":"2026-10-27T10:01:00.000Z","expiresAt":"2026-10-27T10:11:00.000Z","approved":true}]}"""),
        )
        val codes = client().pendingPairings()
        takeRequest("GET", "/izle/api/v1/admin/pair/pending")
        assertEquals(
            listOf(
                PendingCode("483920", "2026-10-27T10:00:00.000Z", "2026-10-27T10:10:00.000Z", false),
                PendingCode("120034", "2026-10-27T10:01:00.000Z", "2026-10-27T10:11:00.000Z", true),
            ),
            codes,
        )
    }

    @Test
    fun approveSendsTheCodeAndOnlyTheFieldsGiven() = runBlocking {
        server.enqueue(json(200, """{"deviceId":"d-9","name":"Kitchen"}"""))
        server.enqueue(json(200, """{"deviceId":"d-1","name":"Salon"}"""))
        server.enqueue(json(200, """{"deviceId":"d-10","name":"TV 2"}"""))
        val api = client()

        assertEquals(ApprovedPairing("d-9", "Kitchen"), api.approvePairing("483920", name = "Kitchen"))
        val named = takeRequest("POST", "/izle/api/v1/admin/pair/approve")
        assertEquals("""{"code":"483920","name":"Kitchen"}""", named.body?.utf8())
        assertEquals("application/json", named.headers["Content-Type"]?.substringBefore(";"))

        // Replacing a TV: the answer is the replaced device.
        assertEquals(ApprovedPairing("d-1", "Salon"), api.approvePairing("120034", replaces = "d-1"))
        assertEquals("""{"code":"120034","replaces":"d-1"}""", takeRequest("POST", "/izle/api/v1/admin/pair/approve").body?.utf8())

        assertEquals("TV 2", api.approvePairing("555111").name)
        assertEquals("""{"code":"555111"}""", takeRequest("POST", "/izle/api/v1/admin/pair/approve").body?.utf8())
    }

    @Test
    fun pairingErrorsKeepTheirCodes() = runBlocking {
        server.enqueue(json(404, """{"error":"unknown_code","message":"no open pairing code with this value"}"""))
        server.enqueue(json(409, """{"error":"already_approved","message":"this code is already approved"}"""))
        server.enqueue(json(404, """{"error":"unknown_device","message":"no active device with this id"}"""))
        server.enqueue(json(404, """{"error":"unknown_code","message":"no open pairing code with this value"}"""))
        val api = client()
        val unknown = assertThrows(ApiException::class.java) { runBlocking { api.approvePairing("000000") } }
        assertEquals(404, unknown.status)
        assertEquals("unknown_code", unknown.code)
        val twice = assertThrows(ApiException::class.java) { runBlocking { api.approvePairing("483920", name = "Salon") } }
        assertEquals(409, twice.status)
        assertEquals("already_approved", twice.code)
        assertEquals("unknown_device", assertThrows(ApiException::class.java) { runBlocking { api.approvePairing("483920", replaces = "gone") } }.code)
        assertEquals("unknown_code", assertThrows(ApiException::class.java) { runBlocking { api.cancelPairing("000000") } }.code)
    }

    @Test
    fun cancelClearsAnOpenCode() = runBlocking {
        server.enqueue(noContent())
        client().cancelPairing("483920")
        takeRequest("DELETE", "/izle/api/v1/admin/pair/pending/483920")
        Unit
    }

    @Test
    fun adminEventsSendTheLimitWhenGiven() = runBlocking {
        server.enqueue(json(200, """{"events":[],"last":5,"gap":false}"""))
        client().adminEvents(after = 0, limit = 500)
        val request = takeRequest("GET", "/izle/api/v1/admin/events")
        assertEquals("500", request.url.queryParameter("limit"))
        assertEquals("0", request.url.queryParameter("after"))
    }

    private companion object {
        const val DEVICE = """{"id":"tv-1","name":"Salon","status":"active","online":true,"createdAt":"2026-10-01T10:00:00.000Z",
            "lastSeenAt":"2026-10-27T10:00:00.000Z","stateVersion":12,
            "settings":{"uiLanguage":null,"preferredAudioLanguage":"tr","subtitlesLanguage":null,"autoplayOnStart":false,"homeColumns":5,"homeRows":null},
            "effective":{"uiLanguage":"tr","preferredAudioLanguage":"tr","subtitlesLanguage":null,"autoplayOnStart":false,"homeColumns":5,"homeRows":2},
            "problems":{"recent":2,"lastAt":"2026-10-27T09:00:00.000Z"},
            "app":{"version":"0.6.0","versionCode":600,"androidSdk":28,"capability":"guided","reportedAt":"2026-10-20T10:00:00.000Z","update":"needs_install_now"}}"""

        const val PROBLEMS = """{"problems":[
            {"id":42,"at":"2026-10-27T09:00:00.000Z","origin":"tv","kind":"playback","code":"ERROR_CODE_IO_BAD_HTTP_STATUS","itemId":"show-1",
             "itemTitle":"Caminandes","itemKind":"series","episodeId":"show-1.e2","episodeTitle":"Gran Dillama","season":1,"number":2,"sourceId":"tr-dub",
             "positionMs":754000,"httpStatus":403,"detail":"InvalidResponseCodeException: Response code: 403","appVersion":"0.6.1","missing":false},
            {"id":41,"at":"2026-10-27T08:00:00.000Z","origin":"server","kind":"proxy","code":"upstream_unreachable","itemId":"ch-1","itemTitle":"News",
             "itemKind":"live","episodeId":null,"episodeTitle":null,"season":null,"number":null,"sourceId":"main","positionMs":null,"httpStatus":null,
             "detail":"segment: no answer within 20 s","appVersion":null,"missing":false},
            {"id":40,"at":"2026-10-20T08:00:00.000Z","origin":"server","kind":"resolve","code":"no_playable_source","itemId":"old","itemTitle":null,
             "itemKind":null,"episodeId":"old.e1","episodeTitle":null,"season":null,"number":null,"sourceId":null,"positionMs":null,"httpStatus":null,
             "detail":"src-a: timeout","appVersion":null,"missing":true}]}"""

        const val STATUS = """{"serverNowMs":1793000000000,"server":{"version":"0.6.1"},"catalog":{"id":"sample","buildId":"b-7"},"pairing":{"pending":1},
            "devices":[
              {"id":"tv-1","name":"Salon","online":true,"lastSeenAt":"2026-10-27T10:00:00.000Z","nowPlaying":{"itemId":"show-1","itemKind":"series",
               "episodeId":"show-1.e2","sourceId":"tr-dub","itemTitle":"Caminandes","episodeTitle":"Gran Dillama","positionMs":120000,"durationMs":900000,
               "state":"playing","updatedAt":"2026-10-27T10:00:00.000Z","playing":true,"viewingId":"v-3"}},
              {"id":"tv-2","name":"Kitchen","online":false,"lastSeenAt":"2026-10-26T20:00:00.000Z","nowPlaying":null}],
            "lastEventId":9001}"""
    }
}
