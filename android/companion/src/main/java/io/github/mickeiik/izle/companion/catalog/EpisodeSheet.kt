package io.github.mickeiik.izle.companion.catalog

import android.content.res.Resources
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import io.github.mickeiik.izle.companion.R
import io.github.mickeiik.izle.companion.home.VerdictChip
import io.github.mickeiik.izle.companion.home.errorText
import io.github.mickeiik.izle.companion.home.resources
import io.github.mickeiik.izle.companion.home.worthAChip
import io.github.mickeiik.izle.companion.tv.episodeName
import io.github.mickeiik.izle.companion.tv.formatClock
import io.github.mickeiik.izle.companion.tv.timeAgo
import io.github.mickeiik.izle.companion.ui.design.ActionRow
import io.github.mickeiik.izle.companion.ui.design.Caption
import io.github.mickeiik.izle.companion.ui.design.Hairline
import io.github.mickeiik.izle.companion.ui.design.IzleIcons
import io.github.mickeiik.izle.companion.ui.design.IzleSheet
import io.github.mickeiik.izle.companion.ui.design.IzleTheme
import io.github.mickeiik.izle.companion.ui.design.ListRow
import io.github.mickeiik.izle.companion.ui.design.ProgressBar
import io.github.mickeiik.izle.companion.ui.design.SectionHeader
import io.github.mickeiik.izle.companion.ui.design.Tone
import io.github.mickeiik.izle.data.api.AdminEpisode
import io.github.mickeiik.izle.data.api.AdminSource
import io.github.mickeiik.izle.data.api.CheckSummary
import java.time.Instant

/**
 * An episode's sheet: its name, "2:26 · 2 sources · checked 3 h ago", Play this on <TV>, <TV> continues from here and
 * Check this episode (an episode the catalog does not let play has only the check), then its sources in the order the
 * TV tries them, each with what its last check found.
 */
@Composable
internal fun EpisodeSheet(
    episode: AdminEpisode,
    sources: PlayableSources?,
    tvName: String,
    onPlay: () -> Unit,
    onContinue: () -> Unit,
    onCheck: () -> Unit,
    onDismiss: () -> Unit,
) {
    IzleSheet(onDismiss, title = episodeName(episode), padded = false) {
        // Play and Continue close the sheet (their result is a message); a check keeps it open to show what it found.
        EpisodeSheetContent(episode, sources, tvName, onPlay = { onDismiss(); onPlay() }, onContinue = { onDismiss(); onContinue() }, onCheck = onCheck)
    }
}

/** The sheet under its title (also drawn alone in the screenshots). */
@Composable
internal fun EpisodeSheetContent(
    episode: AdminEpisode,
    sources: PlayableSources?,
    tvName: String,
    onPlay: () -> Unit,
    onContinue: () -> Unit,
    onCheck: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val res = resources()
    val s = IzleTheme.spacing
    val checking = sources?.checking == true
    Column(modifier.fillMaxWidth().verticalScroll(rememberScrollState())) {
        Caption(
            episodeCaption(res, episode.durationMs, episode.sources.size, sources?.check ?: episode.check),
            Modifier.padding(horizontal = s.lg).padding(bottom = s.sm),
        )
        if (!episode.playbackAllowed) {
            Caption(stringResource(R.string.show_not_allowed), Modifier.padding(horizontal = s.lg).padding(bottom = s.sm), tone = Tone.Warning)
        }
        Hairline()
        if (episode.playbackAllowed) {
            ActionRow(stringResource(R.string.show_play_this_on, tvName), Icons.Outlined.PlayArrow, onPlay)
            ActionRow(stringResource(R.string.show_continues_from_here, tvName), IzleIcons.SkipNext, onContinue)
        }
        ActionRow(
            stringResource(if (checking) R.string.show_checking else R.string.show_check_episode),
            Icons.Outlined.CheckCircle,
            onCheck,
            enabled = !checking,
        )
        SectionHeader(stringResource(R.string.show_sources_order))
        if (checking || sources?.loading != false) ProgressBar(null)
        SourceRows(episode.sources, sources)
    }
}

/**
 * The rows of [sources] in the order the TV tries them: "main · HLS · proxied", what the last check found (or why it
 * fails, in `danger`) and the verdict's chip.
 */
@Composable
internal fun SourceRows(sources: List<AdminSource>, checks: PlayableSources?) {
    val res = resources()
    if (sources.isEmpty()) {
        Caption(stringResource(R.string.show_no_sources), Modifier.padding(IzleTheme.spacing.lg))
        return
    }
    checks?.error?.takeIf { checks.reports.isEmpty() }?.let {
        Caption("${stringResource(R.string.show_sources_failed)} ${errorText(res, it)}", Modifier.padding(IzleTheme.spacing.lg), tone = Tone.Danger)
    }
    for ((i, source) in sources.withIndex()) {
        val report = checks?.reports?.get(source.id)
        val verdict = reportVerdict(report)
        ListRow(
            sourceKindText(source),
            supporting = sourceFindingsText(source, report),
            supportingTone = if (report?.verdict == "fail" && !report.stale) Tone.Danger else Tone.Neutral,
            badge = if (verdict.worthAChip) ({ VerdictChip(verdict) }) else null,
            divider = i < sources.lastIndex,
        )
    }
}

/** "2:26 · 2 sources · checked 3 hours ago", or "… · not checked". */
internal fun episodeCaption(res: Resources, durationMs: Long?, sourceCount: Int, check: CheckSummary?, nowMs: Long = System.currentTimeMillis()): String =
    listOfNotNull(
        durationMs?.takeIf { it > 0 }?.let(::formatClock),
        res.getQuantityString(R.plurals.show_source_count, sourceCount, sourceCount),
        checkedText(res, check, nowMs),
    ).joinToString(" · ")

/** "checked 3 hours ago", or "not checked". */
internal fun checkedText(res: Resources, check: CheckSummary?, nowMs: Long = System.currentTimeMillis()): String {
    val at = check?.checkedAt?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }
        ?: return res.getString(R.string.show_not_checked)
    return res.getString(R.string.show_checked_ago, timeAgo(res, at, nowMs))
}
