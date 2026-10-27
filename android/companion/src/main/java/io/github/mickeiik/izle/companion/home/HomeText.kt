package io.github.mickeiik.izle.companion.home

import android.content.res.Resources
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext
import io.github.mickeiik.izle.companion.R
import io.github.mickeiik.izle.companion.tv.UNREACHABLE
import io.github.mickeiik.izle.companion.tv.apiErrorText
import io.github.mickeiik.izle.companion.tv.episodeName
import io.github.mickeiik.izle.companion.tv.formatClock
import io.github.mickeiik.izle.companion.tv.playResultText
import io.github.mickeiik.izle.data.api.AdminHomeEntry
import io.github.mickeiik.izle.data.api.CatalogHit
import io.github.mickeiik.izle.data.api.ContinueInfo

// The Home tab's words, as the admin page says them (server/admin/lib.js: continueText, checkSummaryText).

/** Below this, OK on the TV starts the episode over rather than continuing it (the admin page's RESUME_MIN_MS). */
const val RESUME_MIN_MS = 30_000L

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
    val which = if (film) res.getString(R.string.home_film) else episodeName(c.season, c.number, c.label, null)
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

/** "Film · 2003", "Series · 40 episodes", "Channel". */
fun hitLine(res: Resources, hit: CatalogHit): String = when (hit.kind) {
    "live" -> res.getString(R.string.home_hit_channel)
    "series" -> (hit.playableCount ?: hit.episodeCount ?: 0).let { res.getQuantityString(R.plurals.home_hit_series, it, it) }
    else -> hit.year?.let { res.getString(R.string.home_hit_film_year, it) } ?: res.getString(R.string.home_film)
}

fun sectionTitle(res: Resources, title: String?): String = title ?: res.getString(R.string.home_no_title)

fun errorText(res: Resources, error: HomeError): String = when (error) {
    HomeError.Unreachable -> UNREACHABLE
    is HomeError.Server -> when (error.code) {
        "too_many_items" -> res.getString(R.string.home_error_too_many_items)
        "too_many_sections" -> res.getString(R.string.home_sections_full, 20)
        "duplicate_item" -> res.getString(R.string.home_error_duplicate_item)
        "unknown_item" -> res.getString(R.string.home_error_unknown_item)
        "not_playable" -> res.getString(R.string.home_error_not_playable)
        "nothing_to_check" -> res.getString(R.string.home_error_nothing_to_check)
        "unknown_check" -> res.getString(R.string.home_error_unknown_check)
        in HomeViewModel.CHANGED_ELSEWHERE -> res.getString(R.string.home_changed_elsewhere)
        else -> apiErrorText(error.code) ?: res.getString(R.string.home_error_other, error.code)
    }
}

/** A notice in words; [tvName] names the TV. */
fun noticeText(res: Resources, notice: HomeNotice, tvName: String): String = when (notice) {
    HomeNotice.ChangedElsewhere -> res.getString(R.string.home_changed_elsewhere)
    is HomeNotice.Failed -> errorText(res, notice.error)
    is HomeNotice.Added ->
        notice.sectionTitle?.let { res.getString(R.string.home_added_to, notice.title, it) } ?: res.getString(R.string.home_added_home, notice.title)
    is HomeNotice.Continues -> res.getString(R.string.home_continues, tvName, notice.title, notice.episode)
    is HomeNotice.Played -> playResultText(tvName, notice.title, notice.outcome)
    is HomeNotice.CheckRunning -> res.getString(R.string.home_check_already_running, runTitle(res, notice.run))
}

@Composable
internal fun resources(): Resources = LocalContext.current.resources
