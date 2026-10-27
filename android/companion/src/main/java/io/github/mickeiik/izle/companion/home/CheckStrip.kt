package io.github.mickeiik.izle.companion.home

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.List
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import io.github.mickeiik.izle.companion.R
import io.github.mickeiik.izle.companion.ui.design.ActionRow
import io.github.mickeiik.izle.companion.ui.design.ButtonSize
import io.github.mickeiik.izle.companion.ui.design.Caption
import io.github.mickeiik.izle.companion.ui.design.Hairline
import io.github.mickeiik.izle.companion.ui.design.IconAction
import io.github.mickeiik.izle.companion.ui.design.IzleButton
import io.github.mickeiik.izle.companion.ui.design.IzleSheet
import io.github.mickeiik.izle.companion.ui.design.IzleTheme
import io.github.mickeiik.izle.companion.ui.design.ProgressBar
import io.github.mickeiik.izle.companion.ui.design.StatusLine
import io.github.mickeiik.izle.data.api.CheckRun

/**
 * The check strip at the top of the Home tab: what [run] checks, "12 of 40 checked · 1 failing" and a bar with
 * **Stop** while it runs; once it ended, its result in the verdict's tone, what was skipped and why, and a close button.
 */
@Composable
internal fun CheckStrip(run: CheckRun, onStop: () -> Unit, onDismiss: () -> Unit, modifier: Modifier = Modifier) {
    val res = resources()
    val s = IzleTheme.spacing
    // While it runs the skipped are counted; once it ended a sentence names them.
    val skipped = if (run.running) null else skippedText(res, run)
    val progress = runProgressText(res, run, countSkipped = skipped == null)
    Column(modifier.fillMaxWidth().background(IzleTheme.colors.surface)) {
        Row(
            Modifier.fillMaxWidth().padding(start = s.lg, end = if (run.running) s.lg else s.xs, top = s.sm, bottom = if (run.running) s.xs else s.sm),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(s.md),
        ) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(s.line)) {
                Text(runTitle(res, run), style = IzleTheme.type.label, color = IzleTheme.colors.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (run.running) Caption(progress, maxLines = 1) else StatusLine(progress, runVerdict(run).tone)
                skipped?.let { Caption(it, maxLines = 2) }
            }
            if (run.running) {
                IzleButton(stringResource(R.string.home_check_stop), onClick = onStop, size = ButtonSize.Small)
            } else {
                IconAction(Icons.Outlined.Close, stringResource(R.string.home_check_dismiss), onClick = onDismiss)
            }
        }
        if (run.running) {
            val fraction = if (run.total > 0) run.done.toFloat() / run.total else 0f
            ProgressBar(fraction, Modifier.padding(horizontal = s.lg).padding(bottom = s.sm))
        }
        Hairline()
    }
}

/** Check Home…: the quick and the full check under the admin page's note on what a pass means. */
@Composable
internal fun CheckHomeSheet(onPick: (mode: String) -> Unit, onDismiss: () -> Unit) {
    val act = { mode: String -> { onDismiss(); onPick(mode) } }
    IzleSheet(onDismiss, title = stringResource(R.string.home_check_home_title), padded = false) {
        Caption(stringResource(R.string.home_check_note), Modifier.padding(horizontal = IzleTheme.spacing.lg).padding(bottom = IzleTheme.spacing.sm))
        Hairline()
        ActionRow(stringResource(R.string.home_check_quick), Icons.Outlined.Check, act(CheckRun.MODE_QUICK))
        ActionRow(stringResource(R.string.home_check_full), Icons.Outlined.List, act(CheckRun.MODE_FULL))
    }
}
