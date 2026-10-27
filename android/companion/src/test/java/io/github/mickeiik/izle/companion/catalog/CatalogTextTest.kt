package io.github.mickeiik.izle.companion.catalog

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import io.github.mickeiik.izle.data.api.AdminCatalog
import io.github.mickeiik.izle.data.api.BuildCounts
import io.github.mickeiik.izle.data.api.CatalogBuild
import io.github.mickeiik.izle.data.api.CatalogChanges
import io.github.mickeiik.izle.data.api.CatalogHit
import io.github.mickeiik.izle.data.api.CatalogStats
import io.github.mickeiik.izle.data.api.ChangedEpisode
import io.github.mickeiik.izle.data.api.ChangedItem
import io.github.mickeiik.izle.data.api.EpisodeChanges
import io.github.mickeiik.izle.data.api.ItemChanges
import io.github.mickeiik.izle.data.api.ResolverInfo
import io.github.mickeiik.izle.data.api.ServerInfo
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.TimeZone

/** The Catalog tab's and What's new's words. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class CatalogTextTest {
    private val res = ApplicationProvider.getApplicationContext<Context>().resources
    private val paris = TimeZone.getTimeZone("GMT+02:00")

    @Test
    fun aShowsLine() {
        val series = CatalogHit("c", "series", "Caminandes", year = 2013, episodeCount = 3, newEpisodes = 2)
        assertEquals("Series · 2013 · 3 episodes", catalogLine(res, series))
        assertEquals("Series · 2013 · 3 episodes · 2 new", catalogLine(res, series, withNew = true))
        assertEquals("Series · 1 episode", catalogLine(res, series.copy(year = null, episodeCount = 1)))
        assertEquals("Film · 2012", catalogLine(res, CatalogHit("t", "movie", "Tears", year = 2012)))
        assertEquals("Film", catalogLine(res, CatalogHit("t", "movie", "Tears")))
        assertEquals("Channel", catalogLine(res, CatalogHit("n", "live", "News", year = 2020)))
    }

    @Test
    fun builds() {
        val b = build("7f3a", "2026-10-25T07:12:00Z", added = BuildCounts(3, 12), removed = BuildCounts(1, 0))
        assertEquals("25 Oct · 3 shows, 12 episodes", whatsNewRowText(res, b, paris))
        assertEquals("25 Oct · 1 episode", whatsNewRowText(res, b.copy(added = BuildCounts(0, 1)), paris))
        assertEquals("25 Oct · nothing added", whatsNewRowText(res, b.copy(added = BuildCounts()), paris))
        assertEquals("Build 7f3a · loaded 25 Oct 09:12 · +3 shows, +12 episodes, −1 show", buildSummary(res, b, paris))
        assertEquals("Build 7f3a · loaded 25 Oct 09:12", buildSummary(res, b.copy(added = BuildCounts(), removed = BuildCounts()), paris))

        val chips = buildChips(
            res,
            listOf(b, build("b", "2026-10-25T05:00:00Z"), build("c", "2026-10-18T08:00:00Z"), build("d", "2026-10-10T08:00:00Z", baseline = true)),
            paris,
        ).map { it.second }
        assertEquals(listOf("25 Oct 09:12", "25 Oct 07:00", "18 Oct", "First loaded"), chips)
    }

    @Test
    fun whatABuildChanged() {
        val changes = CatalogChanges(
            ItemChanges(
                added = listOf(ChangedItem("tears", "Tears of Steel", "movie")),
                removed = listOf(ChangedItem("old", "Old Show"), ChangedItem("lost")),
            ),
            EpisodeChanges(
                added = listOf(
                    ChangedEpisode("tears.m", "tears", "Tears of Steel"),
                    ChangedEpisode("c.e2", "c", "Caminandes", season = 1, number = 2),
                    ChangedEpisode("c.e3", "c", "Caminandes", season = 1, number = 3),
                ),
                removed = listOf(ChangedEpisode("s.e9", "s", "Sintel"), ChangedEpisode("old.e1", "old", "Old Show")),
            ),
        )
        assertEquals(listOf(EpisodeGroup("c", "Caminandes", listOf("S1 · E2", "S1 · E3"))), newEpisodeGroups(changes))
        assertEquals(listOf("Old Show", "lost", "Sintel · 1 episode"), goneLines(res, changes))
    }

    @Test
    fun aboutTheCatalog() {
        val c = AdminCatalog(
            id = "open-movies", buildId = "7f3a", name = "Open movies", builtAt = "2026-10-25T07:00:00Z", loadedAt = "2026-10-25T07:12:00Z",
            stats = CatalogStats(items = 142, movies = 40, series = 100, live = 2, episodes = 1200, playableEpisodes = 1100, sources = 1300),
            resolver = ResolverInfo("ab", listOf("example")), server = ServerInfo("0.6.1"),
        )
        assertEquals(
            listOf(
                "Name" to "Open movies",
                "Catalog id" to "open-movies",
                "Build" to "7f3a",
                "Built" to "25 Oct 09:00",
                "Loaded" to "25 Oct 09:12",
                "Contents" to "142 shows (40 films, 100 series, 2 channels) · 1200 episodes, 1100 playable · 1300 sources",
                "Resolver" to "provides example",
                "Server" to "izle-server 0.6.1",
            ),
            aboutFacts(res, c, paris),
        )
        assertEquals("none configured", aboutFacts(res, c.copy(resolver = null), paris)[6].second)
    }

    private fun build(id: String, loadedAt: String, baseline: Boolean = false, added: BuildCounts = BuildCounts(), removed: BuildCounts = BuildCounts()) =
        CatalogBuild(id, loadedAt = loadedAt, baseline = baseline, added = added, removed = removed)
}
