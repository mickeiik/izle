package io.github.mickeiik.izle.data.api

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The DTOs against documents shaped like docs/spec/server-api-v1.md, including fields the TV does not know. */
class ModelsTest {
    private fun state(json: String = STATE) = ApiJson.decodeFromString(TvState.serializer(), json)

    private fun resolve(json: String = RESOLVE) = ApiJson.decodeFromString(ResolveResponse.serializer(), json)

    private fun wire(report: ProgressReport) = ApiJson.encodeToString(ProgressReport.serializer(), report)

    private fun String.withDevice(fields: String) = replace("\"newField\": 1", fields)

    private fun String.withItem(fields: String) = replace(POSTER, "$POSTER, $fields")

    @Test
    fun decodesTheHomeState() {
        val state = state()
        assertEquals(7L, state.version)
        assertEquals("tr", state.device.uiLanguage)
        assertNull(state.device.subtitlesLanguage)
        assertFalse("autoplay on start is off unless the server says so", state.device.autoplayOnStart)
        assertTrue(state(STATE.withDevice("\"autoplayOnStart\": true")).device.autoplayOnStart)
        assertEquals("20261010-247b34f7", state.catalog.buildId)
        val entry = state.home.single()
        assertEquals("caminandes", entry.item.id)
        assertEquals("/assets/f3f9.jpg", entry.item.posterUrl)
        assertEquals("caminandes.s01e02", entry.playNext?.episodeId)
        assertEquals(1, entry.playNext?.index)
        assertEquals("new", entry.playNext?.status)
        assertFalse(entry.item.isLive)
        assertEquals("a server without new-episode counts means none", 0, entry.newEpisodes)
        for ((value, count) in listOf("3" to 3, "0" to 0, "null" to 0)) {
            val counted = state(STATE.replace("\"continue\": {", "\"newEpisodes\": $value, \"continue\": {")).home.single()
            assertEquals(value, count, counted.newEpisodes)
        }
    }

    @Test
    fun decodesTheHomeGridAndBackdrops() {
        // An older server (no grid size, no backdrop), or nulls: the defaults.
        val nulls = STATE.withDevice("\"homeColumns\": null, \"homeRows\": null").withItem("\"backdropUrl\": null")
        for (json in listOf(STATE, nulls)) {
            val defaults = state(json)
            assertEquals(4 to 2, defaults.device.homeColumns to defaults.device.homeRows)
            assertNull(defaults.home.single().item.backdropUrl)
        }
        val state = state(STATE.withDevice("\"homeColumns\": 6, \"homeRows\": 1").withItem("\"backdropUrl\": \"/assets/b4c1.jpg\""))
        assertEquals(6 to 1, state.device.homeColumns to state.device.homeRows)
        assertEquals("/assets/b4c1.jpg", state.home.single().item.backdropUrl)
        assertEquals("/assets/f3f9.jpg", state.home.single().item.posterUrl)

        // In item details and resolve answers too.
        val backdrop = "\"posterUrl\": null, \"backdropUrl\": \"/assets/b.jpg\""
        val details = ApiJson.decodeFromString(ItemDetailsResponse.serializer(), ITEM.replace("\"posterUrl\": null", backdrop))
        assertEquals("/assets/b.jpg", details.item.backdropUrl)
        assertEquals("/assets/b.jpg", resolve(RESOLVE.replace("\"posterUrl\": null", backdrop)).item.backdropUrl)
    }

    @Test
    fun decodesHomeSectionsAndKeepsThemInTheCachedState() {
        // An older server (and a state cached before sections): none.
        assertEquals(emptyList<HomeSectionInfo>(), state().homeSections)

        val state = state(
            STATE.replace(
                "\"somethingNew\":",
                """"homeSections": [
                     {"id": "untitled", "title": null, "layout": "grid", "itemIds": ["caminandes"], "extra": 1},
                     {"id": "Hq7cP2xd", "title": "Channels", "layout": "row", "itemIds": ["news-24"]},
                     {"id": "Zt3kQ9wm", "title": "Later"}
                   ],
                   "somethingNew":""",
            ),
        )
        assertEquals(
            listOf(
                HomeSectionInfo("untitled", null, "grid", listOf("caminandes")),
                HomeSectionInfo("Hq7cP2xd", "Channels", "row", listOf("news-24")),
                HomeSectionInfo("Zt3kQ9wm", "Later", "grid", emptyList()),
            ),
            state.homeSections,
        )
        // The offline cache is the state encoded with the same Json: the sections come back from it.
        assertEquals(state, state(ApiJson.encodeToString(TvState.serializer(), state)))
    }

    @Test
    fun decodesAResolveAnswer() {
        val r = resolve()
        assertEquals("hls", r.media.kind)
        assertEquals(listOf("multi", "unknown"), r.alternatives)
        assertEquals("show.e2", r.next?.episodeId)
        assertEquals(90_000L, r.resume?.positionMs)
        assertEquals("tr", r.subtitleTracks.single().language)
        assertEquals(5, r.episode?.count)
        assertFalse(r.item.isLive)
        assertNull(r.expiresAt)
        val expiring = resolve(RESOLVE.replace("\"resume\":", "\"expiresAt\": \"2026-10-14T12:01:40.000Z\", \"resume\":"))
        assertEquals("2026-10-14T12:01:40.000Z", expiring.expiresAt)
        assertNull("the Date header is not part of the body", expiring.serverDateMs)
    }

    @Test
    fun decodesAChannelsResolveAnswer() {
        val r = resolve(CHANNEL_RESOLVE)
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
    fun decodesTheEpisodeList() {
        val d = ApiJson.decodeFromString(ItemDetailsResponse.serializer(), ITEM)
        assertEquals("show.e2", d.cursorEpisodeId)
        assertEquals("finished", d.episodes[0].progress?.status)
        assertEquals(false, d.episodes[1].playbackAllowed)
        assertNull(d.episodes[1].progress)
    }

    @Test
    fun aChannelOnHomeHasNoContinue() {
        val channel = state(STATE.replace("\"home\": [", "\"home\": [$CHANNEL_ENTRY,")).home.first()
        assertTrue(channel.item.isLive)
        assertEquals("news-24", channel.item.id)
        assertEquals("News 24", channel.item.title)
        assertEquals("/assets/7b0e.png", channel.item.posterUrl)
        assertNull("OK plays it at its live edge", channel.playNext)
        assertEquals(0, channel.newEpisodes)
        // A missing `continue` reads the same.
        val bare = ApiJson.decodeFromString(HomeEntry.serializer(), """{"item":{"id":"n","kind":"live","title":"N"}}""")
        assertNull(bare.playNext)
        assertTrue(bare.item.isLive)
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
    fun aChannelsProgressNamesItsItemWithoutAPosition() {
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
        // A problem report may name a channel too.
        assertEquals(
            """{"kind":"playback","code":"gave_up","itemId":"news-24","sourceId":"main"}""",
            ApiJson.encodeToString(ProblemReport.serializer(), ProblemReport(kind = "playback", code = "gave_up", itemId = "news-24", sourceId = "main")),
        )
    }

    @Test
    fun decodesTheDeviceList() {
        val devices = ApiJson.decodeFromString(
            DevicesResponse.serializer(),
            """{"devices": [
                 {"id": "tv1", "name": "Living room", "status": "active", "online": true, "createdAt": "c", "lastSeenAt": "2026-10-26T10:00:00.000Z",
                  "settings": {}, "effective": {}, "problems": {"recent": 0, "lastAt": null}, "app": null, "homeCount": 3},
                 {"id": "tv2", "name": "Kitchen", "status": "pending", "online": null, "lastSeenAt": null}
               ], "future": 1}""",
        ).devices
        assertEquals(AdminDevice("tv1", "Living room", "active", online = true, lastSeenAt = "2026-10-26T10:00:00.000Z", effective = DeviceEffective(), problems = DeviceProblems(), homeCount = 3), devices[0])
        assertEquals(AdminDevice("tv2", "Kitchen", "pending", online = false, lastSeenAt = null), devices[1])
    }

    @Test
    fun decodesNowWithAndWithoutAnAnchor() {
        val now = ApiJson.decodeFromString(NowResponse.serializer(), NOW)
        assertTrue(now.online)
        assertEquals(1_791_979_200_000L, now.serverNowMs)
        assertEquals(12L, now.seq)
        val playing = now.nowPlaying!!
        assertEquals("show.e2", playing.episodeId)
        assertEquals("dub", playing.sourceId)
        assertEquals(61_000L, playing.positionMs)
        assertEquals(1_500_000L, playing.durationMs)
        assertEquals("playing", playing.state)
        assertEquals(true, playing.playing)
        assertFalse(playing.isLive)
        assertEquals(Anchor(positionMs = 61_000, atMs = 1_791_979_199_400, playing = true, rate = 1.0), now.anchor)

        // A channel: no anchor, no position; and before the TV played anything, nothing at all.
        val channel = ApiJson.decodeFromString(
            NowResponse.serializer(),
            """{"online": false, "serverNowMs": 5, "seq": 3, "anchor": null, "extra": [],
                "nowPlaying": {"itemId": "news-24", "itemKind": "live", "episodeId": null, "sourceId": "main", "itemTitle": "News 24",
                               "episodeTitle": null, "positionMs": null, "durationMs": null, "state": "starting", "updatedAt": "u", "playing": null}}""",
        )
        assertNull(channel.anchor)
        assertTrue(channel.nowPlaying!!.isLive)
        assertNull(channel.nowPlaying!!.positionMs)
        assertNull(channel.nowPlaying!!.playing)
        val idle = ApiJson.decodeFromString(NowResponse.serializer(), """{"online": true, "serverNowMs": 5, "seq": 0, "nowPlaying": null, "anchor": null}""")
        assertNull(idle.nowPlaying)
        assertEquals(0L, idle.seq)
    }

    @Test
    fun decodesTheCompanionCandidates() {
        val c = ApiJson.decodeFromString(CompanionResponse.serializer(), COMPANION)
        assertEquals("Caminandes", c.nowPlaying?.itemTitle)
        assertEquals(1_500_000L, c.nowPlaying?.durationMs)
        assertNull("not in this route", c.nowPlaying?.positionMs)
        val (dub, adapter, dash, pasted) = c.candidates
        assertEquals(
            CompanionCandidate(
                "dub", "direct", "hls", "German dub", CandidateLanguages(listOf("de"), emptyList()), current = false, supported = true,
                link = LinkTiming(1_500, 1.0427, "de", "2026-10-14T11:00:00.000Z"),
            ),
            dub,
        )
        assertEquals("adapter", adapter.type)
        assertNull(adapter.kind)
        assertTrue(adapter.current)
        assertEquals("defaults, nothing stored", LinkTiming(), adapter.link)
        assertFalse(dash.supported)
        assertEquals("dash", dash.reason)
        assertEquals(
            CompanionCandidate("pasted", "pasted", null, null, CandidateLanguages(null, null), link = LinkTiming(-250, 1.0, null, "t")),
            pasted,
        )
        // A channel: no candidates.
        val channel = ApiJson.decodeFromString(
            CompanionResponse.serializer(),
            """{"nowPlaying": {"itemId": "news-24", "itemKind": "live", "state": "playing"}, "candidates": []}""",
        )
        assertTrue(channel.nowPlaying!!.isLive)
        assertEquals(emptyList<CompanionCandidate>(), channel.candidates)
    }

    @Test
    fun companionRequestsOmitNulls() {
        assertEquals(
            """{"episodeId":"show.e2","sourceId":"dub"}""",
            ApiJson.encodeToString(CompanionResolveRequest.serializer(), CompanionResolveRequest("show.e2", "dub")),
        )
        assertEquals(
            """{"offsetMs":1500,"rate":1.0427,"language":"de"}""",
            ApiJson.encodeToString(LinkUpdate.serializer(), LinkUpdate(1_500, 1.0427, "de")),
        )
        val resolved = ApiJson.decodeFromString(
            CompanionResolveResponse.serializer(),
            """{"episodeId": "show.e2", "sourceId": "dub", "media": {"kind": "hls", "url": "/p/tok/index.m3u8"},
                "languages": {"audio": null, "subtitles": null}, "expiresAt": null,
                "link": {"offsetMs": 0, "rate": 1, "language": null, "updatedAt": null}, "more": true}""",
        )
        assertEquals(CandidateLanguages(), resolved.languages)
        assertEquals(LinkTiming(), resolved.link)
        assertNull(resolved.serverDateMs)
    }

    @Test
    fun parsesEvents() {
        assertEquals(ServerEvent.State(8), ServerEvent.parse("state", """{"version":8}"""))
        // The owner removed the stored APK: the TV checks `/tv/app` again like for any other app event.
        assertEquals(ServerEvent.App(0), ServerEvent.parse("app", """{"versionCode":0}"""))
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
        const val POSTER = "\"posterUrl\": \"/assets/f3f9.jpg\""

        val NOW = """
            {
              "online": true, "serverNowMs": 1791979200000, "seq": 12,
              "nowPlaying": {
                "itemId": "caminandes", "itemKind": "series", "episodeId": "show.e2", "sourceId": "dub", "itemTitle": "Caminandes",
                "episodeTitle": "Gran Dillama", "positionMs": 61000, "durationMs": 1500000, "state": "playing",
                "updatedAt": "2026-10-14T11:59:59.400Z", "playing": true, "viewingId": "v1"
              },
              "anchor": { "positionMs": 61000, "atMs": 1791979199400, "playing": true, "rate": 1, "next": 0 }
            }
        """.trimIndent()

        val COMPANION = """
            {
              "nowPlaying": { "itemId": "caminandes", "itemKind": "series", "episodeId": "show.e2", "sourceId": "multi", "itemTitle": "Caminandes",
                              "episodeTitle": "Gran Dillama", "durationMs": 1500000, "state": "playing" },
              "candidates": [
                { "sourceId": "dub", "type": "direct", "kind": "hls", "label": "German dub", "languages": { "audio": ["de"], "subtitles": [] },
                  "current": false, "supported": true, "reason": null,
                  "link": { "offsetMs": 1500, "rate": 1.0427, "language": "de", "updatedAt": "2026-10-14T11:00:00.000Z" } },
                { "sourceId": "multi", "type": "adapter", "kind": null, "label": null, "languages": { "audio": null, "subtitles": null },
                  "current": true, "supported": true, "reason": null,
                  "link": { "offsetMs": 0, "rate": 1, "language": null, "updatedAt": null } },
                { "sourceId": "hd", "type": "direct", "kind": "dash", "label": "HD", "languages": { "audio": ["en"], "subtitles": null },
                  "current": false, "supported": false, "reason": "dash", "link": { "offsetMs": 0, "rate": 1, "language": null, "updatedAt": null } },
                { "sourceId": "pasted", "type": "pasted", "kind": null, "label": null, "languages": { "audio": null, "subtitles": null },
                  "current": false, "supported": true, "reason": null, "unknown": "x",
                  "link": { "offsetMs": -250, "rate": 1, "language": null, "updatedAt": "t" } }
              ]
            }
        """.trimIndent()

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
            { "item": { "id": "news-24", "kind": "live", "title": "News 24", "year": null, "posterUrl": "/assets/7b0e.png" },
              "continue": null, "newEpisodes": 0 }
        """.trimIndent()

        /** Explicit nulls for what a channel has not: no episode, no next, no resume. */
        val CHANNEL_RESOLVE = """
            { "sessionId": "Q8mQ8mQ8mQ8mQ8mQ", "sourceId": "main", "media": { "kind": "ts", "url": "/p/Tk9uZQ/stream.ts" },
              "subtitleTracks": [], "languages": { "audio": ["tr"], "subtitles": [] }, "alternatives": ["backup"], "next": null,
              "item": { "id": "news-24", "kind": "live", "title": "News 24", "year": null, "posterUrl": null, "backdropUrl": null },
              "episode": null, "resume": null, "expiresAt": "2026-10-21T12:00:00.000Z" }
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
