package io.github.mickeiik.izle.companion.pairing

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import io.github.mickeiik.izle.companion.R
import io.github.mickeiik.izle.companion.home.resources
import io.github.mickeiik.izle.companion.ui.CompanionViewModel
import io.github.mickeiik.izle.companion.ui.design.ButtonKind
import io.github.mickeiik.izle.companion.ui.design.Caption
import io.github.mickeiik.izle.companion.ui.design.Card
import io.github.mickeiik.izle.companion.ui.design.ChoiceGrid
import io.github.mickeiik.izle.companion.ui.design.IzleButton
import io.github.mickeiik.izle.companion.ui.design.IzleSheet
import io.github.mickeiik.izle.companion.ui.design.IzleTheme
import io.github.mickeiik.izle.companion.ui.design.Tone
import io.github.mickeiik.izle.data.api.AdminDevice
import kotlinx.coroutines.launch

/** The card above the TVs while a code waits: the code, the minutes left, then Not mine and Approve…. */
@Composable
fun WaitingCodeCard(code: WaitingCode, onNotMine: () -> Unit, onApprove: () -> Unit, modifier: Modifier = Modifier) {
    Card(modifier) {
        Text(stringResource(R.string.pairing_waiting), style = IzleTheme.type.heading, color = IzleTheme.colors.textPrimary)
        Column(verticalArrangement = Arrangement.spacedBy(IzleTheme.spacing.line)) {
            Text(
                formatCode(code.code),
                style = IzleTheme.type.digits,
                color = IzleTheme.colors.textPrimary,
            )
            Caption(pluralStringResource(R.plurals.pairing_minutes_left, code.minutesLeft, code.minutesLeft))
        }
        if (code.approved) {
            Caption(code.approvedAs?.let { stringResource(R.string.pairing_approved_as, it) } ?: stringResource(R.string.pairing_approved))
        } else {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(IzleTheme.spacing.sm, Alignment.End)) {
                IzleButton(stringResource(R.string.pairing_not_mine), onClick = onNotMine, kind = ButtonKind.Quiet)
                IzleButton(stringResource(R.string.pairing_approve_button), onClick = onApprove, kind = ButtonKind.Primary)
            }
        }
    }
}

/**
 * Approving [code]: the name (blank: [defaultName], as the server names it) and what the TV is, a new one or in place
 * of one of [devices]; Cancel and Approve. [approve] answers why it failed, or null when it worked (the sheet closes).
 */
@Composable
fun ApproveSheet(
    code: String,
    devices: List<AdminDevice>,
    defaultName: String,
    approve: suspend (name: String?, replaces: String?) -> Exception?,
    onDone: () -> Unit,
    onDismiss: () -> Unit,
) {
    IzleSheet(onDismiss = onDismiss, title = stringResource(R.string.pairing_code_title, formatCode(code))) {
        ApproveForm(devices, defaultName, approve, onDone, onDismiss)
    }
}

/** The approve sheet's content, under its title. */
@Composable
internal fun ColumnScope.ApproveForm(
    devices: List<AdminDevice>,
    defaultName: String,
    approve: suspend (name: String?, replaces: String?) -> Exception?,
    onDone: () -> Unit,
    onDismiss: () -> Unit,
) {
    val res = resources()
    val scope = rememberCoroutineScope()
    var name by rememberSaveable { mutableStateOf("") }
    var replaces by rememberSaveable { mutableStateOf<String?>(null) }
    // Not saved: the request does not outlive the composition, so a restored "busy" would never clear.
    var busy by remember { mutableStateOf(false) }
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    val options = listOf<String?>(null) + devices.map { it.id }
    if (replaces == null) {
        Caption(stringResource(R.string.pairing_name))
        // No label: the placeholder, the name the server gives it, shows while the field is empty.
        OutlinedTextField(
            value = name,
            onValueChange = { name = it.take(PairingViewModel.NAME_MAX) },
            placeholder = { Text(defaultName) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
            modifier = Modifier.fillMaxWidth(),
        )
    }
    Caption(stringResource(R.string.pairing_this_tv_is))
    ChoiceGrid(
        options,
        label = { id ->
            if (id == null) res.getString(R.string.pairing_new_tv)
            else res.getString(R.string.pairing_replaces, devices.firstOrNull { it.id == id }?.name.orEmpty())
        },
        selected = { it == replaces },
        onSelect = { replaces = it },
        columns = 2,
    )
    error?.let { Caption(it, tone = Tone.Danger) }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(IzleTheme.spacing.sm, Alignment.End)) {
        IzleButton(stringResource(R.string.cancel), onClick = onDismiss)
        IzleButton(
            stringResource(R.string.pairing_approve),
            onClick = {
                busy = true
                error = null
                scope.launch {
                    val failed = approve(name.takeIf { replaces == null }, replaces)
                    busy = false
                    if (failed == null) onDone() else error = pairingErrorText(res, failed)
                }
            },
            kind = ButtonKind.Primary,
            enabled = !busy,
        )
    }
}

/** Pair a new TV by its code: the 6-digit field; Next opens the approve form. */
@Composable
fun PairByCodeDialog(onNext: (String) -> Unit, onDismiss: () -> Unit) {
    var text by rememberSaveable { mutableStateOf("") }
    val code = CompanionViewModel.normalizeCode(text)
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.pairing_by_code_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(IzleTheme.spacing.sm)) {
                Text(stringResource(R.string.pairing_by_code_text))
                OutlinedTextField(
                    value = text,
                    onValueChange = { v -> text = v.filter { it.isDigit() || it == ' ' }.take(CODE_FIELD_MAX) },
                    label = { Text(stringResource(R.string.pairing_code_field)) },
                    singleLine = true,
                    textStyle = IzleTheme.type.digits,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = {
            IzleButton(stringResource(R.string.pairing_next), onClick = { code?.let(onNext) }, kind = ButtonKind.Primary, enabled = code != null)
        },
        dismissButton = { IzleButton(stringResource(R.string.cancel), onClick = onDismiss, kind = ButtonKind.Quiet) },
    )
}

/** Not mine: clearing a code asks first. */
@Composable
fun NotMineDialog(code: String, onClear: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.pairing_not_mine_title, formatCode(code))) },
        text = { Text(stringResource(R.string.pairing_not_mine_text)) },
        confirmButton = { IzleButton(stringResource(R.string.pairing_clear), onClick = { onDismiss(); onClear() }, kind = ButtonKind.Danger) },
        dismissButton = { IzleButton(stringResource(R.string.pairing_keep), onClick = onDismiss, kind = ButtonKind.Quiet) },
    )
}

/** Six digits and the space a reader may type between the groups. */
private const val CODE_FIELD_MAX = 7
