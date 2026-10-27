package io.github.mickeiik.izle.companion.ui

import android.os.SystemClock
import android.text.format.DateUtils
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import coil3.compose.AsyncImage
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleStartEffect
import io.github.mickeiik.izle.companion.R
import io.github.mickeiik.izle.data.api.NowResponse
import io.github.mickeiik.izle.domain.IsoTime
import kotlinx.coroutines.delay

/**
 * The TV page's Now tab: whether the TV is online, what it plays (followed with `GET …/now` while shown), Listen
 * along (or the listening bar while this phone listens), the remote and a message for the TV.
 */
@Composable
fun NowTab(state: CompanionUi.Tv, vm: CompanionViewModel, modifier: Modifier = Modifier) {
    LifecycleStartEffect(vm, state.tvId) {
        vm.startFollowingNow()
        onStopOrDispose { vm.stopFollowingNow() }
    }
    var messageOpen by rememberSaveable { mutableStateOf(false) }

    Column(modifier = modifier.fillMaxSize()) {
        if (state.now == null) LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
        Column(
            modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(
                onlineText(state),
                style = MaterialTheme.typography.labelLarge,
                color = if (state.online) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
            )
            state.now?.let { NowCard(it, state.nowAtMs, state.posterUrl) }
            ListenAlongEntry(state, vm)
            Text(stringResource(R.string.remote), style = MaterialTheme.typography.titleMedium)
            Remote(state.now, vm)
            EqualRow {
                ChoiceButton(stringResource(R.string.stop_the_tv), onClick = { vm.remote("stop") }, modifier = Modifier.weight(1f))
            }
            EqualRow {
                ChoiceButton(stringResource(R.string.send_message), onClick = { messageOpen = true }, modifier = Modifier.weight(1f))
            }
        }
    }

    if (messageOpen) {
        MessageSheet(
            tvName = state.displayName,
            onSend = { text, seconds ->
                vm.sendMessage(text, seconds)
                messageOpen = false
            },
            onDismiss = { messageOpen = false },
        )
    }
}

@Composable
private fun onlineText(state: CompanionUi.Tv): String {
    if (state.online) return stringResource(R.string.tv_online)
    val at = state.device?.lastSeenAt?.let(IsoTime::parseEpochMs) ?: return stringResource(R.string.tv_offline)
    val ago = DateUtils.getRelativeTimeSpanString(at, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS).toString()
    return stringResource(R.string.tv_offline_seen, ago)
}

/** What plays: the title, the episode, a progress bar and `12:04 / 30:10 · playing`, moved on from the anchor. */
@Composable
private fun NowCard(now: NowResponse, nowAtMs: Long, posterUrl: String?) {
    val n = now.nowPlaying
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            if (n == null || !isPlayingNow(now)) {
                Text(stringResource(R.string.nothing_is_playing), style = MaterialTheme.typography.titleMedium)
                return@Column
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                if (posterUrl != null) {
                    AsyncImage(
                        posterUrl,
                        contentDescription = null,
                        contentScale = ContentScale.Crop,
                        modifier = Modifier.size(width = 48.dp, height = 72.dp).clip(RoundedCornerShape(4.dp)),
                    )
                }
                Text(n.itemTitle ?: n.itemId, style = MaterialTheme.typography.titleLarge)
            }
            if (n.isLive) {
                Text(stringResource(R.string.channel_line, n.state), style = MaterialTheme.typography.bodyMedium)
                return@Column
            }
            n.episodeTitle?.takeIf { it != n.itemTitle }?.let { Text(it, style = MaterialTheme.typography.bodyLarge) }
            // Ticks once a second while the TV plays.
            var clock by remember { mutableLongStateOf(SystemClock.elapsedRealtime()) }
            val moving = now.anchor?.playing == true
            LaunchedEffect(nowAtMs, moving) {
                clock = SystemClock.elapsedRealtime()
                while (moving) {
                    delay(1_000)
                    clock = SystemClock.elapsedRealtime()
                }
            }
            val position = tvPositionAfter(now, (clock - nowAtMs).coerceAtLeast(0)) ?: 0
            progressFraction(position, n.durationMs)?.let { LinearProgressIndicator(progress = { it }, modifier = Modifier.fillMaxWidth()) }
            Text(
                progressText(position, n.durationMs, n.state),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/** While this phone listens to this TV: the listening bar (tap: Listen along); else Listen along, or why not. */
@Composable
private fun ListenAlongEntry(state: CompanionUi.Tv, vm: CompanionViewModel) {
    val target = state.session.target
    if (state.listening && target?.deviceId == state.tvId) {
        val source = state.options.firstOrNull { it.sourceId == target.sourceId && it.language == target.language }?.label ?: target.sourceId
        Surface(
            color = MaterialTheme.colorScheme.primaryContainer,
            shape = MaterialTheme.shapes.medium,
            modifier = Modifier.fillMaxWidth().clickable(onClick = vm::openListen),
        ) {
            Row(modifier = Modifier.padding(start = 16.dp, end = 8.dp, top = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(stringResource(R.string.listening_bar, listeningWord(state.session)), style = MaterialTheme.typography.titleSmall)
                    Text(source, style = MaterialTheme.typography.bodySmall, maxLines = 1)
                }
                TextButton(onClick = vm::stopListening) { Text(stringResource(R.string.stop)) }
            }
        }
        return
    }
    val why = nothingToListenText(state.now, state.displayName)
    when {
        why != null -> Text(why, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        state.now != null -> Button(onClick = vm::openListen, modifier = Modifier.fillMaxWidth().height(56.dp)) {
            Text(stringResource(R.string.listen_along), style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center, maxLines = 1)
        }
    }
}

/**
 * Previous, −30 s, Play/Pause, +30 s, Next in one row of equal buttons; a channel has no seek or pause, only its
 * Previous channel and Next channel.
 */
@Composable
private fun Remote(now: NowResponse?, vm: CompanionViewModel) {
    val n = now?.nowPlaying
    if (n?.isLive == true) {
        EqualRow {
            ChoiceButton(stringResource(R.string.previous_channel), onClick = { vm.remote("previous") }, modifier = Modifier.weight(1f))
            ChoiceButton(stringResource(R.string.next_channel), onClick = { vm.remote("next") }, modifier = Modifier.weight(1f))
        }
        return
    }
    val playing = n?.state == "playing"
    EqualRow {
        RemoteButton(RemoteIcons.SkipPrevious, stringResource(R.string.previous_episode)) { vm.remote("previous") }
        val thirty = stringResource(R.string.seek_30)
        RemoteButton(RemoteIcons.FastRewind, stringResource(R.string.back_30), label = thirty) { vm.remote("seek", -SEEK_MS) }
        if (playing) {
            RemoteButton(RemoteIcons.Pause, stringResource(R.string.pause)) { vm.remote("pause") }
        } else {
            RemoteButton(Icons.Filled.PlayArrow, stringResource(R.string.play)) { vm.remote("resume") }
        }
        RemoteButton(RemoteIcons.FastForward, stringResource(R.string.forward_30), label = thirty) { vm.remote("seek", SEEK_MS) }
        RemoteButton(RemoteIcons.SkipNext, stringResource(R.string.next_episode)) { vm.remote("next") }
    }
}

@Composable
private fun RowScope.RemoteButton(icon: ImageVector, description: String, label: String? = null, onClick: () -> Unit) {
    FilledTonalButton(
        onClick = onClick,
        contentPadding = PaddingValues(0.dp),
        modifier = Modifier.weight(1f).height(56.dp).semantics { contentDescription = description },
    ) {
        Icon(icon, contentDescription = null, modifier = Modifier.size(24.dp))
        if (label != null) Text(label, style = MaterialTheme.typography.labelMedium, maxLines = 1)
    }
}

private const val SEEK_MS = 30_000L

/** The message's choices of how long it shows, in seconds; 1 min by default. */
private val MESSAGE_SECONDS = listOf(15, 60, 120)
private const val DEFAULT_SECONDS = 60

/** "Send a message to the TV": its text (1–200 characters), how long it shows, Send. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MessageSheet(tvName: String, onSend: (String, Int) -> Unit, onDismiss: () -> Unit) {
    var text by rememberSaveable { mutableStateOf("") }
    var seconds by rememberSaveable { mutableIntStateOf(DEFAULT_SECONDS) }
    val max = CompanionViewModel.MESSAGE_MAX
    val valid = text.isNotBlank() && text.trim().length <= max
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(modifier = Modifier.padding(start = 16.dp, end = 16.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(stringResource(R.string.message_title, tvName), style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                label = { Text(stringResource(R.string.message_label)) },
                isError = text.trim().length > max,
                supportingText = { Text(stringResource(R.string.message_counter, text.trim().length, max)) },
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                minLines = 2,
                modifier = Modifier.fillMaxWidth(),
            )
            Text(stringResource(R.string.show_for), style = MaterialTheme.typography.labelLarge)
            EqualRow {
                for (s in MESSAGE_SECONDS) {
                    val label = when (s) {
                        15 -> stringResource(R.string.show_15s)
                        60 -> stringResource(R.string.show_1min)
                        else -> stringResource(R.string.show_2min)
                    }
                    ChoiceButton(label, onClick = { seconds = s }, selected = seconds == s, modifier = Modifier.weight(1f))
                }
            }
            Button(onClick = { onSend(text, seconds) }, enabled = valid, modifier = Modifier.fillMaxWidth().height(48.dp)) {
                Text(stringResource(R.string.send), textAlign = TextAlign.Center, maxLines = 1)
            }
        }
    }
}
