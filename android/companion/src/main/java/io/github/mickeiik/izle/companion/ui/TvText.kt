package io.github.mickeiik.izle.companion.ui

import io.github.mickeiik.izle.companion.sync.ListenPhase
import io.github.mickeiik.izle.companion.sync.ListenState
import io.github.mickeiik.izle.companion.sync.ListenSync
import io.github.mickeiik.izle.data.api.CommandInfo
import io.github.mickeiik.izle.data.api.NowPlaying
import io.github.mickeiik.izle.data.api.NowResponse
import java.math.BigDecimal
import kotlin.math.abs

// The TV page's texts and the pure parts of the Now tab (what plays, the remote's results, the listening bar). Plain
// Kotlin: unit-tested without Android.

/** A command the TV gets only if it connects within the next 2 minutes. */
fun offlineText(tvName: String): String = "$tvName is offline. It gets this if it connects in the next 2 minutes."

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
        "not_ready" -> "$tvName isn't ready (it shows its pairing screen)."
        else -> {
            val why = command.reason?.let { " (${REASONS[it] ?: it.replace('_', ' ')})" }.orEmpty()
            if (result == "failed") "$tvName couldn't do that$why." else "$tvName didn't do that$why."
        }
    }
}

/** lib.js's REASONS, for the reasons without a sentence of their own. */
private val REASONS = mapOf(
    "unknown_type" to "it does not know this command",
    "no_playable_source" to "no source could be played",
    "playback_error" to "the player failed",
    "superseded" to "something else started first",
    "stopped" to "the player was left first",
    "busy" to "it was busy",
    "episodes_unavailable" to "the episode list could not be fetched",
)

/** Whether the TV plays something now: online, and a starting, playing or paused report within 2 min (lib.js `isActive`). */
fun isPlayingNow(now: NowResponse): Boolean = now.online && ListenSync.isActive(now.nowPlaying, now.serverNowMs)

/** Where the TV is [elapsedMs] after the answer: from the anchor while it plays, else the reported position. */
fun tvPositionAfter(now: NowResponse, elapsedMs: Long): Long? =
    ListenSync.tvPositionAt(now.anchor, now.serverNowMs + elapsedMs)?.toLong() ?: now.nowPlaying?.positionMs

/** `12:04 / 30:10 · playing`; without a duration `12:04 · paused`. */
fun progressText(positionMs: Long, durationMs: Long?, state: String): String {
    val at = ListenSync.formatClock(positionMs.toDouble())
    val of = durationMs?.let { " / ${ListenSync.formatClock(it.toDouble())}" }.orEmpty()
    return "$at$of · $state"
}

/** The progress bar's fraction, null without a duration. */
fun progressFraction(positionMs: Long, durationMs: Long?): Float? =
    durationMs?.takeIf { it > 0 }?.let { (positionMs.toFloat() / it).coerceIn(0f, 1f) }

/** "Sintel · Pilot": the title, then the episode's when it differs. */
fun playingTitle(n: NowPlaying): String =
    listOfNotNull(n.itemTitle ?: n.itemId, n.episodeTitle?.takeIf { it != n.itemTitle }).joinToString(" · ")

/** The Listen along screen's one line: "Sintel · Pilot on Salon. Plug in earphones." */
fun listenContext(n: NowPlaying?, tvName: String): String =
    if (n == null) "Plug in earphones." else "${playingTitle(n)} on $tvName. Plug in earphones."

/** Why the Now tab offers no Listen along: a channel, or nothing playing; null when it can (or before the first answer). */
fun nothingToListenText(now: NowResponse?, tvName: String): String? = when {
    now == null -> null
    !isPlayingNow(now) -> nothingToListenText(null as NowPlaying?, tvName)
    else -> nothingToListenText(now.nowPlaying, tvName)
}

/** The same for what plays ([n] null: nothing); null for an episode. */
fun nothingToListenText(n: NowPlaying?, tvName: String): String? = when {
    n?.isLive == true -> "Nothing to listen to: $tvName is on a channel."
    n?.episodeId == null -> "Nothing to listen to: $tvName isn't playing anything."
    else -> null
}

/** The listening bar's word for the session: in sync, catching up, waiting, paused, starting. */
fun listeningWord(state: ListenState): String = when {
    state.phase == ListenPhase.Starting || state.syncLabel == null -> "starting"
    state.syncLabel == ListenSync.SyncState.Synced.label -> "in sync"
    state.syncLabel == ListenSync.SyncState.Waiting.label -> "waiting"
    state.syncLabel == ListenSync.SyncState.Paused.label -> "paused"
    state.syncLabel in CATCHING_UP -> "catching up"
    else -> state.syncLabel
}

private val CATCHING_UP = setOf(
    ListenSync.SyncState.CatchingUp.label, ListenSync.SyncState.HoldingBack.label, ListenSync.SyncState.Seeking.label,
)

/** The folded timing section's summary: `offset −1.25 s · speed 1.0427`. */
fun timingSummary(timing: LinkTimingInput?): String {
    if (timing == null) return "offset or speed is not a valid number"
    val seconds = BigDecimal(abs(timing.offsetMs)).movePointLeft(3).stripTrailingZeros().toPlainString()
    val sign = if (timing.offsetMs < 0) "−" else "+"
    val rate = BigDecimal(timing.rate.toString()).stripTrailingZeros().toPlainString()
    return "offset $sign$seconds s · speed $rate"
}

/** A mark tapped while not listening. */
const val LISTEN_FIRST = "Listen first, then mark."

/** The two-tap mark's half so far: "TV marked at 12:04.2, now tap when you hear it"; null with none. */
fun markPendingText(tvMarkMs: Double?, phoneMarkMs: Double?): String? = when {
    tvMarkMs != null -> "TV marked at ${ListenSync.formatPosition(tvMarkMs)}, now tap when you hear it"
    phoneMarkMs != null -> "Phone marked at ${ListenSync.formatPosition(phoneMarkMs)}, now tap when you see it on the TV"
    else -> null
}
