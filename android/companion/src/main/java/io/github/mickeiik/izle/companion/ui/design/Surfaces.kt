package io.github.mickeiik.izle.companion.ui.design

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import io.github.mickeiik.izle.companion.R

/**
 * A card: `surface` with a 1 dp `border`, radius `md`, padding `lg`, no elevation. [accent] fills it with
 * `accentMuted` instead (the listening bar). With [onClick] the whole card is tappable.
 */
@Composable
fun Card(
    modifier: Modifier = Modifier,
    accent: Boolean = false,
    onClick: (() -> Unit)? = null,
    onClickLabel: String? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val c = IzleTheme.colors
    val shape = RoundedCornerShape(IzleTheme.radii.md)
    val inner = @Composable {
        Column(Modifier.padding(IzleTheme.spacing.lg), verticalArrangement = Arrangement.spacedBy(IzleTheme.spacing.sm), content = content)
    }
    val fill = if (accent) c.accentMuted else c.surface
    val border = if (accent) null else BorderStroke(IzleTheme.sizes.hairline, c.border)
    Surface(
        shape = shape,
        color = fill,
        contentColor = c.textPrimary,
        border = border,
        modifier = modifier.fillMaxWidth().then(
            if (onClick != null) Modifier.clip(shape).clickable(onClickLabel = onClickLabel, onClick = onClick) else Modifier,
        ),
    ) { inner() }
}

/** A 1 dp `border` hairline across the width (between rows, under a bar). */
@Composable
fun Hairline(modifier: Modifier = Modifier) {
    HorizontalDivider(modifier, thickness = IzleTheme.sizes.hairline, color = IzleTheme.colors.border)
}

/**
 * A list row, at least 56 dp: [leading] (a [Poster], an icon), the title (`heading`-sized, Regular) and one
 * `caption` [supporting] line in [supportingTone] (both ellipsised; the title in [titleTone]'s colour when not Neutral) followed by [badge] (a [StatusChip]), then [trailing]; a hairline under it when
 * [divider]. With [selected] non-null it is a radio row (the radio drawn as leading); else [onClick] makes it tappable.
 */
@Composable
fun ListRow(
    title: String,
    modifier: Modifier = Modifier,
    supporting: String? = null,
    supportingTone: Tone = Tone.Neutral,
    titleTone: Tone = Tone.Neutral,
    badge: (@Composable () -> Unit)? = null,
    leading: (@Composable () -> Unit)? = null,
    trailing: (@Composable RowScope.() -> Unit)? = null,
    onClick: (() -> Unit)? = null,
    onClickLabel: String? = null,
    selected: Boolean? = null,
    divider: Boolean = true,
) {
    val s = IzleTheme.spacing
    val action = when {
        selected != null && onClick != null -> Modifier.selectable(selected = selected, onClick = onClick, role = Role.RadioButton)
        onClick != null -> Modifier.clickable(onClickLabel = onClickLabel, onClick = onClick)
        else -> Modifier
    }
    Column(modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().then(action).heightIn(min = IzleTheme.sizes.listRow).padding(horizontal = s.lg, vertical = s.sm),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(s.md),
        ) {
            if (selected != null) RadioButton(selected = selected, onClick = null)
            leading?.invoke()
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(s.line)) {
                Text(
                    title,
                    style = IzleTheme.type.rowTitle,
                    color = if (titleTone == Tone.Neutral) IzleTheme.colors.textPrimary else toneColor(titleTone),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (supporting != null || badge != null) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(s.sm)) {
                        if (supporting != null) {
                            Text(
                                supporting,
                                style = IzleTheme.type.caption,
                                color = toneColor(supportingTone),
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f, fill = false),
                            )
                        }
                        badge?.invoke()
                    }
                }
            }
            trailing?.invoke(this)
        }
        if (divider) Hairline(Modifier.padding(start = s.lg))
    }
}

/** A section's header band: `surfaceMuted`, the `heading` title with `caption` [meta] on the same line, then [trailing] (an [OverflowMenu]). */
@Composable
fun SectionHeader(title: String, modifier: Modifier = Modifier, meta: String? = null, trailing: (@Composable RowScope.() -> Unit)? = null) {
    val s = IzleTheme.spacing
    Row(
        modifier.fillMaxWidth().background(IzleTheme.colors.surfaceMuted).heightIn(min = IzleTheme.sizes.button + s.sm)
            .padding(start = s.lg, end = s.xs),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(s.sm),
    ) {
        // The title takes what is left; the meta and the menu sit at the right edge on every header.
        Text(
            title,
            style = IzleTheme.type.heading,
            color = IzleTheme.colors.textPrimary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (meta != null) Text(meta, style = IzleTheme.type.caption, color = IzleTheme.colors.textSecondary, maxLines = 1)
        trailing?.invoke(this)
    }
}

/** A sheet's action as a 52 dp row: [icon] and [text], in `danger` for [Tone.Danger]. Sheets list actions this way, never as stacked buttons. */
@Composable
fun ActionRow(text: String, icon: ImageVector, onClick: () -> Unit, modifier: Modifier = Modifier, tone: Tone = Tone.Neutral, enabled: Boolean = true) {
    val color = when {
        !enabled -> IzleTheme.colors.textMuted
        tone == Tone.Neutral -> IzleTheme.colors.textPrimary
        else -> toneColor(tone)
    }
    Row(
        modifier.fillMaxWidth().clickable(enabled = enabled, role = Role.Button, onClick = onClick).heightIn(min = IzleTheme.sizes.actionRow)
            .padding(horizontal = IzleTheme.spacing.lg),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(IzleTheme.spacing.lg),
    ) {
        Icon(icon, contentDescription = null, tint = color, modifier = Modifier.size(IzleTheme.sizes.icon))
        Text(text, style = IzleTheme.type.body, color = color, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/**
 * A folded section under a hairline (Timing for this source, Sync details): the `heading` [title], the `caption`
 * [summary] while folded, a chevron; tapping it calls [onToggle]. [content] shows while [expanded].
 */
@Composable
fun Disclosure(
    title: String,
    summary: String?,
    expanded: Boolean,
    onToggle: () -> Unit,
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    val s = IzleTheme.spacing
    Column(modifier.fillMaxWidth()) {
        Hairline()
        val action = stringResource(if (expanded) R.string.hide else R.string.show)
        Row(
            Modifier.fillMaxWidth().clickable(onClickLabel = action, onClick = onToggle).padding(vertical = s.md),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(s.line)) {
                Text(title, style = IzleTheme.type.heading, color = IzleTheme.colors.textPrimary)
                if (summary != null && !expanded) Text(summary, style = IzleTheme.type.caption, color = IzleTheme.colors.textSecondary)
            }
            Icon(
                if (expanded) IzleIcons.ExpandLess else IzleIcons.ExpandMore,
                contentDescription = null,
                tint = IzleTheme.colors.textSecondary,
                modifier = Modifier.size(IzleTheme.sizes.icon),
            )
        }
        if (expanded) Column(Modifier.padding(bottom = s.sm), verticalArrangement = Arrangement.spacedBy(s.sm), content = content)
    }
}

/** A quiet line where content would be ("Nothing is playing"): body text in `textSecondary`, no card around it. */
@Composable
fun EmptyState(text: String, modifier: Modifier = Modifier) {
    Text(text, style = IzleTheme.type.body, color = IzleTheme.colors.textSecondary, modifier = modifier)
}

/** A caption line: supporting text, hints and meta in `textSecondary` (or [tone]'s colour). */
@Composable
fun Caption(text: String, modifier: Modifier = Modifier, tone: Tone = Tone.Neutral, maxLines: Int = Int.MAX_VALUE, align: TextAlign? = null) {
    Text(text, style = IzleTheme.type.caption, color = toneColor(tone), maxLines = maxLines, overflow = TextOverflow.Ellipsis, textAlign = align, modifier = modifier)
}

/** An icon-only button (20 dp icon in `textSecondary`, or [tint]) with its spoken [description]. */
@Composable
fun IconAction(icon: ImageVector, description: String, onClick: () -> Unit, modifier: Modifier = Modifier, tint: Color = Color.Unspecified) {
    IconButton(onClick = onClick, modifier = modifier.size(IzleTheme.sizes.iconButton + IzleTheme.spacing.sm)) {
        Icon(
            icon,
            contentDescription = description,
            tint = if (tint == Color.Unspecified) IzleTheme.colors.textSecondary else tint,
            modifier = Modifier.size(IzleTheme.sizes.icon),
        )
    }
}

/** One entry of an [OverflowMenu]; [checked] non-null draws a check (or its room) before the text. */
data class MenuItem(val text: String, val onClick: () -> Unit, val enabled: Boolean = true, val checked: Boolean? = null)

/** The ⋮ button and its menu of [items] (each closes the menu before it acts); [description] is the button's spoken name. */
@Composable
fun OverflowMenu(description: String, items: List<MenuItem>, modifier: Modifier = Modifier) {
    var open by remember { mutableStateOf(false) }
    Box(modifier) {
        IconAction(Icons.Filled.MoreVert, description, onClick = { open = true })
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            for (item in items) {
                DropdownMenuItem(
                    text = { Text(item.text, style = IzleTheme.type.body) },
                    enabled = item.enabled,
                    leadingIcon = item.checked?.let { checked ->
                        {
                            if (checked) Icon(Icons.Filled.Check, contentDescription = null, modifier = Modifier.size(IzleTheme.sizes.icon))
                            else Spacer(Modifier.size(IzleTheme.sizes.icon))
                        }
                    },
                    onClick = {
                        open = false
                        item.onClick()
                    },
                )
            }
        }
    }
}
