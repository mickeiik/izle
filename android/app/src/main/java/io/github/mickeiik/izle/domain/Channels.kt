package io.github.mickeiik.izle.domain

import io.github.mickeiik.izle.data.api.HomeEntry

/**
 * What one playback plays: an episode, named by its episode id, or a channel, named by its item id. The server keeps
 * the two id spaces apart (`episodeId` / `itemId` in resolve, progress and problem reports), and so does the TV.
 */
sealed interface PlayableRef {
    data class Episode(val episodeId: String) : PlayableRef

    /** A channel (`kind: "live"`): no position, played at its live edge. */
    data class Channel(val itemId: String) : PlayableRef

    companion object {
        /**
         * What OK on [entry]'s tile plays: the channel, or the show's `continue` episode; null for a show without one
         * (never from a correct server).
         */
        fun of(entry: HomeEntry): PlayableRef? =
            if (entry.item.isLive) Channel(entry.item.id) else entry.playNext?.episodeId?.let(::Episode)
    }
}

val PlayableRef.episodeId: String? get() = (this as? PlayableRef.Episode)?.episodeId

/** A channel's item id; null for an episode, which its id names alone. */
val PlayableRef.itemId: String? get() = (this as? PlayableRef.Channel)?.itemId

/**
 * CH+/CH− (and the remote's |◀◀ ▶▶| keys, and the owner's next/previous commands) while a channel plays: the channels
 * on this TV's Home, in Home order. The server has no notion of a next channel; this is the TV's own.
 */
object ChannelZap {
    /**
     * The channel after ([direction] > 0) or before ([direction] < 0) [currentItemId] among [home]'s channels (the shows
     * in between skipped); null at either end (no wrap-around), without a direction, or when the playing channel is
     * not on Home (started by the owner).
     */
    fun neighbour(home: List<HomeEntry>, currentItemId: String, direction: Int): HomeEntry? {
        val at = home.indexOfFirst { it.item.id == currentItemId && it.item.isLive }
        if (at < 0 || direction == 0) return null
        val candidates = if (direction > 0) (at + 1 until home.size) else (at - 1 downTo 0)
        return candidates.asSequence().map { home[it] }.firstOrNull { it.item.isLive }
    }
}
