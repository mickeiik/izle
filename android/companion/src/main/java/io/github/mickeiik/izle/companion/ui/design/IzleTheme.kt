package io.github.mickeiik.izle.companion.ui.design

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

private val LocalIzleColors = staticCompositionLocalOf { LightIzleColors }
private val LocalIzleSpacing = staticCompositionLocalOf { IzleSpacing() }
private val LocalIzleRadii = staticCompositionLocalOf { IzleRadii() }
private val LocalIzleSizes = staticCompositionLocalOf { IzleSizes() }
private val LocalIzleType = staticCompositionLocalOf { IzleType() }

/** The tokens of the [IzleTheme] around the caller: screens read colours, spacing, sizes and type from here. */
object IzleTheme {
    val colors: IzleColors
        @Composable @ReadOnlyComposable get() = LocalIzleColors.current
    val spacing: IzleSpacing
        @Composable @ReadOnlyComposable get() = LocalIzleSpacing.current
    val radii: IzleRadii
        @Composable @ReadOnlyComposable get() = LocalIzleRadii.current
    val sizes: IzleSizes
        @Composable @ReadOnlyComposable get() = LocalIzleSizes.current
    val type: IzleType
        @Composable @ReadOnlyComposable get() = LocalIzleType.current
}

/**
 * The companion's theme: the tokens, light or dark as the system says (no dynamic colour), mapped onto
 * [MaterialTheme] so plain Material 3 components (dialogs, text fields, snackbars, menus) follow them.
 */
@Composable
fun IzleTheme(darkTheme: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val colors = if (darkTheme) DarkIzleColors else LightIzleColors
    val type = IzleType()
    val radii = IzleRadii()
    CompositionLocalProvider(
        LocalIzleColors provides colors,
        LocalIzleSpacing provides IzleSpacing(),
        LocalIzleRadii provides radii,
        LocalIzleSizes provides IzleSizes(),
        LocalIzleType provides type,
    ) {
        MaterialTheme(colorScheme = colorScheme(colors), typography = typography(type), shapes = shapes(radii), content = content)
    }
}

/** Flat: every container is `surface`, no tonal tint; `primary` is the accent, `error` the danger tone. */
private fun colorScheme(c: IzleColors): ColorScheme {
    val base = if (c.isDark) darkColorScheme() else lightColorScheme()
    return base.copy(
        primary = c.accent,
        onPrimary = c.onAccent,
        primaryContainer = c.accentMuted,
        onPrimaryContainer = c.accent,
        inversePrimary = c.accent,
        secondary = c.accent,
        onSecondary = c.onAccent,
        secondaryContainer = c.accentMuted,
        onSecondaryContainer = c.accent,
        tertiary = c.warning,
        onTertiary = c.onAccent,
        tertiaryContainer = c.warningMuted,
        onTertiaryContainer = c.warning,
        background = c.background,
        onBackground = c.textPrimary,
        surface = c.surface,
        onSurface = c.textPrimary,
        surfaceVariant = c.surfaceMuted,
        onSurfaceVariant = c.textSecondary,
        surfaceTint = Color.Transparent,
        inverseSurface = c.textPrimary,
        inverseOnSurface = c.surface,
        error = c.danger,
        onError = c.onAccent,
        errorContainer = c.dangerMuted,
        onErrorContainer = c.danger,
        outline = c.border,
        outlineVariant = c.border,
        scrim = Color.Black.copy(alpha = 0.4f),
        surfaceBright = c.surface,
        surfaceDim = c.surface,
        surfaceContainerLowest = c.surface,
        surfaceContainerLow = c.surface,
        surfaceContainer = c.surface,
        surfaceContainerHigh = c.surface,
        surfaceContainerHighest = c.surfaceMuted,
    )
}

private fun typography(t: IzleType) = Typography(
    displayLarge = t.title, displayMedium = t.title, displaySmall = t.title,
    headlineLarge = t.title, headlineMedium = t.title, headlineSmall = t.title,
    titleLarge = t.title, titleMedium = t.heading, titleSmall = t.heading,
    bodyLarge = t.body, bodyMedium = t.body, bodySmall = t.caption,
    labelLarge = t.label, labelMedium = t.label, labelSmall = t.chip,
)

private fun shapes(r: IzleRadii) = Shapes(
    extraSmall = RoundedCornerShape(r.md),
    small = RoundedCornerShape(r.sm),
    medium = RoundedCornerShape(r.md),
    large = RoundedCornerShape(r.md),
    extraLarge = RoundedCornerShape(r.lg),
)
