package io.github.mickeiik.izle.ui.player

import androidx.compose.foundation.background
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
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
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
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import io.github.mickeiik.izle.R
import io.github.mickeiik.izle.domain.EpisodeNames
import io.github.mickeiik.izle.domain.PlaybackPlan
import io.github.mickeiik.izle.player.PlayerPhase
import io.github.mickeiik.izle.player.PlayerUi
import io.github.mickeiik.izle.ui.common.PanelButton
import io.github.mickeiik.izle.ui.common.PanelCountdown
import io.github.mickeiik.izle.ui.common.PauseIcon
import io.github.mickeiik.izle.ui.common.PlayIcon
import io.github.mickeiik.izle.ui.common.PosterPanel
import io.github.mickeiik.izle.ui.common.ProgressBar
import io.github.mickeiik.izle.ui.common.Spinner
import io.github.mickeiik.izle.ui.common.episodeNameText
import io.github.mickeiik.izle.ui.common.formatTime
import io.github.mickeiik.izle.ui.common.fullScreen
import io.github.mickeiik.izle.ui.theme.IzleColors
import io.github.mickeiik.izle.ui.theme.IzleShapes
import io.github.mickeiik.izle.ui.theme.IzleSpacing

/** Where the information panel's shade goes from clear to dark, above its text. */
private val InfoFade = 48.dp

/** Video only; information appears for a few seconds after a key press, or as a large panel at the end. */
@Composable
fun PlayerScreen(ui: PlayerUi, player: Player?, onPlayNext: () -> Unit, onHome: () -> Unit, onRetry: () -> Unit) {
    val view = LocalView.current
    val keepOn = (ui.phase == PlayerPhase.Playing || ui.phase == PlayerPhase.Loading) && ui.playWhenReady
    DisposableEffect(keepOn) {
        view.keepScreenOn = keepOn
        onDispose { view.keepScreenOn = false }
    }

    Box(Modifier.fillMaxSize().background(IzleColors.Video)) {
        if (player != null && ui.phase !is PlayerPhase.Failed && ui.phase != PlayerPhase.Finished) {
            ContentFrame(player, modifier = Modifier.fillMaxSize(), surfaceType = SURFACE_TYPE_SURFACE_VIEW, contentScale = ContentScale.Fit)
        }
        when (val phase = ui.phase) {
            PlayerPhase.Idle -> Unit
            PlayerPhase.Loading -> LoadingOverlay(ui)
            PlayerPhase.Playing -> {
                if (ui.buffering) Spinner(Modifier.align(Alignment.Center))
                if (!ui.playWhenReady && !ui.showInfo && !ui.live) {
                    Box(
                        Modifier.align(Alignment.TopEnd)
                            .padding(IzleSpacing.Safe)
                            .background(IzleColors.Scrim, IzleShapes.Large)
                            .padding(IzleSpacing.Large),
                    ) { PauseIcon(Modifier.size(48.dp)) }
                }
                // Subtitles sit just above the information panel while it shows.
                Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                    ui.cues?.let { Captions(it, Modifier.padding(bottom = if (ui.showInfo) IzleSpacing.Small else IzleSpacing.SafeVertical + IzleSpacing.Large)) }
                    if (ui.showInfo) InfoPanel(ui)
                }
            }
            is PlayerPhase.UpNext -> {
                val next = phase.next
                val name = ui.item?.let { episodeNameText(EpisodeNames.name(it.kind, next.season, next.number, next.label, (ui.episode?.index ?: 0) + 1)) }
                PosterPanel(
                    ui.posterUrl, ui.item?.title, overline = stringResource(R.string.up_next), title = name ?: ui.item?.title.orEmpty(),
                    lines = listOfNotNull(next.title?.takeIf { it.isNotBlank() }),
                    countdown = PanelCountdown(stringResource(R.string.up_next_countdown, phase.secondsLeft), phase.secondsLeft, PlaybackPlan.AUTO_NEXT_COUNTDOWN_SEC),
                    buttons = listOf(PanelButton(stringResource(R.string.play_now), onPlayNext), PanelButton(stringResource(R.string.go_home), onHome)),
                )
            }
            PlayerPhase.Finished -> PosterPanel(ui.posterUrl, ui.item?.title, title = stringResource(R.string.finished), lines = listOfNotNull(ui.item?.title))
            is PlayerPhase.Failed -> PosterPanel(
                ui.posterUrl, ui.item?.title, title = stringResource(R.string.cannot_play), lines = listOfNotNull(ui.item?.title),
                countdown = PanelCountdown(stringResource(R.string.auto_home_countdown, phase.secondsLeft), phase.secondsLeft, PlaybackPlan.FAILED_AUTO_HOME_SEC),
                buttons = listOf(PanelButton(stringResource(R.string.try_again), onRetry), PanelButton(stringResource(R.string.go_home), onHome)),
            )
        }
    }
}

/** What is playing under the title: the episode, or "Live" for a channel. */
@Composable
private fun episodeLine(ui: PlayerUi): String? {
    if (ui.live) return stringResource(R.string.badge_live)
    val item = ui.item ?: return null
    val ep = ui.episode ?: return null
    val name = episodeNameText(EpisodeNames.name(item.kind, ep.season, ep.number, ep.label, ep.index)) ?: return null
    return if (ep.title.isNullOrBlank()) name else "$name · ${ep.title}"
}

@Composable
private fun Captions(text: String, modifier: Modifier) {
    Text(
        text,
        style = MaterialTheme.typography.headlineSmall,
        color = IzleColors.OnCaption,
        textAlign = TextAlign.Center,
        modifier = modifier
            .padding(horizontal = IzleSpacing.SafeHorizontal + IzleSpacing.Large)
            .background(IzleColors.Caption, IzleShapes.Small)
            .padding(horizontal = IzleSpacing.Large, vertical = 6.dp),
    )
}

@Composable
private fun LoadingOverlay(ui: PlayerUi) {
    Box(Modifier.fullScreen(IzleColors.Video), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Spinner()
            Spacer(Modifier.height(IzleSpacing.XXLarge))
            Text(
                ui.item?.title ?: stringResource(R.string.loading),
                style = MaterialTheme.typography.displaySmall,
                color = IzleColors.OnSurface,
                textAlign = TextAlign.Center,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            episodeLine(ui)?.let { Text(it, style = MaterialTheme.typography.headlineSmall, color = IzleColors.Accent, maxLines = 1, overflow = TextOverflow.Ellipsis) }
        }
    }
}

/** The information's shade: clear at the top, dark behind the text, over the bottom of the video. */
private fun Modifier.infoShade(): Modifier = fillMaxWidth()
    .drawBehind {
        val dark = (InfoFade.toPx() / size.height).coerceIn(0f, 1f)
        drawRect(Brush.verticalGradient(0f to Color.Transparent, dark to IzleColors.InfoShade, 1f to IzleColors.InfoShade))
    }
    .padding(start = IzleSpacing.SafeHorizontal, end = IzleSpacing.SafeHorizontal, top = InfoFade + IzleSpacing.Small, bottom = IzleSpacing.SafeVertical)

/** Title, episode, position, on the dark part of the shade; a channel only its name and "Live" (nothing about time). */
@Composable
private fun InfoPanel(ui: PlayerUi) {
    val duration = ui.durationMs ?: 0
    val position = ui.seekPreviewMs ?: ui.positionMs
    val paused = !ui.playWhenReady && !ui.live
    Column(Modifier.infoShade()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (!ui.live) {
                if (paused) PauseIcon(Modifier.size(44.dp)) else PlayIcon(Modifier.size(44.dp))
                Spacer(Modifier.width(IzleSpacing.XLarge))
            }
            Column {
                Text(ui.item?.title.orEmpty(), style = MaterialTheme.typography.headlineMedium, color = IzleColors.OnSurface, maxLines = 1, overflow = TextOverflow.Ellipsis)
                episodeLine(ui)?.let { Text(it, style = MaterialTheme.typography.titleLarge, color = IzleColors.Accent, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                if (paused) Text(stringResource(R.string.paused), style = MaterialTheme.typography.titleLarge, color = IzleColors.Dim)
            }
        }
        if (!ui.live) {
            Spacer(Modifier.height(IzleSpacing.XLarge))
            ProgressBar(if (duration > 0) position.toFloat() / duration else 0f, height = 10.dp)
            Spacer(Modifier.height(IzleSpacing.Small))
            Row(Modifier.fillMaxWidth()) {
                val color = if (ui.seekPreviewMs != null) IzleColors.Accent else IzleColors.OnSurface
                Text(formatTime(position), style = MaterialTheme.typography.titleLarge, color = color)
                Spacer(Modifier.weight(1f))
                if (duration > 0) Text(formatTime(duration), style = MaterialTheme.typography.titleLarge, color = IzleColors.Dim)
            }
        }
    }
}
