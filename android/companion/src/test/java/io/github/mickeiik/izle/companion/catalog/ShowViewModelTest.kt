package io.github.mickeiik.izle.companion.catalog

import android.os.Looper
import io.github.mickeiik.izle.companion.home.HomeNotice
import io.github.mickeiik.izle.companion.tv.CommandOutcome
import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.json
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
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
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.util.concurrent.CopyOnWriteArrayList

/**
 * The real [ShowViewModel] and API client against an in-process server: a series not on the TV's Home (OK plays from
 * the TV's progress, new episodes from the newest build), Add to Home, an episode's Play, Continue from here and its
 * check, and a film whose sources are on the page.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class ShowViewModelTest {
    private val server = MockWebServer()
    private val requests = CopyOnWriteArrayList<RecordedRequest>()
    private val scope = MainScope()
    private val notices = CopyOnWriteArrayList<HomeNotice>()

    @Volatile private var home = HOME_WITHOUT

    @Before
    fun setUp() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                val path = request.url.encodedPath
                val method = request.method
                return when {
                    path == "/api/v1/admin/catalog/items/caminandes" -> json(200, """{"item":$SERIES}""")
                    path == "/api/v1/admin/catalog/items/sintel" -> json(200, """{"item":$FILM}""")
                    path == "/api/v1/admin/devices/tv-1" -> json(200, device(home))
                    path == "/api/v1/admin/devices/tv-1/progress" ->
                        json(200, """{"cursors":[{"itemId":"caminandes","episodeId":"cam.e2"}],"progress":[]}""")
                    path == "/api/v1/admin/catalog" -> json(200, CATALOG)
                    path == "/api/v1/admin/checks/current" -> json(200, """{"run":null}""")
                    path == "/api/v1/admin/devices/tv-1/home/items" && method == "POST" -> {
                        home = HOME_WITH
                        json(200, """{"version":3,"home":$HOME_WITH,"sections":$SECTIONS}""")
                    }
                    path == "/api/v1/admin/devices/tv-1/commands" && method == "POST" -> json(200, """{"id":7,"online":false}""")
                    path == "/api/v1/admin/devices/tv-1/cursor" && method == "PUT" -> MockResponse.Builder().code(204).build()
                    path == "/api/v1/admin/checks/playables/cam.e3" -> json(200, """{"itemId":"caminandes","episodeId":"cam.e3","check":null,"sources":[]}""")
                    path == "/api/v1/admin/checks/playables/sintel.film" ->
                        json(200, """{"itemId":"sintel","episodeId":"sintel.film","check":$CHECK,"sources":[$FILE_REPORT]}""")
                    path == "/api/v1/admin/diagnostics/resolve" ->
                        json(200, """{"itemId":"caminandes","episodeId":"cam.e3","playbackAllowed":true,"verdict":"fail","checkedAt":"2026-10-27T10:00:00.000Z","sources":[$FAILED_REPORT]}""")
                    else -> json(404, """{"error":"not_found"}""")
                }
            }
        }
        server.start()
    }

    @After
    fun tearDown() {
        scope.cancel()
        server.close()
    }

    @Test
    fun aSeriesNotOnHomeSaysWhatOkPlaysAndWhatIsNew() {
        val vm = loaded("caminandes")
        val s = vm.state.value
        assertEquals("Caminandes", s.item?.title)
        assertFalse(s.onHome)
        assertTrue(s.listsEpisodes)
        assertTrue(s.playable)
        // Not on Home: the cursor says what OK plays.
        assertEquals("cam.e2", s.okPlays)
        assertEquals(setOf("cam.e3"), s.newEpisodes)
        assertNull("a series' episodes are on the page, their sources in the sheet", s.direct)
        assertTrue(requests.any { it.url.encodedPath == "/api/v1/admin/devices/tv-1/progress" })
    }

    @Test
    fun addToHomeThenOkPlaysAsHomeSays() {
        val vm = loaded("caminandes")
        vm.addToHome("kids01")
        waitUntil("added") { vm.state.value.onHome && HomeNotice.Added("Caminandes", "Kids") in notices }
        val post = requests.single { it.method == "POST" && it.url.encodedPath.endsWith("/home/items") }
        assertEquals("""{"itemId":"caminandes","sectionId":"kids01"}""", post.body?.utf8())
        // On Home now: its `continue` says what OK plays.
        waitUntil("reloaded") { vm.state.value.okPlays == "cam.e1" && !vm.state.value.saving }
    }

    @Test
    fun anEpisodePlaysContinuesAndIsChecked() {
        val vm = loaded("caminandes")
        val e3 = vm.state.value.item!!.episodes.single { it.id == "cam.e3" }
        vm.play(e3)
        waitUntil("played") { notices.any { it is HomeNotice.Played } }
        assertEquals(HomeNotice.Played("Caminandes", CommandOutcome.Queued), notices.single { it is HomeNotice.Played })
        assertEquals("""{"type":"play","episodeId":"cam.e3"}""", requests.single { it.url.encodedPath.endsWith("/commands") }.body?.utf8())

        vm.continueFrom(e3)
        waitUntil("continues") { HomeNotice.Continues("Caminandes", "S1 · E3 — Llamigos") in notices }
        assertEquals("""{"itemId":"caminandes","episodeId":"cam.e3"}""", requests.single { it.method == "PUT" }.body?.utf8())
        assertEquals("cam.e3", vm.state.value.okPlays)

        vm.openEpisode(e3)
        waitUntil("its sources read") { vm.sheet.value?.loading == false }
        assertEquals(emptyMap<String, Any>(), vm.sheet.value!!.reports)
        vm.checkEpisode()
        assertTrue(vm.sheet.value!!.checking)
        waitUntil("checked") { vm.sheet.value?.checking == false }
        val report = vm.sheet.value!!.reports["main"]!!
        assertEquals("timeout at segment", sourceFindingsText(null, report))
        assertEquals("""{"episodeId":"cam.e3"}""", requests.single { it.url.encodedPath == "/api/v1/admin/diagnostics/resolve" }.body?.utf8())
        vm.closeEpisode()
        assertNull(vm.sheet.value)
    }

    @Test
    fun aFilmShowsItsSourcesOnThePage() {
        home = HOME_WITH
        val vm = loaded("sintel")
        val s = vm.state.value
        assertFalse(s.listsEpisodes)
        waitUntil("its sources") { vm.state.value.direct?.loading == false }
        val direct = vm.state.value.direct!!
        assertEquals("sintel.film", direct.episodeId)
        assertEquals("audio en · no range: seeking breaks", sourceFindingsText(vm.state.value.item!!.episodes[0].sources[0], direct.reports["file"]))
        assertEquals("pass", direct.check?.verdict)
        assertEquals("sintel", requests.first { it.url.encodedPath == "/api/v1/admin/checks/playables/sintel.film" }.url.queryParameter("itemId"))
        // Not on this TV's Home and no cursor: the first allowed episode.
        assertEquals("sintel.film", s.okPlays)
    }

    private fun loaded(itemId: String): ShowViewModel {
        val api = ApiClient(server.url("/"), "izph_test", OkHttpClient())
        val vm = ShowViewModel(api, "tv-1", itemId)
        scope.launch { vm.notices.collect { notices += it } }
        waitUntil("the load") { vm.state.value.loaded && !vm.state.value.loading }
        return vm
    }

    private val mainLooper get() = shadowOf(Looper.getMainLooper())

    private fun waitUntil(what: String, condition: () -> Boolean) {
        repeat(500) {
            mainLooper.idle()
            if (condition()) return
            Thread.sleep(10)
        }
        fail("Timed out waiting for $what; requests: ${requests.map { "${it.method} ${it.url.encodedPath}" }}")
    }

    private companion object {
        const val CHECK = """{"verdict":"pass","checkedAt":"2026-10-27T09:00:00.000Z","working":1,"total":1,"stale":false}"""
        const val SERIES = """{"id":"caminandes","kind":"series","title":"Caminandes","year":2013,"genres":["Animation"],"autoAdvance":true,
            "episodes":[
              {"id":"cam.e1","season":1,"number":1,"title":"Llama Drama","durationMs":90000,"playbackAllowed":true,"sources":[{"id":"main","type":"direct","kind":"hls"}],"check":$CHECK},
              {"id":"cam.e2","season":1,"number":2,"title":"Gran Dillama","durationMs":146000,"playbackAllowed":true,"sources":[{"id":"main","type":"direct","kind":"hls"}],"check":null},
              {"id":"cam.e3","season":1,"number":3,"title":"Llamigos","durationMs":150000,"playbackAllowed":true,"sources":[{"id":"main","type":"direct","kind":"hls"}],"check":null}]}"""
        const val FILM = """{"id":"sintel","kind":"movie","title":"Sintel","year":2010,
            "episodes":[{"id":"sintel.film","playbackAllowed":true,"durationMs":888000,
              "sources":[{"id":"file","type":"direct","kind":"mp4","languages":{"audio":["en"]},"needsProxy":false}],"check":$CHECK}]}"""
        const val FILE_REPORT = """{"sourceId":"file","type":"direct","ok":true,"ms":3,"verdict":"warn","steps":[{"what":"file","host":"h","ok":true,"status":200,"ms":2,"container":"mp4"}],
            "codecs":[],"warnings":["no_range"],"checkMs":2,"checkedAt":"2026-10-27T09:00:00.000Z","stale":false}"""
        const val FAILED_REPORT = """{"sourceId":"main","type":"direct","ok":true,"ms":3,"verdict":"fail",
            "steps":[{"what":"playlist","host":"h","ok":true,"status":200,"ms":2},{"what":"segment","index":0,"of":"variant","host":"h","ok":false,"ms":10000,"error":"timeout"}],
            "codecs":[],"warnings":[],"checkMs":10000}"""
        const val SECTIONS = """[{"id":"untitled","title":null,"layout":"grid","itemIds":[]},{"id":"kids01","title":"Kids","layout":"grid","itemIds":[]}]"""
        const val HOME_WITHOUT = "[]"
        const val HOME_WITH = """[{"itemId":"caminandes","title":"Caminandes","kind":"series","missing":false,"playable":true,
            "continue":{"episodeId":"cam.e1","season":1,"number":1,"label":null,"index":0,"positionMs":0,"durationMs":null,"status":"new"},"newEpisodes":1}]"""
        const val CATALOG = """{"id":"demo","buildId":"7f3a","name":"Demo","builds":[],
            "changes":{"items":{"added":[],"removed":[]},"episodes":{"added":[{"id":"cam.e3","itemId":"caminandes","season":1,"number":3,"playbackAllowed":true},
              {"id":"other.e1","itemId":"other"}],"removed":[]}}}"""

        fun device(home: String) = """{"device":{"id":"tv-1","name":"Salon","status":"active","online":true},"home":$home,"sections":$SECTIONS}"""
    }
}
