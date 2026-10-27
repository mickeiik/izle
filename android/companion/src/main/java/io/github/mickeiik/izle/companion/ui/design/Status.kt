package io.github.mickeiik.izle.companion.ui.design

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage

/** What a status says: colour only where it means something. [Neutral] is plain secondary text. */
enum class Tone { Neutral, Accent, Success, Warning, Danger }

/** The tone's colour (text, icon, dot); [Tone.Neutral] is `textSecondary`. */
@Composable
fun toneColor(tone: Tone): Color {
    val c = IzleTheme.colors
    return when (tone) {
        Tone.Neutral -> c.textSecondary
        Tone.Accent -> c.accent
        Tone.Success -> c.success
        Tone.Warning -> c.warning
        Tone.Danger -> c.danger
    }
}

@Composable
private fun toneFill(tone: Tone): Color {
    val c = IzleTheme.colors
    return when (tone) {
        Tone.Neutral -> c.surfaceMuted
        Tone.Accent -> c.accentMuted
        Tone.Success -> c.successMuted
        Tone.Warning -> c.warningMuted
        Tone.Danger -> c.dangerMuted
    }
}

/**
 * A small status chip: the tone's muted fill with its colour as text, radius `sm`. Draw it only when it says
 * something (on Home: Fails and Works with warnings).
 */
@Composable
fun StatusChip(text: String, tone: Tone, modifier: Modifier = Modifier) {
    Text(
        text,
        style = IzleTheme.type.chip,
        color = toneColor(tone),
        maxLines = 1,
        modifier = modifier
            .clip(RoundedCornerShape(IzleTheme.radii.sm))
            .background(toneFill(tone))
            .padding(horizontal = IzleTheme.spacing.sm, vertical = IzleTheme.spacing.line),
    )
}

/** An 8 dp dot in the tone's colour, then `caption` text: "Online", "Offline · seen 5 min ago". */
@Composable
fun StatusLine(text: String, tone: Tone, modifier: Modifier = Modifier) {
    val dot = when (tone) {
        Tone.Neutral -> IzleTheme.colors.textMuted
        else -> toneColor(tone)
    }
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(IzleTheme.spacing.sm)) {
        Box(Modifier.size(IzleTheme.sizes.statusDot).clip(CircleShape).background(dot))
        Text(text, style = IzleTheme.type.caption, color = IzleTheme.colors.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** A poster at [size] (`IzleTheme.sizes.posterRow` or `posterNow`): radius `sm`, cropped, `surfaceMuted` until loaded or without [url]. */
@Composable
fun Poster(url: String?, size: DpSize, modifier: Modifier = Modifier) {
    Box(modifier.size(size).clip(RoundedCornerShape(IzleTheme.radii.sm)).background(IzleTheme.colors.surfaceMuted)) {
        if (url != null) AsyncImage(url, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
    }
}

/**
 * A 4 dp progress bar, `accent` on `surfaceMuted`, full width: [fraction] 0–1, or null while something loads (moving).
 */
@Composable
fun ProgressBar(fraction: Float?, modifier: Modifier = Modifier) {
    val c = IzleTheme.colors
    val m = modifier.fillMaxWidth().height(IzleTheme.sizes.progress)
    if (fraction == null) {
        LinearProgressIndicator(modifier = m, color = c.accent, trackColor = c.surfaceMuted, strokeCap = StrokeCap.Butt, gapSize = 0.dp)
    } else {
        LinearProgressIndicator(
            progress = { fraction },
            modifier = m.clip(RoundedCornerShape(IzleTheme.sizes.progress / 2)),
            color = c.accent,
            trackColor = c.surfaceMuted,
            strokeCap = StrokeCap.Butt,
            gapSize = 0.dp,
            drawStopIndicator = {},
        )
    }
}
