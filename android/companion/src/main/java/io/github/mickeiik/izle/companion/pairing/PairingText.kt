package io.github.mickeiik.izle.companion.pairing

import android.content.res.Resources
import io.github.mickeiik.izle.companion.R
import io.github.mickeiik.izle.companion.tv.UNREACHABLE
import io.github.mickeiik.izle.companion.tv.apiErrorText
import io.github.mickeiik.izle.companion.tv.timeAgo
import io.github.mickeiik.izle.data.api.AdminDevice
import io.github.mickeiik.izle.data.api.ApiException
import io.github.mickeiik.izle.data.api.StatusDevice
import io.github.mickeiik.izle.domain.IsoTime

// The TV list's words: each TV's state, a waiting code, why an approval failed.

/** "483 920": a pairing code in two groups of three. */
fun formatCode(code: String): String = if (code.length == 6) "${code.take(3)} ${code.drop(3)}" else code

/** Whole minutes until [expiresAtMs] at [nowMs], rounded up; 0 once it expired. */
fun minutesLeft(expiresAtMs: Long, nowMs: Long): Int = if (expiresAtMs <= nowMs) 0 else ((expiresAtMs - nowMs + MINUTE_MS - 1) / MINUTE_MS).toInt()

/** The name the server gives a TV approved without one: "TV", else the first free "TV n" (pairing.ts `defaultName`). */
fun defaultTvName(taken: Collection<String>): String {
    val names = taken.map { it.trim().lowercase() }.toSet()
    if ("tv" !in names) return "TV"
    var n = 2
    while ("tv $n" in names) n++
    return "TV $n"
}

/** A TV's row: "Online · playing Caminandes", "Offline · seen 2 hours ago", "Not seen yet". */
fun tvStateText(res: Resources, device: AdminDevice, status: StatusDevice?, nowMs: Long = System.currentTimeMillis()): String {
    if (status?.online ?: device.online) {
        val playing = status?.nowPlaying?.let { it.itemTitle ?: it.itemId }
        return if (playing != null) res.getString(R.string.pairing_online_playing, playing) else res.getString(R.string.tv_online)
    }
    val seen = (status?.lastSeenAt ?: device.lastSeenAt)?.let(IsoTime::parseEpochMs) ?: return res.getString(R.string.tv_never_seen)
    return res.getString(R.string.tv_offline_seen, timeAgo(res, seen, nowMs))
}

/** Why an approval or a clear failed, in words. */
fun pairingErrorText(res: Resources, e: Exception): String = when {
    e !is ApiException -> UNREACHABLE
    e.code == "unknown_code" -> res.getString(R.string.pairing_unknown_code)
    e.code == "already_approved" -> res.getString(R.string.pairing_already_approved)
    else -> apiErrorText(e.code) ?: res.getString(R.string.pairing_refused, e.code)
}

private const val MINUTE_MS = 60_000L
