package io.github.mickeiik.izle.companion.activity

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import io.github.mickeiik.izle.companion.device.problemTitle
import io.github.mickeiik.izle.data.api.AdminEvent
import io.github.mickeiik.izle.data.api.ApiJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.TimeZone

/** The Activity's words, on events as the server sends them (docs/spec/server-api-v1.md, Events). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class EventTextTest {
    private val res = ApplicationProvider.getApplicationContext<Context>().resources

    private fun event(json: String): AdminEvent = ApiJson.decodeFromString(AdminEvent.serializer(), json)

    private fun words(json: String, ctx: EventContext = EventContext(thisPhoneId = "ph-1")) = eventWords(res, event(json), ctx)

    private val started = """{"id":10,"at":"2026-10-27T14:05:00.000Z","type":"playback.started","deviceId":"tv-1",
        "actor":{"type":"tv","deviceId":"tv-1"},
        "data":{"viewingId":7,"itemId":"cam","itemKind":"series","itemTitle":"Caminandes","episodeId":"cam.e2","episodeTitle":"Gran Dillama",
        "season":1,"number":2,"sourceId":"s1","positionMs":250000,"trigger":"viewer"}}"""

    @Test
    fun playing() {
        assertEquals(EventWords("Started Caminandes · S1 · E2", "from 4:10 · OK on Home"), words(started))
        val fromPhone = started.replace(""""actor":{"type":"tv","deviceId":"tv-1"}""", """"actor":{"type":"phone","phoneId":"ph-1","name":"Pixel 8"}""")
            .replace(""""trigger":"viewer"""", """"trigger":"command"""")
        assertEquals(EventWords("Started Caminandes · S1 · E2", "from 4:10 · played from your phone"), words(fromPhone))
        assertEquals("another phone by its name", "from 4:10 · played from Pixel 8", words(fromPhone, EventContext())?.supporting)
        val film = """{"id":11,"type":"playback.started","deviceId":"tv-1","actor":{"type":"tv"},
            "data":{"viewingId":8,"itemId":"sintel","itemKind":"movie","itemTitle":"Sintel","episodeId":"sintel.m","episodeTitle":"Sintel",
            "positionMs":0,"trigger":"autoplay"}}"""
        assertEquals(EventWords("Started Sintel", "autoplay on start"), words(film))
        val channel = """{"id":12,"type":"playback.started","actor":{"type":"tv"},
            "data":{"viewingId":9,"itemId":"news","itemKind":"live","itemTitle":"News 24","positionMs":null,"trigger":"next"}}"""
        assertEquals(EventWords("Started News 24", "CH+/CH−"), words(channel))

        val viewings = mapOf(startedRef(event(started))!!)
        val ctx = EventContext(viewings = viewings)
        fun ended(reason: String, seen: Boolean = false, at: String = "724000") =
            """{"id":13,"type":"playback.ended","actor":{"type":"tv"},
            "data":{"viewingId":7,"endReason":"$reason","seen":$seen,"positionMs":$at,"watchedMs":400000,"dropped":false}}"""
        assertEquals(EventWords("Stopped at 12:04", "Caminandes · S1 · E2 · the TV"), words(ended("stopped"), ctx))
        assertEquals("Watched to the end", words(ended("finished", seen = true), ctx)?.title)
        assertEquals(EventWords("Switched away at 28:00", "Caminandes · S1 · E2 · seen · the TV"), words(ended("replaced", true, "1680000"), ctx))
        assertEquals("Went silent", words(ended("lost", at = "null"))?.title)
        assertEquals(
            EventWords("Stalled at 12:04", "Caminandes · S1 · E2 · the TV"),
            words("""{"id":14,"type":"playback.stalled","actor":{"type":"tv"},"data":{"viewingId":7,"positionMs":724000}}""", ctx),
        )
        val seen = """{"id":15,"type":"episode.seen","actor":{"type":"tv"},
            "data":{"viewingId":7,"itemId":"cam","episodeId":"cam.e2","firstTime":true,"itemFinished":false}}"""
        assertEquals(EventWords("Marked seen: S1 · E2", "Caminandes · the TV"), words(seen, ctx))
        assertEquals("unknown episode", "Marked seen", words(seen)?.title)
    }

    @Test
    fun theRemote() {
        assertEquals(
            EventWords("Sent: play", "your phone"),
            words("""{"id":20,"type":"command.sent","actor":{"type":"phone","phoneId":"ph-1","name":"Pixel 8"},"data":{"commandId":3,"type":"play","online":true}}"""),
        )
        assertEquals(
            EventWords("Sent: a message", "the TV was offline · admin page"),
            words("""{"id":21,"type":"command.sent","actor":{"type":"owner"},"data":{"commandId":4,"type":"message","online":false}}"""),
        )
        assertEquals(
            EventWords("Sent: stop", "a token: Home bot"),
            words("""{"id":22,"type":"command.sent","actor":{"type":"token","tokenId":"t1","name":"Home bot"},"data":{"commandId":5,"type":"stop","online":true}}"""),
        )
        fun result(type: String, result: String, reason: String?) =
            words("""{"id":23,"type":"command.result","actor":{"type":"tv"},"data":{"commandId":3,"type":"$type","result":"$result","reason":${reason?.let { "\"$it\"" }}}}""")
        assertNull("done is not shown", result("play", "done", null))
        assertEquals(EventWords("Couldn't play: no source could be played", null), result("play", "failed", "no_playable_source"))
        assertEquals("Didn't skip to the next: no next episode", result("next", "ignored", "no_episode")?.title)
        assertEquals("Didn't pause: nothing was playing", result("pause", "ignored", "not_in_player")?.title)
        assertEquals("Couldn't play", result("play", "failed", null)?.title)
    }

    @Test
    fun homeSettingsProblemsAndConnection() {
        val owner = """"actor":{"type":"owner"}"""
        assertEquals(
            EventWords("Home changed · +1 show, −1", "admin page"),
            words("""{"id":30,"type":"home.changed",$owner,"data":{"itemIds":["a","c"],"added":["c"],"removed":["b"]}}"""),
        )
        assertEquals("Home rearranged", words("""{"id":31,"type":"home.changed",$owner,"data":{"itemIds":["a"],"added":[],"removed":[]}}""")?.title)
        val cursor = """{"id":32,"type":"cursor.changed",$owner,"data":{"itemId":"cam","episodeId":"cam.e3"}}"""
        val catalog = EventContext(episodes = mapOf("cam.e3" to EpisodeRef("Caminandes", 1, 3, title = "Llamigos")))
        assertEquals(EventWords("Continues from S1 · E3", "Caminandes · admin page"), words(cursor, catalog))
        assertEquals(
            EventWords("Settings changed: name, audio, grid size", "your phone"),
            words("""{"id":33,"type":"device.updated","actor":{"type":"phone","phoneId":"ph-1"},
                "data":{"fields":["name","preferredAudioLanguage","homeColumns","homeRows"]}}"""),
        )
        val problem = words(
            """{"id":34,"type":"problem.recorded","actor":{"type":"server"},
            "data":{"problemId":5,"origin":"server","kind":"proxy","code":"upstream_403","itemId":"cam","episodeId":"cam.e3"}}""",
            catalog,
        )
        assertEquals(EventWords("Problem: ${problemTitle(res, "proxy", "upstream_403")}", "Caminandes · S1 · E3", problem = true), problem)
        assertEquals(
            EventWords("Home check: 2 fail, 1 warn", "your phone"),
            words("""{"id":35,"type":"check.finished","deviceId":"tv-1","actor":{"type":"phone","phoneId":"ph-1"},
                "data":{"runId":"r1","total":9,"failed":2,"warned":1,"state":"done"}}"""),
        )
        assertEquals(
            "all work",
            "Home check: all work",
            words("""{"id":36,"type":"check.finished","deviceId":"tv-1",$owner,"data":{"runId":"r2","total":9,"failed":0,"warned":0,"state":"done"}}""")?.title,
        )
        assertNull("a show's check", words("""{"id":37,"type":"check.finished",$owner,"data":{"runId":"r3","total":3,"failed":1,"warned":0,"state":"done"}}"""))

        val tv = """"actor":{"type":"tv","deviceId":"tv-1"}"""
        assertEquals(EventWords("Online", null), words("""{"id":40,"type":"device.online",$tv,"data":{}}"""))
        assertEquals(EventWords("Offline", null), words("""{"id":41,"type":"device.offline",$tv,"data":{}}"""))
        assertEquals(EventWords("Paired", "Salon"), words("""{"id":42,"type":"device.paired",$tv,"data":{"name":"Salon","replaced":false}}"""))
        assertEquals(
            EventWords("App 0.6.0 → 0.6.1", null),
            words("""{"id":43,"type":"device.app_version",$tv,"data":{"from":"0.6.0","to":"0.6.1","versionCode":601,"androidSdk":31,"capability":"silent"}}"""),
        )
        assertEquals("App 0.6.1", words("""{"id":44,"type":"device.app_version",$tv,"data":{"from":null,"to":"0.6.1"}}""")?.title)
        assertEquals(
            EventWords("Phone connected: Pixel 8", null),
            words("""{"id":45,"type":"phone.connected","actor":{"type":"phone","phoneId":"ph-2","name":"Pixel 8"},"data":{"phoneId":"ph-2","name":"Pixel 8","deviceId":"tv-1"}}"""),
        )
        assertEquals(
            EventWords("Catalog reloaded · +3 shows", "admin page"),
            words("""{"id":46,"type":"catalog.reloaded",$owner,"data":{"buildId":"b2","added":{"items":3,"episodes":12},"removed":{"items":0,"episodes":0}}}"""),
        )
        assertNull("other types", words("""{"id":47,"type":"playback.paused",$tv,"data":{"viewingId":7,"positionMs":1000}}"""))
        assertNull("unknown types", words("""{"id":48,"type":"something.new","data":{}}"""))
    }

    @Test
    fun daysAndTimes() {
        val zone = TimeZone.getTimeZone("Europe/Istanbul")
        val now = 1_793_099_100_000L // Tue 27 Oct 2026 14:05 in Istanbul
        assertEquals("14:05", clockTime(now, zone))
        assertEquals("Today", dayLabel(res, now - 60_000, now, zone))
        assertEquals("Yesterday", dayLabel(res, now - 24 * 3_600_000L, now, zone))
        assertEquals("Sun 25 Oct", dayLabel(res, now - 2 * 24 * 3_600_000L, now, zone))
    }

    @Test
    fun filtersFetchOnlyShownTypes() {
        for (f in ActivityFilter.entries) assertEquals(f.name, emptyList<String>(), f.types - ACTIVITY_TYPES.toSet())
        assertEquals(listOf("command.sent", "command.result"), ActivityFilter.Remote.types)
    }
}
