package io.github.mickeiik.izle.domain

import io.github.mickeiik.izle.data.api.ApiJson
import io.github.mickeiik.izle.data.api.ResolveRequest
import org.junit.Assert.assertEquals
import org.junit.Test

/** Every resolve says who or what started the playback (`trigger`, `commandId`) for the server's viewing history. */
class PlaybackOriginTest {
    private fun wire(request: ResolveRequest) = ApiJson.encodeToString(ResolveRequest.serializer(), request)

    @Test
    fun eachOriginHasItsTrigger() {
        assertEquals("""{"episodeId":"e","trigger":"viewer"}""", wire(PlaybackOrigin.Viewer.request("e")))
        assertEquals("""{"episodeId":"e","trigger":"autoplay"}""", wire(PlaybackOrigin.Autoplay.request("e")))
        assertEquals("""{"episodeId":"e","trigger":"next"}""", wire(PlaybackOrigin.Next.request("e")))
        assertEquals("""{"episodeId":"e","trigger":"command","commandId":12}""", wire(PlaybackOrigin.command(12).request("e")))
    }

    @Test
    fun fallbacksAndRefreshesRepeatTheOrigin() {
        val origin = PlaybackOrigin.command(7)
        assertEquals(
            """{"episodeId":"e","exclude":["a","b"],"trigger":"command","commandId":7}""",
            wire(origin.request("e", exclude = listOf("a", "b"))),
        )
        assertEquals("""{"episodeId":"e","sourceId":"a","trigger":"command","commandId":7}""", wire(origin.request("e", sourceId = "a")))
    }

    @Test
    fun aRequestWithoutOriginIsTheOldOne() {
        // What an older TV sent; the server records trigger `unknown`.
        assertEquals("""{"episodeId":"e"}""", wire(ResolveRequest("e")))
    }
}
