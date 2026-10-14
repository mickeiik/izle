package io.github.mickeiik.izle.ui.home

import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import io.github.mickeiik.izle.R
import io.github.mickeiik.izle.domain.AutoplayPlan
import io.github.mickeiik.izle.domain.EpisodeNames
import io.github.mickeiik.izle.ui.AutoplayUi
import io.github.mickeiik.izle.ui.common.PanelButton
import io.github.mickeiik.izle.ui.common.PanelCountdown
import io.github.mickeiik.izle.ui.common.PosterPanel
import io.github.mickeiik.izle.ui.common.tileBadgeText

/**
 * "Autoplay on start", drawn over Home like the player's "Up next": the poster, the show, what OK on its tile would
 * play, the countdown, **Play now** (focused) and **Not now**. Back and any other key cancel it (see MainActivity).
 */
@Composable
fun AutoplayOverlay(ui: AutoplayUi, posterUrl: String?, onPlayNow: () -> Unit, onNotNow: () -> Unit) {
    val entry = ui.entry
    val badge = EpisodeNames.badge(entry.item.kind, entry.playNext)
    PosterPanel(
        posterUrl = posterUrl,
        showTitle = entry.item.title,
        title = entry.item.title,
        lines = listOf(tileBadgeText(badge)),
        countdown = PanelCountdown(stringResource(R.string.up_next_countdown, ui.secondsLeft), ui.secondsLeft, AutoplayPlan.COUNTDOWN_SEC),
        buttons = listOf(PanelButton(stringResource(R.string.play_now), onPlayNow), PanelButton(stringResource(R.string.not_now), onNotNow)),
    )
}
