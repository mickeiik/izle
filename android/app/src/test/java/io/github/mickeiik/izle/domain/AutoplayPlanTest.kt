package io.github.mickeiik.izle.domain

import io.github.mickeiik.izle.data.api.CatalogInfo
import io.github.mickeiik.izle.data.api.ContinueInfo
import io.github.mickeiik.izle.data.api.DeviceInfo
import io.github.mickeiik.izle.data.api.HomeEntry
import io.github.mickeiik.izle.data.api.ItemCard
import io.github.mickeiik.izle.data.api.TvState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AutoplayPlanTest {
    private fun entry(id: String) = HomeEntry(ItemCard(id, "series", id), ContinueInfo(episodeId = "$id.e1"))

    private val home = listOf(entry("caminandes"), entry("sintel"), entry("tears"))

    private fun state(autoplay: Boolean, home: List<HomeEntry> = this.home) =
        TvState(1, DeviceInfo("abcdefabcdef", "TV", autoplayOnStart = autoplay), CatalogInfo("c", "b", "n"), home)

    @Test
    fun offersTheShowPlayedLastWhenItIsStillOnHome() {
        assertEquals("sintel", AutoplayPlan.target(home, "sintel")?.item?.id)
        assertEquals("tears", AutoplayPlan.target(home, "tears")?.item?.id)
    }

    @Test
    fun elseTheFirstTile() {
        assertEquals("caminandes", AutoplayPlan.target(home, null)?.item?.id)
        assertEquals("caminandes", AutoplayPlan.target(home, "removed-by-the-owner")?.item?.id)
        assertNull(AutoplayPlan.target(emptyList(), "sintel"))
    }

    @Test
    fun onlyWhenTheOwnerTurnedItOnAndHomeIsNotEmpty() {
        assertNull(AutoplayPlan.offer(state(autoplay = false), "sintel"))
        assertEquals("sintel", AutoplayPlan.offer(state(autoplay = true), "sintel")?.item?.id)
        assertNull(AutoplayPlan.offer(state(autoplay = true, home = emptyList()), "sintel"))
    }
}
