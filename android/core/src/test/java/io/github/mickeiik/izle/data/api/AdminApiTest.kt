package io.github.mickeiik.izle.data.api

import io.github.mickeiik.izle.json
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive
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
import java.util.concurrent.TimeUnit

/** The admin routes of a TV's page in [ApiClient] against an in-process MockWebServer (no network). */
class AdminApiTest {
    private val server = MockWebServer()
    private val http = OkHttpClient()

    @Before
    fun setUp() = server.start()

    @After
    fun tearDown() = server.close()

    private fun client(longPoll: OkHttpClient = http) = ApiClient(server.url("/izle/"), "izph_secret", http, longPoll)

    /** The next request, checked to be [method] [path] with the phone secret. */
    private fun takeRequest(method: String, path: String): RecordedRequest = server.takeRequest().also {
        assertEquals(method, it.method)
        assertEquals(path, it.url.encodedPath)
        assertEquals("Bearer izph_secret", it.headers["Authorization"])
    }

    @Test
    fun deviceDecodesTheHomeListSectionsAndTheNewDeviceFields() = runBlocking {
        server.enqueue(json(200, DETAIL))
        val detail = client().device("tv-1")
        takeRequest("GET", "/izle/api/v1/admin/devices/tv-1")
        assertEquals("Salon", detail.device.name)
        assertTrue(detail.device.online)
        assertEquals(DeviceEffective(uiLanguage = "tr", preferredAudioLanguage = "tr", homeColumns = 5, homeRows = 3), detail.device.effective)
        assertEquals(DeviceProblems(2, "2026-10-27T09:00:00.000Z"), detail.device.problems)
        assertEquals(200, detail.homeMax)
        assertEquals(20, detail.sectionsMax)
        assertEquals(
            listOf(
                HomeSection("untitled", null, "grid", listOf("film-1", "gone")),
                HomeSection("a1b2c3d4", "Series", "row", listOf("show-1")),
            ),
            detail.sections,
        )
        val (film, show, gone) = detail.home
        assertEquals("Sintel", film.title)
        assertEquals("/media/film-1.jpg", film.posterUrl)
        assertNull(film.continueAt)
        assertEquals("pass", film.check?.verdict)
        assertEquals(CheckSummary("pass", "2026-10-26T10:00:00.000Z", 2, 2, false), film.check)
        assertEquals(ContinueInfo("s1e5", 1, 5, "S1 E5", 4, 120_000, 1_800_000, "watching"), show.continueAt)
        assertEquals(3, show.newEpisodes)
        assertEquals("warn", show.checkAll?.verdict)
        assertEquals(CheckAll("warn", 8, 10, 0, 1, "2026-10-20T10:00:00.000Z"), show.checkAll)
        // An item gone from the catalog: no title, not playable, nothing checked.
        assertTrue(gone.missing)
        assertFalse(gone.playable)
        assertNull(gone.title)
        assertNull(gone.kind)
        assertNull(gone.check)
    }

    @Test
    fun anOldStyleDeviceStillDecodes() = runBlocking {
        server.enqueue(json(200, """{"devices":[{"id":"tv-1","name":"Salon","status":"pending","online":false}]}"""))
        val device = client().devices().devices.single()
        assertNull(device.effective)
        assertNull(device.problems)
        assertNull(device.homeCount)
        Unit
    }

    @Test
    fun theDeviceListCarriesHomeCountAndSettings() = runBlocking {
        server.enqueue(
            json(200, """{"devices":[{"id":"tv-1","name":"Salon","status":"active","online":true,"homeCount":24,"effective":{"homeColumns":6},"problems":{"recent":0,"lastAt":null}}]}"""),
        )
        val device = client().devices().devices.single()
        assertEquals(24, device.homeCount)
        assertEquals(6, device.effective?.homeColumns)
        assertEquals(2, device.effective?.homeRows)
        assertNull(device.problems?.lastAt)
    }

    @Test
    fun updateDeviceSendsOnlyTheFieldsGiven() = runBlocking {
        server.enqueue(json(200, """{"device":{"id":"tv-1","name":"Salon","status":"active","online":true,"effective":{"homeColumns":6,"homeRows":2}}}"""))
        server.enqueue(json(200, """{"device":{"id":"tv-1","name":"Salon"}}"""))
        val device = client().updateDevice("tv-1", homeColumns = 6)
        assertEquals(6, device.effective?.homeColumns)
        val columns = takeRequest("PATCH", "/izle/api/v1/admin/devices/tv-1")
        assertEquals("""{"homeColumns":6}""", columns.body?.utf8())
        assertEquals("application/json", columns.headers["Content-Type"]?.substringBefore(";"))

        client().updateDevice("tv-1", homeRows = 3)
        assertEquals("""{"homeRows":3}""", takeRequest("PATCH", "/izle/api/v1/admin/devices/tv-1").body?.utf8())
    }

    @Test
    fun aCommandSendsItsTypeAndFieldsAndReadsTheIdAndOnlineState() = runBlocking {
        server.enqueue(json(202, """{"id":42,"online":false}"""))
        server.enqueue(json(202, """{"id":43,"online":true}"""))
        val api = client()
        val sent = api.sendCommand("tv-1", "seek", mapOf("deltaMs" to JsonPrimitive(-30_000)))
        assertEquals(CommandSent(42, false), sent)
        val seek = takeRequest("POST", "/izle/api/v1/admin/devices/tv-1/commands")
        assertEquals("""{"type":"seek","deltaMs":-30000}""", seek.body?.utf8())

        assertEquals(43L, api.sendCommand("tv-1", "pause").id)
        assertEquals("""{"type":"pause"}""", takeRequest("POST", "/izle/api/v1/admin/devices/tv-1/commands").body?.utf8())
    }

    @Test
    fun aCommandReportsItsResultOnceTheTvHasOne() = runBlocking {
        server.enqueue(
            json(
                200,
                """{"command":{"id":42,"type":"next","payload":{},"actor":{"kind":"phone"},"createdAt":"2026-10-27T10:00:00.000Z","deliveredAt":null,"result":null,"reason":null,"resultAt":null}}""",
            ),
        )
        server.enqueue(
            json(
                200,
                """{"command":{"id":42,"type":"next","createdAt":"2026-10-27T10:00:00.000Z","deliveredAt":"2026-10-27T10:00:01.000Z","result":"ignored","reason":"no_episode","resultAt":"2026-10-27T10:00:01.500Z"}}""",
            ),
        )
        val api = client()
        val waiting = api.command("tv-1", 42)
        takeRequest("GET", "/izle/api/v1/admin/devices/tv-1/commands/42")
        assertNull(waiting.result)
        assertNull(waiting.deliveredAt)
        val done = api.command("tv-1", 42)
        assertEquals(CommandInfo(42, "next", "2026-10-27T10:00:00.000Z", "2026-10-27T10:00:01.000Z", "ignored", "no_episode", "2026-10-27T10:00:01.500Z"), done)
    }

    @Test
    fun homeItemChangesSendOnlyWhatIsGivenAndAnswerTheNewList() = runBlocking {
        repeat(4) { server.enqueue(json(200, CHANGE)) }
        val api = client()

        val added = api.addHomeItem("tv-1", "film-1")
        assertEquals("""{"itemId":"film-1"}""", takeRequest("POST", "/izle/api/v1/admin/devices/tv-1/home/items").body?.utf8())
        assertEquals(7L, added.version)
        assertEquals("film-1", added.home.single().itemId)
        assertEquals("Series", added.sections.single().title)
        assertNull(added.sectionId)

        api.addHomeItem("tv-1", "film-1", sectionId = "a1b2c3d4", position = 0)
        assertEquals(
            """{"itemId":"film-1","sectionId":"a1b2c3d4","position":0}""",
            takeRequest("POST", "/izle/api/v1/admin/devices/tv-1/home/items").body?.utf8(),
        )

        api.moveHomeItem("tv-1", "film-1", position = 2)
        assertEquals("""{"position":2}""", takeRequest("PATCH", "/izle/api/v1/admin/devices/tv-1/home/items/film-1").body?.utf8())

        api.moveHomeItem("tv-1", "a/b c", sectionId = "untitled")
        val moved = takeRequest("PATCH", "/izle/api/v1/admin/devices/tv-1/home/items/a%2Fb%20c")
        assertEquals("""{"sectionId":"untitled"}""", moved.body?.utf8())
    }

    @Test
    fun removingAnItemIsADeleteWithoutBody() = runBlocking {
        server.enqueue(json(200, CHANGE))
        val change = client().removeHomeItem("tv-1", "film-1")
        val request = takeRequest("DELETE", "/izle/api/v1/admin/devices/tv-1/home/items/film-1")
        assertEquals(0, request.body?.size ?: 0)
        assertEquals(7L, change.version)
    }

    @Test
    fun sectionChangesSendOnlyWhatIsGiven() = runBlocking {
        server.enqueue(json(200, CHANGE.replace("""{"version":7,""", """{"version":8,"sectionId":"a1b2c3d4",""")))
        repeat(3) { server.enqueue(json(200, CHANGE)) }
        val api = client()

        val added = api.addSection("tv-1", "Films")
        assertEquals("""{"title":"Films"}""", takeRequest("POST", "/izle/api/v1/admin/devices/tv-1/home/sections").body?.utf8())
        assertEquals("a1b2c3d4", added.sectionId)

        api.updateSection("tv-1", "a1b2c3d4", layout = "row")
        assertEquals("""{"layout":"row"}""", takeRequest("PATCH", "/izle/api/v1/admin/devices/tv-1/home/sections/a1b2c3d4").body?.utf8())

        api.updateSection("tv-1", "a1b2c3d4", title = "Kids", position = 1)
        assertEquals(
            """{"title":"Kids","position":1}""",
            takeRequest("PATCH", "/izle/api/v1/admin/devices/tv-1/home/sections/a1b2c3d4").body?.utf8(),
        )

        api.deleteSection("tv-1", "a1b2c3d4")
        takeRequest("DELETE", "/izle/api/v1/admin/devices/tv-1/home/sections/a1b2c3d4")
        Unit
    }

    @Test
    fun addSectionCanGiveLayoutAndPosition() = runBlocking {
        server.enqueue(json(200, CHANGE))
        client().addSection("tv-1", "Films", layout = "row", position = 0)
        assertEquals(
            """{"title":"Films","layout":"row","position":0}""",
            takeRequest("POST", "/izle/api/v1/admin/devices/tv-1/home/sections").body?.utf8(),
        )
    }

    @Test
    fun homeErrorsKeepTheirCode() {
        server.enqueue(json(404, """{"error":"not_on_home"}"""))
        server.enqueue(json(409, """{"error":"home_changed","itemIds":[]}"""))
        server.enqueue(json(404, """{"error":"unknown_section"}"""))
        val api = client()
        assertEquals("not_on_home", assertThrows(ApiException::class.java) { runBlocking { api.moveHomeItem("tv-1", "x", position = 0) } }.code)
        val conflict = assertThrows(ApiException::class.java) { runBlocking { api.removeHomeItem("tv-1", "x") } }
        assertEquals(409, conflict.status)
        assertEquals("home_changed", conflict.code)
        assertEquals("unknown_section", assertThrows(ApiException::class.java) { runBlocking { api.deleteSection("tv-1", "zzz") } }.code)
    }

    @Test
    fun setCursorPutsTheItemAndEpisode() = runBlocking {
        server.enqueue(json(200, """{"version":9}"""))
        client().setCursor("tv-1", "show-1", "s1e5")
        val put = takeRequest("PUT", "/izle/api/v1/admin/devices/tv-1/cursor")
        assertEquals("""{"itemId":"show-1","episodeId":"s1e5"}""", put.body?.utf8())
    }

    @Test
    fun catalogSearchSendsOnlyTheFiltersGivenAndPagesByOffset() = runBlocking {
        server.enqueue(json(200, SEARCH))
        server.enqueue(json(200, """{"items":[],"total":0,"offset":0}"""))
        val api = client()

        val page = api.catalogSearch(q = "sin tel", kinds = listOf("movie", "series"), notOnDevice = "tv-1", playable = true, offset = 50, limit = 25)
        val request = takeRequest("GET", "/izle/api/v1/admin/catalog/search")
        assertEquals("sin tel", request.url.queryParameter("q"))
        assertEquals("movie,series", request.url.queryParameter("kind"))
        assertEquals("tv-1", request.url.queryParameter("notOnDevice"))
        assertEquals("true", request.url.queryParameter("playable"))
        assertEquals("50", request.url.queryParameter("offset"))
        assertEquals("25", request.url.queryParameter("limit"))
        assertEquals(120, page.total)
        assertEquals(50, page.offset)
        val (film, show, channel) = page.items
        assertEquals(CatalogHit("film-1", "movie", "Sintel", 2010, "/media/film-1.jpg", null, null, true, null), film)
        assertEquals(CatalogHit("show-1", "series", "Dark", 2017, null, 26, 24, true, 2), show)
        // A channel has no counts.
        assertNull(channel.episodeCount)
        assertNull(channel.newEpisodes)
        assertNull(channel.year)

        api.catalogSearch()
        val plain = takeRequest("GET", "/izle/api/v1/admin/catalog/search").url
        assertNull(plain.queryParameter("q"))
        assertNull(plain.queryParameter("kind"))
        assertNull(plain.queryParameter("notOnDevice"))
        assertNull(plain.queryParameter("playable"))
        assertEquals("0", plain.queryParameter("offset"))
        assertEquals("50", plain.queryParameter("limit"))
    }

    @Test
    fun catalogItemDecodesEpisodesWithTheirChecks() = runBlocking {
        server.enqueue(
            json(
                200,
                """{"item":{"id":"show-1","kind":"series","title":"Dark","year":2017,"posterUrl":"/media/p.jpg","autoAdvance":true,"episodes":[
                    {"id":"s1e1","index":0,"season":1,"number":1,"title":"Secrets","label":"S1 E1","playbackAllowed":true,"sources":[],"check":{"verdict":"pass","checkedAt":"2026-10-26T10:00:00.000Z","working":1,"total":1,"stale":false}},
                    {"id":"s1e2","index":1,"season":1,"number":2,"playbackAllowed":false,"check":null}]}}""",
            ),
        )
        val item = client().catalogItem("show-1")
        takeRequest("GET", "/izle/api/v1/admin/catalog/items/show-1")
        assertEquals("Dark", item.title)
        assertNull(item.playbackAllowed)
        val (first, second) = item.episodes
        assertEquals("Secrets", first.title)
        assertTrue(first.playbackAllowed)
        assertEquals("pass", first.check?.verdict)
        assertFalse(second.playbackAllowed)
        assertNull(second.check)
    }

    @Test
    fun aChannelItemHasNoEpisodes() = runBlocking {
        server.enqueue(json(200, """{"item":{"id":"ch-1","kind":"live","title":"News","playbackAllowed":true,"sources":[],"check":null}}"""))
        val item = client().catalogItem("ch-1")
        assertTrue(item.episodes.isEmpty())
        assertEquals(true, item.playbackAllowed)
    }

    @Test
    fun adminEventsFollowFromACursorWithFiltersAndWaitOnTheLongPollClient() = runBlocking {
        // The short client would give up after a second; the long-poll one waits.
        val impatient = OkHttpClient.Builder().readTimeout(1, TimeUnit.MILLISECONDS).build()
        server.enqueue(json(200, EVENTS))
        server.enqueue(json(200, """{"events":[],"last":812,"gap":false}"""))
        val api = ApiClient(server.url("/izle/"), "izph_secret", impatient, http)

        val page = api.adminEvents(after = 810, waitSec = 25, types = listOf("home.changed", "check."), devices = listOf("tv-1", "tv-2"))
        val request = takeRequest("GET", "/izle/api/v1/admin/events")
        assertEquals("810", request.url.queryParameter("after"))
        assertEquals("25", request.url.queryParameter("wait"))
        assertEquals("home.changed,check.", request.url.queryParameter("types"))
        assertEquals("tv-1,tv-2", request.url.queryParameter("devices"))
        assertEquals(812L, page.last)
        assertTrue(page.gap)
        assertEquals(AdminEvent(811, "home.changed", "2026-10-27T10:00:00.000Z", "tv-1"), page.events[0])
        assertNull(page.events[1].deviceId)

        // Without a cursor: where to follow from. No filters, no `after`.
        val start = client().adminEvents(after = null)
        val first = takeRequest("GET", "/izle/api/v1/admin/events").url
        assertNull(first.queryParameter("after"))
        assertNull(first.queryParameter("types"))
        assertNull(first.queryParameter("devices"))
        assertEquals("0", first.queryParameter("wait"))
        assertEquals(812L, start.last)
        assertFalse(start.gap)
    }

    private companion object {
        const val ENTRY_FILM = """{"itemId":"film-1","title":"Sintel","kind":"movie","posterUrl":"/media/film-1.jpg","backdropUrl":null,"missing":false,"playable":true,
            "continue":null,"newEpisodes":0,"check":{"verdict":"pass","checkedAt":"2026-10-26T10:00:00.000Z","working":2,"total":2,"stale":false},"checkAll":null}"""
        const val ENTRY_SHOW = """{"itemId":"show-1","title":"Dark","kind":"series","posterUrl":null,"backdropUrl":null,"missing":false,"playable":true,
            "continue":{"episodeId":"s1e5","season":1,"number":5,"label":"S1 E5","index":4,"positionMs":120000,"durationMs":1800000,"status":"watching"},"newEpisodes":3,
            "check":null,"checkAll":{"verdict":"warn","checked":8,"total":10,"failed":0,"warned":1,"oldestCheckedAt":"2026-10-20T10:00:00.000Z"}}"""
        const val ENTRY_GONE = """{"itemId":"gone","title":null,"kind":null,"posterUrl":null,"backdropUrl":null,"missing":true,"playable":false,
            "continue":null,"newEpisodes":0,"check":null,"checkAll":null}"""

        const val DETAIL = """{"device":{"id":"tv-1","name":"Salon","status":"active","online":true,"createdAt":"2026-10-01T10:00:00.000Z","stateVersion":12,
            "settings":{"homeColumns":4},"effective":{"uiLanguage":"tr","preferredAudioLanguage":"tr","subtitlesLanguage":null,"autoplayOnStart":false,"homeColumns":5,"homeRows":3},
            "problems":{"recent":2,"lastAt":"2026-10-27T09:00:00.000Z"},"app":{"version":"0.6.1","update":"up_to_date"}},
            "home":[$ENTRY_FILM,$ENTRY_SHOW,$ENTRY_GONE],"homeMax":200,
            "sections":[{"id":"untitled","title":null,"layout":"grid","itemIds":["film-1","gone"]},{"id":"a1b2c3d4","title":"Series","layout":"row","itemIds":["show-1"]}],
            "sectionsMax":20}"""

        const val CHANGE = """{"version":7,"home":[$ENTRY_FILM],"sections":[{"id":"a1b2c3d4","title":"Series","layout":"row","itemIds":["film-1"]}]}"""

        const val SEARCH = """{"items":[
            {"id":"film-1","kind":"movie","title":"Sintel","year":2010,"posterUrl":"/media/film-1.jpg","backdropUrl":null,"episodeCount":null,"playableCount":null,"playable":true,"firstSeenAt":null,"newEpisodes":null},
            {"id":"show-1","kind":"series","title":"Dark","year":2017,"posterUrl":null,"episodeCount":26,"playableCount":24,"playable":true,"newEpisodes":2},
            {"id":"ch-1","kind":"live","title":"News","year":null,"posterUrl":null,"episodeCount":null,"playableCount":null,"playable":true,"newEpisodes":null}],
            "total":120,"offset":50}"""

        const val EVENTS = """{"events":[
            {"id":811,"at":"2026-10-27T10:00:00.000Z","type":"home.changed","deviceId":"tv-1","actor":{"kind":"phone"},"data":{"version":7}},
            {"id":812,"at":"2026-10-27T10:00:01.000Z","type":"catalog.reloaded","deviceId":null,"actor":{"kind":"system"},"data":{}}],
            "last":812,"gap":true}"""
    }
}
