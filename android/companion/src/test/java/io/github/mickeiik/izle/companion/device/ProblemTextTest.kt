package io.github.mickeiik.izle.companion.device

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import io.github.mickeiik.izle.companion.tv.dayText
import io.github.mickeiik.izle.companion.tv.shortTimeAgo
import io.github.mickeiik.izle.companion.ui.design.Tone
import io.github.mickeiik.izle.data.api.AdminDevice
import io.github.mickeiik.izle.data.api.DeviceApp
import io.github.mickeiik.izle.data.api.DeviceEffective
import io.github.mickeiik.izle.data.api.DeviceSettings
import io.github.mickeiik.izle.data.api.Problem
import io.github.mickeiik.izle.domain.IsoTime
import java.util.TimeZone
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The TV tab's words: a problem's title, place and time, the TV's app and its settings. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class ProblemTextTest {
    private val res = ApplicationProvider.getApplicationContext<Context>().resources
    private val utc = TimeZone.getTimeZone("UTC")
    private val now = IsoTime.parseEpochMs("2026-10-27T15:00:00.000Z")!!

    @Test
    fun titlesByKindAndCode() {
        assertEquals("Nothing could play", problemTitle(res, "resolve", "no_playable_source"))
        assertEquals("A source failed, another played", problemTitle(res, "resolve", "source_failed"))
        assertEquals("The source refused (401)", problemTitle(res, "proxy", "upstream_401"))
        assertEquals("The source refused (403)", problemTitle(res, "proxy", "upstream_403"))
        assertEquals("The source refused (410)", problemTitle(res, "proxy", "upstream_410"))
        assertEquals("The source broke off", problemTitle(res, "proxy", "upstream_error"))
        assertEquals("The source did not answer", problemTitle(res, "proxy", "upstream_unreachable"))
        for (code in listOf("not_a_playlist", "playlist_too_large", "not_media")) {
            assertEquals("The source sent something unplayable", problemTitle(res, "proxy", code))
        }
        assertEquals("The server refused the source's address", problemTitle(res, "proxy", "egress_denied"))
        assertEquals("Player error: io bad http status", problemTitle(res, "playback", "ERROR_CODE_IO_BAD_HTTP_STATUS"))
        assertEquals("The TV lost the server", problemTitle(res, "network", "server_unreachable"))
        // A code without words shows as it is (another status, another kind's player-looking code).
        assertEquals("upstream_404", problemTitle(res, "proxy", "upstream_404"))
        assertEquals("ERROR_CODE_TIMEOUT", problemTitle(res, "other", "ERROR_CODE_TIMEOUT"))
        assertEquals("cant_play", problemTitle(res, "other", "cant_play"))
    }

    @Test
    fun whereAndWhen() {
        val p = Problem(
            id = 1, at = "2026-10-27T13:00:00.000Z", origin = "server", kind = "proxy", code = "upstream_403",
            itemId = "caminandes", itemTitle = "Caminandes", itemKind = "series", episodeId = "caminandes.e2",
            episodeTitle = "Gran Dillama", season = 1, number = 2,
        )
        assertEquals("Caminandes · S1 · E2 — Gran Dillama", problemPlace(res, p))
        assertEquals("Caminandes · S1 · E2 — Gran Dillama · 2 h ago", problemRowLine(res, p, now))
        assertEquals("Caminandes", problemPlace(res, p.copy(itemKind = "movie")))
        assertEquals("News 24", problemPlace(res, Problem(2, itemId = "news", itemTitle = "News 24", itemKind = "live")))
        assertEquals("caminandes (no longer in the catalog)", problemPlace(res, p.copy(missing = true, itemTitle = null, episodeTitle = null)))
        assertNull(problemPlace(res, Problem(3, kind = "network", code = "x")))
        assertEquals("2 h ago", problemRowLine(res, Problem(3, at = p.at), now))
        assertEquals("just now", shortTimeAgo(res, now - 30_000, now))
        assertEquals("5 min ago", shortTimeAgo(res, now - 5 * 60_000, now))
        assertEquals("3 d ago", shortTimeAgo(res, now - 3 * 86_400_000L, now))
        assertNull(problemRowLine(res, Problem(4), now))

        assertEquals("Today 13:00 · reported by the server", problemCaption(res, p, now, utc))
        assertEquals("Yesterday 13:00 · reported by the TV", problemCaption(res, p.copy(origin = "tv", at = "2026-10-26T13:00:00Z"), now, utc))
        assertEquals("Sat 24 Oct", dayText(res, IsoTime.parseEpochMs("2026-10-24T08:00:00Z")!!, now, utc))
        assertEquals("reported by the TV", problemCaption(res, Problem(5), now, utc))

        assertEquals("Proxy", problemKindText(res, "proxy"))
        assertEquals("Playback", problemKindText(res, "playback"))
        assertEquals("Other", problemKindText(res, "something_new"))
    }

    @Test
    fun theTvsApp() {
        val app = DeviceApp(version = "0.6.1", androidSdk = 31, capability = "silent", update = "up_to_date")
        assertEquals("izle 0.6.1 · Android 12", appLine(res, app))
        assertEquals("izle 0.6.1 · API 40", appLine(res, app.copy(androidSdk = 40)))
        assertEquals("Version unknown", appLine(res, null))
        assertEquals("Up to date" to Tone.Success, updateChip(res, app))
        assertEquals("Update available" to Tone.Neutral, updateChip(res, app.copy(update = "pending")))
        assertEquals("Needs an update" to Tone.Warning, updateChip(res, app.copy(update = "needs_install_now")))
        assertNull(updateChip(res, app.copy(update = "unknown")))
        assertEquals("Installs updates by itself while nobody watches.", installText(res, app))
        assertEquals("Needs someone at the TV to press OK.", installText(res, app.copy(capability = "guided")))
        assertNull(installText(res, null))
        assertFalse(offersUpdate(app))
        assertTrue(offersUpdate(app.copy(update = "pending")))
        assertTrue(offersUpdate(app.copy(update = "needs_install_now")))
    }

    @Test
    fun settingsValues() {
        val tv = AdminDevice(
            "tv-1", "Salon",
            settings = DeviceSettings(uiLanguage = null, preferredAudioLanguage = null, subtitlesLanguage = null),
            effective = DeviceEffective(uiLanguage = "en", preferredAudioLanguage = "tr"),
        )
        assertEquals("Salon", settingValue(res, tv, Setting.Name))
        assertEquals("English", settingValue(res, tv, Setting.MenuLanguage))
        assertEquals("Server default · Türkçe", settingValue(res, tv, Setting.Audio))
        assertEquals("Server default", settingValue(res, tv.copy(effective = DeviceEffective()), Setting.Audio))
        assertEquals("Off", settingValue(res, tv, Setting.Subtitles))
        assertEquals("Off", settingValue(res, tv, Setting.PlayOnStart))
        val set = tv.copy(settings = DeviceSettings(uiLanguage = "tr", preferredAudioLanguage = "en", subtitlesLanguage = "pt-BR", autoplayOnStart = true))
        assertEquals("Türkçe", settingValue(res, set, Setting.MenuLanguage))
        assertEquals("English", settingValue(res, set, Setting.Audio))
        assertEquals("Português", settingValue(res, set, Setting.Subtitles))
        assertEquals("On", settingValue(res, set, Setting.PlayOnStart))
        assertEquals("sv", languageName("sv"))
    }
}
