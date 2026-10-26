package io.github.mickeiik.izle.companion.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// The launcher icon's navy and amber; no dynamic color, so the app looks the same on every phone.
private val Navy = Color(0xFF1B2A41)
private val Amber = Color(0xFFFFC857)

private val LightColors = lightColorScheme(
    primary = Navy,
    onPrimary = Color.White,
    secondary = Color(0xFF7A5900),
    onSecondary = Color.White,
)

private val DarkColors = darkColorScheme(
    primary = Amber,
    onPrimary = Navy,
    secondary = Color(0xFFB7C8E6),
    onSecondary = Navy,
)

/** Material 3, light or dark as the system says. */
@Composable
fun CompanionTheme(darkTheme: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (darkTheme) DarkColors else LightColors, content = content)
}
