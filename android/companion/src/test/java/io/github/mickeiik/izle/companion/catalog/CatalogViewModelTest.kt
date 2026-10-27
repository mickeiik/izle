package io.github.mickeiik.izle.companion.catalog

import android.os.Looper
import io.github.mickeiik.izle.companion.home.HomeError
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
import java.time.Duration
import java.util.concurrent.CopyOnWriteArrayList

/**
 * The real [CatalogViewModel] and API client against an in-process server: the first search with what is on Home, the
 * filters and the sort as query parameters, paging, a reload (and one refused), What's new for the newest and an older
 * build, and adding a new show.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class CatalogViewModelTest {
    private val server = MockWebServer()
    private val requests = CopyOnWriteArrayList<RecordedRequest>()
    private val scope = MainScope()
    private val notices = CopyOnWriteArrayList<CatalogNotice>()

    @Volatile private var reloadAnswer: () -> MockResponse = { json(200, """{"catalog":${catalog("b3")}}""") }
    @Volatile private var searchAnswer: (RecordedRequest) -> MockResponse = { json(200, page(it)) }

    @Before
    fun setUp() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                val path = request.url.encodedPath
                return when {
                    path == "/api/v1/admin/catalog" -> json(200, catalog("b2"))
                    path == "/api/v1/admin/devices/tv-1" -> json(200, DEVICE)
                    path == "/api/v1/admin/catalog/search" -> searchAnswer(request)
                    path == "/api/v1/admin/catalog/reload" -> reloadAnswer()
                    path == "/api/v1/admin/catalog/builds/b1" -> json(200, """{"build":${BUILD_1},"changes":{"items":{"added":[],"removed":[{"id":"old","title":"Old Show"}]}}}""")
                    path == "/api/v1/admin/devices/tv-1/home/items" && request.method == "POST" ->
                        json(200, """{"version":43,"sections":[{"id":"untitled","title":null,"layout":"grid","itemIds":["sintel","tears"]}],"home":[{"itemId":"sintel","title":"Sintel"},{"itemId":"tears","title":"Tears of Steel"}]}""")
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
    fun firstSearchWithWhatIsOnHome() {
        val vm = started()
        val s = vm.state.value
        assertEquals(listOf("sintel", "tears"), s.items.map { it.id })
        assertEquals(120, s.total)
        assertTrue(s.isOnHome("sintel"))
        assertFalse(s.isOnHome("tears"))
        assertEquals("b2", s.newestBuild?.buildId)
        assertEquals("2026-10-25T09:12:00.000Z", s.newSince)
        val search = requests.first { it.url.encodedPath == "/api/v1/admin/catalog/search" }.url
        assertEquals("title", search.queryParameter("sort"))
        assertEquals("0", search.queryParameter("offset"))
        assertEquals("50", search.queryParameter("limit"))
        assertNull(search.queryParameter("since"))
        assertNull(search.queryParameter("notOnDevice"))
        assertNull(search.queryParameter("playable"))

        // Back from a show: Home is read again, the search is not run again.
        val searches = searchCount()
        vm.start()
        waitUntil("home read again") { requests.count { it.url.encodedPath == "/api/v1/admin/devices/tv-1" } == 2 }
        settle()
        assertEquals(searches, searchCount())
    }

    @Test
    fun filtersAndSortAreTheSearchsParameters() {
        val vm = started()
        vm.toggleKind("series")
        vm.toggleKind("movie")
        vm.toggleNew()
        vm.toggleNotOnHome()
        vm.setSort("newest")
        waitUntil("the search") { lastSearch()?.queryParameter("sort") == "newest" && !vm.state.value.loading }
        val url = lastSearch()!!
        assertEquals("movie,series", url.queryParameter("kind"))
        assertEquals("2026-10-25T09:12:00.000Z", url.queryParameter("since"))
        assertEquals("tv-1", url.queryParameter("notOnDevice"))
        assertTrue(vm.state.value.onlyNew)

        // The query waits for a pause in the typing: only the last one is searched.
        vm.setQuery("si")
        vm.setQuery("sin")
        mainLooper.idleFor(Duration.ofMillis(400))
        waitUntil("the query") { lastSearch()?.queryParameter("q") == "sin" && !vm.state.value.loading }
        assertEquals(0, requests.count { it.url.queryParameter("q") == "si" })
    }

    @Test
    fun pagesAsTheListScrolls() {
        val vm = started()
        val generation = vm.state.value.generation
        vm.loadMore()
        waitUntil("the second page") { vm.state.value.items.size == 4 && !vm.state.value.loading }
        assertEquals("2", lastSearch()!!.queryParameter("offset"))
        assertEquals(4, vm.state.value.next)
        // A next page does not move the list back to the top.
        assertEquals(generation, vm.state.value.generation)
    }

    @Test
    fun aFailedSearchSaysWhy() {
        searchAnswer = { json(503, """{"error":"catalog_unavailable"}""") }
        val vm = viewModel()
        vm.start()
        waitUntil("the error") { vm.state.value.error != null }
        assertEquals(HomeError.Server("catalog_unavailable"), vm.state.value.error)
        searchAnswer = { json(200, page(it)) }
        vm.retry()
        waitUntil("the retry") { vm.state.value.items.isNotEmpty() && vm.state.value.error == null }
    }

    @Test
    fun aReloadSaysTheBuildAndSearchesAgain() {
        val vm = started()
        val searches = searchCount()
        vm.reload()
        assertTrue(vm.state.value.reloading)
        waitUntil("reloaded") { CatalogNotice.Reloaded("b3") in notices }
        waitUntil("searched again") { searchCount() == searches + 1 && !vm.state.value.reloading }
        assertEquals("b3", vm.state.value.catalog?.buildId)
        assertEquals("POST", requests.single { it.url.encodedPath == "/api/v1/admin/catalog/reload" }.method)
    }

    @Test
    fun aRefusedReloadListsTheIssues() {
        reloadAnswer = {
            json(422, """{"error":"invalid_catalog","issues":[{"severity":"error","file":"bundle.json","path":"/items/3/title","message":"must be a string"}]}""")
        }
        val vm = started()
        vm.reload()
        waitUntil("refused") { notices.any { it is CatalogNotice.ReloadRefused } }
        val refused = notices.filterIsInstance<CatalogNotice.ReloadRefused>().single()
        assertEquals("bundle.json /items/3/title: must be a string", issueLine(refused.issues.single()))
        waitUntil("done") { !vm.state.value.reloading }
        assertEquals("b2", vm.state.value.catalog?.buildId)
    }

    @Test
    fun whatsNewShowsTheNewestBuildThenAnOlderOne() {
        val vm = started()
        vm.openWhatsNew()
        waitUntil("the posters") { vm.whatsNew.value?.hits?.isNotEmpty() == true }
        val w = vm.whatsNew.value!!
        assertEquals("b2", w.buildId)
        assertEquals(listOf("tears"), w.changes!!.items.added.map { it.id })
        assertEquals("/assets/tears.jpg", w.hits["tears"]?.posterUrl)
        // The newest build's changes came with the catalog; the posters from a search since it was loaded.
        assertEquals(0, requests.count { it.url.encodedPath.startsWith("/api/v1/admin/catalog/builds/") })
        assertEquals("2026-10-25T09:12:00.000Z", lastSearch()!!.queryParameter("since"))

        vm.selectBuild("b1")
        waitUntil("the older build") { vm.whatsNew.value?.changes?.items?.removed?.isNotEmpty() == true }
        assertEquals("Old Show", vm.whatsNew.value!!.changes!!.items.removed.single().title)

        vm.closeWhatsNew()
        assertNull(vm.whatsNew.value)
    }

    @Test
    fun addingANewShowPutsItOnHome() {
        val vm = started()
        vm.openWhatsNew()
        vm.add("tears", "Tears of Steel")
        waitUntil("added") { CatalogNotice.Added("Tears of Steel") in notices }
        assertTrue(vm.state.value.isOnHome("tears"))
        val post = requests.single { it.method == "POST" && it.url.encodedPath.endsWith("/home/items") }
        assertEquals("""{"itemId":"tears","sectionId":"untitled"}""", post.body?.utf8())
    }

    private fun started(): CatalogViewModel = viewModel().also { vm ->
        vm.start()
        waitUntil("the first search") { vm.state.value.searched && vm.state.value.onHome != null && vm.state.value.catalog != null && !vm.state.value.loading }
    }

    private fun viewModel(): CatalogViewModel {
        val api = ApiClient(server.url("/"), "izph_test", OkHttpClient())
        return CatalogViewModel(api, "tv-1").also { vm -> scope.launch { vm.notices.collect { notices += it } } }
    }

    private fun searchCount() = requests.count { it.url.encodedPath == "/api/v1/admin/catalog/search" }

    private fun lastSearch() = requests.lastOrNull { it.url.encodedPath == "/api/v1/admin/catalog/search" }?.url

    private val mainLooper get() = shadowOf(Looper.getMainLooper())

    private fun waitUntil(what: String, condition: () -> Boolean) {
        repeat(500) {
            mainLooper.idle()
            if (condition()) return
            Thread.sleep(10)
        }
        fail("Timed out waiting for $what; requests: ${requests.map { "${it.method} ${it.url}" }}")
    }

    private fun settle() = repeat(20) {
        mainLooper.idle()
        Thread.sleep(10)
    }

    private companion object {
        const val BUILD_1 = """{"buildId":"b1","loadedAt":"2026-10-18T08:00:00.000Z","baseline":false,"added":{"items":0,"episodes":0},"removed":{"items":1,"episodes":0}}"""

        fun catalog(buildId: String) = """
            {"id":"open-movies","buildId":"$buildId","name":"Open movies","loadedAt":"2026-10-25T09:12:00.000Z",
             "stats":{"items":120,"movies":40,"series":78,"live":2,"episodes":900,"playableEpisodes":880,"sources":1000},
             "builds":[
               {"buildId":"b2","loadedAt":"2026-10-25T09:12:00.000Z","baseline":false,"added":{"items":1,"episodes":3},"removed":{"items":0,"episodes":0}},
               $BUILD_1,
               {"buildId":"b0","loadedAt":"2026-10-10T08:00:00.000Z","baseline":true}
             ],
             "changes":{"items":{"added":[{"id":"tears","title":"Tears of Steel","kind":"movie"}],"removed":[]},
                        "episodes":{"added":[{"id":"sintel.e3","itemId":"sintel","itemTitle":"Sintel","season":1,"number":3}],"removed":[]}}}
        """

        const val DEVICE = """
            {"device":{"id":"tv-1","name":"Salon"},"sections":[{"id":"untitled","title":null,"layout":"grid","itemIds":["sintel"]}],
             "home":[{"itemId":"sintel","title":"Sintel","kind":"series"}]}
        """

        /** Two hits a page, 120 in all. */
        fun page(request: RecordedRequest): String {
            val offset = request.url.queryParameter("offset")?.toInt() ?: 0
            val hits = if (offset == 0) {
                """{"id":"sintel","kind":"series","title":"Sintel","year":2010,"episodeCount":3,"playable":true},
                   {"id":"tears","kind":"movie","title":"Tears of Steel","year":2012,"posterUrl":"/assets/tears.jpg","playable":true}"""
            } else {
                """{"id":"x$offset","kind":"movie","title":"X$offset"},{"id":"y$offset","kind":"live","title":"Y$offset"}"""
            }
            return """{"items":[$hits],"total":120,"offset":$offset}"""
        }
    }
}
