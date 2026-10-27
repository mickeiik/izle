package io.github.mickeiik.izle.companion.device

import android.content.res.Resources
import io.github.mickeiik.izle.companion.R
import io.github.mickeiik.izle.companion.ui.design.Tone
import io.github.mickeiik.izle.data.api.AdminDevice
import io.github.mickeiik.izle.data.api.DeviceApp
import io.github.mickeiik.izle.data.api.DeviceEffective

// The TV tab's words for the TV's app and settings, as the admin page says them (server/admin/lib.js: LANGUAGES,
// languageLabel, appUpdateChip, androidText, capabilityText), shortened for a phone.

/** The languages the settings offer (lib.js `LANGUAGES`); any other tag is shown as it is. */
val LANGUAGES: List<Pair<String, String>> = listOf(
    "en" to "English", "tr" to "Türkçe", "de" to "Deutsch", "fr" to "Français", "es" to "Español", "it" to "Italiano",
    "nl" to "Nederlands", "pt" to "Português", "ru" to "Русский", "ar" to "العربية", "ku" to "Kurdî",
)

/** The TV's menu languages: Türkçe or English (`uiLanguage`). */
val MENU_LANGUAGES: List<String> = listOf("tr", "en")

/** "Türkçe" for `tr` (and `tr-TR`), else the tag as it is. */
fun languageName(tag: String): String {
    val primary = tag.substringBefore('-').lowercase()
    return LANGUAGES.firstOrNull { it.first == primary }?.second ?: tag
}

/** A setting of the tab that a choice changes. */
enum class Setting { Name, MenuLanguage, Audio, Subtitles, PlayOnStart }

/**
 * A setting's value as its row says it: "Salon", "English", "Server default · Türkçe" (stored null: the server's
 * language, when it has one), "Off", "On".
 */
fun settingValue(res: Resources, device: AdminDevice, setting: Setting): String {
    val effective = device.effective ?: DeviceEffective()
    return when (setting) {
        Setting.Name -> device.name
        Setting.MenuLanguage -> languageName(device.settings?.uiLanguage ?: effective.uiLanguage)
        Setting.Audio -> device.settings?.preferredAudioLanguage?.let(::languageName)
            ?: effective.preferredAudioLanguage?.let { res.getString(R.string.device_server_default_is, languageName(it)) }
            ?: res.getString(R.string.device_server_default)
        // Stored null is off (the server has no default for subtitles).
        Setting.Subtitles -> (if (device.settings != null) device.settings?.subtitlesLanguage else effective.subtitlesLanguage)?.let(::languageName)
            ?: res.getString(R.string.device_subtitles_off)
        Setting.PlayOnStart -> res.getString(if (playsOnStart(device)) R.string.device_on else R.string.device_off)
    }
}

fun playsOnStart(device: AdminDevice): Boolean = device.settings?.autoplayOnStart ?: device.effective?.autoplayOnStart ?: false

/** A setting's name, as its row's title. */
fun settingName(res: Resources, setting: Setting): String = res.getString(
    when (setting) {
        Setting.Name -> R.string.device_name
        Setting.MenuLanguage -> R.string.device_menu_language
        Setting.Audio -> R.string.device_audio
        Setting.Subtitles -> R.string.device_subtitles
        Setting.PlayOnStart -> R.string.device_play_on_start
    },
)

/** "izle 0.6.1 · Android 12"; "Version unknown" before the TV reported. */
fun appLine(res: Resources, app: DeviceApp?): String {
    val version = app?.version?.let { res.getString(R.string.device_app_version, it) } ?: res.getString(R.string.device_app_unknown)
    return listOfNotNull(version, androidName(res, app?.androidSdk)).joinToString(" · ")
}

/** "Android 12" by API level (lib.js `androidText`, without the level); "API 37" for one not listed; null unknown. */
fun androidName(res: Resources, sdk: Int?): String? {
    if (sdk == null) return null
    return ANDROID[sdk]?.let { res.getString(R.string.device_android, it) } ?: res.getString(R.string.device_api, sdk)
}

/** The update state as a chip's words and tone; null when unknown (no chip). */
fun updateChip(res: Resources, app: DeviceApp?): Pair<String, Tone>? = when (app?.update) {
    DeviceApp.UPDATE_UP_TO_DATE -> res.getString(R.string.device_up_to_date) to Tone.Success
    DeviceApp.UPDATE_PENDING -> res.getString(R.string.device_update_available) to Tone.Neutral
    DeviceApp.UPDATE_NEEDS_INSTALL_NOW -> res.getString(R.string.device_needs_update) to Tone.Warning
    else -> null
}

/** How the TV installs updates; null when it has not said. */
fun installText(res: Resources, app: DeviceApp?): String? = when (app?.capability) {
    DeviceApp.CAPABILITY_SILENT -> res.getString(R.string.device_installs_silent)
    DeviceApp.CAPABILITY_GUIDED -> res.getString(R.string.device_installs_guided)
    else -> null
}

/** Update now is offered while an update waits. */
fun offersUpdate(app: DeviceApp?): Boolean =
    app?.update == DeviceApp.UPDATE_PENDING || app?.update == DeviceApp.UPDATE_NEEDS_INSTALL_NOW

/** Android versions by API level (lib.js `ANDROID`). */
private val ANDROID = mapOf(
    21 to "5.0", 22 to "5.1", 23 to "6", 24 to "7.0", 25 to "7.1", 26 to "8.0", 27 to "8.1", 28 to "9", 29 to "10",
    30 to "11", 31 to "12", 32 to "12L", 33 to "13", 34 to "14", 35 to "15", 36 to "16",
)
