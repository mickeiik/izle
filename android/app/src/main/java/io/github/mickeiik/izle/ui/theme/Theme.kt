package io.github.mickeiik.izle.ui.theme

import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Typography
import androidx.tv.material3.darkColorScheme

/** High-contrast palette: near-black background, white focus, warm accent for "Continue". */
object IzleColors {
    val Background = Color(0xFF0B0B0F)
    val Surface = Color(0xFF1C1C24)
    val SurfaceHigh = Color(0xFF2A2A35)
    val OnSurface = Color(0xFFF5F5F7)
    val Dim = Color(0xFFB8B8C4)
    val Focus = Color(0xFFFFFFFF)
    val Accent = Color(0xFFFFC94D)
    val OnAccent = Color(0xFF1A1300)
    val New = Color(0xFF7FE3C4)
    val OnNew = Color(0xFF002118)
    val Error = Color(0xFFFF8A80)
    val Scrim = Color(0xCC000000)
}

private val ColorScheme = darkColorScheme(
    primary = IzleColors.Focus,
    onPrimary = Color.Black,
    secondary = IzleColors.Accent,
    onSecondary = IzleColors.OnAccent,
    background = IzleColors.Background,
    onBackground = IzleColors.OnSurface,
    surface = IzleColors.Surface,
    onSurface = IzleColors.OnSurface,
    surfaceVariant = IzleColors.SurfaceHigh,
    onSurfaceVariant = IzleColors.Dim,
    error = IzleColors.Error,
)

private fun style(size: Int, weight: FontWeight = FontWeight.Normal, lineHeight: Int = size + 8) =
    TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = weight, fontSize = size.sp, lineHeight = lineHeight.sp)

/** Nothing on screen is smaller than 24 sp: the viewer sits far away and may not see well. */
private val IzleTypography = Typography(
    displayLarge = style(96, FontWeight.Bold, 104),
    displayMedium = style(56, FontWeight.Bold),
    displaySmall = style(44, FontWeight.Bold),
    headlineLarge = style(40, FontWeight.Bold),
    headlineMedium = style(34, FontWeight.Bold),
    headlineSmall = style(30, FontWeight.Bold),
    titleLarge = style(28, FontWeight.Bold),
    titleMedium = style(26, FontWeight.Bold),
    titleSmall = style(24, FontWeight.Bold),
    bodyLarge = style(28),
    bodyMedium = style(26),
    bodySmall = style(24),
    labelLarge = style(26, FontWeight.Bold),
    labelMedium = style(24, FontWeight.Bold),
    labelSmall = style(24),
)

@Composable
fun IzleTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = ColorScheme, typography = IzleTypography, content = content)
}
