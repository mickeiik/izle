package io.github.mickeiik.izle.companion

import android.app.Application
import android.content.Context
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.preferencesDataStoreFile
import io.github.mickeiik.izle.companion.settings.CompanionStore
import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.player.ExoMediaEngine
import io.github.mickeiik.izle.player.MediaEngine
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

    /** API calls with the `companion` access token. */
    fun apiClient(baseUrl: HttpUrl, token: String): ApiClient = ApiClient(baseUrl, token, http, longPollHttp)

    /** The tests replace it with a fake. */
    var mediaEngine: () -> MediaEngine = { ExoMediaEngine(context, http, userAgent, capVideoTo720p = false) }

    /** Media requests. */
    val userAgent: String = "izle-companion/${BuildConfig.VERSION_NAME}"
}

class CompanionApp : Application() {
    lateinit var graph: CompanionGraph
        private set

    override fun onCreate() {
        super.onCreate()
        graph = CompanionGraph(this)
    }
}
