package io.github.mickeiik.izle.companion.ui

import android.text.format.DateUtils
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import io.github.mickeiik.izle.companion.R
import io.github.mickeiik.izle.data.api.Phone
import io.github.mickeiik.izle.domain.IsoTime

/** The phones connected to the server: each one's name, this one marked, when it was last used, and Disconnect. */
@Composable
fun PhonesScreen(
    state: CompanionUi.Phones,
    onDisconnect: (id: String) -> Unit,
    onRetry: () -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    BackHandler(onBack = onBack)
    var confirming by rememberSaveable { mutableStateOf<String?>(null) }
    Column(modifier = modifier.fillMaxSize()) {
        if (state.loading) LinearProgressIndicator(modifier = Modifier.fillMaxWidth()) else HorizontalDivider()
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(stringResource(R.string.phones_hint), style = MaterialTheme.typography.bodyMedium)
            state.error?.let {
                Text(connectErrorText(it), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                OutlinedButton(onClick = onRetry, enabled = !state.loading) { Text(stringResource(R.string.try_again)) }
            }
        }
        LazyColumn {
            items(state.phones, key = { it.id }) { phone ->
                val isThis = phone.id == state.thisPhoneId
                ListItem(
                    overlineContent = if (isThis) ({ Text(stringResource(R.string.this_phone)) }) else null,
                    headlineContent = { Text(phone.name) },
                    supportingContent = { Text(usedText(phone)) },
                    trailingContent = {
                        TextButton(onClick = { confirming = phone.id }, enabled = !state.loading) {
                            Text(stringResource(R.string.disconnect))
                        }
                    },
                )
            }
        }
    }

    val phone = confirming?.let { id -> state.phones.firstOrNull { it.id == id } }
    if (phone != null) {
        AlertDialog(
            onDismissRequest = { confirming = null },
            title = { Text(stringResource(R.string.disconnect_title, phone.name)) },
            text = {
                val self = phone.id == state.thisPhoneId
                Text(stringResource(if (self) R.string.disconnect_self_text else R.string.disconnect_other_text))
            },
            confirmButton = {
                TextButton(onClick = {
                    confirming = null
                    onDisconnect(phone.id)
                }) { Text(stringResource(R.string.disconnect)) }
            },
            dismissButton = { TextButton(onClick = { confirming = null }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}

@Composable
private fun usedText(phone: Phone): String {
    val at = phone.lastUsedAt?.let(IsoTime::parseEpochMs) ?: return stringResource(R.string.phone_never_used)
    val ago = DateUtils.getRelativeTimeSpanString(at, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS).toString()
    return stringResource(R.string.phone_last_used, ago)
}
