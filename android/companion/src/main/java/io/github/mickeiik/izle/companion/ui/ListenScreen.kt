package io.github.mickeiik.izle.companion.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LifecycleStartEffect
import io.github.mickeiik.izle.companion.R
import io.github.mickeiik.izle.companion.sync.ListenSync
import io.github.mickeiik.izle.companion.sync.ListenTiming
import io.github.mickeiik.izle.companion.sync.PASTED_SOURCE_ID
import io.github.mickeiik.izle.companion.ui.design.ButtonGrid
import io.github.mickeiik.izle.companion.ui.design.ButtonKind
import io.github.mickeiik.izle.companion.ui.design.ButtonRow
import io.github.mickeiik.izle.companion.ui.design.ButtonSize
import io.github.mickeiik.izle.companion.ui.design.Caption
import io.github.mickeiik.izle.companion.ui.design.ChoiceGrid
import io.github.mickeiik.izle.companion.ui.design.Disclosure
import io.github.mickeiik.izle.companion.ui.design.EmptyState
import io.github.mickeiik.izle.companion.ui.design.IzleButton
import io.github.mickeiik.izle.companion.ui.design.IzleIcons
import io.github.mickeiik.izle.companion.ui.design.IzleTheme
import io.github.mickeiik.izle.companion.ui.design.ListRow
import io.github.mickeiik.izle.companion.ui.design.ProgressBar
import io.github.mickeiik.izle.companion.ui.design.StatusChip
import io.github.mickeiik.izle.companion.ui.design.Tone
import io.github.mickeiik.izle.companion.ui.design.toneColor

/**
 * Listen along, over the Now tab: one line saying what and where, the source to hear on this phone, Listen / Stop,
 * the earphone delay, and folded, the timing for this source (by ear: #34) and the sync details. What the TV plays
 * is read again every 10 s while shown.
 */
@Composable
fun ListenScreen(state: CompanionUi.Tv, vm: CompanionViewModel, modifier: Modifier = Modifier) {
    LifecycleStartEffect(vm) {
        vm.startRefreshing()
        onStopOrDispose { vm.stopRefreshing() }
    }
    val context = LocalContext.current
    // Android 13+: the notification of the foreground service needs the permission; listening starts whatever the answer.
    val notifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { vm.listen() }
    val onListen = {
        val ask = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        if (ask) notifications.launch(Manifest.permission.POST_NOTIFICATIONS) else vm.listen()
    }
    ListenContent(
        state,
        onListen = onListen,
        onStop = vm::stopListening,
        onChoose = vm::choose,
        onNudge = vm::nudge,
        onFinder = vm::openFinder,
        onForget = vm::forgetFoundLink,
        timing = { TimingControls(state, vm) },
        modifier = modifier,
    )
}

/** Listen along's content, without the view model; [timing] fills the Timing disclosure. */
@Composable
internal fun ListenContent(
    state: CompanionUi.Tv,
    onListen: () -> Unit,
    onStop: () -> Unit,
    onChoose: (CandidateOption) -> Unit,
    onNudge: (Long) -> Unit,
    onFinder: () -> Unit,
    onForget: () -> Unit,
    timing: @Composable () -> Unit,
    modifier: Modifier = Modifier,
) {
    val s = IzleTheme.spacing
    val inset = Modifier.padding(horizontal = s.lg)
    Column(modifier = modifier.fillMaxSize()) {
        if (state.refreshing || !state.loaded) ProgressBar(null)
        Column(
            modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(vertical = s.lg),
            verticalArrangement = Arrangement.spacedBy(s.lg),
        ) {
            Caption(listenContext(state.nowPlaying, state.displayName), modifier = inset)
            // While listening the form stays, whatever the TV reports meanwhile.
            val episode = state.nowPlaying?.episodeId != null && !state.isChannel
            when {
                !state.loaded -> Unit
                state.listening || episode -> ListenForm(state, onListen, onStop, onChoose, onNudge, onFinder, onForget, timing, inset)
                else -> EmptyState(nothingToListenText(state.nowPlaying, state.displayName).orEmpty(), modifier = inset)
            }
            val error = state.session.error ?: state.error
            if (error != null) Caption(error, tone = Tone.Danger, modifier = inset)
        }
    }
}

@Composable
private fun ListenForm(
    state: CompanionUi.Tv,
    onListen: () -> Unit,
    onStop: () -> Unit,
    onChoose: (CandidateOption) -> Unit,
    onNudge: (Long) -> Unit,
    onFinder: () -> Unit,
    onForget: () -> Unit,
    timing: @Composable () -> Unit,
    inset: Modifier,
) {
    Column {
        Text(stringResource(R.string.source), style = IzleTheme.type.heading, color = IzleTheme.colors.textPrimary, modifier = inset)
        if (state.options.isEmpty()) {
            Caption(stringResource(R.string.no_candidates), modifier = inset.padding(top = IzleTheme.spacing.md))
        } else {
            Column(modifier = Modifier.selectableGroup()) {
                for (option in state.options) SourceRow(option, state, onChoose, onFinder, onForget)
            }
        }
    }

    if (state.listening) {
        IzleButton(stringResource(R.string.stop), onClick = onStop, kind = ButtonKind.Danger, modifier = inset.fillMaxWidth())
    } else {
        IzleButton(
            stringResource(R.string.listen),
            onClick = onListen,
            kind = ButtonKind.Primary,
            icon = IzleIcons.Headphones,
            enabled = state.canListen,
            modifier = inset.fillMaxWidth(),
        )
    }

    EarphoneDelay(state.nudgeMs, onNudge)

    Column(modifier = inset) {
        var timingOpen by rememberSaveable { mutableStateOf(false) }
        Disclosure(
            title = stringResource(R.string.timing_title),
            summary = timingSummary(parseTiming(state.offsetText, state.speedText)),
            expanded = timingOpen,
            onToggle = { timingOpen = !timingOpen },
        ) { timing() }

        var detailsOpen by rememberSaveable { mutableStateOf(false) }
        Disclosure(
            title = stringResource(R.string.sync_details),
            summary = null,
            expanded = detailsOpen,
            onToggle = { detailsOpen = !detailsOpen },
        ) {
            val synced = state.session.syncLabel == "synced"
            Text(
                statusLine(state.session) ?: stringResource(R.string.not_listening),
                style = IzleTheme.type.mono,
                color = toneColor(if (synced) Tone.Success else Tone.Neutral),
            )
        }
    }
}

/** One source as a radio row; the `pasted` one is the found link: whether one is ready (never its URL), and the way to the finder. */
@Composable
private fun SourceRow(
    option: CandidateOption,
    state: CompanionUi.Tv,
    onChoose: (CandidateOption) -> Unit,
    onFinder: () -> Unit,
    onForget: () -> Unit,
) {
    val selected = option.key == state.chosen?.key
    val found = option.sourceId == PASTED_SOURCE_ID
    val label = when {
        !found -> option.label
        state.foundLink != null -> stringResource(R.string.found_link_ready)
        else -> stringResource(R.string.found_link_none)
    }
    // "dub — French dub · Français (fr) · the TV's source": the source is the title, the rest its supporting line.
    ListRow(
        title = label.substringBefore(LABEL_SEPARATOR),
        supporting = label.substringAfter(LABEL_SEPARATOR, "").ifEmpty { null },
        selected = selected,
        onClick = { onChoose(option) },
        trailing = {
            option.kind?.let { StatusChip(mediaKindLabel(it), Tone.Neutral) }
            // The found link's row carries its own way to the finder, as in the mockup.
            if (found) {
                if (state.foundLink != null) {
                    IzleButton(stringResource(R.string.forget_link), onClick = onForget, kind = ButtonKind.Quiet, size = ButtonSize.Small)
                }
                IzleButton(
                    stringResource(if (state.foundLink != null) R.string.find_new_link else R.string.find_link),
                    onClick = onFinder,
                    size = ButtonSize.Small,
                )
            }
        },
    )
}

private const val LABEL_SEPARATOR = " · "

/** "Earphone delay, kept on this phone", then − value + (50 ms a step), as in the mockup. */
@Composable
private fun EarphoneDelay(nudgeMs: Long, onNudge: (Long) -> Unit) {
    val less = stringResource(R.string.nudge_minus)
    val more = stringResource(R.string.nudge_plus)
    ListRow(
        title = stringResource(R.string.earphone_delay),
        supporting = stringResource(R.string.earphone_delay_hint),
        divider = false,
        trailing = {
            IzleButton(stringResource(R.string.minus_sign), onClick = { onNudge(-NUDGE_STEP_MS) }, size = ButtonSize.Small, modifier = Modifier.semantics { contentDescription = less })
            Text(ListenSync.formatDrift(nudgeMs.toDouble()), style = IzleTheme.type.body, color = IzleTheme.colors.textPrimary)
            IzleButton(stringResource(R.string.plus_sign), onClick = { onNudge(NUDGE_STEP_MS) }, size = ButtonSize.Small, modifier = Modifier.semantics { contentDescription = more })
        },
    )
}

/**
 * Timing for this source, by ear: Line it up (Mark on TV, Mark on phone), the offset's readout with Edit and its
 * nudges (two rows of three), the speed (2 × 2 choices, Other opens the decimal field), Save timing and Apply to all
 * episodes. Changes apply at once while listening.
 */
@Composable
internal fun TimingControls(state: CompanionUi.Tv, vm: CompanionViewModel) {
    TimingControls(
        state,
        onMark = vm::mark,
        onNudge = vm::nudgeOffset,
        onOffsetText = vm::setOffsetText,
        onSpeed = vm::chooseSpeed,
        onSpeedText = vm::setSpeedText,
        onSave = vm::saveTiming,
        onApplyAll = vm::applyToAll,
    )
}

@Composable
internal fun TimingControls(
    state: CompanionUi.Tv,
    onMark: (onTv: Boolean) -> Unit,
    onNudge: (Long) -> Unit,
    onOffsetText: (String) -> Unit,
    onSpeed: (Double?) -> Unit,
    onSpeedText: (String) -> Unit,
    onSave: () -> Unit,
    onApplyAll: () -> Unit,
) {
    val s = IzleTheme.spacing
    Column(verticalArrangement = Arrangement.spacedBy(s.sm)) {
        Text(stringResource(R.string.line_it_up), style = IzleTheme.type.label, color = IzleTheme.colors.textPrimary)
        Caption(stringResource(R.string.mark_hint))
        ButtonRow {
            IzleButton(stringResource(R.string.mark_on_tv), onClick = { onMark(true) }, selected = state.tvMarkMs != null)
            IzleButton(stringResource(R.string.mark_on_phone), onClick = { onMark(false) }, selected = state.phoneMarkMs != null)
        }
        markPendingText(state.tvMarkMs, state.phoneMarkMs)?.let { Caption(it, tone = Tone.Accent) }

        var editing by rememberSaveable { mutableStateOf(false) }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(s.md)) {
            Caption(stringResource(R.string.offset))
            val offsetMs = parseTiming(state.offsetText, "1")?.offsetMs
            Text(
                offsetMs?.let(ListenTiming::formatOffset) ?: "–",
                style = IzleTheme.type.digits,
                color = IzleTheme.colors.textPrimary,
                modifier = Modifier.weight(1f),
            )
            IzleButton(stringResource(R.string.edit), onClick = { editing = !editing }, kind = ButtonKind.Quiet, size = ButtonSize.Small)
        }
        if (editing) {
            OutlinedTextField(
                value = state.offsetText,
                onValueChange = onOffsetText,
                label = { Text(stringResource(R.string.offset_label)) },
                singleLine = true,
                isError = !state.timingValid,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                // A decimal keyboard may have no minus key.
                trailingIcon = {
                    val flip = stringResource(R.string.flip_sign)
                    IzleButton(
                        stringResource(R.string.flip_sign_symbol),
                        onClick = { onOffsetText(flipSign(state.offsetText)) },
                        kind = ButtonKind.Quiet,
                        size = ButtonSize.Small,
                        modifier = Modifier.semantics { contentDescription = flip },
                    )
                },
                modifier = Modifier.fillMaxWidth(),
            )
        }
        ButtonGrid(columns = 3) {
            for (ms in ListenTiming.OFFSET_NUDGES_MS) IzleButton(ListenTiming.nudgeLabel(ms), onClick = { onNudge(ms) })
        }
        Caption(stringResource(R.string.nudges_hint))

        Text(stringResource(R.string.speed), style = IzleTheme.type.label, color = IzleTheme.colors.textPrimary, modifier = Modifier.padding(top = s.sm))
        val rate = parseTiming("0", state.speedText)?.rate
        val preset = if (state.otherSpeed || rate == null) ListenTiming.OTHER else ListenTiming.speedPreset(rate)
        val choices = ListenTiming.SPEED_PRESETS.map { Triple(it.label, it.rate as Double?, it.id) } +
            Triple(stringResource(R.string.speed_other), null, ListenTiming.OTHER)
        ChoiceGrid(choices, label = { it.first }, selected = { preset == it.third }, onSelect = { onSpeed(it.second) }, columns = 2)
        if (preset == ListenTiming.OTHER) {
            OutlinedTextField(
                value = state.speedText,
                onValueChange = onSpeedText,
                label = { Text(stringResource(R.string.speed_label)) },
                singleLine = true,
                isError = !state.timingValid,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        if (!state.timingValid) Caption(stringResource(R.string.timing_invalid), tone = Tone.Danger)
        ButtonRow(modifier = Modifier.padding(top = s.sm)) {
            val chosen = state.chosen != null
            IzleButton(stringResource(R.string.save_timing), onClick = onSave, enabled = state.timingValid && chosen)
            if (state.applyAllVisible) IzleButton(stringResource(R.string.apply_to_all), onClick = onApplyAll, enabled = chosen)
        }
    }
}

private const val NUDGE_STEP_MS = 50L

/** `1.250` ↔ `-1.250`. */
internal fun flipSign(text: String): String {
    val t = text.trim()
    return when {
        t.startsWith("-") || t.startsWith("−") -> t.substring(1)
        t.isEmpty() -> "-"
        else -> "-$t"
    }
}
