package io.github.mickeiik.izle.companion

import android.app.Application
import android.content.Context
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.preferencesDataStoreFile
import io.github.mickeiik.izle.companion.connect.phoneName
import io.github.mickeiik.izle.companion.settings.CompanionStore
import io.github.mickeiik.izle.companion.sync.ApiClientCompanionApi
import io.github.mickeiik.izle.companion.sync.ListenSession
import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.player.ExoMediaEngine
import io.github.mickeiik.izle.player.MediaEngine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/** Manual dependency graph, like the TV app's: one OkHttp connection pool, one settings store. */
class CompanionGraph(val context: Context) {
    val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .writeTimeout(20, TimeUnit.SECONDS)
        .build()

    /** `GET /now?wait=25` holds the request up to 25 s. */
    private val longPollHttp: OkHttpClient = http.newBuilder().readTimeout(40, TimeUnit.SECONDS).build()

    val store = CompanionStore(PreferenceDataStoreFactory.create { context.preferencesDataStoreFile("companion") })

    /** API calls with this phone's secret (or a debug build's typed token); without one, only the claim. */
    fun apiClient(baseUrl: HttpUrl, token: String?): ApiClient = ApiClient(baseUrl, token, http, longPollHttp)

    /** The name a claim gives this phone; the tests replace it. */
    var phoneName: () -> String = { phoneName(context.contentResolver) }

    /** The tests replace it with a fake. */
    var mediaEngine: () -> MediaEngine = { ExoMediaEngine(context, http, userAgent, capVideoTo720p = false, audioOnly = true) }

    /** Media requests. */
    val userAgent: String = "izle-companion/${BuildConfig.VERSION_NAME}"

    /** Builds the session of one pairing, on its own main-thread scope; the tests replace it to use a fake API. */
    var newSession: (api: ApiClient, scope: CoroutineScope) -> ListenSession = { api, scope ->
        ListenSession(ApiClientCompanionApi(api), mediaEngine(), scope, { api.resolve(it)?.toString() })
    }

    private class Held(val key: String, val session: ListenSession, val scope: CoroutineScope)

    private var held: Held? = null

    /**
     * The process's single Listen along session, for the pairing ([baseUrl] and [token]) it is made with: the screen
     * starts and stops it, and [io.github.mickeiik.izle.companion.sync.ListenService] keeps the process alive while it
     * plays and shows it in a notification. Made on first use; another pairing releases the previous one (and its
     * scope), as [releaseSession] does when the pairing is forgotten. Main thread only.
     */
    fun session(baseUrl: HttpUrl, token: String): ListenSession {
        val key = "$baseUrl $token"
        held?.let { if (it.key == key) return it.session }
        releaseSession()
        val scope = MainScope()
        return newSession(apiClient(baseUrl, token), scope).also { held = Held(key, it, scope) }
    }

    /** The session made last, if any (null after [releaseSession]): what the service follows. */
    val currentSession: ListenSession? get() = held?.session

    /** Stops and frees the current session, its player and its scope. */
    fun releaseSession() {
        val h = held ?: return
        held = null
        h.session.release()
        h.scope.cancel()
    }
}

class CompanionApp : Application() {
    lateinit var graph: CompanionGraph
        private set

    override fun onCreate() {
        super.onCreate()
        graph = CompanionGraph(this)
    }
}
