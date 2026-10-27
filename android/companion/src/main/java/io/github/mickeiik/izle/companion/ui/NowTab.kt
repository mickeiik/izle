package io.github.mickeiik.izle.companion.ui

import android.os.SystemClock
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.lifecycle.compose.LifecycleStartEffect
import io.github.mickeiik.izle.companion.R
import io.github.mickeiik.izle.companion.tv.timeAgo
import io.github.mickeiik.izle.companion.ui.design.ButtonKind
import io.github.mickeiik.izle.companion.ui.design.ButtonRow
import io.github.mickeiik.izle.companion.ui.design.ButtonSize
import io.github.mickeiik.izle.companion.ui.design.Caption
import io.github.mickeiik.izle.companion.ui.design.Card
import io.github.mickeiik.izle.companion.ui.design.ChoiceGrid
import io.github.mickeiik.izle.companion.ui.design.EmptyState
import io.github.mickeiik.izle.companion.ui.design.IzleButton
import io.github.mickeiik.izle.companion.ui.design.IzleIcons
import io.github.mickeiik.izle.companion.ui.design.IzleSheet
import io.github.mickeiik.izle.companion.ui.design.IzleTheme
import io.github.mickeiik.izle.companion.ui.design.Poster
import io.github.mickeiik.izle.companion.ui.design.ProgressBar
import io.github.mickeiik.izle.companion.ui.design.RemoteBar
import io.github.mickeiik.izle.companion.ui.design.RemoteKey
import io.github.mickeiik.izle.companion.ui.design.StatusLine
import io.github.mickeiik.izle.companion.ui.design.Tone
import io.github.mickeiik.izle.data.api.NowResponse
import io.github.mickeiik.izle.domain.IsoTime
import kotlinx.coroutines.delay

/**
 * The TV page's Now tab: whether the TV is online, what it plays (followed with `GET …/now` while shown), Listen
 * along (or the listening bar while this phone listens), the remote, Stop the TV and a message for the TV.
 */
@Composable
fun NowTab(state: CompanionUi.Tv, vm: CompanionViewModel, modifier: Modifier = Modifier) {
    LifecycleStartEffect(vm, state.tvId) {
        vm.startFollowingNow()
        onStopOrDispose { vm.stopFollowingNow() }
    }
    var messageOpen by rememberSaveable { mutableStateOf(false) }
    NowContent(
        state,
        onRemote = vm::remote,
        onListen = vm::openListen,
        onStopListening = vm::stopListening,
        onMessage = { messageOpen = true },
        modifier = modifier,
    )
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

/** Now's content, without the view model: [onRemote] gets a command's type and, for a seek, its delta. */
@Composable
internal fun NowContent(
    state: CompanionUi.Tv,
    onRemote: (String, Long?) -> Unit,
    onListen: () -> Unit,
    onStopListening: () -> Unit,
    onMessage: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val s = IzleTheme.spacing
    Column(modifier = modifier.fillMaxSize()) {
        if (state.now == null) ProgressBar(null)
        Column(
            modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(s.lg),
            verticalArrangement = Arrangement.spacedBy(s.lg),
        ) {
            StatusLine(onlineText(state), if (state.online) Tone.Success else Tone.Neutral)
            val now = state.now
            when {
                now == null -> Unit
                isPlayingNow(now) && now.nowPlaying != null -> NowCard(now, state.nowAtMs, state.posterUrl)
                else -> EmptyState(stringResource(R.string.nothing_is_playing))
            }
            ListenAlongEntry(state, onListen, onStopListening)
            Remote(state.now, onRemote)
            ButtonRow {
                IzleButton(stringResource(R.string.stop_the_tv), onClick = { onRemote("stop", null) }, icon = IzleIcons.Stop)
                IzleButton(stringResource(R.string.message), onClick = onMessage, icon = IzleIcons.Message)
            }
        }
    }
}

/** "Online", or "Offline · seen 5 minutes ago". */
@Composable
private fun onlineText(state: CompanionUi.Tv): String {
    if (state.online) return stringResource(R.string.tv_online)
    val at = state.device?.lastSeenAt?.let(IsoTime::parseEpochMs) ?: return stringResource(R.string.tv_offline)
    return stringResource(R.string.tv_offline_seen, timeAgo(LocalContext.current.resources, at))
}

/** What plays: the poster, the title, the episode, a progress bar and `12:04 / 30:10 · playing`, moved on from the anchor. */
@Composable
private fun NowCard(now: NowResponse, nowAtMs: Long, posterUrl: String?) {
    val n = now.nowPlaying ?: return
    val c = IzleTheme.colors
    Card {
        Row(horizontalArrangement = Arrangement.spacedBy(IzleTheme.spacing.md), verticalAlignment = Alignment.CenterVertically) {
            Poster(posterUrl, IzleTheme.sizes.posterNow)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(IzleTheme.spacing.xs)) {
                Text(n.itemTitle ?: n.itemId, style = IzleTheme.type.heading, color = c.textPrimary, maxLines = 2, overflow = TextOverflow.Ellipsis)
                if (n.isLive) {
                    Caption(stringResource(R.string.channel_line, n.state))
                    return@Column
                }
                n.episodeTitle?.takeIf { it != n.itemTitle }?.let {
                    Text(it, style = IzleTheme.type.body, color = c.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
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
                progressFraction(position, n.durationMs)?.let { ProgressBar(it, Modifier.padding(top = IzleTheme.spacing.xs)) }
                Caption(progressText(position, n.durationMs, n.state))
            }
        }
    }
}

/** While this phone listens to this TV: the listening bar (tap: Listen along); else Listen along, or why not. */
@Composable
private fun ListenAlongEntry(state: CompanionUi.Tv, onListen: () -> Unit, onStop: () -> Unit) {
    val target = state.session.target
    if (state.listening && target?.deviceId == state.tvId) {
        val source = state.options.firstOrNull { it.sourceId == target.sourceId && it.language == target.language }?.label ?: target.sourceId
        Card(accent = true, onClick = onListen, onClickLabel = stringResource(R.string.listen_along)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(IzleTheme.spacing.md)) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(IzleTheme.spacing.line)) {
                    Text(
                        stringResource(R.string.listening_bar, listeningWord(state.session)),
                        style = IzleTheme.type.heading,
                        color = IzleTheme.colors.accent,
                        maxLines = 1,
                    )
                    Caption(source, maxLines = 1)
                }
                IzleButton(stringResource(R.string.stop), onClick = onStop, size = ButtonSize.Small)
            }
        }
        return
    }
    val why = nothingToListenText(state.now, state.displayName)
    when {
        why != null -> Caption(why)
        state.now != null -> IzleButton(
            stringResource(R.string.listen_along),
            onClick = onListen,
            icon = IzleIcons.Headphones,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

/**
 * Previous, −30 s, Play/Pause, +30 s, Next in one row of equal buttons; a channel has no seek or pause, only its
 * Previous channel and Next channel.
 */
@Composable
private fun Remote(now: NowResponse?, onRemote: (String, Long?) -> Unit) {
    val n = now?.nowPlaying
    if (n?.isLive == true) {
        RemoteBar(
            listOf(
                RemoteKey(stringResource(R.string.previous_channel), { onRemote("previous", null) }, IzleIcons.SkipPrevious, stringResource(R.string.previous_channel)),
                RemoteKey(stringResource(R.string.next_channel), { onRemote("next", null) }, IzleIcons.SkipNext, stringResource(R.string.next_channel)),
            ),
        )
        return
    }
    val playing = n?.state == "playing"
    val thirty = stringResource(R.string.seek_30)
    RemoteBar(
        listOf(
            RemoteKey(stringResource(R.string.previous_episode), { onRemote("previous", null) }, IzleIcons.SkipPrevious),
            RemoteKey(stringResource(R.string.back_30), { onRemote("seek", -SEEK_MS) }, IzleIcons.FastRewind, thirty),
            if (playing) RemoteKey(stringResource(R.string.pause), { onRemote("pause", null) }, IzleIcons.Pause, primary = true)
            else RemoteKey(stringResource(R.string.play), { onRemote("resume", null) }, Icons.Filled.PlayArrow, primary = true),
            RemoteKey(stringResource(R.string.forward_30), { onRemote("seek", SEEK_MS) }, IzleIcons.FastForward, thirty),
            RemoteKey(stringResource(R.string.next_episode), { onRemote("next", null) }, IzleIcons.SkipNext),
        ),
    )
}

private const val SEEK_MS = 30_000L

/** The message's choices of how long it shows, in seconds; 1 min by default. */
private val MESSAGE_SECONDS = listOf(15, 60, 120)
private const val DEFAULT_SECONDS = 60

/** "A message for Salon": its text (1–200 characters), how long it shows, Send. */
@Composable
private fun MessageSheet(tvName: String, onSend: (String, Int) -> Unit, onDismiss: () -> Unit) {
    var text by rememberSaveable { mutableStateOf("") }
    var seconds by rememberSaveable { mutableIntStateOf(DEFAULT_SECONDS) }
    val max = CompanionViewModel.MESSAGE_MAX
    val valid = text.isNotBlank() && text.trim().length <= max
    val labels = mapOf(15 to stringResource(R.string.show_15s), 60 to stringResource(R.string.show_1min), 120 to stringResource(R.string.show_2min))
    IzleSheet(onDismiss = onDismiss, title = stringResource(R.string.message_title, tvName)) {
        OutlinedTextField(
            value = text,
            onValueChange = { text = it },
            label = { Text(stringResource(R.string.message)) },
            isError = text.trim().length > max,
            supportingText = { Text(stringResource(R.string.message_counter, text.trim().length, max)) },
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
            minLines = 2,
            modifier = Modifier.fillMaxWidth(),
        )
        Caption(stringResource(R.string.show_for))
        ChoiceGrid(MESSAGE_SECONDS, label = { labels.getValue(it) }, selected = { it == seconds }, onSelect = { seconds = it })
        IzleButton(
            stringResource(R.string.send),
            onClick = { onSend(text, seconds) },
            kind = ButtonKind.Primary,
            enabled = valid,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}
