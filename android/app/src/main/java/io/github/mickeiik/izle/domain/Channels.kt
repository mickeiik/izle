package io.github.mickeiik.izle.domain

import io.github.mickeiik.izle.data.api.HomeEntry

/**
 * What one playback plays: an episode by its id or a channel by its item id. The server keeps the two id spaces apart
 * (`episodeId` / `itemId` in resolve, progress and problem reports), and so does the TV.
 */
sealed interface PlayableRef {
    data class Episode(val episodeId: String) : PlayableRef
    data class Channel(val itemId: String) : PlayableRef

    companion object {
        /** What OK on [entry]'s tile plays; null for a show without `continue` (never from a correct server). */
        fun of(entry: HomeEntry): PlayableRef? =
            if (entry.item.isLive) Channel(entry.item.id) else entry.playNext?.episodeId?.let(::Episode)
    }
}

val PlayableRef.episodeId: String? get() = (this as? PlayableRef.Episode)?.episodeId

/** A channel's item id; null for an episode, which its id names alone. */
val PlayableRef.itemId: String? get() = (this as? PlayableRef.Channel)?.itemId

/** CH+/CH− while a channel plays: the channels on this TV's Home, in Home order (the server has no next channel). */
object ChannelZap {
    /** Null at either end (no wrap-around), or when the playing channel is not on Home (started by the owner). */
    fun neighbour(home: List<HomeEntry>, currentItemId: String, direction: Int): HomeEntry? {
        val at = home.indexOfFirst { it.item.id == currentItemId && it.item.isLive }
        if (at < 0 || direction == 0) return null
        val candidates = if (direction > 0) (at + 1 until home.size) else (at - 1 downTo 0)
        return candidates.asSequence().map { home[it] }.firstOrNull { it.item.isLive }
    }
}
