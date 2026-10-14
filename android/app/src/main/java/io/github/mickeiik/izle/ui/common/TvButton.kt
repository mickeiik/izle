package io.github.mickeiik.izle.ui.common

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.tv.material3.Button
import androidx.tv.material3.ButtonDefaults
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import io.github.mickeiik.izle.ui.theme.IzleBorders
import io.github.mickeiik.izle.ui.theme.IzleColors
import io.github.mickeiik.izle.ui.theme.IzleShapes
import io.github.mickeiik.izle.ui.theme.IzleSpacing

/**
 * The app's one button: dark with a grey outline, and white with a white border, 10 % larger, while focused, so the
 * focused one is unmistakable from across the room. Two buttons side by side never look alike.
 */
@Composable
fun TvButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    Button(
        onClick = onClick,
        modifier = modifier,
        enabled = enabled,
        scale = ButtonDefaults.scale(focusedScale = 1.1f),
        shape = ButtonDefaults.shape(IzleShapes.Pill),
        colors = ButtonDefaults.colors(
            containerColor = IzleColors.SurfaceHigh,
            contentColor = IzleColors.OnSurface,
            focusedContainerColor = IzleColors.Focus,
            focusedContentColor = IzleColors.OnFocus,
            pressedContainerColor = IzleColors.Focus,
            pressedContentColor = IzleColors.OnFocus,
            disabledContainerColor = IzleColors.Surface,
            disabledContentColor = IzleColors.Dim,
        ),
        border = ButtonDefaults.border(
            border = IzleBorders.outline(IzleShapes.Pill),
            focusedBorder = IzleBorders.focus(IzleShapes.Pill),
            pressedBorder = IzleBorders.focus(IzleShapes.Pill),
            disabledBorder = IzleBorders.outline(IzleShapes.Pill),
            focusedDisabledBorder = IzleBorders.focus(IzleShapes.Pill),
        ),
        contentPadding = PaddingValues(horizontal = IzleSpacing.XXLarge, vertical = IzleSpacing.Small),
    ) {
        Text(text, style = MaterialTheme.typography.titleLarge, maxLines = 1)
    }
}
