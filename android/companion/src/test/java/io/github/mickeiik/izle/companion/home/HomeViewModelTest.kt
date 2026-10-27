package io.github.mickeiik.izle.companion.home

import android.os.Looper
import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.data.api.CatalogHit
import io.github.mickeiik.izle.json
import kotlinx.coroutines.Job
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
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * The real [HomeViewModel] and API client against an in-process server: the load, following the event log, a move
 * (drag and drop's one `PATCH`), an add, a section deleted, and a change refused because Home changed elsewhere.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class HomeViewModelTest {
    private val server = MockWebServer()
    private val requests = CopyOnWriteArrayList<RecordedRequest>()
    private val scope = MainScope()
    private val notices = CopyOnWriteArrayList<HomeNotice>()
    private val longPolls = AtomicInteger()

    @Volatile private var deviceAnswer: () -> MockResponse = { json(200, DEVICE) }
    @Volatile private var moveAnswer: () -> MockResponse = { json(200, change(MOVED)) }

    @Before
    fun setUp() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                val path = request.url.encodedPath
                val method = request.method
                return when {
                    path == "/api/v1/admin/devices/tv-1" && method == "GET" -> deviceAnswer()
                    path == "/api/v1/admin/events" && request.url.queryParameter("after") == null -> json(200, """{"events":[],"last":10,"gap":false}""")
                    // The first long-poll brings one event; the next ones wait and bring nothing.
                    path == "/api/v1/admin/events" ->
                        if (longPolls.incrementAndGet() == 1) json(200, """{"events":[{"id":11,"type":"home.changed","deviceId":"tv-1"}],"last":11,"gap":false}""")
                        else json(200, """{"events":[],"last":11,"gap":false}""").newBuilder().headersDelay(1, TimeUnit.SECONDS).build()
                    path == "/api/v1/admin/devices/tv-1/home/items/sintel" && method == "PATCH" -> moveAnswer()
                    path == "/api/v1/admin/devices/tv-1/home/items" && method == "POST" -> json(200, change(ADDED))
                    path == "/api/v1/admin/devices/tv-1/home/sections/kids01" && method == "DELETE" -> json(200, change(KIDS_DELETED))
                    path == "/api/v1/admin/catalog/search" ->
                        json(200, """{"items":[{"id":"tears","kind":"movie","title":"Tears of Steel","year":2012,"playable":true}],"total":1,"offset":0}""")
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
    fun loadsAndReloadsOnAnEvent() {
        val vm = viewModel()
        val follow = scope.launch { vm.follow() }
        waitUntil("the load") { vm.state.value.loaded }
        val s = vm.state.value
        assertEquals(listOf(UNTITLED_SECTION, "films01", "kids01"), s.sections.map { it.id })
        assertEquals(3, s.showCount)
        assertEquals(5, s.columns)
        assertEquals(2, s.rows)
        assertEquals("Sintel", s.entries["sintel"]?.title)
        assertTrue(s.entries["gone"]!!.missing)

        // home.changed → a second read of Home.
        waitUntil("the reload") { requests.count { it.url.encodedPath == "/api/v1/admin/devices/tv-1" } == 2 }
        val polls = requests.filter { it.url.encodedPath == "/api/v1/admin/events" }
        assertEquals("tv-1", polls.first().url.queryParameter("devices"))
        assertEquals("home.changed,cursor.changed,device.updated,catalog.reloaded,check.finished", polls.first().url.queryParameter("types"))
        assertEquals("10", polls[1].url.queryParameter("after"))
        assertEquals("25", polls[1].url.queryParameter("wait"))
        follow.cancel()
    }

    @Test
    fun aDropIsOneMoveAndTheAnswerRedrawsTheList() {
        val vm = loaded()
        vm.move("sintel", HomePlace(UNTITLED_SECTION, 0))
        // At once: the list draws the move while it is saved.
        assertEquals(listOf("sintel", "bunny", "gone"), vm.state.value.section(UNTITLED_SECTION)!!.itemIds)
        waitUntil("saved") { !vm.state.value.saving && requests.any { it.method == "PATCH" } }
        val patch = requests.single { it.method == "PATCH" }
        assertEquals("/api/v1/admin/devices/tv-1/home/items/sintel", patch.url.encodedPath)
        assertEquals("""{"sectionId":"untitled","position":0}""", patch.body?.utf8())
        assertEquals(listOf("sintel", "bunny", "gone"), vm.state.value.section(UNTITLED_SECTION)!!.itemIds)
        assertEquals(emptyList<String>(), vm.state.value.section("films01")!!.itemIds)
        // A move to where it is sends nothing.
        vm.move("sintel", HomePlace(UNTITLED_SECTION, 0))
        settle()
        assertEquals(1, requests.count { it.method == "PATCH" })
    }

    @Test
    fun aChangeRefusedBecauseHomeChangedReloadsAndSaysSo() {
        moveAnswer = { json(409, """{"error":"home_changed"}""") }
        val vm = loaded()
        val reads = requests.count { it.url.encodedPath == "/api/v1/admin/devices/tv-1" }
        vm.move("sintel", HomePlace(UNTITLED_SECTION, 0))
        waitUntil("the notice") { HomeNotice.ChangedElsewhere in notices }
        waitUntil("the reload") { requests.count { it.url.encodedPath == "/api/v1/admin/devices/tv-1" } == reads + 1 }
        waitUntil("saved") { !vm.state.value.saving }
        // Back to the server's list.
        assertEquals(listOf("sintel"), vm.state.value.section("films01")!!.itemIds)

        moveAnswer = { json(404, """{"error":"not_on_home"}""") }
        notices.clear()
        vm.move("sintel", HomePlace(UNTITLED_SECTION, 0))
        waitUntil("the notice") { HomeNotice.ChangedElsewhere in notices }
    }

    @Test
    fun addsToTheChosenSectionAndSaysWhere() {
        val vm = loaded()
        vm.openSearch()
        waitUntil("the results") { vm.search.value.items.isNotEmpty() }
        val search = requests.last { it.url.encodedPath == "/api/v1/admin/catalog/search" }.url
        assertEquals("tv-1", search.queryParameter("notOnDevice"))
        assertEquals("true", search.queryParameter("playable"))
        assertEquals("50", search.queryParameter("limit"))
        assertEquals("the next page starts after the hits read", 1, vm.search.value.next)

        vm.toggleKind("series")
        vm.toggleKind("movie")
        waitUntil("by kind") { requests.any { it.url.queryParameter("kind") == "movie,series" } && !vm.search.value.loading }

        vm.setAddTo("films01")
        vm.add(CatalogHit("tears", "movie", "Tears of Steel", playable = true))
        waitUntil("the notice") { notices.isNotEmpty() }
        assertEquals(HomeNotice.Added("Tears of Steel", "Films"), notices.single())
        val post = requests.single { it.method == "POST" }
        assertEquals("""{"itemId":"tears","sectionId":"films01"}""", post.body?.utf8())
        assertEquals(listOf("sintel", "tears"), vm.state.value.section("films01")!!.itemIds)
        assertTrue("it leaves the results", vm.search.value.items.none { it.id == "tears" })
        assertEquals("and the server's list, so the next page starts one earlier", 0, vm.search.value.next)
        assertFalse(vm.search.value.hasMore)
    }

    @Test
    fun deletesASection() {
        val vm = loaded()
        vm.deleteSection(UNTITLED_SECTION) // never sent
        vm.deleteSection("kids01")
        waitUntil("deleted") { vm.state.value.section("kids01") == null }
        assertEquals(listOf("DELETE /api/v1/admin/devices/tv-1/home/sections/kids01"), requests.filter { it.method == "DELETE" }.map { "${it.method} ${it.url.encodedPath}" })
        assertFalse(vm.state.value.saving)
    }

    @Test
    fun aRevokedPhoneIsSaidToTheHost() {
        val vm = loaded()
        assertFalse(vm.revoked.value)
        deviceAnswer = { json(401, """{"error":"unauthorized"}""") }
        vm.retry()
        waitUntil("revoked") { vm.revoked.value }
        assertTrue("what is shown stays", vm.state.value.loaded)
    }

    private fun loaded(): HomeViewModel = viewModel().also { vm ->
        scope.launch { vm.reload() }
        waitUntil("the load") { vm.state.value.loaded }
    }

    private fun viewModel(): HomeViewModel {
        val api = ApiClient(server.url("/"), "izph_test", OkHttpClient())
        return HomeViewModel(api, "tv-1").also { vm -> scope.launch { vm.notices.collect { notices += it } } }
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

    private fun settle() = repeat(20) {
        mainLooper.idle()
        Thread.sleep(10)
    }

    private companion object {
        const val ENTRIES = """
            {"itemId":"bunny","title":"Big Buck Bunny","kind":"movie","posterUrl":"/assets/b.jpg","backdropUrl":null,"missing":false,"playable":true,
             "continue":{"episodeId":"bunny.m","season":null,"number":null,"label":null,"index":0,"positionMs":0,"durationMs":null,"status":"new"},
             "newEpisodes":0,"check":null,"checkAll":null},
            {"itemId":"gone","title":null,"kind":null,"posterUrl":null,"backdropUrl":null,"missing":true,"playable":false,"continue":null,
             "newEpisodes":0,"check":null,"checkAll":null},
            {"itemId":"sintel","title":"Sintel","kind":"series","posterUrl":"/assets/s.jpg","backdropUrl":null,"missing":false,"playable":true,
             "continue":{"episodeId":"sintel.e5","season":1,"number":5,"label":null,"index":4,"positionMs":724000,"durationMs":1810000,"status":"watching"},
             "newEpisodes":2,"check":{"verdict":"ok","checkedAt":"2026-10-26T10:00:00.000Z","working":1,"total":1,"stale":false},
             "checkAll":{"verdict":"ok","checked":5,"total":5,"failed":0,"warned":0,"oldestCheckedAt":"2026-10-26T10:00:00.000Z"}}"""
        const val TEARS = """,{"itemId":"tears","title":"Tears of Steel","kind":"movie","missing":false,"playable":true,"continue":null,"newEpisodes":0}"""

        const val SECTIONS = """[{"id":"untitled","title":null,"layout":"grid","itemIds":["bunny","gone"]},
            {"id":"films01","title":"Films","layout":"row","itemIds":["sintel"]},
            {"id":"kids01","title":"Kids","layout":"grid","itemIds":[]}]"""
        const val MOVED = """[{"id":"untitled","title":null,"layout":"grid","itemIds":["sintel","bunny","gone"]},
            {"id":"films01","title":"Films","layout":"row","itemIds":[]},
            {"id":"kids01","title":"Kids","layout":"grid","itemIds":[]}]"""
        const val ADDED = """[{"id":"untitled","title":null,"layout":"grid","itemIds":["bunny","gone"]},
            {"id":"films01","title":"Films","layout":"row","itemIds":["sintel","tears"]},
            {"id":"kids01","title":"Kids","layout":"grid","itemIds":[]}]"""
        const val KIDS_DELETED = """[{"id":"untitled","title":null,"layout":"grid","itemIds":["bunny","gone"]},
            {"id":"films01","title":"Films","layout":"row","itemIds":["sintel"]}]"""

        val DEVICE = """{"device":{"id":"tv-1","name":"Salon","status":"active","online":true,"lastSeenAt":"2026-10-27T09:00:00.000Z",
            "effective":{"uiLanguage":"en","autoplayOnStart":false,"homeColumns":5,"homeRows":2},"problems":{"recent":0,"lastAt":null}},
            "home":[$ENTRIES],"homeMax":200,"sections":$SECTIONS,"sectionsMax":20}"""

        fun change(sections: String) = """{"version":42,"home":[$ENTRIES$TEARS],"sections":$sections}"""
    }
}
