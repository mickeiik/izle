package io.github.mickeiik.izle.ui.pairing

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import io.github.mickeiik.izle.R
import io.github.mickeiik.izle.ui.PairingProblem
import io.github.mickeiik.izle.ui.PairingUi
import io.github.mickeiik.izle.ui.common.ErrorText
import io.github.mickeiik.izle.ui.common.Spinner
import io.github.mickeiik.izle.ui.common.fullScreen
import io.github.mickeiik.izle.ui.theme.IzleColors
import io.github.mickeiik.izle.ui.theme.IzleShapes
import io.github.mickeiik.izle.ui.theme.IzleSpacing

/**
 * The 6-digit code the owner approves from the admin page, with that page's address so the owner knows what to open
 * on the phone; the TV long-polls until it gets its token.
 */
@Composable
fun PairingScreen(ui: PairingUi) {
    Box(Modifier.fullScreen()) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.align(Alignment.Center)) {
            Text(stringResource(R.string.pair_title), style = MaterialTheme.typography.displaySmall, color = IzleColors.OnSurface)
            Spacer(Modifier.height(IzleSpacing.Medium))
            Text(
                stringResource(R.string.pair_instructions, ui.adminUrl),
                style = MaterialTheme.typography.bodyLarge,
                color = IzleColors.Dim,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(28.dp))
            Box(
                Modifier.background(IzleColors.Surface, IzleShapes.Large).padding(horizontal = 56.dp, vertical = IzleSpacing.Medium),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = ui.code?.let { "${it.take(3)} ${it.drop(3)}" } ?: "––– –––",
                    style = MaterialTheme.typography.displayLarge.copy(fontFamily = FontFamily.Monospace, letterSpacing = 8.sp),
                    color = if (ui.code != null) IzleColors.Accent else IzleColors.Dim,
                )
            }
            Spacer(Modifier.height(28.dp))
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(IzleSpacing.Large)) {
                when (ui.problem) {
                    PairingProblem.Unreachable -> ErrorText(
                        stringResource(R.string.setup_error_unreachable) + " " + stringResource(R.string.no_connection_detail),
                        textAlign = TextAlign.Center,
                    )
                    PairingProblem.RateLimited -> ErrorText(stringResource(R.string.pair_rate_limited), textAlign = TextAlign.Center)
                    null -> {
                        Spinner(size = 36.dp)
                        Text(stringResource(R.string.pair_waiting), style = MaterialTheme.typography.headlineSmall, color = IzleColors.OnSurface)
                    }
                }
            }
        }
        Text(
            stringResource(R.string.pair_back_hint),
            style = MaterialTheme.typography.bodySmall,
            color = IzleColors.Dim,
            modifier = Modifier.align(Alignment.BottomCenter),
        )
    }
}
