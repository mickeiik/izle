package io.github.mickeiik.izle.companion.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import io.github.mickeiik.izle.companion.R

/** The server address and an access token with the `companion` scope (hidden by default). */
@Composable
fun PairingScreen(state: CompanionUi.Pairing, onConnect: (url: String, token: String) -> Unit, modifier: Modifier = Modifier) {
    var url by rememberSaveable(state.initialUrl) { mutableStateOf(state.initialUrl) }
    var token by rememberSaveable { mutableStateOf("") }
    var showToken by rememberSaveable { mutableStateOf(false) }
    val canConnect = !state.busy && url.isNotBlank() && token.isNotBlank()
    val connect = { if (canConnect) onConnect(url, token) }

    Column(
        modifier = modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(stringResource(R.string.pairing_title), style = MaterialTheme.typography.headlineSmall)
        Text(stringResource(R.string.pairing_intro), style = MaterialTheme.typography.bodyMedium)
        OutlinedTextField(
            value = url,
            onValueChange = { url = it },
            label = { Text(stringResource(R.string.server_address)) },
            singleLine = true,
            enabled = !state.busy,
            isError = state.error == ConnectError.InvalidAddress,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next, autoCorrectEnabled = false),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = token,
            onValueChange = { token = it },
            label = { Text(stringResource(R.string.access_token)) },
            singleLine = true,
            enabled = !state.busy,
            visualTransformation = if (showToken) VisualTransformation.None else PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done, autoCorrectEnabled = false),
            keyboardActions = KeyboardActions(onDone = { connect() }),
            trailingIcon = {
                TextButton(onClick = { showToken = !showToken }) {
                    Text(stringResource(if (showToken) R.string.hide_token else R.string.show_token))
                }
            },
            modifier = Modifier.fillMaxWidth(),
        )
        state.error?.let { Text(connectErrorText(it), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
        Button(onClick = connect, enabled = canConnect, modifier = Modifier.fillMaxWidth()) {
            if (state.busy) CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
            else Text(stringResource(R.string.connect))
        }
    }
}

@Composable
fun connectErrorText(error: ConnectError): String = when (error) {
    ConnectError.InvalidAddress -> stringResource(R.string.error_invalid_address)
    ConnectError.Unreachable -> stringResource(R.string.error_unreachable)
    ConnectError.TokenNotAccepted -> stringResource(R.string.error_token_not_accepted)
    ConnectError.NeedsCompanionScope -> stringResource(R.string.error_needs_companion_scope)
    is ConnectError.Server -> stringResource(R.string.error_server, error.code)
}
