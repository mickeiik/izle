package io.github.mickeiik.izle.domain

import io.github.mickeiik.izle.data.api.ContinueInfo
import io.github.mickeiik.izle.data.api.HomeEntry
import io.github.mickeiik.izle.data.api.ItemCard
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ChannelsTest {
    private fun channel(id: String) = HomeEntry(ItemCard(id, "live", id), playNext = null)

    private fun show(id: String, kind: String = "series") = HomeEntry(ItemCard(id, kind, id), ContinueInfo("$id.e2"))

    /** Home as the owner ordered it: channels and shows mixed. */
    private val home = listOf(channel("news"), show("caminandes"), channel("sport"), show("sintel", "movie"), channel("music"))

    private fun zap(from: String, direction: Int) = ChannelZap.neighbour(home, from, direction)?.item?.id

    @Test
    fun zappingFollowsHomeOrderSkippingShowsWithoutWrappingAround() {
        assertEquals("the show in between is skipped", "sport", zap("news", 1))
        assertEquals("music", zap("sport", 1))
        assertNull("the last channel", zap("music", 1))
        assertEquals("sport", zap("music", -1))
        assertEquals("news", zap("sport", -1))
        assertNull("the first channel", zap("news", -1))
    }

    @Test
    fun aChannelNotOnHomeOrNoDirectionHasNoNeighbour() {
        assertNull("started by the owner, not on Home", zap("radio", 1))
        assertNull("a show's id is no channel", zap("caminandes", 1))
        assertNull(zap("news", 0))
        assertNull(ChannelZap.neighbour(emptyList(), "news", 1))
        assertNull("Home without other channels", ChannelZap.neighbour(listOf(show("a"), channel("news"), show("b")), "news", 1))
    }

    @Test
    fun okOnATilePlaysTheChannelOrTheShowsContinueEpisode() {
        assertEquals(PlayableRef.Channel("news"), PlayableRef.of(channel("news")))
        assertEquals(PlayableRef.Episode("caminandes.e2"), PlayableRef.of(show("caminandes")))
        assertNull("a show without `continue`", PlayableRef.of(HomeEntry(ItemCard("x", "series", "X"), playNext = null)))
        // The kind decides, whatever else the entry carries.
        assertEquals(PlayableRef.Channel("odd"), PlayableRef.of(HomeEntry(ItemCard("odd", "live", "Odd"), ContinueInfo("odd.e1"))))
    }
}
