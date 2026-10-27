package io.github.mickeiik.izle.companion.home

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.KeyboardArrowUp
import androidx.compose.material.icons.outlined.List
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import io.github.mickeiik.izle.companion.R
import io.github.mickeiik.izle.companion.ui.design.ActionRow
import io.github.mickeiik.izle.companion.ui.design.Caption
import io.github.mickeiik.izle.companion.ui.design.IzleIcons
import io.github.mickeiik.izle.companion.ui.design.IzleSheet
import io.github.mickeiik.izle.companion.ui.design.IzleTheme
import io.github.mickeiik.izle.companion.ui.design.Tone
import io.github.mickeiik.izle.data.api.AdminHomeEntry
import io.github.mickeiik.izle.data.api.HomeSection

/**
 * A show's sheet: where it is ("Films · card 1 of 6"), what OK plays and its check, then Play on <TV> now, Continue
 * from episode… (a series), Move to section…, Move to first and Remove from Home. A show hidden on the TV offers only
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
    onDismiss: () -> Unit,
    onPlay: () -> Unit,
    onContinue: () -> Unit,
    onMoveTo: () -> Unit,
    onFirst: () -> Unit,
    onRemove: () -> Unit,
) {
    val res = resources()
    val hidden = hiddenReason(entry)
    // Each action closes the sheet first; its result shows in the list or as a message.
    val act = { action: () -> Unit -> { onDismiss(); action() } }
    IzleSheet(onDismiss, title = entry?.title ?: itemId, padded = false) {
        Column(Modifier.padding(horizontal = IzleTheme.spacing.lg), verticalArrangement = Arrangement.spacedBy(IzleTheme.spacing.sm)) {
            Caption(stringResource(R.string.home_place, sectionTitle(res, section.title), index + 1, section.itemIds.size))
            if (hidden != null) {
                Caption(stringResource(hidden), tone = Tone.Warning)
            } else if (entry != null) {
                Caption(showLine(res, entry))
                VerdictLine(verdictOf(entry.check))
            }
        }
        if (hidden == null) {
            ActionRow(stringResource(R.string.home_play_now, tvName), Icons.Outlined.PlayArrow, act(onPlay))
            if (entry?.kind == "series") {
                ActionRow(stringResource(R.string.home_continue_from), IzleIcons.SkipNext, act(onContinue))
            }
        }
        if (sectionCount > 1) ActionRow(stringResource(R.string.home_move_to_section), Icons.Outlined.List, act(onMoveTo))
        if (index > 0) ActionRow(stringResource(R.string.home_move_first), Icons.Outlined.KeyboardArrowUp, act(onFirst))
        ActionRow(stringResource(R.string.home_remove_from_home), Icons.Outlined.Delete, act(onRemove), tone = Tone.Danger)
    }
}
