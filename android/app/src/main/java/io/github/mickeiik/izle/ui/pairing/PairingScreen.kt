package io.github.mickeiik.izle.ui.pairing

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
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
import io.github.mickeiik.izle.ui.common.Spinner
import io.github.mickeiik.izle.ui.theme.IzleColors

/** The 6-digit code the owner approves from the admin page; the TV long-polls until it gets its token. */
@Composable
fun PairingScreen(ui: PairingUi) {
    Box(Modifier.fillMaxSize().background(IzleColors.Background).padding(horizontal = 48.dp, vertical = 32.dp)) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.align(Alignment.Center)) {
            Text(stringResource(R.string.pair_title), style = MaterialTheme.typography.displaySmall, color = IzleColors.OnSurface)
            Spacer(Modifier.height(12.dp))
            Text(stringResource(R.string.pair_instructions), style = MaterialTheme.typography.bodyLarge, color = IzleColors.Dim, textAlign = TextAlign.Center)
            Spacer(Modifier.height(28.dp))
            Box(
                Modifier.background(IzleColors.Surface, RoundedCornerShape(24.dp)).padding(horizontal = 56.dp, vertical = 12.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = ui.code?.let { "${it.take(3)} ${it.drop(3)}" } ?: "––– –––",
                    style = MaterialTheme.typography.displayLarge.copy(fontFamily = FontFamily.Monospace, letterSpacing = 8.sp),
                    color = if (ui.code != null) IzleColors.Accent else IzleColors.Dim,
                )
            }
            Spacer(Modifier.height(28.dp))
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                when (ui.problem) {
                    PairingProblem.Unreachable -> Text(
                        stringResource(R.string.setup_error_unreachable) + " " + stringResource(R.string.no_connection_detail),
                        style = MaterialTheme.typography.headlineSmall, color = IzleColors.Error,
                    )
                    PairingProblem.RateLimited -> Text(stringResource(R.string.pair_rate_limited), style = MaterialTheme.typography.headlineSmall, color = IzleColors.Error)
                    null -> {
                        Spinner(size = 36.dp)
                        Text(stringResource(R.string.pair_waiting), style = MaterialTheme.typography.headlineSmall, color = IzleColors.OnSurface)
                    }
                }
            }
        }
        Column(Modifier.align(Alignment.BottomCenter), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(stringResource(R.string.pair_server, ui.server), style = MaterialTheme.typography.bodySmall, color = IzleColors.Dim)
            Text(stringResource(R.string.pair_back_hint), style = MaterialTheme.typography.bodySmall, color = IzleColors.Dim)
        }
    }
}
