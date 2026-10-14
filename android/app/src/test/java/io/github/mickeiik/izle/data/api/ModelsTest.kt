package io.github.mickeiik.izle.data.api

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The DTOs against documents shaped like docs/spec/server-api-v1.md, including fields the TV does not know. */
class ModelsTest {
    @Test
    fun autoplayOnStartIsOffUnlessTheServerSaysSo() {
        assertFalse(ApiJson.decodeFromString(TvState.serializer(), STATE).device.autoplayOnStart)
        val on = ApiJson.decodeFromString(TvState.serializer(), STATE.replace("\"newField\": 1", "\"autoplayOnStart\": true"))
        assertTrue(on.device.autoplayOnStart)
    }

    @Test
    fun resolveKeepsTheExpiryHint() {
        assertNull(ApiJson.decodeFromString(ResolveResponse.serializer(), RESOLVE).expiresAt)
        val r = ApiJson.decodeFromString(ResolveResponse.serializer(), RESOLVE.replace("\"resume\":", "\"expiresAt\": \"2026-10-14T12:01:40.000Z\", \"resume\":"))
        assertEquals("2026-10-14T12:01:40.000Z", r.expiresAt)
        assertNull("the Date header is not part of the body", r.serverDateMs)
        val explicitNull = ApiJson.decodeFromString(ResolveResponse.serializer(), RESOLVE.replace("\"resume\":", "\"expiresAt\": null, \"resume\":"))
        assertNull(explicitNull.expiresAt)
    }

    @Test
    fun problemReportsLeaveOutUnsetFields() {
        assertEquals(
            """{"kind":"network","code":"server_unreachable","ageMs":420000,"detail":"unreachable for 7 min 0 s","appVersion":"0.2.0"}""",
            ApiJson.encodeToString(
                ProblemReport.serializer(),
                ProblemReport(kind = "network", code = "server_unreachable", ageMs = 420_000, detail = "unreachable for 7 min 0 s", appVersion = "0.2.0"),
            ),
        )
    }

    @Test
    fun parsesTheNewCommandPayloads() {
        assertEquals(ServerEvent.Command(30, "seek", deltaMs = 30_000), ServerEvent.parse("command", """{"id":30,"type":"seek","payload":{"deltaMs":30000}}"""))
        assertEquals(ServerEvent.Command(31, "seek", positionMs = 0), ServerEvent.parse("command", """{"id":31,"type":"seek","payload":{"positionMs":0}}"""))
        assertEquals(
            ServerEvent.Command(32, "message", text = "Dinner is ready", durationSec = 20),
            ServerEvent.parse("command", """{"id":32,"type":"message","payload":{"text":"Dinner is ready","durationSec":20}}"""),
        )
        assertEquals(ServerEvent.Command(33, "pause"), ServerEvent.parse("command", """{"id":33,"type":"pause","payload":{}}"""))
        // An envelope without an id cannot be acknowledged: ignored like before.
        assertNull(ServerEvent.parse("command", """{"type":"pause","payload":{}}"""))
    }

    @Test
    fun decodesTheHomeState() {
        val state = ApiJson.decodeFromString(TvState.serializer(), STATE)
        assertEquals(7L, state.version)
        assertEquals("tr", state.device.uiLanguage)
        assertNull(state.device.subtitlesLanguage)
        assertEquals("20261010-247b34f7", state.catalog.buildId)
        val entry = state.home.single()
        assertEquals("caminandes", entry.item.id)
        assertEquals("/assets/f3f9.jpg", entry.item.posterUrl)
        assertEquals("caminandes.s01e02", entry.playNext.episodeId)
        assertEquals(1, entry.playNext.index)
        assertEquals("new", entry.playNext.status)
    }

    @Test
    fun decodesAResolveAnswer() {
        val r = ApiJson.decodeFromString(ResolveResponse.serializer(), RESOLVE)
        assertEquals("hls", r.media.kind)
        assertEquals(listOf("multi", "unknown"), r.alternatives)
        assertEquals("show.e2", r.next?.episodeId)
        assertEquals(90_000L, r.resume?.positionMs)
        assertEquals("tr", r.subtitleTracks.single().language)
        assertEquals(listOf("tr"), r.languages.audio)
        assertEquals(5, r.episode.count)
    }

    @Test
    fun decodesAResolveAnswerWithoutNextOrResume() {
        val r = ApiJson.decodeFromString(
            ResolveResponse.serializer(),
            """{"sessionId":"s","sourceId":"mp4","media":{"kind":"mp4","url":"https://cdn.example.net/a.mp4"},
               "subtitleTracks":[],"languages":{"audio":null,"subtitles":[]},"alternatives":[],"next":null,
               "item":{"id":"m","kind":"movie","title":"M","year":null,"posterUrl":null},
               "episode":{"id":"m.film","index":0,"count":1,"season":null,"number":null,"title":null,"label":null,"durationMs":null},
               "resume":null}""",
        )
        assertNull(r.next)
        assertNull(r.resume)
        assertNull(r.languages.audio)
    }

    @Test
    fun decodesTheEpisodeList() {
        val d = ApiJson.decodeFromString(ItemDetailsResponse.serializer(), ITEM)
        assertEquals("show.e2", d.cursorEpisodeId)
        assertEquals("finished", d.episodes[0].progress?.status)
        assertEquals(false, d.episodes[1].playbackAllowed)
        assertNull(d.episodes[1].progress)
    }

    @Test
    fun requestsLeaveOutUnsetFields() {
        assertEquals("""{"episodeId":"caminandes.s01e01"}""", ApiJson.encodeToString(ResolveRequest.serializer(), ResolveRequest("caminandes.s01e01")))
        assertEquals(
            """{"episodeId":"e","exclude":["hls"]}""",
            ApiJson.encodeToString(ResolveRequest.serializer(), ResolveRequest("e", exclude = listOf("hls"))),
        )
        assertEquals(
            """{"episodeId":"e","positionMs":1000,"status":"stopped"}""",
            ApiJson.encodeToString(ProgressReport.serializer(), ProgressReport(null, "e", 1_000, null, "stopped")),
        )
        assertEquals(
            """{"sessionId":"s","episodeId":"e","positionMs":1000,"durationMs":2000,"status":"playing","playing":false,"ageMs":120}""",
            ApiJson.encodeToString(ProgressReport.serializer(), ProgressReport("s", "e", 1_000, 2_000, "playing", playing = false, ageMs = 120)),
        )
    }

    @Test
    fun parsesEvents() {
        assertEquals(ServerEvent.State(8), ServerEvent.parse("state", """{"version":8}"""))
        assertEquals(
            ServerEvent.Command(12, "play", "show", "show.e1"),
            ServerEvent.parse("command", """{"id":12,"type":"play","payload":{"itemId":"show","episodeId":"show.e1"}}"""),
        )
        assertEquals(ServerEvent.Command(13, "stop", null, null), ServerEvent.parse("command", """{"id":13,"type":"stop","payload":{}}"""))
        assertNull(ServerEvent.parse("hello", "{}"))
        assertNull(ServerEvent.parse("state", "not json"))
    }

    private companion object {
        val STATE = """
            {
              "version": 7,
              "device": { "id": "aZ3aZ3aZ3aZ3", "name": "Living room", "uiLanguage": "tr", "preferredAudioLanguage": "tr", "subtitlesLanguage": null, "newField": 1 },
              "catalog": { "id": "izle-sample", "buildId": "20261010-247b34f7", "name": "izle sample catalog" },
              "home": [
                {
                  "item": { "id": "caminandes", "kind": "series", "title": "Caminandes", "year": 2013, "posterUrl": "/assets/f3f9.jpg" },
                  "continue": {
                    "episodeId": "caminandes.s01e02", "season": 1, "number": 2, "title": "Gran Dillama", "label": null,
                    "index": 1, "count": 3, "positionMs": 0, "durationMs": 146050, "status": "new"
                  }
                }
              ],
              "somethingNew": { "a": [1, 2] }
            }
        """.trimIndent()

        val RESOLVE = """
            {
              "sessionId": "Q8mQ8mQ8mQ8mQ8mQ",
              "sourceId": "tr-dub",
              "media": { "kind": "hls", "url": "https://cdn.example.net/master.m3u8" },
              "subtitleTracks": [ { "url": "https://cdn.example.net/tr.vtt", "language": "tr", "format": "vtt", "label": null } ],
              "languages": { "audio": ["tr"], "subtitles": [] },
              "alternatives": ["multi", "unknown"],
              "next": { "episodeId": "show.e2", "season": 1, "number": 2, "title": "Season finale", "label": null },
              "item": { "id": "show", "kind": "series", "title": "Show", "year": 2001, "posterUrl": null },
              "episode": { "id": "show.e1", "index": 0, "count": 5, "season": 1, "number": 1, "title": "Pilot", "label": null, "durationMs": 1200000 },
              "resume": { "positionMs": 90000, "durationMs": 1200000 }
            }
        """.trimIndent()

        val ITEM = """
            {
              "item": { "id": "show", "kind": "series", "title": "Show", "year": 2001, "posterUrl": null, "originalTitle": null, "synopsis": null, "genres": [] },
              "cursorEpisodeId": "show.e2",
              "episodes": [
                { "id": "show.e1", "index": 0, "season": 1, "number": 1, "title": "Pilot", "label": null, "durationMs": 1200000,
                  "playbackAllowed": true,
                  "progress": { "positionMs": 1190000, "durationMs": 1200000, "status": "finished", "updatedAt": "2026-10-10T10:00:00.000Z" },
                  "sources": [ { "id": "tr-dub", "label": null, "languages": { "audio": ["tr"], "subtitles": [] } } ] },
                { "id": "show.e2", "index": 1, "season": 1, "number": 2, "title": null, "label": null, "durationMs": null,
                  "playbackAllowed": false, "progress": null, "sources": [] }
              ]
            }
        """.trimIndent()
    }
}
