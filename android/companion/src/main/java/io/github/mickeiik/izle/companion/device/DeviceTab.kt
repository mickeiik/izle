package io.github.mickeiik.izle.companion.device

import android.content.res.Resources
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import io.github.mickeiik.izle.companion.R
import io.github.mickeiik.izle.companion.home.HomeError
import io.github.mickeiik.izle.companion.home.errorText
import io.github.mickeiik.izle.companion.home.resources
import io.github.mickeiik.izle.companion.tv.commandOutcomeText
import io.github.mickeiik.izle.companion.ui.design.ActionRow
import io.github.mickeiik.izle.companion.ui.design.ButtonKind
import io.github.mickeiik.izle.companion.ui.design.ButtonSize
import io.github.mickeiik.izle.companion.ui.design.Caption
import io.github.mickeiik.izle.companion.ui.design.Chevron
import io.github.mickeiik.izle.companion.ui.design.EmptyState
import io.github.mickeiik.izle.companion.ui.design.IzleButton
import io.github.mickeiik.izle.companion.ui.design.IzleSwitch
import io.github.mickeiik.izle.companion.ui.design.IzleTheme
import io.github.mickeiik.izle.companion.ui.design.ListRow
import io.github.mickeiik.izle.companion.ui.design.ProgressBar
import io.github.mickeiik.izle.companion.ui.design.SectionHeader
import io.github.mickeiik.izle.companion.ui.design.StatusChip
import io.github.mickeiik.izle.companion.ui.design.Tone
import io.github.mickeiik.izle.data.api.AdminDevice
import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.data.api.Problem

/**
 * The TV tab of a TV's page (docs/ux/companion-tv.md): its problems, Activity, its app, its settings and Forget this TV.
 * A problem's Open the show calls [onOpenShow], the Activity row [onOpenActivity]; once forgotten, [onForgotten]. The
 * count of the last 24 hours' problems goes to [onProblemsChanged] (the tab's dot) and a new name to [onRenamed] (the
 * app bar) whenever they are read; messages to [onMessage] (the host's snackbar).
 */
@Composable
fun DeviceTab(
    api: ApiClient,
    tvId: String,
    tvName: String,
    onOpenShow: (itemId: String) -> Unit,
    onOpenActivity: () -> Unit,
    onForgotten: () -> Unit,
    onProblemsChanged: (Int) -> Unit,
    onMessage: (String) -> Unit,
    modifier: Modifier = Modifier,
    onRenamed: (String) -> Unit = {},
) {
    // Per client too, as Home: a phone paired anew gets a new one.
    val vm: DeviceViewModel = viewModel(key = "device-$tvId-${System.identityHashCode(api)}") { DeviceViewModel(api, tvId) }
    val res = resources()
    val message by rememberUpdatedState(onMessage)
    val name by rememberUpdatedState(tvName)
    val forgotten by rememberUpdatedState(onForgotten)
    val problemsChanged by rememberUpdatedState(onProblemsChanged)
    val renamed by rememberUpdatedState(onRenamed)
    LaunchedEffect(vm) { vm.follow() }
    LaunchedEffect(vm) { vm.notices.collect { message(deviceNoticeText(res, it, name)) } }
    val state by vm.state.collectAsStateWithLifecycle()
    val check by vm.check.collectAsStateWithLifecycle()
    LaunchedEffect(state.forgotten) { if (state.forgotten) forgotten() }
    LaunchedEffect(state.loaded, state.recent) { if (state.loaded) problemsChanged(state.recent) }
    LaunchedEffect(state.device?.name) { state.device?.name?.let { if (it != name) renamed(it) } }
    DeviceContent(
        state,
        check,
        tvName,
        DeviceActions(
            onRetry = vm::retry,
            onClear = vm::clearProblems,
            onCheck = vm::checkProblem,
            onCloseProblem = vm::closeProblem,
            onOpenShow = onOpenShow,
            onOpenActivity = onOpenActivity,
            onUpdate = vm::update,
            onRename = vm::rename,
            onMenuLanguage = vm::setMenuLanguage,
            onAudio = vm::setAudio,
            onSubtitles = vm::setSubtitles,
            onPlayOnStart = vm::setPlayOnStart,
            onForget = vm::forget,
        ),
        modifier,
    )
}

/** What the tab's rows, sheets and dialogs do. */
internal class DeviceActions(
    val onRetry: () -> Unit = {},
    val onClear: () -> Unit = {},
    val onCheck: (Problem) -> Unit = {},
    val onCloseProblem: () -> Unit = {},
    val onOpenShow: (String) -> Unit = {},
    val onOpenActivity: () -> Unit = {},
    val onUpdate: () -> Unit = {},
    val onRename: (String) -> Unit = {},
    val onMenuLanguage: (String) -> Unit = {},
    val onAudio: (String?) -> Unit = {},
    val onSubtitles: (String?) -> Unit = {},
    val onPlayOnStart: (Boolean) -> Unit = {},
    val onForget: () -> Unit = {},
)

/** What a sheet or dialog of the tab is open for. */
private sealed interface DeviceDialog {
    data object AllProblems : DeviceDialog
    data object Clear : DeviceDialog
    data object Forget : DeviceDialog
    data class Choose(val setting: Setting) : DeviceDialog
}

/** The tab as [state] says, without its view model (the screenshots draw it alone). */
@Composable
internal fun DeviceContent(
    state: DeviceState,
    check: ProblemCheck?,
    tvName: String,
    actions: DeviceActions,
    modifier: Modifier = Modifier,
    openProblem: Long? = null,
) {
    val res = resources()
    val space = IzleTheme.spacing
    var dialog by remember { mutableStateOf<DeviceDialog?>(null) }
    var sheetFor by rememberSaveable { mutableStateOf(openProblem) }
    val device = state.device

    Column(modifier.fillMaxSize()) {
        Box(Modifier.fillMaxWidth().height(IzleTheme.sizes.progress)) {
            if (state.loading && !state.loaded) ProgressBar(null)
        }
        if (device == null) {
            state.loadError?.let { error ->
                Column(Modifier.padding(space.lg), verticalArrangement = Arrangement.spacedBy(space.sm)) {
                    Text(stringResource(R.string.device_load_failed), style = IzleTheme.type.body, color = IzleTheme.colors.textPrimary)
                    Caption(errorText(res, error), tone = Tone.Danger)
                    IzleButton(stringResource(R.string.try_again), onClick = actions.onRetry, enabled = !state.loading)
                }
            }
            return@Column
        }
        LazyColumn(Modifier.fillMaxSize()) {
            item(key = "problems") {
                SectionHeader(
                    stringResource(R.string.device_problems),
                    meta = state.recent.takeIf { it > 0 }?.let { stringResource(R.string.device_problems_today, it) },
                    trailing = if (state.problems.isEmpty()) null else ({
                        IzleButton(stringResource(R.string.device_clear), onClick = { dialog = DeviceDialog.Clear }, kind = ButtonKind.Quiet, size = ButtonSize.Small)
                    }),
                )
            }
            if (state.problems.isEmpty()) {
                item(key = "no-problems") { EmptyState(stringResource(R.string.device_no_problems), Modifier.padding(horizontal = space.lg, vertical = space.md)) }
            }
            items(state.problems.take(DeviceViewModel.PROBLEMS_SHOWN), key = { "problem-${it.id}" }) { p ->
                ProblemRow(p, onClick = { sheetFor = p.id })
            }
            if (state.problems.size > DeviceViewModel.PROBLEMS_SHOWN) {
                item(key = "all-problems") {
                    ListRow(
                        pluralStringResource(R.plurals.device_all_problems, state.problems.size, state.problems.size),
                        trailing = { Chevron() },
                        onClick = { dialog = DeviceDialog.AllProblems },
                    )
                }
            }
            item(key = "activity") {
                ListRow(
                    stringResource(R.string.activity),
                    supporting = stringResource(R.string.device_activity_line, tvName),
                    trailing = { Chevron() },
                    onClick = actions.onOpenActivity,
                    divider = false,
                )
            }
            item(key = "app") { AppBlock(device, state.updating, actions.onUpdate) }
            item(key = "settings") { SettingsBlock(device, onChoose = { dialog = DeviceDialog.Choose(it) }, onPlayOnStart = actions.onPlayOnStart) }
            item(key = "forget") {
                ActionRow(stringResource(R.string.device_forget), Icons.Outlined.Delete, onClick = { dialog = DeviceDialog.Forget }, tone = Tone.Danger)
            }
            item(key = "bottom") { Box(Modifier.height(space.sm)) }
        }
    }

    sheetFor?.let { id ->
        val p = state.problems.firstOrNull { it.id == id }
        if (p == null) {
            // Cleared (here or elsewhere): its sheet closes.
            LaunchedEffect(id) { sheetFor = null }
        } else {
            ProblemSheet(
                p,
                check?.takeIf { it.problemId == id },
                onCheck = { actions.onCheck(p) },
                onOpenShow = { sheetFor = null; dialog = null; p.itemId?.let(actions.onOpenShow) },
                onDismiss = { sheetFor = null; actions.onCloseProblem() },
            )
        }
    }

    when (val d = dialog) {
        null -> Unit
        DeviceDialog.AllProblems -> AllProblemsSheet(state.problems, onOpen = { sheetFor = it.id }, onDismiss = { dialog = null })
        DeviceDialog.Clear -> ConfirmDialog(
            title = stringResource(R.string.device_clear_title),
            text = stringResource(R.string.device_clear_text),
            confirm = stringResource(R.string.device_clear),
            onConfirm = actions.onClear,
            onDismiss = { dialog = null },
        )
        DeviceDialog.Forget -> ConfirmDialog(
            title = stringResource(R.string.device_forget_title, device?.name ?: tvName),
            text = stringResource(R.string.device_forget_text),
            confirm = stringResource(R.string.device_forget_confirm),
            onConfirm = actions.onForget,
            onDismiss = { dialog = null },
        )
        is DeviceDialog.Choose -> if (device == null) {
            LaunchedEffect(d) { dialog = null }
        } else if (d.setting == Setting.Name) {
            NameDialog(device.name, onSave = actions.onRename, onDismiss = { dialog = null })
        } else {
            ChoiceSheet(device, d.setting, actions, onDismiss = { dialog = null })
        }
    }
}

/** A problem: its title, where and when, and its kind as a Neutral chip. */
@Composable
internal fun ProblemRow(p: Problem, onClick: () -> Unit) {
    val res = resources()
    ListRow(
        problemTitle(res, p),
        supporting = problemRowLine(res, p),
        badge = { StatusChip(problemKindText(res, p.kind), Tone.Neutral) },
        onClick = onClick,
    )
}

/** TV app: "izle 0.6.1 · Android 12" with the update state's chip, how the TV installs updates, and Update now. */
@Composable
private fun AppBlock(device: AdminDevice, updating: Boolean, onUpdate: () -> Unit) {
    val res = resources()
    val app = device.app
    val chip = updateChip(res, app)
    val install = installText(res, app)
    SectionHeader(stringResource(R.string.device_tv_app))
    ListRow(
        appLine(res, app),
        trailing = chip?.let { (text, tone) -> { StatusChip(text, tone) } },
        divider = false,
    )
    if (install != null || offersUpdate(app)) {
        Column(
            Modifier.fillMaxWidth().padding(start = IzleTheme.spacing.lg, end = IzleTheme.spacing.lg, bottom = IzleTheme.spacing.md),
            verticalArrangement = Arrangement.spacedBy(IzleTheme.spacing.md),
        ) {
            install?.let { Caption(it) }
            if (offersUpdate(app)) {
                IzleButton(stringResource(R.string.device_update_now), onClick = onUpdate, size = ButtonSize.Small, enabled = !updating)
            }
        }
    }
}

/** Settings: rows that open a choice, each with its value; Play on start's switch. */
@Composable
private fun SettingsBlock(device: AdminDevice, onChoose: (Setting) -> Unit, onPlayOnStart: (Boolean) -> Unit) {
    val res = resources()
    SectionHeader(stringResource(R.string.device_settings))
    for (setting in listOf(Setting.Name, Setting.MenuLanguage, Setting.Audio, Setting.Subtitles)) {
        ListRow(settingName(res, setting), supporting = settingValue(res, device, setting), onClick = { onChoose(setting) })
    }
    val on = playsOnStart(device)
    ListRow(
        settingName(res, Setting.PlayOnStart),
        trailing = { IzleSwitch(on, onCheckedChange = null) },
        onClick = { onPlayOnStart(!on) },
        onClickLabel = settingName(res, Setting.PlayOnStart),
    )
}

/** A notice in words; [tvName] names the TV. */
internal fun deviceNoticeText(res: Resources, notice: DeviceNotice, tvName: String): String = when (notice) {
    is DeviceNotice.Failed -> deviceErrorText(res, notice.error)
    is DeviceNotice.NotSaved -> res.getString(
        R.string.device_not_saved,
        deviceErrorText(res, notice.error),
        settingName(res, notice.setting),
        settingValue(res, notice.before, notice.setting),
    )
    // Done says nothing in the shared wording: here it is worth saying.
    is DeviceNotice.Updated -> commandOutcomeText(tvName, notice.outcome) ?: res.getString(R.string.device_update_sent, tvName)
    DeviceNotice.ProblemsCleared -> res.getString(R.string.device_problems_cleared)
}

/** [errorText], with `409 no_apk` of Update now. */
internal fun deviceErrorText(res: Resources, error: HomeError): String =
    if (error is HomeError.Server && error.code == "no_apk") res.getString(R.string.device_no_apk) else errorText(res, error)
