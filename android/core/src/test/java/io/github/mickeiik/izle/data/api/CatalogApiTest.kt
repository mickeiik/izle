package io.github.mickeiik.izle.data.api

import io.github.mickeiik.izle.json
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.TimeUnit

/** The catalog routes in [ApiClient] (the loaded catalog, its history, a reload) and a TV's progress, against MockWebServer. */
class CatalogApiTest {
    private val server = MockWebServer()
    private val http = OkHttpClient()

    @Before
    fun setUp() = server.start()

    @After
    fun tearDown() = server.close()

    private fun client() = ApiClient(server.url("/izle/"), "izph_secret", http)

    private fun takeRequest(method: String, path: String): RecordedRequest = server.takeRequest().also {
        assertEquals(method, it.method)
        assertEquals(path, it.url.encodedPath)
        assertEquals("Bearer izph_secret", it.headers["Authorization"])
    }

    @Test
    fun theCatalogDecodesItsHistoryChangesAndFacets() = runBlocking {
        server.enqueue(json(200, CATALOG))
        val catalog = client().catalog()
        takeRequest("GET", "/izle/api/v1/admin/catalog")
        assertEquals("sample", catalog.id)
        assertEquals("7f3a", catalog.buildId)
        assertEquals("Sample", catalog.name)
        assertEquals("2026-10-25T09:12:00.000Z", catalog.loadedAt)
        assertEquals(CatalogStats(items = 12, movies = 4, series = 6, live = 2, episodes = 40, playableEpisodes = 38, sources = 50, posters = 12, backdrops = 3), catalog.stats)
        assertEquals(listOf("example"), catalog.adapters)
        assertEquals(CatalogIssue(file = "items/a.json", path = "/posterUrl", message = "poster is large"), catalog.warnings.single())
        assertEquals(ResolverInfo("ab12", listOf("example")), catalog.resolver)
        assertEquals("0.6.1", catalog.server?.version)
        val (newest, first) = catalog.builds
        assertEquals(CatalogBuild("7f3a", "2026-10-25T09:00:00Z", "2026-10-25T09:12:00.000Z", false, BuildCounts(12, 40), BuildCounts(3, 12), BuildCounts(1, 2)), newest)
        assertTrue(first.baseline)
        val changes = catalog.changes!!
        assertEquals(ChangedItem("show-2", "Spring", "series"), changes.items.added.single())
        assertEquals(ChangedItem("gone", null), changes.items.removed.single())
        assertEquals(ChangedEpisode("s2e1", "show-2", "Spring", 1, 1, "S1 E1", true), changes.episodes.added.single())
        assertEquals(ChangedEpisode("old.e1", "gone", null), changes.episodes.removed.single())
        assertEquals(KindCounts(4, 6, 2), catalog.facets.kinds)
        assertEquals(GenreCount("Animation", 5), catalog.facets.genres.first())
        assertEquals(YearRange(1998, 2024), catalog.facets.years)
    }

    @Test
    fun aCatalogWithoutResolverOrChangesStillDecodes() = runBlocking {
        server.enqueue(json(200, """{"id":"c","buildId":"b","builtAt":"2026-10-20T00:00:00Z","name":"C","loadedAt":"2026-10-20T00:00:00.000Z","stats":{},"adapters":[],"warnings":[],"resolver":null,"server":{"version":"0.6.1"},"builds":[],"changes":null,"facets":{"kinds":{"movie":0,"series":0,"live":0},"genres":[],"years":null}}"""))
        val catalog = client().catalog()
        assertNull(catalog.resolver)
        assertNull(catalog.changes)
        assertNull(catalog.facets.years)
        assertTrue(catalog.builds.isEmpty())
    }

    @Test
    fun aBuildIsReadByItsIdAsAPathSegment() = runBlocking {
        server.enqueue(json(200, """{"build":{"buildId":"b/1","builtAt":null,"loadedAt":"2026-10-18T08:00:00.000Z","baseline":true,"counts":{"items":9,"episodes":30},"added":{"items":0,"episodes":0},"removed":{"items":0,"episodes":0}},"changes":{"items":{"added":[],"removed":[]},"episodes":{"added":[],"removed":[]}}}"""))
        server.enqueue(json(404, """{"error":"unknown_build"}"""))
        val api = client()
        val found = api.catalogBuild("b/1")
        takeRequest("GET", "/izle/api/v1/admin/catalog/builds/b%2F1")
        assertTrue(found.build.baseline)
        assertEquals(BuildCounts(9, 30), found.build.counts)
        assertTrue(found.changes.items.added.isEmpty())
        val unknown = assertThrows(ApiException::class.java) { runBlocking { api.catalogBuild("nope") } }
        assertEquals("unknown_build", unknown.code)
    }

    @Test
    fun aReloadAnswersTheCatalogOnTheLongPollClientOrTheIssuesOfARefusedBundle() = runBlocking {
        val impatient = OkHttpClient.Builder().readTimeout(1, TimeUnit.MILLISECONDS).build()
        server.enqueue(json(200, """{"catalog":$CATALOG}""").newBuilder().headersDelay(200, TimeUnit.MILLISECONDS).build())
        server.enqueue(
            json(
                422,
                """{"error":"invalid_catalog","issues":[{"severity":"error","file":"items/a.json","path":"/episodes/0/id","message":"duplicate id"},{"severity":"warning","file":"manifest.json","path":"","message":"no name"}]}""",
            ),
        )
        val api = ApiClient(server.url("/izle/"), "izph_secret", impatient, http)

        assertEquals("7f3a", api.reloadCatalog().buildId)
        val request = takeRequest("POST", "/izle/api/v1/admin/catalog/reload")
        assertEquals(0L, request.bodySize)

        val refused = assertThrows(ApiException::class.java) { runBlocking { api.reloadCatalog() } }
        assertEquals(422, refused.status)
        assertEquals("invalid_catalog", refused.code)
        assertEquals(
            listOf(CatalogIssue("error", "items/a.json", "/episodes/0/id", "duplicate id"), CatalogIssue("warning", "manifest.json", "", "no name")),
            refused.issues,
        )
    }

    @Test
    fun otherErrorsCarryNoIssues() {
        server.enqueue(json(403, """{"error":"forbidden"}"""))
        val e = assertThrows(ApiException::class.java) { runBlocking { client().reloadCatalog() } }
        assertTrue(e.issues.isEmpty())
    }

    @Test
    fun aTvsProgressDecodesCursorsAndPositions() = runBlocking {
        server.enqueue(
            json(
                200,
                """{"cursors":[{"itemId":"show-1","episodeId":"s1e2","updatedAt":"2026-10-26T20:00:00.000Z","itemTitle":"Dark","kind":"series","season":1,"number":2,"episodeTitle":"Lies"},
                              {"itemId":"gone","episodeId":"x","updatedAt":"2026-10-01T20:00:00.000Z","missing":true}],
                    "progress":[{"itemId":"show-1","episodeId":"s1e1","positionMs":3000000,"durationMs":3060000,"status":"finished","updatedAt":"2026-10-26T20:00:00.000Z","itemTitle":"Dark","kind":"series","season":1,"number":1,"episodeTitle":"Secrets"}]}""",
            ),
        )
        val progress = client().deviceProgress("tv 1")
        takeRequest("GET", "/izle/api/v1/admin/devices/tv%201/progress")
        assertEquals(ItemCursor("show-1", "s1e2", "2026-10-26T20:00:00.000Z", "Dark", "series", 1, 2, "Lies"), progress.cursors.first())
        assertTrue(progress.cursors.last().missing)
        assertNull(progress.cursors.last().itemTitle)
        val saved = progress.progress.single()
        assertEquals(SavedProgress.FINISHED, saved.status)
        assertEquals(3_000_000L, saved.positionMs)
    }

    @Test
    fun okPlaysTheCursorsEpisodeOrTheNextAllowedOne() {
        val item = series(ep("e1"), ep("e2", allowed = false), ep("e3"))
        assertEquals("e1", DeviceProgress(cursors = listOf(cursor("e1"))).okPlays(item))
        // A cursor on an episode no longer allowed moves on; past the last allowed one, back to the first.
        assertEquals("e3", DeviceProgress(cursors = listOf(cursor("e2"))).okPlays(item))
        assertEquals("e1", DeviceProgress(cursors = listOf(cursor("e3"))).okPlays(series(ep("e1"), ep("e2"), ep("e3", allowed = false))))
        // A cursor of another item, or on an episode the item lost, does not count.
        assertEquals("e1", DeviceProgress(cursors = listOf(ItemCursor("other", "e3"), cursor("gone"))).okPlays(item))
    }

    @Test
    fun withoutCursorOkPlaysTheFirstAllowedEpisodeNotFinishedElseTheFirstAllowed() {
        val item = series(ep("e0", allowed = false), ep("e1"), ep("e2"))
        assertEquals("e1", DeviceProgress().okPlays(item))
        assertEquals("e2", DeviceProgress(progress = listOf(saved("e1", SavedProgress.FINISHED))).okPlays(item))
        assertEquals("e1", DeviceProgress(progress = listOf(saved("e1", "watching"))).okPlays(item))
        assertEquals("e1", DeviceProgress(progress = listOf(saved("e1", SavedProgress.FINISHED), saved("e2", SavedProgress.FINISHED))).okPlays(item))
    }

    @Test
    fun okPlaysNothingWhenNoEpisodeMayPlayOrForAChannel() {
        assertNull(DeviceProgress().okPlays(series(ep("e1", allowed = false))))
        assertNull(DeviceProgress().okPlays(AdminItem("ch", "live", "News", playbackAllowed = true)))
    }

    private fun series(vararg episodes: AdminEpisode) = AdminItem("show-1", "series", "Dark", episodes = episodes.toList())

    private fun ep(id: String, allowed: Boolean = true) = AdminEpisode(id, playbackAllowed = allowed)

    private fun cursor(episodeId: String) = ItemCursor("show-1", episodeId)

    private fun saved(episodeId: String, status: String) = SavedProgress("show-1", episodeId, status = status)

    private companion object {
        const val CATALOG = """{"id":"sample","buildId":"7f3a","builtAt":"2026-10-25T09:00:00Z","name":"Sample","loadedAt":"2026-10-25T09:12:00.000Z",
            "stats":{"items":12,"movies":4,"series":6,"live":2,"episodes":40,"playableEpisodes":38,"sources":50,"posters":12,"backdrops":3},
            "adapters":["example"],"warnings":[{"file":"items/a.json","path":"/posterUrl","message":"poster is large"}],
            "resolver":{"sha256":"ab12","adapters":["example"]},"server":{"version":"0.6.1"},
            "builds":[{"buildId":"7f3a","builtAt":"2026-10-25T09:00:00Z","loadedAt":"2026-10-25T09:12:00.000Z","baseline":false,"counts":{"items":12,"episodes":40},"added":{"items":3,"episodes":12},"removed":{"items":1,"episodes":2}},
                      {"buildId":"1a2b","builtAt":"2026-10-18T08:00:00Z","loadedAt":"2026-10-18T08:00:00.000Z","baseline":true,"counts":{"items":10,"episodes":30},"added":{"items":0,"episodes":0},"removed":{"items":0,"episodes":0}}],
            "changes":{"items":{"added":[{"id":"show-2","title":"Spring","kind":"series"}],"removed":[{"id":"gone","title":null}]},
                       "episodes":{"added":[{"id":"s2e1","itemId":"show-2","itemTitle":"Spring","season":1,"number":1,"label":"S1 E1","playbackAllowed":true}],"removed":[{"id":"old.e1","itemId":"gone","itemTitle":null}]}},
            "facets":{"kinds":{"movie":4,"series":6,"live":2},"genres":[{"name":"Animation","count":5},{"name":"Drama","count":2}],"years":{"min":1998,"max":2024}}}"""
    }
}
