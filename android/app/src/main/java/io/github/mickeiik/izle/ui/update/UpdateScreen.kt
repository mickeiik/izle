package io.github.mickeiik.izle.ui.update

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import io.github.mickeiik.izle.R
import io.github.mickeiik.izle.ui.UpdatePhase
import io.github.mickeiik.izle.ui.UpdateUi
import io.github.mickeiik.izle.ui.common.PanelButton
import io.github.mickeiik.izle.ui.common.PanelCountdown
import io.github.mickeiik.izle.ui.common.PosterPanel
import io.github.mickeiik.izle.ui.common.Spinner
import io.github.mickeiik.izle.ui.common.fullScreen
import io.github.mickeiik.izle.ui.theme.IzleColors
import io.github.mickeiik.izle.ui.theme.IzleSpacing
import io.github.mickeiik.izle.update.UpdatePlan

/**
 * A new version of the app, full screen (docs/ux/senior-tv.md, "Update"): the guided "press OK" with Install focused
 * and Not now beside it, counting down to Home; "Updating…" while it installs; "Could not update", then Home.
 */
@Composable
fun UpdateScreen(ui: UpdateUi, onInstall: () -> Unit, onHome: () -> Unit) {
    val appName = stringResource(R.string.app_name)
    when (val phase = ui.phase) {
        is UpdatePhase.Prompt -> PosterPanel(
            posterUrl = null,
            showTitle = appName,
            overline = stringResource(R.string.update_overline),
            title = ui.versionName,
            lines = listOf(stringResource(R.string.update_press_ok)),
            countdown = PanelCountdown(stringResource(R.string.auto_home_countdown, phase.secondsLeft), phase.secondsLeft, UpdatePlan.GUIDED_TIMEOUT_SEC),
            buttons = listOf(PanelButton(stringResource(R.string.update_install), onInstall), PanelButton(stringResource(R.string.not_now), onHome)),
        )
        UpdatePhase.Installing -> Box(Modifier.fullScreen()) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(IzleSpacing.XLarge),
                modifier = Modifier.align(Alignment.Center),
            ) {
                Spinner()
                Text(stringResource(R.string.update_installing), style = MaterialTheme.typography.headlineMedium, color = IzleColors.OnSurface)
                Text(ui.versionName, style = MaterialTheme.typography.headlineSmall, color = IzleColors.Dim)
            }
        }
        is UpdatePhase.Failed -> PosterPanel(
            posterUrl = null,
            showTitle = appName,
            title = stringResource(R.string.update_failed),
            lines = listOf(ui.versionName),
            countdown = PanelCountdown(stringResource(R.string.auto_home_countdown, phase.secondsLeft), phase.secondsLeft, UpdatePlan.FAILED_HOME_SEC),
            buttons = listOf(PanelButton(stringResource(R.string.go_home), onHome)),
        )
    }
}
