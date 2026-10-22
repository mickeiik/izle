package io.github.mickeiik.izle

import android.app.Application
import android.content.Context
import android.os.Build
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
import io.github.mickeiik.izle.player.ExoMediaEngine
import io.github.mickeiik.izle.player.MediaEngine
import io.github.mickeiik.izle.settings.DeviceStore
import io.github.mickeiik.izle.update.ApkDownloader
import io.github.mickeiik.izle.update.AppInstaller
import io.github.mickeiik.izle.update.AppUpdater
import io.github.mickeiik.izle.update.PackageInstallerAppInstaller
import io.github.mickeiik.izle.update.UpdateCapabilities
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

    val repository = ServerRepository(appScope, deviceStore, EventsClient(sseHttp), onAppCheck = { api -> updater.check(api) })

    val problems = ProblemReporter(appScope, { repository.api }, SystemClock::elapsedRealtime)
    val commandResults = CommandResultReporter(appScope) { api, id, result -> api.reportCommandResult(id, result) }

    /** The tests put a fake here before the view model starts, and replace [mediaEngine]. */
    var installer: AppInstaller = PackageInstallerAppInstaller(context)

    var mediaEngine: () -> MediaEngine = {
        ExoMediaEngine(
            context, http, userAgent,
            // The emulator decodes H.264 in software; real TVs, debug build or not, get full resolution.
            capVideoTo720p = BuildConfig.DEBUG && Build.HARDWARE in setOf("ranchu", "goldfish"),
        )
    }

    val updater: AppUpdater by lazy {
        AppUpdater(
            scope = appScope,
            store = deviceStore,
            downloader = ApkDownloader(http, context.cacheDir),
            installer = { installer },
            problems = problems,
            capabilityOf = { silentRefused -> UpdateCapabilities.current(context, silentRefused) },
            installedVersionCode = BuildConfig.VERSION_CODE.toLong(),
            versionName = BuildConfig.VERSION_NAME,
            sdkInt = Build.VERSION.SDK_INT,
        )
    }

    /** API calls (never media) say which app version this is and how it can update. */
    fun apiClient(baseUrl: HttpUrl, deviceToken: String?): ApiClient =
        ApiClient(baseUrl, deviceToken, http, longPollHttp, userAgent = { updater.userAgent })

    /** Media requests. */
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
