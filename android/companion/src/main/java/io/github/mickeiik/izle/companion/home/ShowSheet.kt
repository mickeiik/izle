package io.github.mickeiik.izle.companion.home

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.KeyboardArrowUp
import androidx.compose.material.icons.outlined.List
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import io.github.mickeiik.izle.companion.R
import io.github.mickeiik.izle.companion.ui.design.ActionRow
import io.github.mickeiik.izle.companion.ui.design.Caption
import io.github.mickeiik.izle.companion.ui.design.Hairline
import io.github.mickeiik.izle.companion.ui.design.IzleIcons
import io.github.mickeiik.izle.companion.ui.design.IzleSheet
import io.github.mickeiik.izle.companion.ui.design.IzleTheme
import io.github.mickeiik.izle.companion.ui.design.Tone
import io.github.mickeiik.izle.data.api.AdminApp
import io.github.mickeiik.izle.data.api.AdminHomeEntry
import io.github.mickeiik.izle.data.api.HomeSection

/**
 * A show's sheet: where it is ("Films · card 1 of 6"), what OK plays and its check, then Play on <TV> now, Continue
 * from episode… (a series), Check this show, Move to section…, Move to first and Remove from Home. A show hidden on the TV offers only
 * the moves and Remove.
 */
@Composable
internal fun ShowSheet(
    entry: AdminHomeEntry?,
    itemId: String,
    section: HomeSection,
    index: Int,
    sectionCount: Int,
    tvName: String,
    poster: @Composable () -> Unit,
    onDismiss: () -> Unit,
    onPlay: () -> Unit,
    onContinue: () -> Unit,
    onMoveTo: () -> Unit,
    onFirst: () -> Unit,
    onCheck: () -> Unit,
    onRemove: () -> Unit,
) {
    val res = resources()
    val hidden = hiddenReason(entry)
    val act = closing(onDismiss)
    CardSheet(onDismiss, poster, entry?.title ?: itemId, lines = {
        val place = placeText(section, index)
        when {
            hidden != null -> {
                Caption(place)
                Caption(stringResource(hidden), tone = Tone.Warning)
            }
            entry != null -> Caption("$place · ${showLine(res, entry)}")
            else -> Caption(place)
        }
        val verdict = verdictOf(entry?.check)
        if (hidden == null && verdict != Verdict.NotChecked) VerdictLine(verdict)
    }) {
        if (hidden == null) {
            ActionRow(stringResource(R.string.home_play_now, tvName), Icons.Outlined.PlayArrow, act(onPlay))
            if (entry?.kind == "series") {
                ActionRow(stringResource(R.string.home_continue_from), IzleIcons.SkipNext, act(onContinue))
            }
            ActionRow(stringResource(R.string.home_check_show), Icons.Outlined.CheckCircle, act(onCheck))
        }
        MoveActions(index, sectionCount, act, onMoveTo, onFirst, onRemove)
    }
}

/**
 * An app card's sheet: where it is, "OK opens Weather on Salon" (or why the TV hides it), then Move to section…, Move to
 * first and Remove from Home.
 */
@Composable
internal fun AppSheet(
    app: AdminApp?,
    appId: String,
    section: HomeSection,
    index: Int,
    sectionCount: Int,
    tvName: String,
    picture: @Composable () -> Unit,
    onDismiss: () -> Unit,
    onMoveTo: () -> Unit,
    onFirst: () -> Unit,
    onRemove: () -> Unit,
) {
    val name = appName(app, appId)
    CardSheet(onDismiss, picture, name, lines = {
        Caption(placeText(section, index))
        if (appHidden(app)) Caption(stringResource(R.string.home_hidden_not_installed), tone = Tone.Warning)
        else Caption(stringResource(R.string.home_app_opens, name, tvName))
    }) {
        MoveActions(index, sectionCount, closing(onDismiss), onMoveTo, onFirst, onRemove)
    }
}

/** Each action closes the sheet first; its result shows in the list or as a message. */
private fun closing(onDismiss: () -> Unit) = { action: () -> Unit -> { onDismiss(); action() } }

/** "Films · card 1 of 6": the card's place among all the cards of its section. */
@Composable
private fun placeText(section: HomeSection, index: Int): String =
    stringResource(R.string.home_place, sectionTitle(resources(), section.title), index + 1, section.cards.size)

/**
 * The mockup's sheet: the picture beside the title and the [lines] saying where the card is and what OK does, a
 * hairline, then the [actions].
 */
@Composable
private fun CardSheet(
    onDismiss: () -> Unit,
    picture: @Composable () -> Unit,
    title: String,
    lines: @Composable ColumnScope.() -> Unit,
    actions: @Composable ColumnScope.() -> Unit,
) {
    IzleSheet(onDismiss, padded = false) {
        Row(
            Modifier.padding(horizontal = IzleTheme.spacing.lg).padding(bottom = IzleTheme.spacing.sm),
            horizontalArrangement = Arrangement.spacedBy(IzleTheme.spacing.md),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            picture()
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(IzleTheme.spacing.line)) {
                Text(title, style = IzleTheme.type.title, color = IzleTheme.colors.textPrimary, maxLines = 2, overflow = TextOverflow.Ellipsis)
                lines()
            }
        }
        Hairline()
        actions()
    }
}

/** Move to section… (with another section to go to), Move to first (not for the first card), Remove from Home. */
@Composable
private fun MoveActions(index: Int, sectionCount: Int, act: (() -> Unit) -> () -> Unit, onMoveTo: () -> Unit, onFirst: () -> Unit, onRemove: () -> Unit) {
    if (sectionCount > 1) ActionRow(stringResource(R.string.home_move_to_section), Icons.Outlined.List, act(onMoveTo))
    if (index > 0) ActionRow(stringResource(R.string.home_move_first), Icons.Outlined.KeyboardArrowUp, act(onFirst))
    ActionRow(stringResource(R.string.home_remove_from_home), Icons.Outlined.Delete, act(onRemove), tone = Tone.Danger)
}
