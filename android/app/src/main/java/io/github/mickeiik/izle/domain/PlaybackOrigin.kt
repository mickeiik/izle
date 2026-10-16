package io.github.mickeiik.izle.domain

import io.github.mickeiik.izle.data.api.ResolveRequest
import io.github.mickeiik.izle.data.api.Trigger

/**
 * Who or what started a playback: the `trigger` (and, for an owner command, its `commandId`) of every resolve made for
 * it. A playback keeps its origin through source fallbacks, expiry refreshes and Try again, which continue it; a new
 * episode (auto-next, CH+/CH−, the menu) gets its own.
 */
data class PlaybackOrigin(val trigger: Trigger, val commandId: Long? = null) {
    fun request(episodeId: String, sourceId: String? = null, exclude: List<String>? = null): ResolveRequest =
        ResolveRequest(episodeId, sourceId, exclude, trigger, commandId)

    companion object {
        val Viewer = PlaybackOrigin(Trigger.Viewer)
        val Autoplay = PlaybackOrigin(Trigger.Autoplay)
        val Next = PlaybackOrigin(Trigger.Next)

        /** The owner's `play`, `next` or `previous` command [id]. */
        fun command(id: Long) = PlaybackOrigin(Trigger.Command, id)
    }
}
