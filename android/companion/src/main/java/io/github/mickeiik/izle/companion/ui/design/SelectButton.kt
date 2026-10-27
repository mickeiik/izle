package io.github.mickeiik.izle.companion.ui.design

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow

/**
 * A Secondary-looking button that picks one of [items] from a menu: the current choice as [text] (one line,
 * ellipsised) and a chevron after it; each item closes the menu before it acts.
 * Full width unless [modifier] says otherwise.
 */
@Composable
fun SelectButton(text: String, items: List<MenuItem>, modifier: Modifier = Modifier) {
    var open by remember { mutableStateOf(false) }
    val c = IzleTheme.colors
    Box(modifier.fillMaxWidth()) {
        Surface(
            onClick = { open = true },
            shape = RoundedCornerShape(IzleTheme.radii.md),
            color = Color.Transparent,
            contentColor = c.textPrimary,
            border = BorderStroke(IzleTheme.sizes.hairline, c.border),
            modifier = Modifier.fillMaxWidth().heightIn(min = IzleTheme.sizes.button).semantics { role = Role.DropdownList },
        ) {
            Row(
                Modifier.padding(horizontal = IzleTheme.spacing.lg),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.Center,
            ) {
                Text(text, style = IzleTheme.type.label, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                Spacer(Modifier.size(IzleTheme.spacing.xs))
                Icon(IzleIcons.ExpandMore, contentDescription = null, tint = c.textSecondary, modifier = Modifier.size(IzleTheme.sizes.icon))
            }
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            for (item in items) {
                DropdownMenuItem(
                    text = { Text(item.text, style = IzleTheme.type.body, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    enabled = item.enabled,
                    onClick = {
                        open = false
                        item.onClick()
                    },
                )
            }
        }
    }
}
