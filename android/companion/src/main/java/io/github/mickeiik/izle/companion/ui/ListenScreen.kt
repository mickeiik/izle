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
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LifecycleStartEffect
import io.github.mickeiik.izle.companion.R
import io.github.mickeiik.izle.companion.sync.PASTED_SOURCE_ID
import io.github.mickeiik.izle.data.api.NowPlaying

/**
 * Listen along, as the admin page's card: what the TV plays, the source to hear on this phone, its timing, Listen /
 * Stop, the nudge for the earphones and the sync status. What the TV plays is read again every 10 s while shown.
 */
@Composable
fun ListenScreen(state: CompanionUi.Listen, vm: CompanionViewModel, modifier: Modifier = Modifier) {
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
            Text(stringResource(R.string.listen_intro), style = MaterialTheme.typography.bodyMedium)
            NowPlayingCard(state)
            // While listening Stop stays, whatever the TV reports meanwhile.
            if (state.loaded && (state.listening || (state.nowPlaying?.episodeId != null && !state.isChannel))) {
                ListenForm(state, vm, onListen)
            }
            val error = state.session.error ?: state.error
            if (error != null) Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable
private fun NowPlayingCard(state: CompanionUi.Listen) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(stringResource(R.string.what_the_tv_plays), style = MaterialTheme.typography.labelLarge)
            val n = state.nowPlaying
            when {
                !state.loaded -> Unit
                n == null -> Text(stringResource(R.string.nothing_playing), style = MaterialTheme.typography.bodyLarge)
                n.isLive -> Text(stringResource(R.string.channel_playing, n.itemTitle ?: n.itemId), style = MaterialTheme.typography.bodyLarge)
                else -> {
                    Text(n.itemTitle ?: n.itemId, style = MaterialTheme.typography.titleLarge)
                    n.episodeTitle?.let { Text(it, style = MaterialTheme.typography.bodyLarge) }
                    Text(tvStateText(n), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

@Composable
private fun tvStateText(n: NowPlaying): String = when (n.state) {
    "playing" -> stringResource(R.string.tv_state_playing)
    "paused" -> stringResource(R.string.tv_state_paused)
    "starting" -> stringResource(R.string.tv_state_starting)
    "stopped" -> stringResource(R.string.tv_state_stopped)
    else -> n.state
}

@Composable
private fun ListenForm(state: CompanionUi.Listen, vm: CompanionViewModel, onListen: () -> Unit) {
    Text(stringResource(R.string.audio_on_this_phone), style = MaterialTheme.typography.titleMedium)
    if (state.options.isEmpty()) {
        Text(stringResource(R.string.no_candidates), style = MaterialTheme.typography.bodyMedium)
    } else {
        Column(modifier = Modifier.selectableGroup()) {
            for (option in state.options) {
                val selected = option.key == state.chosen?.key
                Row(
                    modifier = Modifier.fillMaxWidth()
                        .selectable(selected = selected, onClick = { vm.choose(option) }, role = Role.RadioButton)
                        .padding(vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    RadioButton(selected = selected, onClick = null)
                    Text(option.label, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                    option.kind?.let { KindChip(mediaKindLabel(it)) }
                }
            }
        }
    }
    if (state.chosen?.sourceId == PASTED_SOURCE_ID) FoundLinkRow(state, vm)

    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        OutlinedTextField(
            value = state.offsetText,
            onValueChange = vm::setOffsetText,
            label = { Text(stringResource(R.string.offset_label)) },
            singleLine = true,
            isError = !state.timingValid,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            // A decimal keyboard may have no minus key.
            trailingIcon = {
                val flip = stringResource(R.string.flip_sign)
                TextButton(onClick = { vm.setOffsetText(flipSign(state.offsetText)) }, modifier = Modifier.semantics { contentDescription = flip }) {
                    Text(stringResource(R.string.flip_sign_symbol))
                }
            },
            modifier = Modifier.weight(1f),
        )
        OutlinedTextField(
            value = state.speedText,
            onValueChange = vm::setSpeedText,
            label = { Text(stringResource(R.string.speed_label)) },
            singleLine = true,
            isError = !state.timingValid,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            modifier = Modifier.weight(0.7f),
        )
    }
    Text(
        stringResource(if (state.timingValid) R.string.timing_hint else R.string.timing_invalid),
        style = MaterialTheme.typography.bodySmall,
        color = if (state.timingValid) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error,
    )
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        OutlinedButton(onClick = vm::saveTiming, enabled = state.timingValid && state.chosen != null) {
            Text(stringResource(R.string.save_timing))
        }
        if (state.applyAllVisible) {
            OutlinedButton(onClick = vm::applyToAll, enabled = state.chosen != null) { Text(stringResource(R.string.apply_to_all)) }
        }
    }

    if (state.listening) {
        Button(
            onClick = vm::stopListening,
            colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error, contentColor = MaterialTheme.colorScheme.onError),
            modifier = Modifier.fillMaxWidth().height(56.dp),
        ) { Text(stringResource(R.string.stop), style = MaterialTheme.typography.titleMedium) }
    } else {
        Button(onClick = onListen, enabled = state.canListen, modifier = Modifier.fillMaxWidth().height(56.dp)) {
            Text(stringResource(R.string.listen), style = MaterialTheme.typography.titleMedium)
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedButton(onClick = { vm.nudge(-NUDGE_STEP_MS) }) { Text(stringResource(R.string.nudge_minus)) }
            Text(nudgeText(state.nudgeMs), style = MaterialTheme.typography.bodyMedium)
            OutlinedButton(onClick = { vm.nudge(NUDGE_STEP_MS) }) { Text(stringResource(R.string.nudge_plus)) }
        }
        Text(stringResource(R.string.nudge_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }

    statusLine(state.session)?.let { line ->
        val synced = state.session.syncLabel == "synced"
        Text(
            line,
            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
            color = if (synced) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** The `pasted` option's link: whether one is ready (never its URL), and the way to the link finder. */
@Composable
private fun FoundLinkRow(state: CompanionUi.Listen, vm: CompanionViewModel) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(
            stringResource(if (state.foundLink != null) R.string.found_link_ready else R.string.found_link_none),
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.weight(1f),
        )
        OutlinedButton(onClick = vm::openFinder) {
            Text(stringResource(if (state.listening && state.foundLink != null) R.string.find_new_link else R.string.find_link))
        }
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
