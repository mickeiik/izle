package io.github.mickeiik.izle.companion.device

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import io.github.mickeiik.izle.companion.R
import io.github.mickeiik.izle.companion.catalog.reportVerdict
import io.github.mickeiik.izle.companion.catalog.sourceFindingsText
import io.github.mickeiik.izle.companion.home.resources
import io.github.mickeiik.izle.companion.home.tone
import io.github.mickeiik.izle.companion.home.verdictText
import io.github.mickeiik.izle.companion.tv.formatClock
import io.github.mickeiik.izle.companion.ui.design.ActionRow
import io.github.mickeiik.izle.companion.ui.design.ButtonKind
import io.github.mickeiik.izle.companion.ui.design.Caption
import io.github.mickeiik.izle.companion.ui.design.FactRow
import io.github.mickeiik.izle.companion.ui.design.Hairline
import io.github.mickeiik.izle.companion.ui.design.IzleButton
import io.github.mickeiik.izle.companion.ui.design.IzleIcons
import io.github.mickeiik.izle.companion.ui.design.IzleSheet
import io.github.mickeiik.izle.companion.ui.design.IzleTheme
import io.github.mickeiik.izle.companion.ui.design.ListRow
import io.github.mickeiik.izle.companion.ui.design.StatusLine
import io.github.mickeiik.izle.data.api.AdminDevice
import io.github.mickeiik.izle.data.api.Problem

/**
 * A problem's sheet: its title, when and by whom with its code, the facts it has, the check's verdict once it answers,
 * then Check this episode now and Open the show (neither without an item, or for one gone from the catalog).
 */
@Composable
internal fun ProblemSheet(p: Problem, check: ProblemCheck?, onCheck: () -> Unit, onOpenShow: () -> Unit, onDismiss: () -> Unit) {
    IzleSheet(onDismiss, title = problemTitle(resources(), p), padded = false) {
        ProblemSheetContent(p, check, onCheck, onOpenShow)
    }
}

/** The sheet under its title (also drawn alone in the screenshots). */
@Composable
internal fun ProblemSheetContent(p: Problem, check: ProblemCheck?, onCheck: () -> Unit, onOpenShow: () -> Unit, modifier: Modifier = Modifier) {
    val res = resources()
    val s = IzleTheme.spacing
    Column(modifier.fillMaxWidth().verticalScroll(rememberScrollState())) {
        Column(Modifier.padding(horizontal = s.lg).padding(bottom = s.md), verticalArrangement = Arrangement.spacedBy(s.line)) {
            Caption(problemCaption(res, p))
            Text(p.code, style = IzleTheme.type.mono, color = IzleTheme.colors.textSecondary)
        }
        Hairline()
        Column(Modifier.padding(vertical = s.sm)) {
            val show = if (p.missing) res.getString(R.string.problem_missing) else p.itemTitle
            show?.let { FactRow(stringResource(R.string.problem_show), it) }
            problemEpisode(p)?.let { FactRow(stringResource(R.string.problem_episode), it) }
            p.sourceId?.let { FactRow(stringResource(R.string.problem_source), it) }
            p.positionMs?.let { FactRow(stringResource(R.string.problem_at), formatClock(it)) }
            p.httpStatus?.let { FactRow(stringResource(R.string.problem_http), it.toString()) }
            p.appVersion?.let { FactRow(stringResource(R.string.problem_app), it) }
            p.detail?.let { FactRow(stringResource(R.string.problem_detail), it, mono = true) }
        }
        val report = check?.report
        if (report != null) {
            Column(Modifier.padding(horizontal = s.lg).padding(bottom = s.md), verticalArrangement = Arrangement.spacedBy(s.sm)) {
                for (source in report.sources) {
                    // With nothing else to say, the verdict in words ("main · Works").
                    val verdict = reportVerdict(source)
                    val findings = sourceFindingsText(null, source).ifEmpty { verdictText(res, verdict) }
                    StatusLine("${source.sourceId} · $findings", verdict.tone)
                }
            }
        }
        if (p.itemId != null && !p.missing) {
            Hairline()
            val checking = check?.checking == true
            val label = when {
                checking -> R.string.show_checking
                p.itemKind == "live" -> R.string.problem_check_channel
                else -> R.string.problem_check_now
            }
            ActionRow(stringResource(label), Icons.Outlined.CheckCircle, onCheck, enabled = !checking)
            ActionRow(stringResource(R.string.problem_open_show), IzleIcons.Library, onOpenShow)
        }
    }
}

/** Every problem the TV keeps, in the tab's rows. */
@Composable
internal fun AllProblemsSheet(problems: List<Problem>, onOpen: (Problem) -> Unit, onDismiss: () -> Unit) {
    IzleSheet(onDismiss, title = pluralStringResource(R.plurals.device_all_problems, problems.size, problems.size), padded = false) {
        LazyColumn {
            items(problems, key = { it.id }) { p -> ProblemRow(p, onClick = { onOpen(p) }) }
        }
    }
}

/** A setting's choices as radio rows, the current one selected; a choice saves at once and closes the sheet. */
@Composable
internal fun ChoiceSheet(device: AdminDevice, setting: Setting, actions: DeviceActions, onDismiss: () -> Unit) {
    val res = resources()
    val stored = device.settings
    // (value, words): null is the server's default (audio) or off (subtitles).
    val (choices, current, pick) = when (setting) {
        Setting.MenuLanguage -> Triple(
            MENU_LANGUAGES.map { it to languageName(it) },
            stored?.uiLanguage ?: device.effective?.uiLanguage,
        ) { tag: String? -> if (tag != null) actions.onMenuLanguage(tag) }
        Setting.Audio -> Triple(
            listOf<Pair<String?, String>>(null to res.getString(R.string.device_server_default)) + languages(stored?.preferredAudioLanguage),
            stored?.preferredAudioLanguage,
            actions.onAudio,
        )
        else -> Triple(
            listOf<Pair<String?, String>>(null to res.getString(R.string.device_subtitles_off)) + languages(stored?.subtitlesLanguage),
            stored?.subtitlesLanguage,
            actions.onSubtitles,
        )
    }
    IzleSheet(onDismiss, title = settingName(res, setting), padded = false) {
        Column(Modifier.verticalScroll(rememberScrollState())) {
            for ((i, choice) in choices.withIndex()) {
                val (value, words) = choice
                ListRow(
                    words,
                    selected = value == current,
                    onClick = {
                        onDismiss()
                        if (value != current) pick(value)
                    },
                    divider = i < choices.lastIndex,
                )
            }
        }
    }
}

/** The settings' languages, and [current] at the end when it is another tag. */
private fun languages(current: String?): List<Pair<String?, String>> {
    val known = LANGUAGES.map { (tag, name) -> tag to name }
    if (current == null || known.any { it.first == current }) return known
    // A regional tag ("tr-TR") says which it is, beside its language's own row.
    val name = languageName(current).let { if (it == current) it else "$it ($current)" }
    return known + (current to name)
}

/** Rename the TV: the field (1–60 characters), Cancel and Save. */
@Composable
internal fun NameDialog(name: String, onSave: (String) -> Unit, onDismiss: () -> Unit) {
    var text by rememberSaveable { mutableStateOf(name) }
    val trimmed = text.trim()
    val ok = trimmed.isNotEmpty() && trimmed.length <= DeviceViewModel.NAME_MAX && trimmed != name
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.device_name)) },
        text = {
            OutlinedTextField(
                value = text,
                onValueChange = { text = it.take(DeviceViewModel.NAME_MAX) },
                singleLine = true,
                supportingText = { Text(stringResource(R.string.device_name_hint)) },
                modifier = Modifier.fillMaxWidth(),
            )
        },
        confirmButton = { IzleButton(stringResource(R.string.device_save), onClick = { onDismiss(); onSave(trimmed) }, kind = ButtonKind.Primary, enabled = ok) },
        dismissButton = { IzleButton(stringResource(R.string.cancel), onClick = onDismiss, kind = ButtonKind.Quiet) },
    )
}

/** Asks first: [confirm] is Danger, Cancel Quiet. */
@Composable
internal fun ConfirmDialog(title: String, text: String, confirm: String, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { Text(text) },
        confirmButton = { IzleButton(confirm, onClick = { onDismiss(); onConfirm() }, kind = ButtonKind.Danger) },
        dismissButton = { IzleButton(stringResource(R.string.cancel), onClick = onDismiss, kind = ButtonKind.Quiet) },
    )
}
