package io.github.mickeiik.izle.companion.home

import android.os.Looper
import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.data.api.CatalogHit
import io.github.mickeiik.izle.data.api.SectionEntry
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
    @Volatile private var appAnswer: () -> MockResponse = { json(200, appChange(APP_SECTIONS, APPS)) }

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
                    path == "/api/v1/admin/devices/tv-1/home/apps" && method == "POST" -> appAnswer()
                    path.startsWith("/api/v1/admin/devices/tv-1/home/apps/") -> appAnswer()
                    path == "/api/v1/admin/devices/tv-1/home/items/bunny" && method == "PATCH" -> json(200, appChange(APP_SECTIONS, APPS))
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
        assertEquals("home.changed,cursor.changed,device.updated,device.apps,catalog.reloaded,check.finished", polls.first().url.queryParameter("types"))
        assertEquals("10", polls[1].url.queryParameter("after"))
        assertEquals("25", polls[1].url.queryParameter("wait"))
        follow.cancel()
    }

    @Test
    fun aDropIsOneMoveAndTheAnswerRedrawsTheList() {
        val vm = loaded()
        vm.move(SINTEL, HomePlace(UNTITLED_SECTION, 0))
        // At once: the list draws the move while it is saved.
        assertEquals(listOf("sintel", "bunny", "gone"), vm.state.value.section(UNTITLED_SECTION)!!.itemIds)
        waitUntil("saved") { !vm.state.value.saving && requests.any { it.method == "PATCH" } }
        val patch = requests.single { it.method == "PATCH" }
        assertEquals("/api/v1/admin/devices/tv-1/home/items/sintel", patch.url.encodedPath)
        assertEquals("""{"sectionId":"untitled","position":0}""", patch.body?.utf8())
        assertEquals(listOf("sintel", "bunny", "gone"), vm.state.value.section(UNTITLED_SECTION)!!.itemIds)
        assertEquals(emptyList<String>(), vm.state.value.section("films01")!!.itemIds)
        // A move to where it is sends nothing.
        vm.move(SINTEL, HomePlace(UNTITLED_SECTION, 0))
        settle()
        assertEquals(1, requests.count { it.method == "PATCH" })
    }

    @Test
    fun aChangeRefusedBecauseHomeChangedReloadsAndSaysSo() {
        moveAnswer = { json(409, """{"error":"home_changed"}""") }
        val vm = loaded()
        val reads = requests.count { it.url.encodedPath == "/api/v1/admin/devices/tv-1" }
        vm.move(SINTEL, HomePlace(UNTITLED_SECTION, 0))
        waitUntil("the notice") { HomeNotice.ChangedElsewhere in notices }
        waitUntil("the reload") { requests.count { it.url.encodedPath == "/api/v1/admin/devices/tv-1" } == reads + 1 }
        waitUntil("saved") { !vm.state.value.saving }
        // Back to the server's list.
        assertEquals(listOf("sintel"), vm.state.value.section("films01")!!.itemIds)

        moveAnswer = { json(404, """{"error":"not_on_home"}""") }
        notices.clear()
        vm.move(SINTEL, HomePlace(UNTITLED_SECTION, 0))
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
    fun anOlderServerHasNoAppsAndTheTvNeverReported() {
        val s = loaded().state.value
        assertEquals(emptyMap<String, Any>(), s.apps)
        assertNull(s.appsReportedAt)
        assertEquals(0, s.appCount)
    }

    @Test
    fun loadsTheAppsAndCountsTheAppCards() {
        deviceAnswer = { json(200, DEVICE_APPS) }
        val s = loaded().state.value
        assertEquals(listOf(WEATHER, MAIL, CLOCK, RADIO), s.apps.keys.toList())
        assertEquals("2026-10-27T09:00:00.000Z", s.appsReportedAt)
        assertEquals(4, s.showCount)
        assertEquals(2, s.appCount)
        assertEquals(listOf(SINTEL, SectionEntry(appId = WEATHER), BUNNY, GONE), s.section(UNTITLED_SECTION)!!.cards)
    }

    @Test
    fun anAppCardMovesWithItsOwnRouteAndPositionsCountEveryCard() {
        deviceAnswer = { json(200, DEVICE_APPS) }
        val vm = loaded()
        val weather = SectionEntry(appId = WEATHER)
        // Over Films' one show: its second place.
        vm.move(weather, HomePlace("films01", 1))
        assertEquals(listOf(SectionEntry(itemId = "tears"), weather), vm.state.value.section("films01")!!.cards)
        waitUntil("saved") { !vm.state.value.saving && requests.any { it.method == "PATCH" } }
        val patch = requests.single { it.method == "PATCH" }
        assertEquals("/api/v1/admin/devices/tv-1/home/apps/$WEATHER", patch.url.encodedPath)
        assertEquals("""{"sectionId":"films01","position":1}""", patch.body?.utf8())

        // A show's position counts the app cards: Bunny, after Weather, is at 2 and goes to 1, before it.
        requests.clear()
        assertEquals(HomePlace(UNTITLED_SECTION, 2), placeOf(vm.state.value.sections, BUNNY))
        vm.move(BUNNY, HomePlace(UNTITLED_SECTION, 1))
        assertEquals(listOf(SINTEL, BUNNY, SectionEntry(appId = WEATHER), GONE), vm.state.value.section(UNTITLED_SECTION)!!.cards)
        assertEquals(listOf("sintel", "bunny", "gone"), vm.state.value.section(UNTITLED_SECTION)!!.itemIds)
        waitUntil("saved") { !vm.state.value.saving && requests.any { it.method == "PATCH" } }
        val show = requests.single { it.method == "PATCH" }
        assertEquals("/api/v1/admin/devices/tv-1/home/items/bunny", show.url.encodedPath)
        assertEquals("""{"sectionId":"untitled","position":1}""", show.body?.utf8())
    }

    @Test
    fun removesAnAppCardTheTvNoLongerHas() {
        deviceAnswer = { json(200, DEVICE_APPS) }
        val vm = loaded()
        assertTrue(appHidden(vm.state.value.apps[RADIO]))
        appAnswer = { json(200, appChange(APP_SECTIONS.replace("""{"appId":"$RADIO"}""", ""), APPS.replace(""""onHome":true,"x":1""", """"onHome":false"""))) }
        vm.remove(SectionEntry(appId = RADIO))
        assertEquals("at once", emptyList<SectionEntry>(), vm.state.value.section("kids01")!!.cards)
        waitUntil("saved") { !vm.state.value.saving && requests.any { it.method == "DELETE" } }
        assertEquals("/api/v1/admin/devices/tv-1/home/apps/$RADIO", requests.single { it.method == "DELETE" }.url.encodedPath)
        assertEquals(emptyList<SectionEntry>(), vm.state.value.section("kids01")!!.cards)
    }

    @Test
    fun theAppsChipAddsAnAppAndTheAnswerTakesItOffTheChoices() {
        deviceAnswer = { json(200, DEVICE_APPS) }
        val vm = loaded()
        vm.openSearch()
        vm.toggleKind("movie")
        vm.toggleApps()
        assertTrue(vm.search.value.apps)
        assertEquals("the Apps chip lets go of the kinds", emptySet<String>(), vm.search.value.kinds)
        val searches = requests.count { it.url.encodedPath == "/api/v1/admin/catalog/search" }
        vm.setQuery("MA")
        settle()
        assertEquals("the apps are filtered here, not searched", searches, requests.count { it.url.encodedPath == "/api/v1/admin/catalog/search" })
        assertEquals(listOf(MAIL), appChoices(vm.state.value.apps.values, vm.search.value.query).map { it.appId })

        appAnswer = { json(200, appChange(APP_SECTIONS.replace("""[{"itemId":"tears"}]""", """[{"itemId":"tears"},{"appId":"$MAIL"}]"""), APPS.replace(""""label":"Mail","imageUrl":null,"installed":true,"onHome":false""", """"label":"Mail","imageUrl":null,"installed":true,"onHome":true"""))) }
        vm.setAddTo("films01")
        vm.addApp(vm.state.value.apps.getValue(MAIL))
        waitUntil("the notice") { notices.isNotEmpty() }
        assertEquals(HomeNotice.Added("Mail", "Films"), notices.single())
        assertEquals("""{"appId":"$MAIL","sectionId":"films01"}""", requests.single { it.method == "POST" }.body?.utf8())
        assertEquals(3, vm.state.value.appCount)
        assertEquals(emptyList<String>(), appChoices(vm.state.value.apps.values, "MA").map { it.appId })

        // A kind chip lets go of Apps and searches the catalog again.
        vm.toggleKind("series")
        assertFalse(vm.search.value.apps)
        waitUntil("the search") { requests.any { it.url.queryParameter("kind") == "series" } }
    }

    @Test
    fun aFullHomeRefusesTheAppInWords() {
        deviceAnswer = { json(200, DEVICE_APPS) }
        val vm = loaded()
        appAnswer = { json(400, """{"error":"too_many_apps","max":50}""") }
        vm.openSearch()
        vm.toggleApps()
        vm.addApp(vm.state.value.apps.getValue(CLOCK))
        waitUntil("the notice") { notices.isNotEmpty() }
        assertEquals(HomeNotice.Failed(HomeError.Server("too_many_apps")), notices.single())
        assertNull(vm.search.value.adding)
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

        val SINTEL = SectionEntry(itemId = "sintel")
        val BUNNY = SectionEntry(itemId = "bunny")
        val GONE = SectionEntry(itemId = "gone")
        const val WEATHER = "com.example.weather"
        const val MAIL = "com.example.mail"
        const val CLOCK = "com.example.clock"
        const val RADIO = "com.example.radio"

        // Weather among the shows of No title, Radio (the TV no longer has it) alone in Kids.
        const val APP_SECTIONS = """[{"id":"untitled","title":null,"layout":"grid","itemIds":["sintel","bunny","gone"],
              "entries":[{"itemId":"sintel"},{"appId":"$WEATHER"},{"itemId":"bunny"},{"itemId":"gone"}]},
            {"id":"films01","title":"Films","layout":"row","itemIds":["tears"],"entries":[{"itemId":"tears"}]},
            {"id":"kids01","title":"Kids","layout":"grid","itemIds":[],"entries":[{"appId":"$RADIO"}]}]"""
        const val APPS = """[{"appId":"$WEATHER","label":"Weather","imageUrl":"/app-images/aa.png","installed":true,"onHome":true},
            {"appId":"$MAIL","label":"Mail","imageUrl":null,"installed":true,"onHome":false},
            {"appId":"$CLOCK","label":"Clock","imageUrl":null,"installed":true,"onHome":false},
            {"appId":"$RADIO","label":"Radio","imageUrl":null,"installed":false,"onHome":true,"x":1}]"""

        val DEVICE_APPS = """{"device":{"id":"tv-1","name":"Salon","online":true,"effective":{"homeColumns":5,"homeRows":2}},
            "home":[$ENTRIES$TEARS],"homeMax":200,"sections":$APP_SECTIONS,"sectionsMax":20,
            "apps":$APPS,"appsMax":50,"appsReportedAt":"2026-10-27T09:00:00.000Z"}"""

        fun appChange(sections: String, apps: String) = """{"version":43,"home":[$ENTRIES$TEARS],"sections":$sections,"apps":$apps}"""
    }
}
