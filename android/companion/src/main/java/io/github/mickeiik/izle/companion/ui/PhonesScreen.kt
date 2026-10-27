package io.github.mickeiik.izle.companion.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import io.github.mickeiik.izle.companion.R
import io.github.mickeiik.izle.companion.tv.timeAgo
import io.github.mickeiik.izle.companion.ui.design.ButtonKind
import io.github.mickeiik.izle.companion.ui.design.ButtonSize
import io.github.mickeiik.izle.companion.ui.design.Caption
import io.github.mickeiik.izle.companion.ui.design.Hairline
import io.github.mickeiik.izle.companion.ui.design.IzleButton
import io.github.mickeiik.izle.companion.ui.design.IzleTheme
import io.github.mickeiik.izle.companion.ui.design.ListRow
import io.github.mickeiik.izle.companion.ui.design.ProgressBar
import io.github.mickeiik.izle.companion.ui.design.StatusChip
import io.github.mickeiik.izle.companion.ui.design.Tone
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
    val s = IzleTheme.spacing
    Column(modifier = modifier.fillMaxSize()) {
        if (state.loading) ProgressBar(null) else Hairline()
        Column(modifier = Modifier.padding(s.lg), verticalArrangement = Arrangement.spacedBy(s.sm)) {
            Caption(stringResource(R.string.phones_hint))
            state.error?.let {
                Caption(connectErrorText(it), tone = Tone.Danger)
                IzleButton(stringResource(R.string.try_again), onClick = onRetry, enabled = !state.loading, size = ButtonSize.Small)
            }
        }
        LazyColumn {
            items(state.phones, key = { it.id }) { phone ->
                // This phone: its mark above the row, so the row keeps its room for the name and when it was used.
                if (phone.id == state.thisPhoneId) {
                    StatusChip(stringResource(R.string.this_phone), Tone.Neutral, Modifier.padding(start = s.lg, top = s.sm))
                }
                ListRow(
                    title = phone.name,
                    supporting = usedText(phone),
                    trailing = {
                        IzleButton(
                            stringResource(R.string.disconnect),
                            onClick = { confirming = phone.id },
                            kind = ButtonKind.Danger,
                            size = ButtonSize.Small,
                            enabled = !state.loading,
                        )
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
                IzleButton(stringResource(R.string.disconnect), kind = ButtonKind.Danger, onClick = {
                    confirming = null
                    onDisconnect(phone.id)
                })
            },
            dismissButton = { IzleButton(stringResource(R.string.cancel), kind = ButtonKind.Quiet, onClick = { confirming = null }) },
        )
    }
}

@Composable
private fun usedText(phone: Phone): String {
    val at = phone.lastUsedAt?.let(IsoTime::parseEpochMs) ?: return stringResource(R.string.phone_never_used)
    return stringResource(R.string.phone_last_used, timeAgo(LocalContext.current.resources, at))
}
