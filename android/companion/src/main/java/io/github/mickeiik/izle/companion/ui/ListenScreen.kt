package io.github.mickeiik.izle.companion.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LifecycleStartEffect
import io.github.mickeiik.izle.companion.R
import io.github.mickeiik.izle.companion.sync.ListenTiming
import io.github.mickeiik.izle.companion.sync.PASTED_SOURCE_ID

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

    Column(modifier = modifier.fillMaxSize()) {
        if (state.refreshing || !state.loaded) LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
        Column(
            modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(listenContext(state.nowPlaying, state.displayName), style = MaterialTheme.typography.bodyLarge)
            // While listening the form stays, whatever the TV reports meanwhile.
            val episode = state.nowPlaying?.episodeId != null && !state.isChannel
            when {
                !state.loaded -> Unit
                state.listening || episode -> ListenForm(state, vm, onListen)
                else -> Text(
                    nothingToListenText(state.nowPlaying, state.displayName).orEmpty(),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            val error = state.session.error ?: state.error
            if (error != null) Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable
private fun ListenForm(state: CompanionUi.Tv, vm: CompanionViewModel, onListen: () -> Unit) {
    Text(stringResource(R.string.source), style = MaterialTheme.typography.titleMedium)
    if (state.options.isEmpty()) {
        Text(stringResource(R.string.no_candidates), style = MaterialTheme.typography.bodyMedium)
    } else {
        Column(modifier = Modifier.selectableGroup()) {
            for (option in state.options) SourceRow(option, state, vm)
        }
    }

    if (state.listening) {
        Button(
            onClick = vm::stopListening,
            colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error, contentColor = MaterialTheme.colorScheme.onError),
            modifier = Modifier.fillMaxWidth().height(56.dp),
        ) { Text(stringResource(R.string.stop), style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center) }
    } else {
        Button(onClick = onListen, enabled = state.canListen, modifier = Modifier.fillMaxWidth().height(56.dp)) {
            Text(stringResource(R.string.listen), style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
        }
    }

    EarphoneDelay(state.nudgeMs, vm::nudge)

    var timingOpen by rememberSaveable { mutableStateOf(false) }
    Fold(
        title = stringResource(R.string.timing_title),
        summary = timingSummary(parseTiming(state.offsetText, state.speedText)),
        open = timingOpen,
        onToggle = { timingOpen = !timingOpen },
    ) { TimingControls(state, vm) }

    var detailsOpen by rememberSaveable { mutableStateOf(false) }
    val status = statusLine(state.session)
    Fold(
        title = stringResource(R.string.sync_details),
        summary = null,
        open = detailsOpen,
        onToggle = { detailsOpen = !detailsOpen },
    ) {
        val synced = state.session.syncLabel == "synced"
        Text(
            status ?: stringResource(R.string.not_listening),
            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
            color = if (synced) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** One source; the `pasted` one is the found link: whether one is ready (never its URL), and the way to the finder. */
@Composable
private fun SourceRow(option: CandidateOption, state: CompanionUi.Tv, vm: CompanionViewModel) {
    val selected = option.key == state.chosen?.key
    val found = option.sourceId == PASTED_SOURCE_ID
    Column(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth()
                .selectable(selected = selected, onClick = { vm.choose(option) }, role = Role.RadioButton)
                .padding(vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            RadioButton(selected = selected, onClick = null)
            val label = when {
                !found -> option.label
                state.foundLink != null -> stringResource(R.string.found_link_ready)
                else -> stringResource(R.string.found_link_none)
            }
            Text(label, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
            option.kind?.let { KindChip(mediaKindLabel(it)) }
        }
        if (found && selected) {
            Row(modifier = Modifier.padding(start = 48.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = vm::openFinder) {
                    Text(stringResource(if (state.foundLink != null) R.string.find_new_link else R.string.find_link))
                }
                if (state.foundLink != null) TextButton(onClick = vm::forgetFoundLink) { Text(stringResource(R.string.forget_link)) }
            }
        }
    }
}

/** "Earphone delay": −50 ms, the value, +50 ms; kept on this phone. */
@Composable
private fun EarphoneDelay(nudgeMs: Long, onNudge: (Long) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(stringResource(R.string.earphone_delay), style = MaterialTheme.typography.titleMedium)
        EqualRow(modifier = Modifier.padding(top = 4.dp)) {
            ChoiceButton(stringResource(R.string.nudge_minus), onClick = { onNudge(-NUDGE_STEP_MS) }, modifier = Modifier.weight(1f))
            Text(
                nudgeText(nudgeMs),
                style = MaterialTheme.typography.bodyMedium,
                textAlign = TextAlign.Center,
                maxLines = 1,
                modifier = Modifier.weight(1f).align(Alignment.CenterVertically),
            )
            ChoiceButton(stringResource(R.string.nudge_plus), onClick = { onNudge(NUDGE_STEP_MS) }, modifier = Modifier.weight(1f))
        }
        Text(
            stringResource(R.string.earphone_delay_hint),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
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
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(stringResource(R.string.line_it_up), style = MaterialTheme.typography.titleSmall)
        Text(stringResource(R.string.mark_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        EqualRow {
            val tvMarked = state.tvMarkMs != null
            val phoneMarked = state.phoneMarkMs != null
            ChoiceButton(stringResource(R.string.mark_on_tv), onClick = { onMark(true) }, selected = tvMarked, modifier = Modifier.weight(1f))
            ChoiceButton(stringResource(R.string.mark_on_phone), onClick = { onMark(false) }, selected = phoneMarked, modifier = Modifier.weight(1f))
        }
        markPendingText(state.tvMarkMs, state.phoneMarkMs)?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
        }

        var editing by rememberSaveable { mutableStateOf(false) }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(stringResource(R.string.offset), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            val offsetMs = parseTiming(state.offsetText, "1")?.offsetMs
            Text(offsetMs?.let(ListenTiming::formatOffset) ?: "–", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.weight(1f))
            TextButton(onClick = { editing = !editing }) { Text(stringResource(R.string.edit)) }
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
                    TextButton(onClick = { onOffsetText(flipSign(state.offsetText)) }, modifier = Modifier.semantics { contentDescription = flip }) {
                        Text(stringResource(R.string.flip_sign_symbol))
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            )
        }
        for (row in ListenTiming.OFFSET_NUDGES_MS.chunked(3)) {
            EqualRow {
                for (ms in row) ChoiceButton(ListenTiming.nudgeLabel(ms), onClick = { onNudge(ms) }, modifier = Modifier.weight(1f))
            }
        }
        Text(stringResource(R.string.nudges_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)

        Text(stringResource(R.string.speed), style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 8.dp))
        val rate = parseTiming("0", state.speedText)?.rate
        val preset = if (state.otherSpeed || rate == null) ListenTiming.OTHER else ListenTiming.speedPreset(rate)
        val choices = ListenTiming.SPEED_PRESETS.map { Triple(it.label, it.rate as Double?, it.id) } +
            Triple(stringResource(R.string.speed_other), null, ListenTiming.OTHER)
        for (row in choices.chunked(2)) {
            EqualRow {
                for ((label, value, id) in row) {
                    ChoiceButton(label, onClick = { onSpeed(value) }, selected = preset == id, modifier = Modifier.weight(1f))
                }
            }
        }
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
        if (!state.timingValid) {
            Text(stringResource(R.string.timing_invalid), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
        }
        EqualRow(modifier = Modifier.padding(top = 8.dp)) {
            val chosen = state.chosen != null
            ChoiceButton(stringResource(R.string.save_timing), onClick = onSave, enabled = state.timingValid && chosen, modifier = Modifier.weight(1f))
            if (state.applyAllVisible) {
                ChoiceButton(stringResource(R.string.apply_to_all), onClick = onApplyAll, enabled = chosen, modifier = Modifier.weight(1f))
            }
        }
    }
}

/** A section folded under its title (and a one-line [summary]); tap the title to open it. */
@Composable
private fun Fold(title: String, summary: String?, open: Boolean, onToggle: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    Column(modifier = Modifier.fillMaxWidth()) {
        HorizontalDivider()
        val action = stringResource(if (open) R.string.fold_close else R.string.fold_open)
        Row(
            modifier = Modifier.fillMaxWidth().clickable(onClickLabel = action, onClick = onToggle).padding(vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleMedium)
                if (summary != null && !open) {
                    Text(summary, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            Icon(if (open) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown, contentDescription = null)
        }
        if (open) Column(modifier = Modifier.padding(bottom = 8.dp), content = content)
    }
}

@Composable
private fun KindChip(text: String) {
    Surface(shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.secondaryContainer) {
        Text(text, style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp))
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
