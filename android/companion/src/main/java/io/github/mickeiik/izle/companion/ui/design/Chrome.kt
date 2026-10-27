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
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material3.BottomSheetDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.mickeiik.izle.companion.R

/**
 * One remote button: an [icon] and/or a short [label] ("30" in `caption` beside the icon, or a channel button's
 * words), spoken as [description]. [primary] fills it with `accent` (Play/Pause).
 */
data class RemoteKey(
    val description: String,
    val onClick: () -> Unit,
    val icon: ImageVector? = null,
    val label: String? = null,
    val primary: Boolean = false,
)

/** The remote: one row of equal 48 dp outlined buttons (radius `md`), `textPrimary` icons, the primary key outlined in `accent`. */
@Composable
fun RemoteBar(keys: List<RemoteKey>, modifier: Modifier = Modifier) {
    val c = IzleTheme.colors
    ButtonRow(modifier.fillMaxWidth()) {
        for (key in keys) {
            Surface(
                onClick = key.onClick,
                shape = RoundedCornerShape(IzleTheme.radii.md),
                color = Color.Transparent,
                contentColor = if (key.primary) c.accent else c.textPrimary,
                border = BorderStroke(IzleTheme.sizes.hairline, if (key.primary) c.accent else c.border),
                modifier = Modifier.height(IzleTheme.sizes.remoteButton).semantics { contentDescription = key.description },
            ) {
                Row(horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                    key.icon?.let { Icon(it, contentDescription = null, modifier = Modifier.size(IzleTheme.sizes.icon)) }
                    if (key.icon != null && key.label != null) Spacer(Modifier.width(IzleTheme.spacing.xs / 2))
                    key.label?.let {
                        Text(it, style = if (key.icon != null) IzleTheme.type.caption else IzleTheme.type.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
    }
}

/**
 * A bottom sheet: `surface`, top radius `lg`, a hairline-coloured handle, [title] in `title`; [content] padded `lg`
 * (with [padded] false it spans the width, for [ActionRow]s, which pad themselves).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun IzleSheet(onDismiss: () -> Unit, title: String? = null, padded: Boolean = true, content: @Composable ColumnScope.() -> Unit) {
    val s = IzleTheme.spacing
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        shape = RoundedCornerShape(topStart = IzleTheme.radii.lg, topEnd = IzleTheme.radii.lg),
        containerColor = IzleTheme.colors.surface,
        contentColor = IzleTheme.colors.textPrimary,
        tonalElevation = 0.dp,
        dragHandle = { BottomSheetDefaults.DragHandle(color = IzleTheme.colors.border) },
    ) {
        Column(Modifier.fillMaxWidth().padding(bottom = s.xl), verticalArrangement = Arrangement.spacedBy(s.md)) {
            if (title != null) {
                Text(
                    title,
                    style = IzleTheme.type.title,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(horizontal = s.lg),
                )
            }
            Column(
                Modifier.fillMaxWidth().padding(horizontal = if (padded) s.lg else 0.dp),
                verticalArrangement = Arrangement.spacedBy(if (padded) s.md else 0.dp),
                content = content,
            )
        }
    }
}

/**
 * The app bar (56 dp, `surface`, a hairline under it, below the status bar): a back arrow with [onBack], the [title]
 * in `title` (with [onTitleClick] it is tappable, [titleClickLabel] spoken, with a drop-down arrow), then [actions].
 */
@Composable
fun IzleTopBar(
    title: String,
    modifier: Modifier = Modifier,
    onBack: (() -> Unit)? = null,
    onTitleClick: (() -> Unit)? = null,
    titleClickLabel: String? = null,
    actions: @Composable RowScope.() -> Unit = {},
) {
    val c = IzleTheme.colors
    val s = IzleTheme.spacing
    Column(modifier.fillMaxWidth().background(c.surface).windowInsetsPadding(WindowInsets.statusBars)) {
        Row(
            Modifier.fillMaxWidth().height(IzleTheme.sizes.topBar).padding(start = if (onBack == null) s.lg else s.xs, end = s.xs),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (onBack != null) IconAction(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.back), onBack, tint = c.textPrimary)
            Row(
                Modifier.weight(1f).fillMaxHeight().then(
                    if (onTitleClick != null) Modifier.clickable(onClickLabel = titleClickLabel, onClick = onTitleClick) else Modifier,
                ).padding(start = if (onBack == null) 0.dp else s.xs),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    title,
                    style = IzleTheme.type.title,
                    color = c.textPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (onTitleClick != null) {
                    Icon(Icons.Filled.ArrowDropDown, contentDescription = null, tint = c.textSecondary, modifier = Modifier.size(IzleTheme.sizes.icon))
                }
            }
            actions()
        }
        Hairline()
    }
}

/** One tab of the [IzleBottomBar]; [dot] draws a small `danger` dot on its icon (the TV has problems). */
data class TabItem(val label: String, val icon: ImageVector, val selected: Boolean, val dot: Boolean = false, val onClick: () -> Unit)

/**
 * The bottom bar (64 dp, `surface`, a hairline above it, above the navigation bar): each tab an icon over its
 * `label`, the active one in `accent` on an `accentMuted` indicator, the others in `textSecondary`; a tab's [TabItem.dot]
 * is an 8 dp `danger` dot at its icon's top end.
 */
@Composable
fun IzleBottomBar(tabs: List<TabItem>, modifier: Modifier = Modifier) {
    val c = IzleTheme.colors
    Column(modifier.fillMaxWidth().background(c.surface).windowInsetsPadding(WindowInsets.navigationBars)) {
        Hairline()
        Row(Modifier.fillMaxWidth().height(IzleTheme.sizes.bottomBar).selectableGroup()) {
            for (tab in tabs) {
                val color = if (tab.selected) c.accent else c.textSecondary
                Column(
                    Modifier.weight(1f).fillMaxHeight().selectable(selected = tab.selected, onClick = tab.onClick, role = Role.Tab),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) {
                    Box(
                        Modifier.size(IzleTheme.sizes.tabIndicator).clip(RoundedCornerShape(IzleTheme.radii.lg))
                            .background(if (tab.selected) c.accentMuted else c.surface),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(tab.icon, contentDescription = null, tint = color, modifier = Modifier.size(IzleTheme.sizes.icon))
                        if (tab.dot) {
                            val half = IzleTheme.sizes.icon / 2
                            Box(
                                Modifier.offset(x = half, y = -half + IzleTheme.sizes.statusDot / 2).size(IzleTheme.sizes.statusDot)
                                    .clip(CircleShape).background(c.danger),
                            )
                        }
                    }
                    Spacer(Modifier.height(IzleTheme.spacing.xs))
                    Text(tab.label, style = IzleTheme.type.label, color = color, maxLines = 1)
                }
            }
        }
    }
}
