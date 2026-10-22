package io.github.mickeiik.izle.data.api

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The DTOs against documents shaped like docs/spec/server-api-v1.md, including fields the TV does not know. */
class ModelsTest {
    @Test
    fun decodesTheHomeState() {
        val state = ApiJson.decodeFromString(TvState.serializer(), STATE)
        assertEquals(7L, state.version)
        assertEquals("tr", state.device.uiLanguage)
        assertNull(state.device.subtitlesLanguage)
        assertFalse("autoplay on start is off unless the server says so", state.device.autoplayOnStart)
        val autoplay = STATE.replace("\"newField\": 1", "\"autoplayOnStart\": true")
        assertTrue(ApiJson.decodeFromString(TvState.serializer(), autoplay).device.autoplayOnStart)
        assertEquals("20261010-247b34f7", state.catalog.buildId)
        val entry = state.home.single()
        assertEquals("caminandes", entry.item.id)
        assertEquals("/assets/f3f9.jpg", entry.item.posterUrl)
        assertEquals("caminandes.s01e02", entry.playNext?.episodeId)
        assertEquals(1, entry.playNext?.index)
        assertEquals("new", entry.playNext?.status)
        assertFalse(entry.item.isLive)
        assertEquals("a server without new-episode counts means none", 0, entry.newEpisodes)

        fun withCount(value: String) =
            ApiJson.decodeFromString(TvState.serializer(), STATE.replace("\"continue\": {", "\"newEpisodes\": $value, \"continue\": {")).home.single()
        val counted = withCount("3")
        assertEquals(3, counted.newEpisodes)
        assertEquals("caminandes.s01e02", counted.playNext?.episodeId)
        assertEquals(0, withCount("0").newEpisodes)
        assertEquals(0, withCount("null").newEpisodes)
    }

    @Test
    fun decodesTheHomeGridAndBackdrops() {
        // An older server: no grid size, no backdrop.
        val old = ApiJson.decodeFromString(TvState.serializer(), STATE)
        assertEquals(4, old.device.homeColumns)
        assertEquals(2, old.device.homeRows)
        assertNull(old.home.single().item.backdropUrl)

        val grid = STATE.replace("\"newField\": 1", "\"homeColumns\": 6, \"homeRows\": 1")
            .replace("\"posterUrl\": \"/assets/f3f9.jpg\"", "\"posterUrl\": \"/assets/f3f9.jpg\", \"backdropUrl\": \"/assets/b4c1.jpg\"")
        val state = ApiJson.decodeFromString(TvState.serializer(), grid)
        assertEquals(6, state.device.homeColumns)
        assertEquals(1, state.device.homeRows)
        assertEquals("/assets/b4c1.jpg", state.home.single().item.backdropUrl)
        assertEquals("/assets/f3f9.jpg", state.home.single().item.posterUrl)

        // Nulls fall back to the defaults.
        val nulls = STATE.replace("\"newField\": 1", "\"homeColumns\": null, \"homeRows\": null")
            .replace("\"posterUrl\": \"/assets/f3f9.jpg\"", "\"posterUrl\": \"/assets/f3f9.jpg\", \"backdropUrl\": null")
        val defaults = ApiJson.decodeFromString(TvState.serializer(), nulls)
        assertEquals(4, defaults.device.homeColumns)
        assertEquals(2, defaults.device.homeRows)
        assertNull(defaults.home.single().item.backdropUrl)

        // In item details and resolve answers too.
        val details = ApiJson.decodeFromString(ItemDetailsResponse.serializer(), ITEM.replace("\"posterUrl\": null", "\"posterUrl\": null, \"backdropUrl\": \"/assets/b.jpg\""))
        assertEquals("/assets/b.jpg", details.item.backdropUrl)
        val resolve = ApiJson.decodeFromString(ResolveResponse.serializer(), RESOLVE.replace("\"posterUrl\": null", "\"posterUrl\": null, \"backdropUrl\": \"/assets/b.jpg\""))
        assertEquals("/assets/b.jpg", resolve.item.backdropUrl)
    }

    @Test
    fun decodesHomeSectionsAndKeepsThemInTheCachedState() {
        // An older server (and a state cached before sections): none.
        assertEquals(emptyList<HomeSectionInfo>(), ApiJson.decodeFromString(TvState.serializer(), STATE).homeSections)

        val withSections = STATE.replace(
            "\"somethingNew\":",
            """"homeSections": [
                 {"id": "untitled", "title": null, "layout": "grid", "itemIds": ["caminandes"], "extra": 1},
                 {"id": "Hq7cP2xd", "title": "Channels", "layout": "row", "itemIds": ["news-24"]},
                 {"id": "Zt3kQ9wm", "title": "Later"}
               ],
               "somethingNew":""",
        )
        val state = ApiJson.decodeFromString(TvState.serializer(), withSections)
        assertEquals(
            listOf(
                HomeSectionInfo("untitled", null, "grid", listOf("caminandes")),
                HomeSectionInfo("Hq7cP2xd", "Channels", "row", listOf("news-24")),
                HomeSectionInfo("Zt3kQ9wm", "Later", "grid", emptyList()),
            ),
            state.homeSections,
        )
        // The offline cache is the state encoded with the same Json: the sections come back from it.
        val cached = ApiJson.decodeFromString(TvState.serializer(), ApiJson.encodeToString(TvState.serializer(), state))
        assertEquals(state, cached)
    }

    @Test
    fun decodesAResolveAnswer() {
        val r = ApiJson.decodeFromString(ResolveResponse.serializer(), RESOLVE)
        assertEquals("hls", r.media.kind)
        assertEquals(listOf("multi", "unknown"), r.alternatives)
        assertEquals("show.e2", r.next?.episodeId)
        assertEquals(90_000L, r.resume?.positionMs)
        assertEquals("tr", r.subtitleTracks.single().language)
        assertEquals(5, r.episode?.count)
        assertFalse(r.item.isLive)
        assertNull(r.expiresAt)
        val withExpiry = RESOLVE.replace("\"resume\":", "\"expiresAt\": \"2026-10-14T12:01:40.000Z\", \"resume\":")
        val expiring = ApiJson.decodeFromString(ResolveResponse.serializer(), withExpiry)
        assertEquals("2026-10-14T12:01:40.000Z", expiring.expiresAt)
        assertNull("the Date header is not part of the body", expiring.serverDateMs)
    }

    @Test
    fun decodesAResolveAnswerWithoutNextOrResume() {
        val r = ApiJson.decodeFromString(
            ResolveResponse.serializer(),
            """{"sessionId":"s","sourceId":"mp4","media":{"kind":"mp4","url":"https://cdn.example.net/a.mp4"},
               "subtitleTracks":[],"languages":{"audio":null,"subtitles":[]},"alternatives":[],"next":null,
               "item":{"id":"m","kind":"movie","title":"M","year":null,"posterUrl":null},
               "episode":{"id":"m.film","index":0,"count":1,"season":null,"number":null,"title":null,"label":null,"durationMs":null},
               "resume":null,"expiresAt":null}""",
        )
        assertNull(r.next)
        assertNull(r.resume)
        assertNull(r.expiresAt)
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
    fun commandResultsKeepTheirWireNames() {
        fun wire(result: CommandResult) = ApiJson.encodeToString(CommandResult.serializer(), result)
        assertEquals("""{"result":"done"}""", wire(CommandResult.Done))
        assertEquals("""{"result":"ignored","reason":"no_episode"}""", wire(CommandResult.ignored(CommandResult.NO_EPISODE)))
        assertEquals("""{"result":"failed","reason":"playback_error"}""", wire(CommandResult.failed(CommandResult.PLAYBACK_ERROR)))
        // Every reason the TV sends is one the server takes: [A-Za-z0-9_.:-]{1,64}.
        val reasons = listOf(
            CommandResult.NOT_IN_PLAYER, CommandResult.NOT_READY, CommandResult.NO_EPISODE, CommandResult.UNKNOWN_TYPE,
            CommandResult.NO_PLAYABLE_SOURCE, CommandResult.PLAYBACK_ERROR, CommandResult.SUPERSEDED, CommandResult.STOPPED,
            CommandResult.BUSY, CommandResult.EPISODES_UNAVAILABLE, CommandResult.LIVE, CommandResult.NO_CHANNEL,
        )
        reasons.forEach { assertTrue(it, Regex("[A-Za-z0-9_.:-]{1,64}").matches(it)) }
    }

    @Test
    fun progressReportsLeaveOutUnsetFieldsAndKeepTheirStatusNames() {
        // Resolve requests: see ApiClientTest.resolvePostsJson and PlaybackOriginTest.
        fun wire(report: ProgressReport) = ApiJson.encodeToString(ProgressReport.serializer(), report)
        assertEquals(
            """{"episodeId":"e","positionMs":1000,"status":"stopped"}""",
            wire(ProgressReport(null, episodeId = "e", positionMs = 1_000, status = ProgressStatus.Stopped)),
        )
        assertEquals(
            """{"sessionId":"s","episodeId":"e","positionMs":1000,"durationMs":2000,"status":"playing","playing":false,"ageMs":120}""",
            wire(ProgressReport.episode("s", "e", ProgressStatus.Playing, 1_000, 2_000, playing = false).copy(ageMs = 120)),
        )
        assertEquals("never a negative position", 0L, ProgressReport.episode("s", "e", ProgressStatus.Paused, -40, null, playing = false).positionMs)
        val names = ProgressStatus.entries.map { wire(ProgressReport(null, episodeId = "e", positionMs = 0, status = it)).substringAfter("\"status\":").substringBefore('}') }
        assertEquals(listOf("\"playing\"", "\"paused\"", "\"stopped\"", "\"finished\""), names)
        assertEquals(listOf(ProgressStatus.Stopped, ProgressStatus.Finished), ProgressStatus.entries.filter { it.isFinal })
    }

    @Test
    fun aChannelOnHomeHasNoContinue() {
        val state = ApiJson.decodeFromString(TvState.serializer(), STATE.replace("\"home\": [", "\"home\": [$CHANNEL_ENTRY,"))
        val (channel, show) = state.home
        assertTrue(channel.item.isLive)
        assertEquals("news-24", channel.item.id)
        assertEquals("News 24", channel.item.title)
        assertEquals("/assets/7b0e.png", channel.item.posterUrl)
        assertNull("OK plays it at its live edge", channel.playNext)
        assertEquals(0, channel.newEpisodes)
        assertFalse(show.item.isLive)
        assertEquals("caminandes.s01e02", show.playNext?.episodeId)
        // A missing `continue` reads the same.
        val bare = ApiJson.decodeFromString(HomeEntry.serializer(), """{"item":{"id":"n","kind":"live","title":"N"}}""")
        assertNull(bare.playNext)
        assertTrue(bare.item.isLive)
    }

    @Test
    fun decodesAChannelsResolveAnswer() {
        val r = ApiJson.decodeFromString(ResolveResponse.serializer(), CHANNEL_RESOLVE)
        assertTrue(r.item.isLive)
        assertNull(r.episode)
        assertNull(r.next)
        assertNull(r.resume)
        assertEquals("ts", r.media.kind)
        assertEquals("/p/Tk9uZQ/stream.ts", r.media.url)
        assertEquals(listOf("backup"), r.alternatives)
        assertEquals("2026-10-21T12:00:00.000Z", r.expiresAt)
    }

    @Test
    fun aChannelsProgressNamesItsItemWithoutAPosition() {
        fun wire(report: ProgressReport) = ApiJson.encodeToString(ProgressReport.serializer(), report)
        assertEquals(
            """{"sessionId":"s","itemId":"news-24","status":"playing","playing":true,"ageMs":0}""",
            wire(ProgressReport.channel("s", "news-24", ProgressStatus.Playing, playing = true).copy(ageMs = 0)),
        )
        assertEquals(
            "a stall",
            """{"itemId":"news-24","status":"playing","playing":false}""",
            wire(ProgressReport.channel(null, "news-24", ProgressStatus.Playing, playing = false)),
        )
        assertEquals("""{"itemId":"news-24","status":"stopped","playing":false}""", wire(ProgressReport.channel(null, "news-24", ProgressStatus.Stopped, playing = false)))
        // A channel is never paused and never finishes: only `playing` and `stopped` go out.
        assertEquals(ProgressStatus.Playing, ProgressReport.channel(null, "n", ProgressStatus.Paused, playing = false).status)
        assertEquals(ProgressStatus.Stopped, ProgressReport.channel(null, "n", ProgressStatus.Finished, playing = false).status)
    }

    @Test
    fun aProblemReportMayNameAChannel() {
        assertEquals(
            """{"kind":"playback","code":"gave_up","itemId":"news-24","sourceId":"main"}""",
            ApiJson.encodeToString(ProblemReport.serializer(), ProblemReport(kind = "playback", code = "gave_up", itemId = "news-24", sourceId = "main")),
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
        // A channel: `episodeId` null.
        assertEquals(
            ServerEvent.Command(14, "play", "news-24", null),
            ServerEvent.parse("command", """{"id":14,"type":"play","payload":{"itemId":"news-24","episodeId":null}}"""),
        )
        assertNull(ServerEvent.parse("hello", "{}"))
        assertNull(ServerEvent.parse("state", "not json"))
        // An envelope without an id cannot be acknowledged: ignored.
        assertNull(ServerEvent.parse("command", """{"type":"pause","payload":{}}"""))
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

        val CHANNEL_ENTRY = """
            {
              "item": { "id": "news-24", "kind": "live", "title": "News 24", "year": null, "posterUrl": "/assets/7b0e.png", "backdropUrl": null },
              "continue": null,
              "newEpisodes": 0
            }
        """.trimIndent()

        val CHANNEL_RESOLVE = """
            {
              "sessionId": "Q8mQ8mQ8mQ8mQ8mQ",
              "sourceId": "main",
              "media": { "kind": "ts", "url": "/p/Tk9uZQ/stream.ts" },
              "subtitleTracks": [],
              "languages": { "audio": ["tr"], "subtitles": [] },
              "alternatives": ["backup"],
              "next": null,
              "item": { "id": "news-24", "kind": "live", "title": "News 24", "year": null, "posterUrl": null, "backdropUrl": null },
              "episode": null,
              "resume": null,
              "expiresAt": "2026-10-21T12:00:00.000Z"
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
