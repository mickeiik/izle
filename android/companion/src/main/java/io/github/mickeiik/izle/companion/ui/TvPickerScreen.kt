package io.github.mickeiik.izle.companion.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import io.github.mickeiik.izle.companion.R
import io.github.mickeiik.izle.companion.tv.timeAgo
import io.github.mickeiik.izle.companion.ui.design.ButtonSize
import io.github.mickeiik.izle.companion.ui.design.Caption
import io.github.mickeiik.izle.companion.ui.design.Hairline
import io.github.mickeiik.izle.companion.ui.design.IzleButton
import io.github.mickeiik.izle.companion.ui.design.IzleTheme
import io.github.mickeiik.izle.companion.ui.design.ListRow
import io.github.mickeiik.izle.companion.ui.design.ProgressBar
import io.github.mickeiik.izle.companion.ui.design.Tone
import io.github.mickeiik.izle.data.api.AdminDevice
import io.github.mickeiik.izle.domain.IsoTime

/** The server's TVs: tap one to listen along with it. */
@Composable
fun TvPickerScreen(state: CompanionUi.PickTv, onPick: (String) -> Unit, onRetry: () -> Unit, modifier: Modifier = Modifier) {
    val s = IzleTheme.spacing
    Column(modifier = modifier.fillMaxSize()) {
        if (state.loading) ProgressBar(null) else Hairline()
        Column(modifier = Modifier.padding(s.lg), verticalArrangement = Arrangement.spacedBy(s.sm)) {
            Text(stringResource(R.string.pick_tv_title), style = IzleTheme.type.title, color = IzleTheme.colors.textPrimary)
            Caption(stringResource(R.string.pick_tv_server, state.server))
            state.error?.let { Caption(connectErrorText(it), tone = Tone.Danger) }
            if (state.error != null || (!state.loading && state.devices.isEmpty())) {
                if (state.error == null) Caption(stringResource(R.string.pick_tv_empty))
                IzleButton(stringResource(R.string.try_again), onClick = onRetry, enabled = !state.loading, size = ButtonSize.Small)
            }
        }
        LazyColumn {
            items(state.devices, key = { it.id }) { device ->
                ListRow(
                    title = device.name,
                    supporting = seenText(device),
                    supportingTone = if (device.online) Tone.Success else Tone.Neutral,
                    onClick = { onPick(device.id) },
                )
            }
        }
    }
}

@Composable
private fun seenText(device: AdminDevice): String {
    if (device.online) return stringResource(R.string.tv_online)
    val at = device.lastSeenAt?.let(IsoTime::parseEpochMs) ?: return stringResource(R.string.tv_never_seen)
    return stringResource(R.string.tv_last_seen, timeAgo(LocalContext.current.resources, at))
}
