package io.github.mickeiik.izle.companion.tv

import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.data.api.CommandInfo
import io.github.mickeiik.izle.data.api.orNullOnFailure
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonPrimitive

// Sending a TV a command and saying what came of it: the remote, a message and Home's Play now all go through here.
// Plain Kotlin: unit-tested without Android.

/** What came of a command. */
sealed interface CommandOutcome {
    /** The TV is offline: it gets the command if it connects within 2 minutes (no result is read). */
    data object Queued : CommandOutcome

    /** The TV reported on it ([CommandInfo.result] set). */
    data class Answered(val command: CommandInfo) : CommandOutcome

    /** No report within [COMMAND_WAIT_MS]. */
    data object NoAnswer : CommandOutcome
}

/** A command's result is read every 500 ms for up to 5 s. */
const val COMMAND_POLL_MS = 500L
const val COMMAND_WAIT_MS = 5_000L

/**
 * Sends [tvId] the command [type] with [fields], then reads its result until the TV reports or the wait is over.
 * Sending fails as the API does ([java.io.IOException], [io.github.mickeiik.izle.data.api.ApiException]); a read that
 * fails is retried at the next poll.
 */
suspend fun ApiClient.sendAndAwait(tvId: String, type: String, fields: Map<String, JsonPrimitive> = emptyMap()): CommandOutcome {
    val sent = sendCommand(tvId, type, fields)
    if (!sent.online) return CommandOutcome.Queued
    repeat((COMMAND_WAIT_MS / COMMAND_POLL_MS).toInt()) {
        delay(COMMAND_POLL_MS)
        val c = orNullOnFailure { command(tvId, sent.id) }
        if (c?.result != null) return CommandOutcome.Answered(c)
    }
    return CommandOutcome.NoAnswer
}

/** A command the TV gets only if it connects within the next 2 minutes. */
fun offlineText(tvName: String): String = "$tvName is offline. It gets this if it connects in the next 2 minutes."

/** A command the TV did not report on within the wait: it is online by the 60 s rule but not answering. */
fun noAnswerText(tvName: String): String = "$tvName hasn't answered. It may be off or asleep."

/** The TV shows its pairing screen. */
fun notReadyText(tvName: String): String = "$tvName isn't ready (it shows its pairing screen)."

/** What a remote press or a message came to, for a snackbar; null when nothing is worth saying (done). */
fun commandOutcomeText(tvName: String, outcome: CommandOutcome): String? = when (outcome) {
    CommandOutcome.Queued -> offlineText(tvName)
    CommandOutcome.NoAnswer -> noAnswerText(tvName)
    is CommandOutcome.Answered -> commandResultText(tvName, outcome.command)
}

/**
 * What a command's result is worth saying, for a snackbar; null when nothing is (done, or no result yet). A message
 * shown says so. Reasons as lib.js's `commandResultText` has them, in a sentence about [tvName].
 */
fun commandResultText(tvName: String, command: CommandInfo): String? {
    val result = command.result ?: return null
    if (result == "done") return if (command.type == "message") "Shown on $tvName" else null
    val back = command.type == "previous"
    return when (command.reason) {
        "not_in_player" -> "Nothing is playing on $tvName."
        "no_episode" -> if (back) "No previous episode." else "No next episode."
        "no_channel" -> if (back) "No channel before this one on Home." else "No channel after this one on Home."
        "live" -> "A channel can't be paused or skipped through."
        "not_ready" -> notReadyText(tvName)
        else -> {
            val why = command.reason?.let { " (${REASONS[it] ?: it.replace('_', ' ')})" }.orEmpty()
            if (result == "failed") "$tvName couldn't do that$why." else "$tvName didn't do that$why."
        }
    }
}

/** What Home's Play now came to: "Sintel is playing on Salon.", "Salon could not play Sintel.", "Sent to Salon.", …. */
fun playResultText(tvName: String, title: String, outcome: CommandOutcome): String = when (outcome) {
    CommandOutcome.Queued -> offlineText(tvName)
    CommandOutcome.NoAnswer -> "Sent to $tvName."
    is CommandOutcome.Answered -> when {
        outcome.command.result == "done" -> "$title is playing on $tvName."
        outcome.command.reason == "not_ready" -> notReadyText(tvName)
        else -> "$tvName could not play $title."
    }
}

/**
 * Why a command was not done, as a phrase ("no source could be played"), for a line that names the command itself
 * (the Activity log's "Couldn't play: …"); null without a reason.
 */
fun commandReasonWords(type: String, reason: String?): String? {
    val back = type == "previous"
    return when (reason) {
        null -> null
        "not_in_player" -> "nothing was playing"
        "no_episode" -> if (back) "no previous episode" else "no next episode"
        "no_channel" -> if (back) "no channel before this one on Home" else "no channel after this one on Home"
        "live" -> "a channel can't be paused or skipped through"
        "not_ready" -> "it showed its pairing screen"
        else -> REASONS[reason] ?: reason.replace('_', ' ')
    }
}

/** lib.js's REASONS, for the reasons without a sentence of their own. */
private val REASONS = mapOf(
    "unknown_type" to "it does not know this command",
    "no_playable_source" to "no source could be played",
    "playback_error" to "the player failed",
    "superseded" to "something else started first",
    "stopped" to "the player was left first",
    "background" to "another app was in front",
    "busy" to "it was busy",
    "episodes_unavailable" to "the episode list could not be fetched",
)
