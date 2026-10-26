package io.github.mickeiik.izle.companion.ui

import android.text.format.DateUtils
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import io.github.mickeiik.izle.companion.R
import io.github.mickeiik.izle.data.api.AdminDevice

/** The server's TVs: tap one to listen along with it. */
@Composable
fun TvPickerScreen(state: CompanionUi.PickTv, onPick: (String) -> Unit, onRetry: () -> Unit, modifier: Modifier = Modifier) {
    Column(modifier = modifier.fillMaxSize()) {
        if (state.loading) LinearProgressIndicator(modifier = Modifier.fillMaxWidth()) else HorizontalDivider()
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(stringResource(R.string.pick_tv_title), style = MaterialTheme.typography.headlineSmall)
            Text(stringResource(R.string.pick_tv_server, state.server), style = MaterialTheme.typography.bodyMedium)
            state.error?.let {
                Text(connectErrorText(it), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
            }
            if (state.error != null || (!state.loading && state.devices.isEmpty())) {
                if (state.error == null) Text(stringResource(R.string.pick_tv_empty), style = MaterialTheme.typography.bodyMedium)
                OutlinedButton(onClick = onRetry, enabled = !state.loading) { Text(stringResource(R.string.try_again)) }
            }
        }
        LazyColumn {
            items(state.devices, key = { it.id }) { device ->
                ListItem(
                    headlineContent = { Text(device.name) },
                    supportingContent = { Text(seenText(device)) },
                    modifier = Modifier.clickable { onPick(device.id) },
                )
            }
        }
    }
}

@Composable
private fun seenText(device: AdminDevice): String {
    if (device.online) return stringResource(R.string.tv_online)
    val at = parseIsoMs(device.lastSeenAt) ?: return stringResource(R.string.tv_never_seen)
    val ago = DateUtils.getRelativeTimeSpanString(at, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS).toString()
    return stringResource(R.string.tv_last_seen, ago)
}
