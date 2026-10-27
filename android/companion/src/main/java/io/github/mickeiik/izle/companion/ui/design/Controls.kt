package io.github.mickeiik.izle.companion.ui.design

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.Icon
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle

/**
 * An on/off switch (a row's trailing slot: Play on start): on, an `accent` track with a `surface` thumb; off, a
 * `surfaceMuted` track with a hairline `border` and a `textMuted` thumb. With [onCheckedChange] null the row around
 * it takes the tap.
 */
@Composable
fun IzleSwitch(checked: Boolean, onCheckedChange: ((Boolean) -> Unit)?, modifier: Modifier = Modifier, enabled: Boolean = true) {
    val c = IzleTheme.colors
    Switch(
        checked = checked,
        onCheckedChange = onCheckedChange,
        enabled = enabled,
        modifier = modifier,
        colors = SwitchDefaults.colors(
            checkedThumbColor = c.surface,
            checkedTrackColor = c.accent,
            checkedBorderColor = c.accent,
            uncheckedThumbColor = c.textMuted,
            uncheckedTrackColor = c.surfaceMuted,
            uncheckedBorderColor = c.border,
            disabledCheckedThumbColor = c.surface,
            disabledCheckedTrackColor = c.textMuted,
            disabledUncheckedThumbColor = c.textMuted,
            disabledUncheckedTrackColor = c.surfaceMuted,
            disabledUncheckedBorderColor = c.border,
        ),
    )
}

/** A row's chevron (it opens something): 20 dp, `textMuted`. */
@Composable
fun Chevron(modifier: Modifier = Modifier) {
    Icon(
        Icons.AutoMirrored.Filled.KeyboardArrowRight,
        contentDescription = null,
        tint = IzleTheme.colors.textMuted,
        modifier = modifier.size(IzleTheme.sizes.icon),
    )
}

/**
 * One fact of a sheet (a problem's Show, Source, HTTP): the [label] in `caption`/`textSecondary` in a fixed column,
 * the [value] in `body` (or `mono` with [mono]) beside it, wrapping; padded `lg` horizontally.
 */
@Composable
fun FactRow(label: String, value: String, modifier: Modifier = Modifier, mono: Boolean = false) {
    val s = IzleTheme.spacing
    Row(
        modifier.fillMaxWidth().padding(horizontal = s.lg, vertical = s.xs),
        horizontalArrangement = Arrangement.spacedBy(s.md),
        verticalAlignment = Alignment.Top,
    ) {
        Text(label, style = IzleTheme.type.caption.withBodyLine(), color = IzleTheme.colors.textSecondary, modifier = Modifier.width(IzleTheme.sizes.factLabel))
        Text(value, style = if (mono) IzleTheme.type.mono.withBodyLine() else IzleTheme.type.body, color = IzleTheme.colors.textPrimary, modifier = Modifier.weight(1f))
    }
}

/** The label sits on the value's first line. */
@Composable
private fun TextStyle.withBodyLine(): TextStyle = copy(lineHeight = IzleTheme.type.body.lineHeight)
