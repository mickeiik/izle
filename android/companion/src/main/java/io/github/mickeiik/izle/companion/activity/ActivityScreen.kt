package io.github.mickeiik.izle.companion.activity

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import io.github.mickeiik.izle.companion.CompanionApp
import io.github.mickeiik.izle.companion.R
import io.github.mickeiik.izle.companion.home.resources
import io.github.mickeiik.izle.companion.tv.UNREACHABLE
import io.github.mickeiik.izle.companion.tv.apiErrorText
import io.github.mickeiik.izle.companion.ui.design.Caption
import io.github.mickeiik.izle.companion.ui.design.ChipRow
import io.github.mickeiik.izle.companion.ui.design.EmptyState
import io.github.mickeiik.izle.companion.ui.design.FilterChip
import io.github.mickeiik.izle.companion.ui.design.Hairline
import io.github.mickeiik.izle.companion.ui.design.IzleTheme
import io.github.mickeiik.izle.companion.ui.design.ListRow
import io.github.mickeiik.izle.companion.ui.design.ProgressBar
import io.github.mickeiik.izle.companion.ui.design.SectionHeader
import io.github.mickeiik.izle.companion.ui.design.Tone
import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.domain.IsoTime

/**
 * What happened on [tvName], live (docs/ux/companion-tv.md, Activity): the filter chips, then day bands of events,
 * newest first. The host draws the bar (back arrow, "Activity"). [thisPhoneId] says "your phone" for this phone's
 * events; null reads it from the app's settings.
 */
@Composable
fun ActivityScreen(api: ApiClient, tvId: String, tvName: String, modifier: Modifier = Modifier, thisPhoneId: String? = null) {
    val vm: ActivityViewModel = viewModel(key = "activity-$tvId-${System.identityHashCode(api)}") { ActivityViewModel(api, tvId) }
    val state by vm.state.collectAsStateWithLifecycle()
    val app = LocalContext.current.applicationContext as? CompanionApp
    LaunchedEffect(vm, thisPhoneId) {
        // Without it, this phone's events name the phone instead of saying "your phone".
        vm.setThisPhone(thisPhoneId ?: app?.let { a -> runCatching { a.graph.store.current().phoneId }.getOrNull() })
    }
    LaunchedEffect(vm, state.filter) { vm.follow() }
    ActivityContent(state, onFilter = vm::select, modifier = modifier)
}

/** One line of the list: a day's band or an event. */
private sealed interface ActivityLine {
    val key: String

    data class Day(val label: String, override val key: String) : ActivityLine
    data class Event(val time: String, val words: EventWords, override val key: String) : ActivityLine
}

@Composable
internal fun ActivityContent(state: ActivityState, onFilter: (ActivityFilter) -> Unit, modifier: Modifier = Modifier) {
    val res = resources()
    val s = IzleTheme.spacing
    val lines = remember(state.events, state.context) {
        val now = System.currentTimeMillis()
        var day: Long? = null
        buildList {
            for (e in state.events) {
                val words = eventWords(res, e, state.context) ?: continue
                val at = e.at?.let(IsoTime::parseEpochMs)
                val d = at?.let { dayNumber(it) }
                if (at != null && d != day) {
                    day = d
                    add(ActivityLine.Day(dayLabel(res, at, now), "day-$d"))
                }
                add(ActivityLine.Event(at?.let { clockTime(it) }.orEmpty(), words, "e-${e.id}"))
            }
        }
    }
    Column(modifier.fillMaxSize()) {
        if (state.loading) ProgressBar(null) else Hairline()
        ChipRow(Modifier.padding(vertical = s.sm)) {
            for (f in ActivityFilter.entries) FilterChip(filterLabel(res, f), selected = f == state.filter, onClick = { onFilter(f) })
        }
        if (state.failed) {
            Column(Modifier.padding(horizontal = s.lg, vertical = s.xs), verticalArrangement = Arrangement.spacedBy(s.line)) {
                Caption(stringResource(R.string.activity_load_failed), tone = Tone.Danger)
                Caption(state.error?.let { apiErrorText(it) ?: it } ?: UNREACHABLE)
            }
        }
        if (state.loaded && lines.isEmpty()) {
            EmptyState(stringResource(R.string.activity_empty), Modifier.padding(horizontal = s.lg, vertical = s.md))
        }
        LazyColumn(Modifier.fillMaxSize()) {
            items(lines, key = { it.key }) { line ->
                when (line) {
                    is ActivityLine.Day -> SectionHeader(line.label)
                    is ActivityLine.Event -> ListRow(
                        title = line.words.title,
                        supporting = line.words.supporting,
                        titleTone = if (line.words.problem) Tone.Danger else Tone.Neutral,
                        leading = { Caption(line.time) },
                    )
                }
            }
        }
    }
}
