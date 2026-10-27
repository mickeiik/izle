package io.github.mickeiik.izle.companion.ui.design

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import io.github.mickeiik.izle.companion.R

/**
 * A search field: radius `md`, a search icon, the [placeholder] in `textMuted`, one line, and a clear button while it
 * holds text.
 */
@Composable
fun SearchField(value: String, onValueChange: (String) -> Unit, placeholder: String, modifier: Modifier = Modifier) {
    val c = IzleTheme.colors
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null, tint = c.textSecondary, modifier = Modifier.size(IzleTheme.sizes.icon)) },
        trailingIcon = if (value.isEmpty()) null else ({ IconAction(Icons.Filled.Close, stringResource(R.string.clear), onClick = { onValueChange("") }) }),
        placeholder = { Text(placeholder, style = IzleTheme.type.body, color = c.textMuted, maxLines = 1) },
        textStyle = IzleTheme.type.body,
        singleLine = true,
        shape = RoundedCornerShape(IzleTheme.radii.md),
        colors = OutlinedTextFieldDefaults.colors(
            focusedBorderColor = c.accent,
            unfocusedBorderColor = c.border,
            focusedContainerColor = c.surface,
            unfocusedContainerColor = c.surface,
            cursorColor = c.accent,
        ),
        modifier = modifier.fillMaxWidth(),
    )
}

/**
 * A filter chip (32 dp, radius `sm`, `label`): at rest a 1 dp `border` and `textSecondary` text, [selected] in
 * `accentMuted` with `accent` text and border. Chips sit in a [ChipRow].
 */
@Composable
fun FilterChip(text: String, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val c = IzleTheme.colors
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(IzleTheme.radii.sm),
        color = if (selected) c.accentMuted else Color.Transparent,
        contentColor = if (selected) c.accent else c.textSecondary,
        border = BorderStroke(IzleTheme.sizes.hairline, if (selected) c.accent else c.border),
        modifier = modifier.heightIn(min = IzleTheme.sizes.buttonSmall).semantics {
            role = Role.Checkbox
            this.selected = selected
        },
    ) {
        Box(Modifier.padding(horizontal = IzleTheme.spacing.md), contentAlignment = Alignment.Center) {
            Text(text, style = IzleTheme.type.label, maxLines = 1)
        }
    }
}

/** Chips in one line that scrolls sideways, `sm` apart, starting at the page gutter. */
@Composable
fun ChipRow(modifier: Modifier = Modifier, content: @Composable RowScope.() -> Unit) {
    val s = IzleTheme.spacing
    Row(
        modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(PaddingValues(horizontal = s.lg)),
        horizontalArrangement = Arrangement.spacedBy(s.sm),
        verticalAlignment = Alignment.CenterVertically,
        content = content,
    )
}

/**
 * A quiet picker in a line of text (a list's sort): the current choice as [text] in `label`, `textSecondary`, with a
 * chevron; its menu lists [items], the [MenuItem.checked] one ticked.
 */
@Composable
fun QuietSelect(text: String, items: List<MenuItem>, modifier: Modifier = Modifier, description: String? = null) {
    var open by remember { mutableStateOf(false) }
    val c = IzleTheme.colors
    Box(modifier) {
        Row(
            Modifier.clip(RoundedCornerShape(IzleTheme.radii.sm))
                .clickable(onClickLabel = description, role = Role.DropdownList) { open = true }
                .heightIn(min = IzleTheme.sizes.buttonSmall)
                .padding(horizontal = IzleTheme.spacing.sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(text, style = IzleTheme.type.label, color = c.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Spacer(Modifier.size(IzleTheme.spacing.xs))
            Icon(IzleIcons.ExpandMore, contentDescription = null, tint = c.textSecondary, modifier = Modifier.size(IzleTheme.sizes.icon))
        }
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
