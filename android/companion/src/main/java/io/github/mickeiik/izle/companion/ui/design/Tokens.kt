package io.github.mickeiik.izle.companion.ui.design

import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// The design system's tokens (docs/ux/companion-design.md): the only file with colour, dp and sp literals for the look.

/** The colours, light or dark. The `*Muted` ones are their tone at 14 % (dark) or 10 % (light). */
@Immutable
data class IzleColors(
    val background: Color,
    val surface: Color,
    val surfaceMuted: Color,
    val border: Color,
    val textPrimary: Color,
    val textSecondary: Color,
    val textMuted: Color,
    val accent: Color,
    val onAccent: Color,
    val accentMuted: Color,
    val success: Color,
    val successMuted: Color,
    val warning: Color,
    val warningMuted: Color,
    val danger: Color,
    val dangerMuted: Color,
    val isDark: Boolean,
)

private fun colors(
    dark: Boolean,
    background: Long, surface: Long, surfaceMuted: Long, border: Long,
    textPrimary: Long, textSecondary: Long, textMuted: Long,
    accent: Long, onAccent: Long, success: Long, warning: Long, danger: Long,
): IzleColors {
    val muted = if (dark) 0.14f else 0.10f
    return IzleColors(
        background = Color(background), surface = Color(surface), surfaceMuted = Color(surfaceMuted), border = Color(border),
        textPrimary = Color(textPrimary), textSecondary = Color(textSecondary), textMuted = Color(textMuted),
        accent = Color(accent), onAccent = Color(onAccent), accentMuted = Color(accent).copy(alpha = muted),
        success = Color(success), successMuted = Color(success).copy(alpha = muted),
        warning = Color(warning), warningMuted = Color(warning).copy(alpha = muted),
        danger = Color(danger), dangerMuted = Color(danger).copy(alpha = muted),
        isDark = dark,
    )
}

val DarkIzleColors: IzleColors = colors(
    dark = true,
    background = 0xFF121316, surface = 0xFF1A1B1F, surfaceMuted = 0xFF22242A, border = 0xFF2E3138,
    textPrimary = 0xFFECEDEF, textSecondary = 0xFFA2A6AE, textMuted = 0xFF6F737B,
    accent = 0xFF5B9BFF, onAccent = 0xFF0B1220, success = 0xFF4CC38A, warning = 0xFFE3B341, danger = 0xFFF47067,
)

val LightIzleColors: IzleColors = colors(
    dark = false,
    background = 0xFFF6F7F9, surface = 0xFFFFFFFF, surfaceMuted = 0xFFEFF1F4, border = 0xFFDDE0E5,
    textPrimary = 0xFF1A1C1F, textSecondary = 0xFF5D626B, textMuted = 0xFF8B9098,
    accent = 0xFF1F6FEB, onAccent = 0xFFFFFFFF, success = 0xFF1A7F4B, warning = 0xFF9A6700, danger = 0xFFCF222E,
)

/** Spacing: [lg] is the page gutter, the gap between blocks and a card's padding; [line] the gap between a row's lines. */
@Immutable
data class IzleSpacing(
    val xs: Dp = 4.dp,
    val sm: Dp = 8.dp,
    val md: Dp = 12.dp,
    val lg: Dp = 16.dp,
    val xl: Dp = 24.dp,
    val line: Dp = 2.dp,
)

/** Corner radii: [sm] chips and posters, [md] buttons, cards and fields, [lg] a bottom sheet's top corners. */
@Immutable
data class IzleRadii(
    val sm: Dp = 6.dp,
    val md: Dp = 10.dp,
    val lg: Dp = 16.dp,
)

/** Component sizes. */
@Immutable
data class IzleSizes(
    val button: Dp = 40.dp,
    val buttonSmall: Dp = 32.dp,
    val remoteButton: Dp = 48.dp,
    val listRow: Dp = 56.dp,
    val actionRow: Dp = 52.dp,
    val posterRow: DpSize = DpSize(36.dp, 54.dp),
    val posterNow: DpSize = DpSize(56.dp, 84.dp),
    val icon: Dp = 20.dp,
    val iconButton: Dp = 40.dp,
    val topBar: Dp = 56.dp,
    val bottomBar: Dp = 64.dp,
    val hairline: Dp = 1.dp,
    val progress: Dp = 4.dp,
    val statusDot: Dp = 8.dp,
    /** A [FactRow]'s label column. */
    val factLabel: Dp = 72.dp,
    /** The active tab's indicator behind its icon. */
    val tabIndicator: DpSize = DpSize(56.dp, 28.dp),
)

/** The six type styles; two weights only (Regular, Medium). Colours come from where they are used. */
@Immutable
data class IzleType(
    val title: TextStyle = style(20, 26, FontWeight.Medium),
    val heading: TextStyle = style(16, 22, FontWeight.Medium),
    /** A [ListRow]'s title: `heading`-sized, Regular. */
    val rowTitle: TextStyle = style(16, 22, FontWeight.Normal),
    val body: TextStyle = style(15, 21, FontWeight.Normal),
    val label: TextStyle = style(14, 20, FontWeight.Medium),
    val caption: TextStyle = style(13, 18, FontWeight.Normal),
    val mono: TextStyle = style(12, 16, FontWeight.Normal).copy(fontFamily = FontFamily.Monospace),
    /** Numbers read at a glance (a pairing code, the timing offset): `title` with digits of equal width. */
    val digits: TextStyle = style(20, 26, FontWeight.Medium).copy(fontFeatureSettings = "tnum"),
    /** A [StatusChip]'s text: `label` at 12 sp. */
    val chip: TextStyle = style(12, 16, FontWeight.Medium),
)

private fun style(size: Int, line: Int, weight: FontWeight) =
    TextStyle(fontSize = size.sp, lineHeight = line.sp, fontWeight = weight)
