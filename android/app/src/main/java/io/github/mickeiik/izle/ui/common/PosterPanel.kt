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
import androidx.compose.runtime.withFrameNanos
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

/** A countdown in a [PosterPanel]: what happens when ("Starts in 8 s"), and a bar for the time left. */
class PanelCountdown(val text: String, val secondsLeft: Int, val totalSeconds: Int)

/** A button of a [PosterPanel]. */
class PanelButton(val label: String, val onClick: () -> Unit)

private val PosterWidth = 220.dp
private val PosterHeight = 330.dp
private val PosterGap = 48.dp
private val TextWidth = 576.dp

/**
 * The full-screen panel of "Up next", autoplay on start, "Can't play right now" and "The end". The poster is
 * always at the same spot (left of the centre, vertically centred), the text beside it always in the same order:
 * a small line above the title, the title, up to two lines under it, the countdown with its bar, the buttons.
 * Opaque: the end credits or the tiles behind would compete with the countdown.
 *
 * The first button takes the focus and comes first: it is what OK does (Play now, Try again). With no buttons
 * nothing here can take the focus.
 */
@Composable
fun PosterPanel(
    posterUrl: String?,
    /** The show's name, drawn in the poster's place when it has none (as on its Home tile). */
    showTitle: String?,
    title: String,
    modifier: Modifier = Modifier,
    overline: String? = null,
    lines: List<String> = emptyList(),
    countdown: PanelCountdown? = null,
    buttons: List<PanelButton> = emptyList(),
) {
    Box(modifier.fillMaxSize().background(IzleColors.Background).padding(IzleSpacing.Safe)) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(PosterGap),
            modifier = Modifier.align(Alignment.Center).width(PosterWidth + PosterGap + TextWidth),
        ) {
            Box(Modifier.size(PosterWidth, PosterHeight).clip(IzleShapes.Large).background(IzleColors.Surface)) {
                if (posterUrl != null) {
                    AsyncImage(model = posterUrl, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                } else if (showTitle != null) {
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
                    CountdownBar(countdown.secondsLeft, countdown.totalSeconds, Modifier.fillMaxWidth())
                }
                if (buttons.isNotEmpty()) {
                    Spacer(Modifier.height(IzleSpacing.XXLarge))
                    PanelButtons(buttons)
                }
            }
        }
    }
}

@Composable
private fun PanelButtons(buttons: List<PanelButton>) {
    // No key: the panel's state changes every second (the countdown), and the focus must be asked for only once.
    val focus = remember { FocusRequester() }
    var firstFocused by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        // The panel may still be laying out on the first frame; try for a few frames.
        repeat(10) {
            withFrameNanos { }
            if (runCatching { focus.requestFocus() }.isSuccess && firstFocused) return@LaunchedEffect
        }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(IzleSpacing.XLarge)) {
        buttons.forEachIndexed { i, button ->
            val first = if (i == 0) Modifier.focusRequester(focus).onFocusChanged { firstFocused = it.isFocused } else Modifier
            TvButton(button.label, button.onClick, first)
        }
    }
}

/**
 * The time left of a countdown that the view model ticks once a second. Each tick starts one linear step of at most
 * a second towards the next value, so the bar moves smoothly and is empty when the countdown runs out; there is no
 * frame loop and no animation measured against a clock, so a paused clock (the UI tests') simply holds it.
 */
@Composable
private fun CountdownBar(secondsLeft: Int, totalSeconds: Int, modifier: Modifier = Modifier) {
    val total = totalSeconds.coerceAtLeast(1).toFloat()
    val fraction = remember { Animatable((secondsLeft / total).coerceIn(0f, 1f)) }
    LaunchedEffect(secondsLeft) {
        fraction.animateTo(((secondsLeft - 1) / total).coerceIn(0f, 1f), tween(1_000, easing = LinearEasing))
    }
    Box(
        modifier.height(10.dp).drawBehind {
            val radius = CornerRadius(size.height / 2)
            drawRoundRect(IzleColors.ProgressTrack, cornerRadius = radius)
            drawRoundRect(IzleColors.Accent, size = Size(size.width * fraction.value, size.height), cornerRadius = radius)
        },
    )
}
