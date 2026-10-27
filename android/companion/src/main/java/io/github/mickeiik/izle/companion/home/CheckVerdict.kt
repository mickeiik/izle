package io.github.mickeiik.izle.companion.home

import android.content.res.Resources
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import io.github.mickeiik.izle.companion.R
import androidx.compose.ui.res.stringResource
import io.github.mickeiik.izle.companion.ui.design.StatusChip
import io.github.mickeiik.izle.companion.ui.design.StatusLine
import io.github.mickeiik.izle.companion.ui.design.Tone
import io.github.mickeiik.izle.data.api.CheckSummary

// A show's last check: its verdict, the words for it and its tone, wherever Home shows it (the row's chip, the sheet).

/** A check's verdict. */
enum class Verdict { Works, Warns, Fails, Stale, NotChecked }

fun verdictOf(check: CheckSummary?): Verdict = when {
    check == null || check.verdict == null -> Verdict.NotChecked
    check.stale -> Verdict.Stale
    check.verdict == "fail" -> Verdict.Fails
    check.verdict == "warn" -> Verdict.Warns
    else -> Verdict.Works
}

/** "Works", "Works, with warnings", "Fails", "Source changed", "Not checked". */
fun verdictText(res: Resources, verdict: Verdict): String = res.getString(
    when (verdict) {
        Verdict.Works -> R.string.home_check_ok
        Verdict.Warns -> R.string.home_check_warn
        Verdict.Fails -> R.string.home_check_fail
        Verdict.Stale -> R.string.home_check_stale
        Verdict.NotChecked -> R.string.home_check_none
    },
)

/** The verdict's colour: success, warning, danger, or neutral for a check that says nothing yet. */
val Verdict.tone: Tone
    get() = when (this) {
        Verdict.Works -> Tone.Success
        Verdict.Warns -> Tone.Warning
        Verdict.Fails -> Tone.Danger
        Verdict.Stale, Verdict.NotChecked -> Tone.Neutral
    }

/** Whether a show's row draws a chip for it (the design system: only for Fails and Works with warnings). */
val Verdict.worthAChip: Boolean get() = this == Verdict.Fails || this == Verdict.Warns

/** The verdict as a [StatusChip]. */
@Composable
fun VerdictChip(verdict: Verdict, modifier: Modifier = Modifier) {
    // One short word on a row; the sheet says it in full.
    val text = if (verdict == Verdict.Warns) stringResource(R.string.home_chip_warn) else verdictText(resources(), verdict)
    StatusChip(text, verdict.tone, modifier)
}

/** The verdict as a [StatusLine] (a show's sheet). */
@Composable
fun VerdictLine(verdict: Verdict, modifier: Modifier = Modifier) {
    StatusLine(verdictText(resources(), verdict), verdict.tone, modifier)
}
