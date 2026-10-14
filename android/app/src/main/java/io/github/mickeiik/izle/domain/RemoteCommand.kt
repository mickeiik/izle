package io.github.mickeiik.izle.domain

import io.github.mickeiik.izle.data.api.ServerEvent

/** What an owner command asks the TV to do (`event: command` on the server's event stream). */
sealed interface RemoteCommand {
    data class Play(val itemId: String?, val episodeId: String) : RemoteCommand
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

    /** A type this TV does not know (a newer server) or an unusable payload: acknowledged, otherwise ignored. */
    data class Ignored(val type: String) : RemoteCommand

    companion object {
        const val MESSAGE_MAX_CHARS = 200
        const val MESSAGE_MIN_SEC = 3
        const val MESSAGE_MAX_SEC = 120
        /** The server applies the same default; only an older or odd payload lacks it. */
        const val MESSAGE_DEFAULT_SEC = 15

        fun of(command: ServerEvent.Command): RemoteCommand = when (command.type) {
            "play" -> command.episodeId?.let { Play(command.itemId, it) } ?: Ignored(command.type)
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
                if (text.isNullOrEmpty()) {
                    Ignored(command.type)
                } else {
                    Message(text, (command.durationSec ?: MESSAGE_DEFAULT_SEC).coerceIn(MESSAGE_MIN_SEC, MESSAGE_MAX_SEC))
                }
            }
            else -> Ignored(command.type)
        }
    }
}
