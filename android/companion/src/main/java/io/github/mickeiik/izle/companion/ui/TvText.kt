package io.github.mickeiik.izle.companion.ui

import io.github.mickeiik.izle.companion.sync.ListenPhase
import io.github.mickeiik.izle.companion.sync.ListenState
import io.github.mickeiik.izle.companion.sync.ListenSync
import io.github.mickeiik.izle.companion.tv.formatClock
import io.github.mickeiik.izle.data.api.NowPlaying
import io.github.mickeiik.izle.data.api.NowResponse
import java.math.BigDecimal
import kotlin.math.abs

// The TV page's texts and the pure parts of the Now tab (what plays, the listening bar); a command's words are in the
// tv package. Plain Kotlin: unit-tested without Android.

/** Whether the TV plays something now: online, and a starting, playing or paused report within 2 min (lib.js `isActive`). */
fun isPlayingNow(now: NowResponse): Boolean = now.online && ListenSync.isActive(now.nowPlaying, now.serverNowMs)

/** Where the TV is [elapsedMs] after the answer: from the anchor while it plays, else the reported position. */
fun tvPositionAfter(now: NowResponse, elapsedMs: Long): Long? =
    ListenSync.tvPositionAt(now.anchor, now.serverNowMs + elapsedMs)?.toLong() ?: now.nowPlaying?.positionMs

/** `12:04 / 30:10 · playing`; without a duration `12:04 · paused`. */
fun progressText(positionMs: Long, durationMs: Long?, state: String): String {
    val at = formatClock(positionMs)
    val of = durationMs?.let { " / ${formatClock(it)}" }.orEmpty()
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
