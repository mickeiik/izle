package io.github.mickeiik.izle.companion.tv

import android.content.res.Resources
import android.text.format.DateUtils
import io.github.mickeiik.izle.companion.R
import io.github.mickeiik.izle.data.api.AdminEpisode

// Words the TV page's tabs and the lists share: a clock, an episode's name, how long ago.

/** `1:02:03` or `12:34` (lib.js `formatClock`); a negative time reads `0:00`. */
fun formatClock(ms: Long): String {
    val total = ms.coerceAtLeast(0) / 1000
    val h = total / 3600
    val m = (total % 3600) / 60
    val s = total % 60
    fun pad(n: Long) = n.toString().padStart(2, '0')
    return if (h > 0) "$h:${pad(m)}:${pad(s)}" else "$m:${pad(s)}"
}

/** The catalog label, else "S2 · E5", else "Episode 5", plus the title (the admin page's `episodeName`). */
fun episodeName(season: Int?, number: Int?, label: String?, title: String?): String {
    val head = label ?: number?.let { n -> if (season != null) "S$season · E$n" else "Episode $n" }
    return when {
        head == null -> title ?: "Episode"
        title != null -> "$head — $title"
        else -> head
    }
}

fun episodeName(e: AdminEpisode): String = episodeName(e.season, e.number, e.label, e.title)

/** "5 minutes ago", or "just now" under a minute (where the system would say "0 minutes ago"). */
fun timeAgo(res: Resources, atMs: Long, nowMs: Long = System.currentTimeMillis()): String =
    if (nowMs - atMs < DateUtils.MINUTE_IN_MILLIS) res.getString(R.string.just_now)
    else DateUtils.getRelativeTimeSpanString(atMs, nowMs, DateUtils.MINUTE_IN_MILLIS).toString()
