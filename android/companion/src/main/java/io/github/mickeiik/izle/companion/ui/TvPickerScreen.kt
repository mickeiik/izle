package io.github.mickeiik.izle.companion.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import io.github.mickeiik.izle.companion.R
import io.github.mickeiik.izle.companion.home.resources
import io.github.mickeiik.izle.companion.pairing.ApproveSheet
import io.github.mickeiik.izle.companion.pairing.NotMineDialog
import io.github.mickeiik.izle.companion.pairing.PairByCodeDialog
import io.github.mickeiik.izle.companion.pairing.PairingState
import io.github.mickeiik.izle.companion.pairing.PairingViewModel
import io.github.mickeiik.izle.companion.pairing.WaitingCodeCard
import io.github.mickeiik.izle.companion.pairing.defaultTvName
import io.github.mickeiik.izle.companion.pairing.pairingErrorText
import io.github.mickeiik.izle.companion.pairing.tvStateText
import io.github.mickeiik.izle.companion.ui.design.ButtonSize
import io.github.mickeiik.izle.companion.ui.design.Caption
import io.github.mickeiik.izle.companion.ui.design.Hairline
import io.github.mickeiik.izle.companion.ui.design.IzleButton
import io.github.mickeiik.izle.companion.ui.design.IzleTheme
import io.github.mickeiik.izle.companion.ui.design.ListRow
import io.github.mickeiik.izle.companion.ui.design.ProgressBar
import io.github.mickeiik.izle.companion.ui.design.StatusChip
import io.github.mickeiik.izle.companion.ui.design.Tone
import io.github.mickeiik.izle.data.api.ApiClient
import kotlinx.coroutines.launch

/**
 * The server's TVs: tap one to open its page. With [api], each row says what the TV does, a code a TV shows waits in
 * a card above them to be approved (or cleared), and a TV can be paired by its code; [onPaired] reloads the list.
 */
@Composable
fun TvPickerScreen(
    state: CompanionUi.PickTv,
    api: ApiClient?,
    onPick: (String) -> Unit,
    onRetry: () -> Unit,
    onPaired: () -> Unit,
    modifier: Modifier = Modifier,
) {
    if (api == null) return TvPickerContent(state, PairingState(), null, onPick, onRetry, onPaired, modifier)
    val pairing: PairingViewModel = viewModel(key = "pairing-${System.identityHashCode(api)}") { PairingViewModel(api) }
    LifecycleStartEffect(pairing) {
        pairing.start()
        onStopOrDispose { pairing.stop() }
    }
    val pairingState by pairing.state.collectAsStateWithLifecycle()
    TvPickerContent(state, pairingState, pairing, onPick, onRetry, onPaired, modifier)
}

/** What a dialog or sheet of the list is open for. */
private sealed interface PairDialog {
    data object ByCode : PairDialog
    data class Approve(val code: String) : PairDialog
    data class NotMine(val code: String) : PairDialog
}

@Composable
private fun TvPickerContent(
    state: CompanionUi.PickTv,
    pairingState: PairingState,
    pairing: PairingViewModel?,
    onPick: (String) -> Unit,
    onRetry: () -> Unit,
    onPaired: () -> Unit,
    modifier: Modifier,
) {
    val s = IzleTheme.spacing
    val res = resources()
    val scope = rememberCoroutineScope()
    var dialog by remember { mutableStateOf<PairDialog?>(null) }
    // Why clearing a code failed, under that code's card only.
    var cardError by rememberSaveable { mutableStateOf<Pair<String, String>?>(null) }
    Column(modifier = modifier.fillMaxSize()) {
        if (state.loading) ProgressBar(null) else Hairline()
        LazyColumn(Modifier.fillMaxSize()) {
            item(key = "head") {
                Column(modifier = Modifier.padding(s.lg), verticalArrangement = Arrangement.spacedBy(s.sm)) {
                    Text(stringResource(R.string.pick_tv_title), style = IzleTheme.type.title, color = IzleTheme.colors.textPrimary)
                    Caption(stringResource(R.string.pick_tv_server, state.server))
                    state.error?.let { Caption(connectErrorText(it), tone = Tone.Danger) }
                    if (state.error != null || (!state.loading && state.devices.isEmpty())) {
                        if (state.error == null) Caption(stringResource(R.string.pick_tv_empty))
                        IzleButton(stringResource(R.string.try_again), onClick = onRetry, enabled = !state.loading, size = ButtonSize.Small)
                    }
                }
            }
            if (pairing != null) {
                items(pairingState.codes, key = { "code-${it.code}" }) { code ->
                    Column(Modifier.padding(start = s.lg, end = s.lg, bottom = s.lg), verticalArrangement = Arrangement.spacedBy(s.xs)) {
                        WaitingCodeCard(
                            code,
                            onNotMine = { dialog = PairDialog.NotMine(code.code) },
                            onApprove = { dialog = PairDialog.Approve(code.code) },
                        )
                        cardError?.takeIf { it.first == code.code }?.let { Caption(it.second, tone = Tone.Danger) }
                    }
                }
            }
            items(state.devices, key = { it.id }) { device ->
                val recent = device.problems?.recent ?: 0
                val online = pairingState.status[device.id]?.online ?: device.online
                ListRow(
                    title = device.name,
                    supporting = tvStateText(res, device, pairingState.status[device.id]),
                    supportingTone = if (online) Tone.Success else Tone.Neutral,
                    badge = if (recent > 0) {
                        { StatusChip(pluralStringResource(R.plurals.pairing_problems, recent, recent), Tone.Warning) }
                    } else null,
                    onClick = { onPick(device.id) },
                )
            }
            if (pairing != null) {
                item(key = "pair") {
                    IzleButton(
                        stringResource(R.string.pairing_by_code),
                        onClick = { dialog = PairDialog.ByCode },
                        modifier = Modifier.fillMaxWidth().padding(s.lg),
                    )
                }
            }
        }
    }
    when (val d = dialog) {
        null -> {}
        PairDialog.ByCode -> PairByCodeDialog(onNext = { dialog = PairDialog.Approve(it) }, onDismiss = { dialog = null })
        is PairDialog.Approve -> pairing?.let { vm ->
            ApproveSheet(
                code = d.code,
                devices = state.devices,
                defaultName = defaultTvName(state.takenNames),
                approve = { name, replaces -> vm.approve(d.code, name, replaces) },
                onDone = {
                    dialog = null
                    onPaired()
                },
                onDismiss = { dialog = null },
            )
        }
        is PairDialog.NotMine -> pairing?.let { vm ->
            NotMineDialog(
                d.code,
                onClear = {
                    cardError = null
                    scope.launch { vm.cancel(d.code)?.let { cardError = d.code to pairingErrorText(res, it) } }
                },
                onDismiss = { dialog = null },
            )
        }
    }
}
