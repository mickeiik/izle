package io.github.mickeiik.izle.ui.common

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
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
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.Hyphens
import androidx.compose.ui.text.style.LineBreak
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import io.github.mickeiik.izle.ui.theme.IzleColors
import io.github.mickeiik.izle.ui.theme.IzleShapes
import io.github.mickeiik.izle.ui.theme.IzleSpacing

/** What happens when ("Starts in 8 s"), and a bar for the time left. */
class PanelCountdown(val text: String, val secondsLeft: Int, val totalSeconds: Int)

class PanelButton(val label: String, val onClick: () -> Unit)

private val PosterWidth = 220.dp
private val PosterHeight = 330.dp
private val TextWidth = 576.dp

/**
 * The full-screen panel of "Up next", autoplay, "Can't play right now", "The end" and the update: the poster (else
 * [showTitle]) always at the same spot, the text beside it. Opaque: the credits or the tiles behind would compete with
 * the countdown. The first button takes the focus: it is what OK does.
 */
@Composable
fun PosterPanel(
    posterUrl: String?,
    showTitle: String?,
    title: String,
    overline: String? = null,
    lines: List<String> = emptyList(),
    countdown: PanelCountdown? = null,
    buttons: List<PanelButton> = emptyList(),
) {
    Box(Modifier.fullScreen()) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(IzleSpacing.Huge),
            modifier = Modifier.align(Alignment.Center).width(PosterWidth + IzleSpacing.Huge + TextWidth),
        ) {
            Box(Modifier.size(PosterWidth, PosterHeight).clip(IzleShapes.Large).background(IzleColors.Surface)) {
                if (posterUrl != null) {
                    AsyncImage(posterUrl, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                } else if (showTitle != null) {
                    // Split at syllables when a word is too long.
                    Text(
                        showTitle,
                        style = MaterialTheme.typography.headlineSmall.copy(hyphens = Hyphens.Auto, lineBreak = LineBreak.Heading),
                        color = IzleColors.Dim,
                        textAlign = TextAlign.Center,
                        maxLines = 5,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.align(Alignment.Center).padding(IzleSpacing.Large),
                    )
                }
            }
            Column(Modifier.width(TextWidth)) {
                if (overline != null) {
                    Text(overline, style = MaterialTheme.typography.headlineSmall, color = IzleColors.Dim, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                Text(title, style = MaterialTheme.typography.displaySmall, color = IzleColors.OnSurface, maxLines = 2, overflow = TextOverflow.Ellipsis)
                lines.forEach {
                    Text(it, style = MaterialTheme.typography.headlineSmall, color = IzleColors.OnSurface, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
                if (countdown != null) {
                    Spacer(Modifier.height(IzleSpacing.XLarge))
                    Text(countdown.text, style = MaterialTheme.typography.headlineMedium, color = IzleColors.Accent)
                    Spacer(Modifier.height(IzleSpacing.Small))
                    CountdownBar(countdown.secondsLeft, countdown.totalSeconds)
                }
                if (buttons.isNotEmpty()) {
                    Spacer(Modifier.height(IzleSpacing.XXLarge))
                    // No key: the panel's state changes every second (the countdown), and the focus must be asked for only once.
                    val focus = remember { FocusRequester() }
                    var firstFocused by remember { mutableStateOf(false) }
                    LaunchedEffect(Unit) { requestFocusWithin({ focus }, took = { firstFocused }) }
                    Row(horizontalArrangement = Arrangement.spacedBy(IzleSpacing.XLarge)) {
                        buttons.forEachIndexed { i, button ->
                            val first = Modifier.focusRequester(focus).onFocusChanged { firstFocused = it.isFocused }
                            TvButton(button.label, button.onClick, if (i == 0) first else Modifier)
                        }
                    }
                }
            }
        }
    }
}

/** Each tick of the view model's countdown starts a one-second linear step: smooth, yet a paused clock holds it. */
@Composable
private fun CountdownBar(secondsLeft: Int, totalSeconds: Int) {
    val total = totalSeconds.coerceAtLeast(1).toFloat()
    val fraction = remember { Animatable((secondsLeft / total).coerceIn(0f, 1f)) }
    LaunchedEffect(secondsLeft) {
        fraction.animateTo(((secondsLeft - 1) / total).coerceIn(0f, 1f), tween(1_000, easing = LinearEasing))
    }
    Box(
        Modifier.fillMaxWidth().height(10.dp).drawBehind {
            val radius = CornerRadius(size.height / 2)
            drawRoundRect(IzleColors.ProgressTrack, cornerRadius = radius)
            drawRoundRect(IzleColors.Accent, size = Size(size.width * fraction.value, size.height), cornerRadius = radius)
        },
    )
}
