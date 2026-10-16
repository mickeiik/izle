package io.github.mickeiik.izle

import android.app.Application
import android.content.Context
import android.os.SystemClock
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.preferencesDataStoreFile
import coil3.ImageLoader
import coil3.PlatformContext
import coil3.SingletonImageLoader
import coil3.network.okhttp.OkHttpNetworkFetcherFactory
import io.github.mickeiik.izle.data.CommandResultReporter
import io.github.mickeiik.izle.data.ProblemReporter
import io.github.mickeiik.izle.data.ServerRepository
import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.data.api.EventsClient
import io.github.mickeiik.izle.settings.DeviceStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.MainScope
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/** Manual dependency graph: one OkHttp connection pool, one settings store, one server repository. */
class AppGraph(val context: Context) {
    /** Lives as long as the process; progress reports run here so they finish after the screen is gone. */
    val appScope: CoroutineScope = MainScope()

    val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .writeTimeout(20, TimeUnit.SECONDS)
        .build()

    /** `pair/wait` holds the request up to 25 s. */
    private val longPollHttp: OkHttpClient = http.newBuilder().readTimeout(40, TimeUnit.SECONDS).build()

    /** 60 s without a byte (the server pings every 20 s) means the event stream is dead. */
    private val sseHttp: OkHttpClient = http.newBuilder().readTimeout(60, TimeUnit.SECONDS).build()

    val deviceStore = DeviceStore(PreferenceDataStoreFactory.create { context.preferencesDataStoreFile("izle") })

    val repository = ServerRepository(appScope, deviceStore, EventsClient(sseHttp))

    /** Problem reports for the owner, sent from the application scope so they outlive the screen. */
    val problems = ProblemReporter(appScope, { repository.api }, SystemClock::elapsedRealtime)

    /** What became of the owner's commands, also sent from the application scope. */
    val commandResults = CommandResultReporter(appScope) { api, id, result -> api.reportCommandResult(id, result) }

    fun apiClient(baseUrl: HttpUrl, deviceToken: String?): ApiClient = ApiClient(baseUrl, deviceToken, http, longPollHttp)

    val userAgent: String = "izle-tv/${BuildConfig.VERSION_NAME}"
}

class IzleApp : Application(), SingletonImageLoader.Factory {
    lateinit var graph: AppGraph
        private set

    override fun onCreate() {
        super.onCreate()
        graph = AppGraph(this)
    }

    // Coil 3 needs its OkHttp network module wired explicitly; posters share the app's connection pool.
    override fun newImageLoader(context: PlatformContext): ImageLoader =
        ImageLoader.Builder(context)
            .components { add(OkHttpNetworkFetcherFactory(callFactory = { graph.http })) }
            .build()
}
