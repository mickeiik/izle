package io.github.mickeiik.izle.ui.theme

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Border
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Typography
import androidx.tv.material3.darkColorScheme

/**
 * High-contrast palette on a near-black background. Each colour has one role: white is the focus, the warm accent
 * is "time and attention" (Continue, countdowns, the owner's message), mint is "New", red is "no connection".
 */
object IzleColors {
    val Background = Color(0xFF0B0B0F)
    val Surface = Color(0xFF1C1C24)
    val SurfaceHigh = Color(0xFF2A2A35)
    val OnSurface = Color(0xFFF5F5F7)
    val Dim = Color(0xFFB8B8C4)

    /** Outlines of unfocused controls (buttons, the address field). */
    val Outline = Color(0xFF4A4A58)

    /** The thin edge that lifts a chip off a busy poster. */
    val Hairline = Color(0x33FFFFFF)

    /** The focused element: border, and the fill of a focused button. */
    val Focus = Color(0xFFFFFFFF)
    val OnFocus = Color(0xFF0B0B0F)

    val Accent = Color(0xFFFFC94D)
    val OnAccent = Color(0xFF1A1300)

    /** The "New" chip: a show never played. */
    val New = Color(0xFF7FE3C4)
    val OnNew = Color(0xFF002118)

    /** The tile chip naming the episode OK plays, or "Watch again": light, so it reads on dark posters too. */
    val ChipNeutral = Color(0xFFE2E2EA)
    val OnChipNeutral = Color(0xFF15151B)

    /** The new-episodes count at the poster's top: dark and quiet, it only informs. */
    val ChipInfo = Color(0xD90B0B0F)
    val OnChipInfo = Color(0xFFF5F5F7)

    /** Error text on a dark background. */
    val Error = Color(0xFFFF8A80)

    /** The "No connection" chip: solid red, dark text. */
    val Offline = Color(0xFFFF5C50)
    val OnOffline = Color(0xFF1F0000)

    /** Behind the hidden menu, the "No connection" message over Home and the player's pause symbol. */
    val Scrim = Color(0xCC000000)

    /** The bottom of a poster, behind its chip. */
    val PosterShade = Color(0xE6000000)

    /** The player's information panel over the video. */
    val InfoShade = Color(0xE6000000)

    val ProgressTrack = Color(0x55FFFFFF)

    /** Subtitles: white on a dark box. */
    val Caption = Color(0xCC000000)
    val OnCaption = Color(0xFFFFFFFF)

    /** Around the video, and behind it while it loads. */
    val Video = Color(0xFF000000)

    /** The edge of the owner's message banner, so it stands out on a bright picture. */
    val BannerEdge = Color(0x66000000)
}

/** Distances on the 960×540 dp TV canvas. */
object IzleSpacing {
    /** 5 % of the canvas on each side: many TVs crop the picture's edges (overscan). Nothing that matters goes there. */
    val SafeHorizontal = 48.dp
    val SafeVertical = 27.dp
    val Safe = PaddingValues(horizontal = SafeHorizontal, vertical = SafeVertical)

    val XSmall = 4.dp
    val Small = 8.dp
    val Medium = 12.dp
    val Large = 16.dp
    val XLarge = 24.dp
    val XXLarge = 32.dp
    val Huge = 48.dp
}

object IzleShapes {
    /** Chips and the subtitle box. */
    val Small = RoundedCornerShape(8.dp)

    /** Tiles, menu rows, the address field. */
    val Medium = RoundedCornerShape(12.dp)

    /** Posters in panels, the owner's message, message boxes, the pairing code. */
    val Large = RoundedCornerShape(16.dp)

    /** Buttons and the "No connection" chip. */
    val Pill = RoundedCornerShape(percent = 50)
}

object IzleBorders {
    /** The one focused element's white border. */
    val FocusWidth = 4.dp
    val OutlineWidth = 2.dp

    fun focus(shape: Shape) = Border(BorderStroke(FocusWidth, IzleColors.Focus), shape = shape)
    fun outline(shape: Shape) = Border(BorderStroke(OutlineWidth, IzleColors.Outline), shape = shape)
}

// What tv-material reads from the scheme here (every other colour of its components is set explicitly): `primary` for
// the address field's text selection, `surface`/`onSurface`/`surfaceTint` for the poster tiles' cards.
private val ColorScheme = darkColorScheme(
    primary = IzleColors.Focus,
    surface = IzleColors.Surface,
    onSurface = IzleColors.OnSurface,
    surfaceTint = IzleColors.Surface,
)

private fun style(size: Int, weight: FontWeight = FontWeight.Normal, lineHeight: Int = size + 8) =
    TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = weight, fontSize = size.sp, lineHeight = lineHeight.sp)

/** Nothing on screen is smaller than 24 sp: the viewer sits far away and may not see well. Only the roles in use. */
private val IzleTypography = Typography(
    displayLarge = style(96, FontWeight.Bold, 104),
    displaySmall = style(44, FontWeight.Bold),
    headlineMedium = style(34, FontWeight.Bold),
    headlineSmall = style(30, FontWeight.Bold),
    titleLarge = style(28, FontWeight.Bold),
    titleMedium = style(26, FontWeight.Bold),
    titleSmall = style(24, FontWeight.Bold),
    bodyLarge = style(28),
    bodySmall = style(24),
    labelMedium = style(24, FontWeight.Bold),
    labelSmall = style(24),
)

@Composable
fun IzleTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = ColorScheme, typography = IzleTypography, content = content)
}
