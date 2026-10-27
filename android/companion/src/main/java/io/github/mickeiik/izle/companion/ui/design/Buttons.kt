package io.github.mickeiik.izle.companion.ui.design

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp

/** What a button is for: at most one [Primary] per screen; [Quiet] is text only ("Edit", "Cancel"). */
enum class ButtonKind { Primary, Secondary, Quiet, Danger }

/** [Regular] is 40 dp high, [Small] 32 dp. */
enum class ButtonSize { Regular, Small }

/**
 * A button: its single-line label centred (an [icon] before it), radius `md`, [kind]'s colours, [size]'s height.
 * [selected] draws it as the current choice (`accentMuted` fill, `accent` text and border), as [ChoiceGrid] does.
 * Full width only when it is the screen's single main action (pass `Modifier.fillMaxWidth()`).
 */
@Composable
fun IzleButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    kind: ButtonKind = ButtonKind.Secondary,
    size: ButtonSize = ButtonSize.Regular,
    icon: ImageVector? = null,
    enabled: Boolean = true,
    selected: Boolean = false,
) {
    val c = IzleTheme.colors
    val hairline = IzleTheme.sizes.hairline
    val (fill, content, border) = when {
        !enabled -> Triple(Color.Transparent, c.textMuted, if (kind == ButtonKind.Quiet) null else c.border)
        selected -> Triple(c.accentMuted, c.accent, c.accent)
        // No fills: the primary action is told by its accent outline and text, as in the mockups.
        kind == ButtonKind.Primary -> Triple(Color.Transparent, c.accent, c.accent)
        kind == ButtonKind.Secondary -> Triple(Color.Transparent, c.textPrimary, c.border)
        kind == ButtonKind.Danger -> Triple(Color.Transparent, c.danger, c.border)
        else -> Triple(Color.Transparent, c.accent, null)
    }
    val height = if (size == ButtonSize.Small) IzleTheme.sizes.buttonSmall else IzleTheme.sizes.button
    // In an equal-width grid the width is set and the label centred: the padding only keeps it off the edges.
    val padding = when {
        LocalInEqualGrid.current -> IzleTheme.spacing.xs
        kind == ButtonKind.Quiet || size == ButtonSize.Small -> IzleTheme.spacing.md
        else -> IzleTheme.spacing.lg
    }
    Surface(
        onClick = onClick,
        enabled = enabled,
        shape = RoundedCornerShape(IzleTheme.radii.md),
        color = fill,
        contentColor = content,
        border = border?.let { BorderStroke(hairline, it) },
        modifier = modifier.heightIn(min = height).semantics {
            role = Role.Button
            if (selected) this.selected = true
        },
    ) {
        ButtonContent(text, icon, horizontalPadding = padding)
    }
}

@Composable
private fun ButtonContent(text: String, icon: ImageVector?, horizontalPadding: Dp) {
    Row(
        modifier = Modifier.padding(horizontal = horizontalPadding),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            Icon(icon, contentDescription = null, modifier = Modifier.size(IzleTheme.sizes.icon))
            Spacer(Modifier.width(IzleTheme.spacing.sm))
        }
        // A label alone in a grid's cell spans it, centred; else the row centres the icon and the label together.
        val spans = icon == null && LocalInEqualGrid.current
        Text(
            text,
            style = IzleTheme.type.label,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            textAlign = if (spans) TextAlign.Center else null,
            modifier = if (spans) Modifier.fillMaxWidth() else Modifier,
        )
    }
}

/** Equal-width children side by side with `sm` gaps (the timing nudges' rows, a dialog's actions); no weights needed. */
@Composable
fun ButtonRow(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    EqualGrid(columns = null, modifier = modifier, content = content)
}

/** Equal-width children in rows of [columns] with `sm` gaps; a short last row keeps the same cell width. */
@Composable
fun ButtonGrid(columns: Int, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    EqualGrid(columns = columns, modifier = modifier, content = content)
}

/**
 * Equal-width choices in rows of [columns] (speed, a message's duration, Add show's kinds): each [options] item drawn
 * by [label], the [selected] ones in `accentMuted` with `accent` text and border.
 */
@Composable
fun <T> ChoiceGrid(
    options: List<T>,
    label: (T) -> String,
    selected: (T) -> Boolean,
    onSelect: (T) -> Unit,
    modifier: Modifier = Modifier,
    columns: Int = options.size,
    size: ButtonSize = ButtonSize.Regular,
) {
    ButtonGrid(columns, modifier) {
        for (option in options) {
            IzleButton(label(option), onClick = { onSelect(option) }, size = size, selected = selected(option))
        }
    }
}

/**
 * Lays its children out in equal-width cells, [columns] per row (null: all on one row), `sm` apart; each row is as
 * high as its tallest child, which the others are centred against.
 */
/** Whether the caller is a cell of an [EqualGrid] (its width is set). */
private val LocalInEqualGrid = compositionLocalOf { false }

@Composable
private fun EqualGrid(columns: Int?, modifier: Modifier, content: @Composable () -> Unit) {
    val gap = IzleTheme.spacing.sm
    Layout(content = { CompositionLocalProvider(LocalInEqualGrid provides true, content = content) }, modifier = modifier) { measurables, constraints ->
        if (measurables.isEmpty()) return@Layout layout(0, 0) {}
        val perRow = (columns ?: measurables.size).coerceAtLeast(1)
        val gapPx = gap.roundToPx()
        val width = if (constraints.hasBoundedWidth) constraints.maxWidth else constraints.minWidth
        val cell = ((width - gapPx * (perRow - 1)) / perRow).coerceAtLeast(0)
        val rows = measurables.chunked(perRow).map { row -> row.map { it.measure(Constraints.fixedWidth(cell)) } }
        val heights = rows.map { row -> row.maxOf { it.height } }
        val height = heights.sum() + gapPx * (rows.size - 1)
        layout(width, height) {
            var y = 0
            rows.forEachIndexed { r, row ->
                row.forEachIndexed { i, p -> p.placeRelative(i * (cell + gapPx), y + (heights[r] - p.height) / 2) }
                y += heights[r] + gapPx
            }
        }
    }
}
