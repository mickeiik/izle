package io.github.mickeiik.izle.domain

import io.github.mickeiik.izle.data.api.ResolveRequest
import io.github.mickeiik.izle.data.api.Trigger

/**
 * Who or what started a playback: the `trigger` (and `commandId`) of every resolve made for it, through fallbacks,
 * expiry refreshes and Try again; a new episode or channel (auto-next, CH+/CH−, the menu) gets its own.
 */
data class PlaybackOrigin(val trigger: Trigger, val commandId: Long? = null) {
    fun request(ref: PlayableRef, sourceId: String? = null, exclude: List<String>? = null): ResolveRequest =
        ResolveRequest(ref.episodeId, ref.itemId, sourceId, exclude, trigger, commandId)

    companion object {
        val Viewer = PlaybackOrigin(Trigger.Viewer)
        val Autoplay = PlaybackOrigin(Trigger.Autoplay)
        val Next = PlaybackOrigin(Trigger.Next)

        /** The owner's `play`, `next` or `previous`. */
        fun command(id: Long) = PlaybackOrigin(Trigger.Command, id)
    }
}
