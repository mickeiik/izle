package io.github.mickeiik.izle.ui.home

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Button
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.OutlinedButton
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import io.github.mickeiik.izle.R
import io.github.mickeiik.izle.domain.EpisodeNames
import io.github.mickeiik.izle.ui.AutoplayUi
import io.github.mickeiik.izle.ui.common.tileBadgeText
import io.github.mickeiik.izle.ui.theme.IzleColors

/**
 * "Autoplay on start", drawn over Home like the player's "Up next": the poster, the show, what OK on its tile would
 * play, the countdown, **Play now** (focused) and **Not now**. Back and any other key cancel it (see MainActivity).
 */
@Composable
fun AutoplayOverlay(ui: AutoplayUi, posterUrl: String?, onPlayNow: () -> Unit, onNotNow: () -> Unit) {
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) {
        repeat(10) {
            withFrameNanos { }
            if (runCatching { focus.requestFocus() }.isSuccess) return@LaunchedEffect
        }
    }
    val entry = ui.entry
    val badge = EpisodeNames.badge(entry.item.kind, entry.playNext)
    // Opaque, like "Up next": the tiles behind would compete with the countdown.
    Box(Modifier.fillMaxSize().background(IzleColors.Background), contentAlignment = Alignment.Center) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(48.dp)) {
            Box(Modifier.width(220.dp).height(330.dp).clip(RoundedCornerShape(16.dp)).background(IzleColors.Surface)) {
                if (posterUrl != null) {
                    AsyncImage(model = posterUrl, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                }
            }
            Column(Modifier.widthIn(max = 560.dp)) {
                Text(
                    entry.item.title,
                    style = MaterialTheme.typography.displayMedium,
                    color = IzleColors.OnSurface,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                Spacer(Modifier.height(8.dp))
                Text(tileBadgeText(badge), style = MaterialTheme.typography.headlineSmall, color = IzleColors.OnSurface)
                Spacer(Modifier.height(16.dp))
                Text(stringResource(R.string.up_next_countdown, ui.secondsLeft), style = MaterialTheme.typography.headlineMedium, color = IzleColors.Accent)
                Spacer(Modifier.height(28.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                    Button(onClick = onPlayNow, modifier = Modifier.focusRequester(focus)) {
                        Text(stringResource(R.string.play_now), style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp))
                    }
                    OutlinedButton(onClick = onNotNow) {
                        Text(stringResource(R.string.not_now), style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp))
                    }
                }
            }
        }
    }
}
