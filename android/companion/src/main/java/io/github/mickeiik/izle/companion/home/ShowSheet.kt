package io.github.mickeiik.izle.companion.home

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.mickeiik.izle.companion.R
import io.github.mickeiik.izle.data.api.AdminHomeEntry
import io.github.mickeiik.izle.data.api.HomeSection

/**
 * A show's sheet: where it is ("Films · card 1 of 6"), what OK plays and its check, then Play on <TV> now, Continue
 * from episode… (a series), Move to section…, Move to first and Remove from Home. A show hidden on the TV offers only
 * the moves and Remove.
 */
@OptIn(ExperimentalMaterial3Api::class)
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
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val hidden = hiddenReason(entry)
    // Each action closes the sheet first; its result shows in the list or as a message.
    val act = { action: () -> Unit -> { onDismiss(); action() } }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp).padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                entry?.title ?: itemId,
                style = MaterialTheme.typography.titleLarge,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                stringResource(R.string.home_place, sectionTitle(res, section.title), index + 1, section.itemIds.size),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (hidden != null) {
                Text(stringResource(hidden), style = MaterialTheme.typography.bodyMedium)
            } else if (entry != null) {
                Text(showLine(res, entry), style = MaterialTheme.typography.bodyMedium)
                VerdictChip(verdictOf(entry.check))
            }
            Spacer(Modifier.height(8.dp))
            if (hidden == null) {
                Button(onClick = act(onPlay), modifier = Modifier.fillMaxWidth()) { WideLabel(stringResource(R.string.home_play_now, tvName)) }
                if (entry?.kind == "series") {
                    OutlinedButton(onClick = act(onContinue), modifier = Modifier.fillMaxWidth()) { WideLabel(stringResource(R.string.home_continue_from)) }
                }
            }
            if (sectionCount > 1) {
                OutlinedButton(onClick = act(onMoveTo), modifier = Modifier.fillMaxWidth()) { WideLabel(stringResource(R.string.home_move_to_section)) }
            }
            if (index > 0) {
                OutlinedButton(onClick = act(onFirst), modifier = Modifier.fillMaxWidth()) { WideLabel(stringResource(R.string.home_move_first)) }
            }
            OutlinedButton(
                onClick = act(onRemove),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
                modifier = Modifier.fillMaxWidth(),
            ) { WideLabel(stringResource(R.string.home_remove_from_home)) }
        }
    }
}
