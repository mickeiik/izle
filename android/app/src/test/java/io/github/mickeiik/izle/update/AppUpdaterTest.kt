package io.github.mickeiik.izle.update

import android.content.Intent
import android.content.pm.PackageInstaller
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import io.github.mickeiik.izle.data.ProblemReporter
import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.data.api.CommandResult
import io.github.mickeiik.izle.installStatus
import io.github.mickeiik.izle.json
import io.github.mickeiik.izle.settings.DeviceStore
import io.github.mickeiik.izle.sha256
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.cancelChildren
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

/**
 * [AppUpdater] on its own, against an in-process server: what a run remembers and reports when it fails, is
 * cancelled or finds the APK gone, which install statuses count, and the `User-Agent` before and after the stored
 * refusal is read. Each test runs in [runBlocking], whose single thread stands in for the main thread.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class AppUpdaterTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private val server = MockWebServer()
    private val http = OkHttpClient()
    private val requests = CopyOnWriteArrayList<RecordedRequest>()
    private val bytes = ByteArray(60_000) { (it % 13).toByte() }
    private val update = AvailableUpdate("0.3.0", 300, sha256(bytes), bytes.size.toLong(), auto = true)
    private val installer = FakeInstaller()

    /** What `GET /tv/app/apk` answers. */
    @Volatile private var apk: () -> MockResponse = { apkBody().build() }

    private fun apkBody() = MockResponse.Builder().body(Buffer().write(bytes))

    /** A slow body: the read is under way for a while. */
    private val slowApk = { apkBody().throttleBody(1_024, 20, TimeUnit.MILLISECONDS).build() }

    private lateinit var storeScope: CoroutineScope
    private lateinit var store: DeviceStore
    private lateinit var cacheDir: File
    private lateinit var api: ApiClient

    @Before
    fun setUp() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                return when (request.url.encodedPath) {
                    "/api/v1/tv/app" -> json(200, """{"versionName":"0.3.0","versionCode":300,"sha256":"${update.sha256}","size":${bytes.size},"auto":true}""")
                    "/api/v1/tv/app/apk" -> apk()
                    "/api/v1/tv/problems" -> json(200, """{"ok":true}""")
                    else -> json(404, """{"error":"not_found"}""")
                }
            }
        }
        server.start()
        api = ApiClient(server.url("/"), "device-token", http)
        storeScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val storeDir = tmp.newFolder("store")
        store = DeviceStore(PreferenceDataStoreFactory.create(scope = storeScope) { File(storeDir, "izle.preferences_pb") })
        cacheDir = tmp.newFolder("cache")
    }

    @After
    fun tearDown() {
        storeScope.cancel()
        server.close()
    }

    @Test
    fun anInstallFailureWithoutTheCommandsOwnResultIsRememberedAndReportedAsAProblem() = runBlocking {
        val updater = updater()
        // Before the result went out, the command's own `failed` tells the owner: no problem report.
        installer.verifyFailure = UpdateException(CommandResult.BAD_ARCHIVE)
        assertEquals(UpdateRun.Failed(CommandResult.BAD_ARCHIVE), updater.runSilent(commandId = 5))
        settle()
        assertTrue(problems().isEmpty())

        // After it (`done installing` is out, a second result would be refused): a problem report.
        installer.verifyFailure = null
        installer.installFailure = UpdateException(PackageInstallerAppInstaller.INSTALL_WRITE)
        assertEquals(UpdateRun.Failed(PackageInstallerAppInstaller.INSTALL_WRITE), updater.runSilent(commandId = 6))
        awaitProblem("update_install_write")
        assertFalse("nothing kept", apkFile.exists())

        // Without a command, and anything unexpected from the installer is an internal failure, not a crash.
        installer.installFailure = RuntimeException("installation services unavailable")
        assertEquals(UpdateRun.Failed(CommandResult.INTERNAL), updater.runSilent())
        awaitProblem("update_internal")
        assertNotNull("remembered", updater.lastFailureAt)
        assertFalse(updater.busy)
        assertFalse("nothing kept", apkFile.exists())
    }

    @Test
    fun anApkRemovedMeanwhileIsUpToDateAndNoLongerOffered() = runBlocking {
        val updater = updater()
        awaitLoaded(updater)
        assertEquals(update, updater.check(api))
        assertTrue(UpdatePlan.autoInstall(updater.available.value, idleOnHome))
        apk = { json(404, """{"error":"no_apk"}""") }
        assertEquals(UpdateRun.Ignored(CommandResult.UP_TO_DATE), updater.runSilent())
        assertNull(updater.available.value)
        assertNull(updater.newer())
        assertFalse("the next tick installs nothing", UpdatePlan.autoInstall(updater.available.value, idleOnHome))
        assertNull("not a failure", updater.lastFailureAt)
    }

    @Test
    fun aCancelledDownloadIsNoFailure() = runBlocking {
        val updater = updater()
        awaitLoaded(updater)
        // Back cancels the run while the read is under way.
        apk = slowApk
        val run = launch { updater.run(api, update, silent = false, commandId = null) { true } }
        awaitDownloadStarted()
        delay(100)
        run.cancelAndJoin()
        settle()
        assertNull("nothing remembered", updater.lastFailureAt)
        assertNull(store.current().lastUpdateFailureAt)
        assertTrue("nothing reported", problems().isEmpty())
        assertFalse("nothing kept", apkFile.exists())
        assertFalse(updater.busy)
        assertTrue(installer.installs.isEmpty())
    }

    @Test
    fun onlyOurSessionsOrANewProcessSeeASuccess() = runBlocking {
        val updater = updater()
        awaitLoaded(updater)
        val statuses = statusesOf(updater)

        // Another app's success intent while a download is under way: nothing changes.
        apk = slowApk
        val run = launch { updater.runSilent() }
        awaitDownloadStarted()
        assertTrue(updater.busy)
        updater.onInstallStatus(installStatus(PackageInstaller.STATUS_SUCCESS, sessionId = 42))
        yield()
        assertTrue(statuses.isEmpty())
        assertTrue("the download goes on", apkFile.exists())
        run.cancelAndJoin()

        // Committed session 7: another session's success does not count, its own does.
        apk = { apkBody().build() }
        assertEquals(UpdateRun.Committed, updater.runSilent())
        updater.onInstallStatus(installStatus(PackageInstaller.STATUS_SUCCESS, sessionId = 42))
        yield()
        assertTrue(statuses.isEmpty())
        updater.onInstallStatus(installStatus(PackageInstaller.STATUS_SUCCESS, sessionId = 7))
        yield()
        assertEquals(listOf<InstallStatus>(InstallStatus.Succeeded), statuses)

        // The new version's process: nothing committed and nothing under way, so the intent that started it counts.
        val fresh = updater()
        val freshStatuses = statusesOf(fresh)
        fresh.onInstallStatus(installStatus(PackageInstaller.STATUS_SUCCESS, sessionId = 7))
        yield()
        assertEquals(listOf<InstallStatus>(InstallStatus.Succeeded), freshStatuses)
        coroutineContext.cancelChildren()
    }

    @Test
    fun theUserAgentWaitsForTheStoredRefusal() = runBlocking {
        store.setUpdateSilentRefused(true)
        val updater = updater()
        assertNull("not `silent` before the refusal is read", updater.userAgent)
        updater.refreshCapability()
        assertNull(updater.userAgent)
        awaitLoaded(updater)
        assertEquals("izle-tv/0.2.0 (Android 36; 200; guided)", updater.userAgent)
        assertEquals(UpdateCapability.Guided, updater.capability.value)
    }

    @Test
    fun aReplacedAppTriesSilentAgainEvenBeforeTheStartsReadFinished() = runBlocking {
        store.setUpdateSilentRefused(true)
        store.setLastUpdateFailureAt(123L)
        val updater = updater()
        updater.onReplaced()
        assertEquals(UpdateCapability.Silent, updater.capability.value)
        assertEquals("izle-tv/0.2.0 (Android 36; 200; silent)", updater.userAgent)
        assertNull(updater.lastFailureAt)
        assertFalse(store.current().updateSilentRefused)
        assertNull(store.current().lastUpdateFailureAt)
    }

    private fun CoroutineScope.updater() = AppUpdater(
        scope = this,
        store = store,
        downloader = ApkDownloader(http, cacheDir),
        installer = { installer },
        problems = ProblemReporter(this, { api }, { 0L }),
        capabilityOf = { refused -> UpdateCapabilities.of(sdkInt = 36, canRequestInstalls = true, silentRefused = refused) },
        installedVersionCode = 200,
        versionName = "0.2.0",
        sdkInt = 36,
        wallClock = { 1_000_000L },
    )

    private val apkFile get() = File(cacheDir, ApkDownloader.FILE_NAME)

    private val idleOnHome = idleHome(now = 1_000_000L)

    private suspend fun AppUpdater.runSilent(commandId: Long? = null) = run(api, update, silent = true, commandId = commandId) { true }

    private suspend fun awaitLoaded(updater: AppUpdater) = withTimeout(5_000) { while (updater.userAgent == null) delay(5) }

    private suspend fun awaitDownloadStarted() = withTimeout(5_000) { while (!apkFile.exists()) delay(5) }

    /** What [updater] says about installs from now on (until this test's children are cancelled). */
    private fun CoroutineScope.statusesOf(updater: AppUpdater) = CopyOnWriteArrayList<InstallStatus>().also { statuses ->
        launch(start = CoroutineStart.UNDISPATCHED) { updater.installStatus.collect { statuses += it } }
    }

    private fun problems() = requests.filter { it.url.encodedPath == "/api/v1/tv/problems" }.map { it.body?.utf8().orEmpty() }

    private suspend fun awaitProblem(code: String) = withTimeout(5_000) {
        while (problems().none { it.contains("\"code\":\"$code\"") }) delay(5)
    }

    /** Gives a request that should not come the time to arrive anyway. */
    private suspend fun settle() = delay(200)

    /** Checks and installs nothing; fails as told. */
    private class FakeInstaller : AppInstaller {
        @Volatile var verifyFailure: Exception? = null
        @Volatile var installFailure: Exception? = null
        val installs = CopyOnWriteArrayList<Boolean>()

        override suspend fun verifyArchive(file: File, expectedVersionCode: Long) = verifyFailure?.let { throw it } ?: Unit

        override suspend fun install(file: File, silent: Boolean): Int {
            installFailure?.let { throw it }
            installs += silent
            return 7
        }

        override fun ownsSession(sessionId: Int) = true

        override fun isSystemConfirmation(intent: Intent) = true

        override fun abandon(sessionId: Int) = Unit
    }
}
