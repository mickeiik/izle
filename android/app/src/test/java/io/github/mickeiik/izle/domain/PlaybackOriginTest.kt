package io.github.mickeiik.izle.domain

import io.github.mickeiik.izle.data.api.ApiJson
import io.github.mickeiik.izle.data.api.ResolveRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/** Every resolve says who or what started the playback (`trigger`, `commandId`) for the server's viewing history. */
class PlaybackOriginTest {
    private val episode = PlayableRef.Episode("e")

    private fun wire(request: ResolveRequest) = ApiJson.encodeToString(ResolveRequest.serializer(), request)

    @Test
    fun eachOriginHasItsTriggerAndFallbacksAndRefreshesRepeatIt() {
        assertEquals("""{"episodeId":"e","trigger":"viewer"}""", wire(PlaybackOrigin.Viewer.request(episode)))
        assertEquals("""{"episodeId":"e","trigger":"autoplay"}""", wire(PlaybackOrigin.Autoplay.request(episode)))
        assertEquals("""{"episodeId":"e","trigger":"next"}""", wire(PlaybackOrigin.Next.request(episode)))
        assertEquals("""{"episodeId":"e","trigger":"command","commandId":12}""", wire(PlaybackOrigin.command(12).request(episode)))
        val origin = PlaybackOrigin.command(7)
        val fallback = origin.request(episode, exclude = listOf("a", "b"))
        assertEquals("""{"episodeId":"e","exclude":["a","b"],"trigger":"command","commandId":7}""", wire(fallback))
        val pinned = origin.request(episode, sourceId = "a")
        assertEquals("""{"episodeId":"e","sourceId":"a","trigger":"command","commandId":7}""", wire(pinned))
        // Without origin: what an older TV sent; the server records trigger `unknown`.
        assertEquals("""{"episodeId":"e"}""", wire(ResolveRequest("e")))
    }

    @Test
    fun aChannelIsResolvedByItsItemId() {
        val channel = PlayableRef.Channel("news-24")
        assertEquals("""{"itemId":"news-24","trigger":"viewer"}""", wire(PlaybackOrigin.Viewer.request(channel)))
        assertEquals("""{"itemId":"news-24","trigger":"next"}""", wire(PlaybackOrigin.Next.request(channel)))
        // Its stream again, the same source first (it ended, or its proxy session expired), then the others.
        assertEquals(
            """{"itemId":"news-24","sourceId":"main","trigger":"command","commandId":3}""",
            wire(PlaybackOrigin.command(3).request(channel, sourceId = "main")),
        )
        assertEquals("""{"itemId":"news-24","exclude":["main"],"trigger":"autoplay"}""", wire(PlaybackOrigin.Autoplay.request(channel, exclude = listOf("main"))))
        // Never both, never neither.
        assertThrows(IllegalArgumentException::class.java) { ResolveRequest(episodeId = "e", itemId = "news-24") }
        assertThrows(IllegalArgumentException::class.java) { ResolveRequest() }
    }
}
