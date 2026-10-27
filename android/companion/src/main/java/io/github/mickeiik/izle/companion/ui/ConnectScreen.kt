package io.github.mickeiik.izle.companion.ui

import android.content.res.Resources
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import io.github.mickeiik.izle.companion.BuildConfig
import io.github.mickeiik.izle.companion.R
import io.github.mickeiik.izle.companion.ui.design.ButtonKind
import io.github.mickeiik.izle.companion.ui.design.ButtonSize
import io.github.mickeiik.izle.companion.ui.design.Caption
import io.github.mickeiik.izle.companion.ui.design.IzleButton
import io.github.mickeiik.izle.companion.ui.design.IzleTheme
import io.github.mickeiik.izle.companion.ui.design.ProgressBar
import io.github.mickeiik.izle.companion.ui.design.Tone

/**
 * Connecting this phone to a TV's server: the server address and the 6-digit code the TV shows (hidden menu → Settings
 * → Connect a phone). Scanning the TV's QR code opens the app with the invite instead, and this screen shows it busy.
 * [allowToken] (debug builds): "Use a token instead" reveals an access token field, for development with the admin
 * token; release builds have none.
 */
@Composable
fun ConnectScreen(
    state: CompanionUi.Connect,
    onConnect: (url: String, code: String) -> Unit,
    onConnectWithToken: (url: String, token: String) -> Unit,
    modifier: Modifier = Modifier,
    allowToken: Boolean = BuildConfig.DEBUG,
) {
    var url by rememberSaveable(state.initialUrl) { mutableStateOf(state.initialUrl) }
    var code by rememberSaveable { mutableStateOf("") }
    var useToken by rememberSaveable { mutableStateOf(false) }
    var token by rememberSaveable { mutableStateOf("") }
    var showToken by rememberSaveable { mutableStateOf(false) }
    val withToken = allowToken && useToken
    val canConnect = !state.busy && url.isNotBlank() &&
        if (withToken) token.isNotBlank() else CompanionViewModel.normalizeCode(code) != null
    val connect = {
        if (canConnect) {
            if (withToken) onConnectWithToken(url, token) else onConnect(url, code)
        }
    }

    val sp = IzleTheme.spacing
    Column(modifier = modifier.fillMaxSize()) {
        if (state.busy) ProgressBar(null)
        Column(
            modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(sp.lg),
            verticalArrangement = Arrangement.spacedBy(sp.lg),
        ) {
            Text(stringResource(R.string.connect_title), style = IzleTheme.type.title, color = IzleTheme.colors.textPrimary)
            Caption(stringResource(R.string.connect_intro))
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
            if (withToken) {
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
                        IzleButton(
                            stringResource(if (showToken) R.string.hide else R.string.show),
                            onClick = { showToken = !showToken },
                            kind = ButtonKind.Quiet,
                            size = ButtonSize.Small,
                        )
                    },
                    modifier = Modifier.fillMaxWidth(),
                )
            } else {
                OutlinedTextField(
                    value = code,
                    // Digits only (spaces, as the TV shows `483 920`, are dropped), at most 6.
                    onValueChange = { typed -> code = typed.filter(Char::isDigit).take(6) },
                    label = { Text(stringResource(R.string.connect_code)) },
                    singleLine = true,
                    enabled = !state.busy,
                    isError = state.error == ConnectError.CodeNotAccepted,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number, imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { connect() }),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            state.error?.let { Caption(connectErrorText(it), tone = Tone.Danger) }
            IzleButton(
                stringResource(if (state.busy) R.string.connecting else R.string.connect),
                onClick = connect,
                kind = ButtonKind.Primary,
                enabled = canConnect,
                modifier = Modifier.fillMaxWidth(),
            )
            if (allowToken) {
                IzleButton(
                    stringResource(if (useToken) R.string.use_code else R.string.use_token),
                    onClick = { useToken = !useToken },
                    kind = ButtonKind.Quiet,
                    enabled = !state.busy,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}

@Composable
fun connectErrorText(error: ConnectError): String {
    LocalConfiguration.current // read again when the configuration (the language) changes
    return connectErrorText(LocalContext.current.resources, error)
}

/** Also for a snackbar (a connect link that failed while this phone is still connected). */
fun connectErrorText(resources: Resources, error: ConnectError): String = when (error) {
    ConnectError.InvalidAddress -> resources.getString(R.string.error_invalid_address)
    ConnectError.Unreachable -> resources.getString(R.string.error_unreachable)
    ConnectError.CodeNotAccepted -> resources.getString(R.string.error_code_not_accepted)
    ConnectError.TooManyTries -> resources.getString(R.string.error_too_many_tries)
    ConnectError.TokenNotAccepted -> resources.getString(R.string.error_token_not_accepted)
    ConnectError.Disconnected -> resources.getString(R.string.error_disconnected)
    is ConnectError.Server -> resources.getString(R.string.error_server, error.code)
}
