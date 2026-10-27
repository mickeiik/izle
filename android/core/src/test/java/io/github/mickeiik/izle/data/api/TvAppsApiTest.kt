package io.github.mickeiik.izle.data.api

import io.github.mickeiik.izle.json
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Before
import org.junit.Test

/** The installed-apps report and the app cards in a section's `entries`, against an in-process server. */
class TvAppsApiTest {
    private val server = MockWebServer()
    private val api by lazy { ApiClient(server.url("/"), "device-token", OkHttpClient()) }

    @Before
    fun setUp() = server.start()

    @After
    fun tearDown() = server.close()

    @Test
    fun theReportSendsEveryAppWithAnExplicitNullImageAndReadsTheMissingOnes() = runBlocking {
        server.enqueue(json(200, """{"missingImages":["${"a".repeat(64)}"]}"""))
        val result = api.reportApps(listOf(InstalledApp("com.example.weather", "Weather", "a".repeat(64)), InstalledApp("org.example.tv", "TV", null)))
        assertEquals(listOf("a".repeat(64)), result.missingImages)
        val request = server.takeRequest()
        assertEquals("PUT", request.method)
        assertEquals("/api/v1/tv/apps", request.url.encodedPath)
        assertEquals("Bearer device-token", request.headers["Authorization"])
        assertEquals(
            """{"apps":[{"appId":"com.example.weather","label":"Weather","image":"${"a".repeat(64)}"},{"appId":"org.example.tv","label":"TV","image":null}]}""",
            request.body?.utf8(),
        )
    }

    @Test
    fun anImageIsAPngPutUnderItsHash() = runBlocking {
        server.enqueue(MockResponse.Builder().code(204).build())
        server.enqueue(json(404, """{"error":"not_found"}"""))
        val png = byteArrayOf(-119, 80, 78, 71, 13, 10, 26, 10)
        api.uploadAppImage("b".repeat(64), png)
        val request = server.takeRequest()
        assertEquals("PUT", request.method)
        assertEquals("/api/v1/tv/apps/images/${"b".repeat(64)}", request.url.encodedPath)
        assertEquals("image/png", request.headers["Content-Type"])
        assertArrayEquals(png, request.body?.toByteArray())
        val e = assertThrows(ApiException::class.java) { runBlocking { api.uploadAppImage("c".repeat(64), png) } }
        assertEquals(404, e.status)
    }

    @Test
    fun aSectionsEntriesNameShowsAndAppsAndAnOldServerHasNone() {
        val state = ApiJson.decodeFromString(
            TvState.serializer(),
            """{"version":1,"device":{"id":"tv","name":"TV"},"catalog":{"id":"c","buildId":"b","name":"C"},"home":[],
              "homeSections":[{"id":"untitled","title":null,"layout":"grid","itemIds":["a"],
                "entries":[{"itemId":"a"},{"appId":"com.example.weather"},{"kind":"later"}]},
                {"id":"Hq7cP2xd","title":"Old","itemIds":["b"]}]}""",
        )
        assertEquals(
            listOf(SectionEntry(itemId = "a"), SectionEntry(appId = "com.example.weather"), SectionEntry()),
            state.homeSections[0].entries,
        )
        assertEquals(emptyList<SectionEntry>(), state.homeSections[1].entries)
    }
}
