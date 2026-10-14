package io.github.mickeiik.izle.ui.player

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.media3.common.Player
import androidx.media3.ui.compose.ContentFrame
import androidx.media3.ui.compose.SURFACE_TYPE_SURFACE_VIEW
import androidx.tv.material3.Button
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.OutlinedButton
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import io.github.mickeiik.izle.R
import io.github.mickeiik.izle.domain.EpisodeNames
import io.github.mickeiik.izle.player.PlayerPhase
import io.github.mickeiik.izle.player.PlayerUi
import io.github.mickeiik.izle.ui.common.FullScreenMessage
import io.github.mickeiik.izle.ui.common.PauseIcon
import io.github.mickeiik.izle.ui.common.PlayIcon
import io.github.mickeiik.izle.ui.common.ProgressBar
import io.github.mickeiik.izle.ui.common.Spinner
import io.github.mickeiik.izle.ui.common.episodeNameText
import io.github.mickeiik.izle.ui.common.formatTime
import io.github.mickeiik.izle.ui.theme.IzleColors

/** Video only; information appears for a few seconds after a key press, or as a large overlay at the end. */
@Composable
fun PlayerScreen(ui: PlayerUi, player: Player?, onPlayNext: () -> Unit, onHome: () -> Unit, onRetry: () -> Unit) {
    val view = LocalView.current
    val keepOn = (ui.phase == PlayerPhase.Playing || ui.phase == PlayerPhase.Loading) && ui.playWhenReady
    DisposableEffect(keepOn) {
        view.keepScreenOn = keepOn
        onDispose { view.keepScreenOn = false }
    }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        if (player != null && ui.phase !is PlayerPhase.Failed && ui.phase != PlayerPhase.Finished) {
            ContentFrame(player, modifier = Modifier.fillMaxSize(), surfaceType = SURFACE_TYPE_SURFACE_VIEW, contentScale = ContentScale.Fit)
        }
        val cues = ui.cues
        if (cues != null && ui.phase == PlayerPhase.Playing) {
            Text(
                cues,
                style = MaterialTheme.typography.headlineSmall,
                color = Color.White,
                textAlign = TextAlign.Center,
                modifier = Modifier.align(Alignment.BottomCenter)
                    .padding(bottom = if (ui.showInfo) 190.dp else 40.dp, start = 64.dp, end = 64.dp)
                    .background(Color(0xB3000000), RoundedCornerShape(8.dp))
                    .padding(horizontal = 16.dp, vertical = 6.dp),
            )
        }
        when (val phase = ui.phase) {
            PlayerPhase.Idle -> Unit
            PlayerPhase.Loading -> LoadingOverlay(ui)
            PlayerPhase.Playing -> {
                if (ui.buffering) Spinner(Modifier.align(Alignment.Center))
                if (!ui.playWhenReady && !ui.showInfo) {
                    Box(
                        Modifier.align(Alignment.TopEnd).padding(32.dp).background(IzleColors.Scrim, RoundedCornerShape(16.dp)).padding(16.dp),
                    ) { PauseIcon(Modifier.size(48.dp)) }
                }
                if (ui.showInfo) InfoPanel(ui, Modifier.align(Alignment.BottomCenter))
            }
            is PlayerPhase.UpNext -> UpNextOverlay(ui, phase, onPlayNext, onHome)
            PlayerPhase.Finished -> FullScreenMessage(stringResource(R.string.finished), ui.item?.title)
            is PlayerPhase.Failed -> FailedOverlay(ui, onRetry, onHome)
        }
    }
}

@Composable
private fun episodeLine(ui: PlayerUi): String? {
    val item = ui.item ?: return null
    val ep = ui.episode ?: return null
    val name = episodeNameText(EpisodeNames.name(item.kind, ep.season, ep.number, ep.label, ep.index)) ?: return null
    return if (ep.title.isNullOrBlank()) name else "$name · ${ep.title}"
}

@Composable
private fun LoadingOverlay(ui: PlayerUi) {
    Box(Modifier.fillMaxSize().background(Color.Black), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Spinner()
            Spacer(Modifier.height(32.dp))
            Text(ui.item?.title ?: stringResource(R.string.loading), style = MaterialTheme.typography.displaySmall, color = IzleColors.OnSurface)
            episodeLine(ui)?.let { Text(it, style = MaterialTheme.typography.headlineSmall, color = IzleColors.Accent) }
        }
    }
}

@Composable
private fun InfoPanel(ui: PlayerUi, modifier: Modifier) {
    val duration = ui.durationMs ?: 0
    val position = ui.seekPreviewMs ?: ui.positionMs
    Column(
        modifier.fillMaxWidth()
            .background(Brush.verticalGradient(listOf(Color.Transparent, Color(0xF0000000))))
            .padding(start = 64.dp, end = 64.dp, top = 64.dp, bottom = 40.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (ui.playWhenReady) PlayIcon(Modifier.size(44.dp)) else PauseIcon(Modifier.size(44.dp))
            Spacer(Modifier.width(20.dp))
            Column {
                Text(ui.item?.title.orEmpty(), style = MaterialTheme.typography.headlineMedium, color = IzleColors.OnSurface, maxLines = 1, overflow = TextOverflow.Ellipsis)
                episodeLine(ui)?.let { Text(it, style = MaterialTheme.typography.titleLarge, color = IzleColors.Accent, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                if (!ui.playWhenReady) Text(stringResource(R.string.paused), style = MaterialTheme.typography.titleLarge, color = IzleColors.Dim)
            }
        }
        Spacer(Modifier.height(20.dp))
        ProgressBar(if (duration > 0) position.toFloat() / duration else 0f, height = 10.dp)
        Spacer(Modifier.height(8.dp))
        Row(Modifier.fillMaxWidth()) {
            Text(formatTime(position), style = MaterialTheme.typography.titleLarge, color = if (ui.seekPreviewMs != null) IzleColors.Accent else IzleColors.OnSurface)
            Spacer(Modifier.weight(1f))
            if (duration > 0) Text(formatTime(duration), style = MaterialTheme.typography.titleLarge, color = IzleColors.Dim)
        }
    }
}

@Composable
private fun Poster(url: String?, modifier: Modifier = Modifier) {
    Box(modifier.width(220.dp).height(330.dp).clip(RoundedCornerShape(16.dp)).background(IzleColors.Surface)) {
        if (url != null) AsyncImage(model = url, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
    }
}

@Composable
private fun UpNextOverlay(ui: PlayerUi, phase: PlayerPhase.UpNext, onPlayNext: () -> Unit, onHome: () -> Unit) {
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    val next = phase.next
    val name = ui.item?.let { episodeNameText(EpisodeNames.name(it.kind, next.season, next.number, next.label, (ui.episode?.index ?: 0) + 1)) }
    // Opaque: end credits behind the countdown would make it hard to read.
    Box(Modifier.fillMaxSize().background(IzleColors.Background), contentAlignment = Alignment.Center) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(48.dp)) {
            Poster(ui.posterUrl)
            Column(Modifier.widthIn(max = 560.dp)) {
                Text(stringResource(R.string.up_next), style = MaterialTheme.typography.headlineSmall, color = IzleColors.Dim)
                Text(name ?: ui.item?.title.orEmpty(), style = MaterialTheme.typography.displayMedium, color = IzleColors.OnSurface)
                if (!next.title.isNullOrBlank()) Text(next.title, style = MaterialTheme.typography.headlineSmall, color = IzleColors.OnSurface)
                Spacer(Modifier.height(16.dp))
                Text(stringResource(R.string.up_next_countdown, phase.secondsLeft), style = MaterialTheme.typography.headlineMedium, color = IzleColors.Accent)
                Spacer(Modifier.height(28.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                    Button(onClick = onPlayNext, modifier = Modifier.focusRequester(focus)) {
                        Text(stringResource(R.string.play_now), style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp))
                    }
                    OutlinedButton(onClick = onHome) {
                        Text(stringResource(R.string.go_home), style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp))
                    }
                }
            }
        }
    }
}

@Composable
private fun FailedOverlay(ui: PlayerUi, onRetry: () -> Unit, onHome: () -> Unit) {
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    Box(Modifier.fillMaxSize().background(IzleColors.Background), contentAlignment = Alignment.Center) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(48.dp)) {
            Poster(ui.posterUrl)
            Column(Modifier.widthIn(max = 560.dp)) {
                Text(stringResource(R.string.cannot_play), style = MaterialTheme.typography.displaySmall, color = IzleColors.OnSurface)
                ui.item?.title?.let { Text(it, style = MaterialTheme.typography.headlineSmall, color = IzleColors.Dim) }
                Spacer(Modifier.height(32.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                    Button(onClick = onRetry, modifier = Modifier.focusRequester(focus)) {
                        Text(stringResource(R.string.try_again), style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp))
                    }
                    OutlinedButton(onClick = onHome) {
                        Text(stringResource(R.string.go_home), style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp))
                    }
                }
            }
        }
    }
}
