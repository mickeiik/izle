package io.github.mickeiik.izle.companion.home

import android.content.res.Resources
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext
import io.github.mickeiik.izle.companion.R
import io.github.mickeiik.izle.data.api.AdminEpisode
import io.github.mickeiik.izle.data.api.AdminHomeEntry
import io.github.mickeiik.izle.data.api.CatalogHit
import io.github.mickeiik.izle.data.api.CheckSummary
import io.github.mickeiik.izle.data.api.ContinueInfo

// The Home tab's words, as the admin page says them (server/admin/lib.js: continueText, checkSummaryText).

/** Below this, OK on the TV starts the episode over rather than continuing it (the admin page's RESUME_MIN_MS). */
const val RESUME_MIN_MS = 30_000L

/** `1:02:03` or `12:34`. */
fun formatClock(ms: Long): String {
    val total = (ms.coerceAtLeast(0)) / 1000
    val h = total / 3600
    val m = (total % 3600) / 60
    val s = total % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%d:%02d".format(m, s)
}

/** The catalog label, else "S2 · E5", else "Episode 5", plus the title (the admin page's episodeName). */
fun episodeName(season: Int?, number: Int?, label: String?, title: String?): String {
    val head = label ?: number?.let { n -> if (season != null) "S$season · E$n" else "Episode $n" }
    return when {
        head == null -> title ?: "Episode"
        title != null -> "$head — $title"
        else -> head
    }
}

fun episodeName(e: AdminEpisode): String = episodeName(e.season, e.number, e.label, e.title)

/** A check's verdict as the chip says it. */
enum class Verdict { Works, Warns, Fails, Stale, NotChecked }

fun verdictOf(check: CheckSummary?): Verdict = when {
    check == null || check.verdict == null -> Verdict.NotChecked
    check.stale -> Verdict.Stale
    check.verdict == "fail" -> Verdict.Fails
    check.verdict == "warn" -> Verdict.Warns
    else -> Verdict.Works
}

/** Whether a show is on the list but not on the TV, and why ([R.string.home_hidden_missing] or …_unplayable); null: shown. */
fun hiddenReason(entry: AdminHomeEntry?): Int? = when {
    entry == null || entry.missing -> R.string.home_hidden_missing
    !entry.playable -> R.string.home_hidden_unplayable
    else -> null
}

/** What OK does on the TV for [entry]: "Live", "Film", "S1 · E5 · continues at 12:04 of 30:10", …. */
fun okPlaysText(res: Resources, entry: AdminHomeEntry): String {
    if (entry.kind == "live") return res.getString(R.string.home_ok_live)
    val c: ContinueInfo = entry.continueAt ?: return res.getString(R.string.home_ok_nothing)
    val film = entry.kind == "movie"
    val which = if (film) res.getString(R.string.home_ok_film) else episodeName(c.season, c.number, c.label, null)
    return when {
        c.status == "watching" && c.positionMs >= RESUME_MIN_MS ->
            c.durationMs?.takeIf { it > 0 }
                ?.let { res.getString(R.string.home_ok_continues_of, which, formatClock(c.positionMs), formatClock(it)) }
                ?: res.getString(R.string.home_ok_continues, which, formatClock(c.positionMs))
        c.status == "watching" -> res.getString(R.string.home_ok_restarts, which)
        c.status == "finished" -> res.getString(R.string.home_ok_watched, which)
        film -> which
        else -> res.getString(R.string.home_ok_new, which)
    }
}

/** The line under a show's title: what OK plays, and "N new" for a series with new episodes. */
fun showLine(res: Resources, entry: AdminHomeEntry): String {
    val ok = okPlaysText(res, entry)
    return if (entry.newEpisodes > 0) "$ok · ${res.getQuantityString(R.plurals.home_new_episodes, entry.newEpisodes, entry.newEpisodes)}" else ok
}

fun verdictText(res: Resources, verdict: Verdict): String = res.getString(
    when (verdict) {
        Verdict.Works -> R.string.home_check_ok
        Verdict.Warns -> R.string.home_check_warn
        Verdict.Fails -> R.string.home_check_fail
        Verdict.Stale -> R.string.home_check_stale
        Verdict.NotChecked -> R.string.home_check_none
    },
)

/** "Film · 2003", "Series · 40 episodes", "Channel". */
fun hitLine(res: Resources, hit: CatalogHit): String = when (hit.kind) {
    "live" -> res.getString(R.string.home_hit_channel)
    "series" -> (hit.playableCount ?: hit.episodeCount ?: 0).let { res.getQuantityString(R.plurals.home_hit_series, it, it) }
    else -> hit.year?.let { res.getString(R.string.home_hit_film_year, it) } ?: res.getString(R.string.home_hit_film)
}

fun sectionTitle(res: Resources, title: String?): String = title ?: res.getString(R.string.home_no_title)

fun errorText(res: Resources, error: HomeError): String = when (error) {
    HomeError.Unreachable -> res.getString(R.string.home_unreachable)
    is HomeError.Server -> when (error.code) {
        "too_many_items" -> res.getString(R.string.home_error_too_many_items)
        "too_many_sections" -> res.getString(R.string.home_sections_full, 20)
        "duplicate_item" -> res.getString(R.string.home_error_duplicate_item)
        "unknown_item" -> res.getString(R.string.home_error_unknown_item)
        "not_playable" -> res.getString(R.string.home_error_not_playable)
        "unknown_episode" -> res.getString(R.string.home_error_unknown_episode)
        "not_allowed" -> res.getString(R.string.home_error_not_allowed)
        "unknown_device" -> res.getString(R.string.home_error_unknown_device)
        in HomeViewModel.CHANGED_ELSEWHERE -> res.getString(R.string.home_changed_elsewhere)
        else -> res.getString(R.string.home_error_other, error.code)
    }
}

/** A notice in words; [tvName] names the TV. */
fun noticeText(res: Resources, notice: HomeNotice, tvName: String): String = when (notice) {
    HomeNotice.ChangedElsewhere -> res.getString(R.string.home_changed_elsewhere)
    is HomeNotice.Failed -> errorText(res, notice.error)
    is HomeNotice.Added ->
        notice.sectionTitle?.let { res.getString(R.string.home_added_to, notice.title, it) } ?: res.getString(R.string.home_added_home, notice.title)
    is HomeNotice.Continues -> res.getString(R.string.home_continues, tvName, notice.title, notice.episode)
    is HomeNotice.PlayQueued -> res.getString(R.string.home_offline, tvName)
    is HomeNotice.Playing -> res.getString(R.string.home_playing, tvName, notice.title)
    is HomeNotice.PlaySent -> res.getString(R.string.home_play_sent, tvName)
    is HomeNotice.NotPlayed ->
        if (notice.reason == "not_ready") res.getString(R.string.home_not_ready, tvName)
        else res.getString(R.string.home_not_played, tvName, notice.title)
}

@Composable
internal fun resources(): Resources = LocalContext.current.resources
