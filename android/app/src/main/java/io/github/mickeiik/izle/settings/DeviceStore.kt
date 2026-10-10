package io.github.mickeiik.izle.settings

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

/** What the TV remembers between runs. */
data class DeviceSettings(
    val serverUrl: String? = null,
    val deviceId: String? = null,
    val deviceToken: String? = null,
    /** `tr`/`en` set from the hidden menu, or null to follow the server. */
    val uiLanguageOverride: String? = null,
) {
    val isPaired: Boolean get() = serverUrl != null && deviceToken != null
}

/**
 * DataStore-backed settings: server address, pairing result, the local UI language override and the last home
 * state (shown while the server is unreachable). Lives in app-private storage.
 */
class DeviceStore(private val dataStore: DataStore<Preferences>) {
    val settings: Flow<DeviceSettings> = dataStore.data.map { p ->
        DeviceSettings(
            serverUrl = p[SERVER_URL],
            deviceId = p[DEVICE_ID],
            deviceToken = p[DEVICE_TOKEN],
            uiLanguageOverride = p[UI_LANGUAGE],
        )
    }

    suspend fun current(): DeviceSettings = settings.first()

    /** A new server address forgets the pairing and the cached state when the address actually changes. */
    suspend fun setServer(url: String) {
        dataStore.edit { p ->
            if (p[SERVER_URL] != url) {
                p.remove(DEVICE_ID)
                p.remove(DEVICE_TOKEN)
                p.remove(CACHED_STATE)
            }
            p[SERVER_URL] = url
        }
    }

    suspend fun savePairing(deviceId: String, token: String) {
        dataStore.edit { p ->
            p[DEVICE_ID] = deviceId
            p[DEVICE_TOKEN] = token
            p.remove(CACHED_STATE)
        }
    }

    suspend fun forgetPairing() {
        dataStore.edit { p ->
            p.remove(DEVICE_ID)
            p.remove(DEVICE_TOKEN)
            p.remove(CACHED_STATE)
        }
    }

    suspend fun setUiLanguageOverride(language: String?) {
        dataStore.edit { p -> if (language == null) p.remove(UI_LANGUAGE) else p[UI_LANGUAGE] = language }
    }

    suspend fun cachedState(): String? = dataStore.data.first()[CACHED_STATE]

    suspend fun saveCachedState(json: String) {
        dataStore.edit { p -> p[CACHED_STATE] = json }
    }

    private companion object {
        val SERVER_URL = stringPreferencesKey("server_url")
        val DEVICE_ID = stringPreferencesKey("device_id")
        val DEVICE_TOKEN = stringPreferencesKey("device_token")
        val UI_LANGUAGE = stringPreferencesKey("ui_language")
        val CACHED_STATE = stringPreferencesKey("cached_state")
    }
}
