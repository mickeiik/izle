package io.github.mickeiik.izle.domain

import io.github.mickeiik.izle.data.api.HomeEntry
import io.github.mickeiik.izle.data.api.TvState

/**
 * Autoplay on start (per TV, set by the owner, off by default): when the TV comes on and lands on Home, the show
 * watched last starts after a countdown unless the viewer does something.
 */
object AutoplayPlan {
    const val COUNTDOWN_SEC = 10

    /** The tile to offer: the show played last on this TV if it is still on Home, else the first tile. */
    fun target(home: List<HomeEntry>, lastPlayedItemId: String?): HomeEntry? =
        home.firstOrNull { it.item.id == lastPlayedItemId } ?: home.firstOrNull()

    /** What to offer for a state freshly fetched from the server, or null when the owner has autoplay off. */
    fun offer(state: TvState, lastPlayedItemId: String?): HomeEntry? =
        if (state.device.autoplayOnStart) target(state.home, lastPlayedItemId) else null
}
