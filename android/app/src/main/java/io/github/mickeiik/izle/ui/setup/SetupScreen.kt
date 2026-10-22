package io.github.mickeiik.izle.ui.setup

import android.view.KeyEvent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import io.github.mickeiik.izle.R
import io.github.mickeiik.izle.ui.PairingProblem
import io.github.mickeiik.izle.ui.PairingUi
import io.github.mickeiik.izle.ui.SetupError
import io.github.mickeiik.izle.ui.SetupUi
import io.github.mickeiik.izle.ui.common.ErrorText
import io.github.mickeiik.izle.ui.common.Spinner
import io.github.mickeiik.izle.ui.common.TvButton
import io.github.mickeiik.izle.ui.common.fullScreen
import io.github.mickeiik.izle.ui.theme.IzleBorders
import io.github.mickeiik.izle.ui.theme.IzleColors
import io.github.mickeiik.izle.ui.theme.IzleShapes
import io.github.mickeiik.izle.ui.theme.IzleSpacing

/** First run (and "Server address" in the hidden menu): the owner types the server address with the TV keyboard. */
@Composable
fun SetupScreen(ui: SetupUi, onAddressChange: (String) -> Unit, onConnect: () -> Unit) {
    val focusManager = LocalFocusManager.current
    val fieldFocus = remember { FocusRequester() }
    var fieldFocused by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { fieldFocus.requestFocus() }

    Box(Modifier.fullScreen()) {
        // Inset a little: the focused button grows by 10 % and must stay inside the safe margin.
        Column(verticalArrangement = Arrangement.spacedBy(IzleSpacing.XLarge), modifier = Modifier.align(Alignment.CenterStart).padding(start = IzleSpacing.Medium)) {
            Text(stringResource(R.string.setup_title), style = MaterialTheme.typography.displaySmall, color = IzleColors.OnSurface)
            Text(stringResource(R.string.setup_hint), style = MaterialTheme.typography.bodyLarge, color = IzleColors.Dim)
            BasicTextField(
                value = ui.address,
                onValueChange = onAddressChange,
                singleLine = true,
                enabled = !ui.busy,
                textStyle = MaterialTheme.typography.headlineMedium.copy(color = IzleColors.OnSurface),
                cursorBrush = SolidColor(IzleColors.Accent),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go, autoCorrectEnabled = false),
                keyboardActions = KeyboardActions(onGo = { onConnect() }, onDone = { onConnect() }),
                modifier = Modifier
                    .widthIn(min = 640.dp)
                    .focusRequester(fieldFocus)
                    .onFocusChanged { fieldFocused = it.isFocused }
                    .onPreviewKeyEvent {
                        // A single-line field keeps D-pad Down by default; move on to the button instead.
                        val e = it.nativeKeyEvent
                        val down = e.keyCode == KeyEvent.KEYCODE_DPAD_DOWN && e.action == KeyEvent.ACTION_DOWN
                        down && focusManager.moveFocus(FocusDirection.Down)
                    }
                    .background(IzleColors.Surface, IzleShapes.Medium)
                    // The focus style of the tiles: a white border, grey while something else has the focus.
                    .border(
                        if (fieldFocused) IzleBorders.FocusWidth else IzleBorders.OutlineWidth,
                        if (fieldFocused) IzleColors.Focus else IzleColors.Outline,
                        IzleShapes.Medium,
                    )
                    .padding(horizontal = IzleSpacing.XLarge, vertical = IzleSpacing.Large),
            )
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(IzleSpacing.XLarge)) {
                TvButton(stringResource(if (ui.busy) R.string.setup_connecting else R.string.setup_connect), onConnect, enabled = !ui.busy)
                if (ui.busy) Spinner(size = 48.dp)
            }
            when (ui.error) {
                SetupError.Invalid -> ErrorText(stringResource(R.string.setup_error_invalid))
                SetupError.Unreachable -> ErrorText(stringResource(R.string.setup_error_unreachable))
                null -> Unit
            }
        }
    }
}

/** The 6-digit code the owner approves from the admin page, with that page's address to open on the phone. */
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
