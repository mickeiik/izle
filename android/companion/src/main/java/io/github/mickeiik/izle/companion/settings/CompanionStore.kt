package io.github.mickeiik.izle.companion.settings

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

/** What the companion remembers between runs. */
data class CompanionSettings(
    val serverUrl: String? = null,
    /**
     * The credential: this phone's own secret (`izph_…`, from claiming the TV's invite), or in a debug build an access
     * token typed instead. Kept under the key the `companion` access tokens used, so an older install reads as paired
     * (the server refuses its token and the app asks to connect again).
     */
    val token: String? = null,
    /** This phone's id on the server; null for a typed token (and an older install). */
    val phoneId: String? = null,
    /** The TV to listen along with. */
    val tvId: String? = null,
    /** For the earphones' delay, in ms: added to the phone's target position (positive plays the phone further ahead). */
    val nudgeMs: Long = 0,
) {
    val isPaired: Boolean get() = serverUrl != null && token != null
}

class CompanionStore(private val dataStore: DataStore<Preferences>) {
    val settings: Flow<CompanionSettings> = dataStore.data.map { p ->
        CompanionSettings(
            serverUrl = p[SERVER_URL],
            token = p[TOKEN],
            phoneId = p[PHONE_ID],
            tvId = p[TV_ID],
            nudgeMs = p[NUDGE_MS] ?: 0,
        )
    }

    suspend fun current(): CompanionSettings = settings.first()

    /**
     * Another server's TVs are not this one's: a different address forgets the chosen TV, unless [tvId] (the TV that
     * showed the invite) chooses one. A null [phoneId] (a typed token) forgets the previous one.
     */
    suspend fun savePairing(url: String, token: String, phoneId: String? = null, tvId: String? = null) {
        dataStore.edit { p ->
            if (p[SERVER_URL] != url) p.remove(TV_ID)
            p[SERVER_URL] = url
            p[TOKEN] = token
            if (phoneId == null) p.remove(PHONE_ID) else p[PHONE_ID] = phoneId
            if (tvId != null) p[TV_ID] = tvId
        }    }

    /** Forgets the server, the credential, the phone id and the TV; the nudge stays (it belongs to the phone). */
    suspend fun forgetPairing() {
        dataStore.edit { p ->
            p.remove(SERVER_URL)
            p.remove(TOKEN)
            p.remove(PHONE_ID)
            p.remove(TV_ID)
        }
    }

    suspend fun setTv(id: String?) {
        dataStore.edit { p -> if (id == null) p.remove(TV_ID) else p[TV_ID] = id }
    }

    suspend fun setNudgeMs(ms: Long) {
        dataStore.edit { p -> if (ms == 0L) p.remove(NUDGE_MS) else p[NUDGE_MS] = ms }
    }

    private companion object {
        val SERVER_URL = stringPreferencesKey("server_url")
        val TOKEN = stringPreferencesKey("token")
        val PHONE_ID = stringPreferencesKey("phone_id")
        val TV_ID = stringPreferencesKey("tv_id")
        val NUDGE_MS = longPreferencesKey("nudge_ms")
    }
}
