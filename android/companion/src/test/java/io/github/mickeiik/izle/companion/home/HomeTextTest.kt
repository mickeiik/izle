package io.github.mickeiik.izle.companion.home

import androidx.test.core.app.ApplicationProvider
import android.content.Context
import io.github.mickeiik.izle.data.api.AdminHomeEntry
import io.github.mickeiik.izle.data.api.CheckSummary
import io.github.mickeiik.izle.data.api.ContinueInfo
import io.github.mickeiik.izle.data.api.CatalogHit
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The Home tab's words: what OK plays, the check chip, hidden shows, search hits, messages. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class HomeTextTest {
    private val res = ApplicationProvider.getApplicationContext<Context>().resources

    @Test
    fun clockAndEpisodeNames() {
        assertEquals("0:00", formatClock(0))
        assertEquals("12:04", formatClock(724_900))
        assertEquals("1:02:03", formatClock(3_723_000))
        assertEquals("S1 · E5 — Rain", episodeName(1, 5, null, "Rain"))
        assertEquals("Episode 5", episodeName(null, 5, null, null))
        assertEquals("Special", episodeName(1, 5, "Special", null))
        assertEquals("Pilot", episodeName(null, null, null, "Pilot"))
        assertEquals("S1 E5", episodeLabel(1, 5, null, "Rain"))
    }

    @Test
    fun whatOkPlays() {
        fun series(c: ContinueInfo?, new: Int = 0) = AdminHomeEntry("s", "Sintel", "series", continueAt = c, newEpisodes = new)
        val e5 = ContinueInfo("s.e5", season = 1, number = 5, status = "watching", positionMs = 724_000, durationMs = 1_810_000)
        assertEquals("S1 · E5 · continues at 12:04 of 30:10", okPlaysText(res, series(e5)))
        assertEquals("S1 · E5 · continues at 12:04 of 30:10 · 2 new", showLine(res, series(e5, new = 2)))
        assertEquals("S1 · E5 · starts from the beginning", okPlaysText(res, series(e5.copy(positionMs = 10_000))))
        assertEquals("S1 · E5 · watched, starts over", okPlaysText(res, series(e5.copy(status = "finished"))))
        assertEquals("S1 · E5 · new", okPlaysText(res, series(e5.copy(status = "new", positionMs = 0))))
        assertEquals("Nothing playable", okPlaysText(res, series(null)))
        val film = AdminHomeEntry("f", "Bunny", "movie", continueAt = ContinueInfo("f.m", status = "new"))
        assertEquals("Film", okPlaysText(res, film))
        assertEquals("Film · continues at 1:00", okPlaysText(res, film.copy(continueAt = ContinueInfo("f.m", status = "watching", positionMs = 60_000))))
        assertEquals("Live", okPlaysText(res, AdminHomeEntry("c", "News", "live")))
    }

    @Test
    fun checksAndHiddenShows() {
        assertEquals(Verdict.NotChecked, verdictOf(null))
        assertEquals(Verdict.Works, verdictOf(CheckSummary("ok")))
        assertEquals(Verdict.Warns, verdictOf(CheckSummary("warn")))
        assertEquals(Verdict.Fails, verdictOf(CheckSummary("fail")))
        assertEquals(Verdict.Stale, verdictOf(CheckSummary("fail", stale = true)))
        assertEquals("Works, with warnings", verdictText(res, Verdict.Warns))
        assertEquals("Hidden on the TV: not in the catalog", res.getString(hiddenReason(AdminHomeEntry("g", missing = true, playable = false))!!))
        assertEquals("Hidden on the TV: can't play", res.getString(hiddenReason(AdminHomeEntry("g", "G", "series", playable = false))!!))
        assertEquals(null, hiddenReason(AdminHomeEntry("g", "G", "series")))
    }

    @Test
    fun hitsAndMessages() {
        assertEquals("Film · 2010", hitLine(res, CatalogHit("f", "movie", "Sintel", year = 2010)))
        assertEquals("Series · 40 episodes", hitLine(res, CatalogHit("s", "series", "S", episodeCount = 40, playableCount = 40)))
        assertEquals("Channel", hitLine(res, CatalogHit("c", "live", "News")))
        assertEquals("Sintel added to Films.", noticeText(res, HomeNotice.Added("Sintel", "Films"), "Salon"))
        assertEquals("Sintel added to Home.", noticeText(res, HomeNotice.Added("Sintel", null), "Salon"))
        assertEquals("Salon continues Sintel from S1 E5.", noticeText(res, HomeNotice.Continues("Sintel", "S1 E5"), "Salon"))
        assertEquals("Salon is offline. It gets this if it connects in the next 2 minutes.", noticeText(res, HomeNotice.PlayQueued("Sintel"), "Salon"))
        assertEquals("Salon isn't ready (it shows its pairing screen).", noticeText(res, HomeNotice.NotPlayed("Sintel", "not_ready"), "Salon"))
        assertEquals("Home changed on another screen; this is the current one.", noticeText(res, HomeNotice.Failed(HomeError.Server("not_on_home")), "Salon"))
        assertEquals("A Home holds at most 20 sections.", noticeText(res, HomeNotice.Failed(HomeError.Server("too_many_sections")), "Salon"))
        assertEquals("The server did not accept this (teapot).", noticeText(res, HomeNotice.Failed(HomeError.Server("teapot")), "Salon"))
    }
}
