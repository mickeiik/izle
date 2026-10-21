package io.github.mickeiik.izle.domain

import io.github.mickeiik.izle.data.api.ServerEvent

/** What an owner command asks the TV to do (`event: command` on the server's event stream). */
sealed interface RemoteCommand {
    /**
     * Plays [episodeId] of [itemId] (the item may be absent) or, with [episodeId] null, the channel [itemId] at its
     * live edge. [positionMs]: where to start an episode, 0 = from the beginning; null = the saved position under the
     * resume rules (always for a channel).
     */
    data class Play(val itemId: String?, val episodeId: String?, val positionMs: Long? = null) : RemoteCommand {
        init {
            require(episodeId != null || itemId != null) { "an episode or a channel" }
        }

        val ref: PlayableRef get() = episodeId?.let(PlayableRef::Episode) ?: PlayableRef.Channel(itemId!!)
    }
    data object Stop : RemoteCommand
    data object Pause : RemoteCommand
    data object Resume : RemoteCommand
    data object Next : RemoteCommand
    data object Previous : RemoteCommand

    /** Exactly one is set: [deltaMs] relative to the current position, or [positionMs] absolute. */
    data class Seek(val deltaMs: Long?, val positionMs: Long?) : RemoteCommand {
        /** Where to seek from [currentMs], clamped to the episode ([durationMs] null = unknown, no upper bound). */
        fun targetMs(currentMs: Long, durationMs: Long?): Long {
            val wanted = positionMs ?: (currentMs + (deltaMs ?: 0))
            val upper = durationMs?.takeIf { it > 0 } ?: Long.MAX_VALUE
            return wanted.coerceIn(0, upper)
        }
    }

    /** A banner at the top of the screen for [durationSec] seconds. */
    data class Message(val text: String, val durationSec: Int) : RemoteCommand

    /**
     * Install the TV app version the server offers; [versionCode]: the one the owner saw (null: whatever is offered).
     * See [io.github.mickeiik.izle.update.UpdatePlan].
     */
    data class Update(val versionCode: Long?) : RemoteCommand

    /** A type this TV does not know (a newer server) or an unusable payload: acknowledged, otherwise ignored. */
    data class Ignored(val type: String) : RemoteCommand

    companion object {
        const val MESSAGE_MAX_CHARS = 200
        const val MESSAGE_MIN_SEC = 3
        const val MESSAGE_MAX_SEC = 120
        const val MESSAGE_DEFAULT_SEC = 15 // as on the server; only an older or odd payload lacks it

        fun of(command: ServerEvent.Command): RemoteCommand = when (command.type) {
            "play" -> when {
                // A negative position (never from a correct server) is no position: the saved one is used.
                command.episodeId != null -> Play(command.itemId, command.episodeId, command.positionMs?.takeIf { it >= 0 })
                // `episodeId: null`: the channel `itemId`, which has no position.
                command.itemId != null -> Play(command.itemId, episodeId = null)
                else -> Ignored(command.type)
            }
            "stop" -> Stop
            "pause" -> Pause
            "resume" -> Resume
            "next" -> Next
            "previous" -> Previous
            "seek" -> when {
                // The server sends one of the two; should both come, the absolute position wins.
                command.positionMs != null -> Seek(deltaMs = null, positionMs = command.positionMs)
                command.deltaMs != null -> Seek(deltaMs = command.deltaMs, positionMs = null)
                else -> Ignored(command.type)
            }
            "message" -> {
                val text = command.text?.trim()?.take(MESSAGE_MAX_CHARS)
                val seconds = (command.durationSec ?: MESSAGE_DEFAULT_SEC).coerceIn(MESSAGE_MIN_SEC, MESSAGE_MAX_SEC)
                if (text.isNullOrEmpty()) Ignored(command.type) else Message(text, seconds)
            }
            "update" -> Update(command.versionCode?.takeIf { it > 0 })
            else -> Ignored(command.type)
        }
    }
}
