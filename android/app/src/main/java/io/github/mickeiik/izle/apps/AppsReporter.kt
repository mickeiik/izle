package io.github.mickeiik.izle.apps

import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.data.api.ApiJson
import io.github.mickeiik.izle.data.api.InstalledApp
import io.github.mickeiik.izle.settings.DeviceStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.builtins.ListSerializer
import java.security.MessageDigest

/** An app as the TV reports it, with its picture's PNG ([InstalledApp.image] is that PNG's SHA-256; null: none). */
class ReportedApp(val app: InstalledApp, val png: ByteArray?)

/** What the TV tells the server about its apps (docs/spec/server-api-v1.md, "Installed apps"). */
object AppsReport {
    const val MAX_APPS = 200
    const val MAX_LABEL = 100

    /** A picture the server takes: a PNG of at most 256 KiB. */
    const val MAX_IMAGE_BYTES = 256 * 1024

    /**
     * An unchanged list is sent again once a day: a server that lost its pictures (restored from a backup, its data
     * moved) asks for them again in its answer, and the TV has no other way to know.
     */
    const val RESEND_MS = 24 * 3_600_000L

    private val APP_ID = Regex("^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+$")

    /**
     * The list sent: valid app ids at most 200 characters, once each, without [ownAppId]; names trimmed to 100
     * characters (the app id when blank); in name order; at most [MAX_APPS].
     */
    fun list(apps: List<ReportedApp>, ownAppId: String): List<ReportedApp> {
        val seen = HashSet<String>()
        return apps.asSequence()
            .filter { val id = it.app.appId; id != ownAppId && id.length <= 200 && APP_ID.matches(id) && seen.add(id) }
            .map { a ->
                val label = a.app.label.trim().ifEmpty { a.app.appId }.let(::cut).trim()
                val png = a.png?.takeIf { it.size <= MAX_IMAGE_BYTES }
                ReportedApp(InstalledApp(a.app.appId, label, png?.let { a.app.image }), png)
            }
            .sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { a: ReportedApp -> a.app.label }.thenBy { it.app.appId })
            .take(MAX_APPS)
            .toList()
    }

    /** At most [MAX_LABEL] UTF-16 units, never half of a surrogate pair. */
    private fun cut(label: String): String {
        if (label.length <= MAX_LABEL) return label
        val end = if (Character.isHighSurrogate(label[MAX_LABEL - 1])) MAX_LABEL - 1 else MAX_LABEL
        return label.substring(0, end)
    }

    /** The list with its pictures (by their hashes), to tell whether it changed since the last accepted report. */
    fun hash(apps: List<InstalledApp>): String = sha256(ApiJson.encodeToString(ListSerializer(InstalledApp.serializer()), apps).toByteArray())

    /** Whether to send [hash]: another list than the last accepted one ([lastHash], at [lastAt]), or a day later. */
    fun due(hash: String, lastHash: String?, lastAt: Long?, now: Long): Boolean =
        hash != lastHash || lastAt == null || now - lastAt >= RESEND_MS || now < lastAt

    fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
}

/**
 * Sends the TV's apps to the server ([api]: the paired device's client, null while there is none) a moment after
 * [reportSoon], only when [AppsReport.due], then the pictures the server misses; the report counts as accepted (and
 * is remembered) once they are all there. Runs in the background; any failure waits for the next occasion.
 */
class AppsReporter(
    private val scope: CoroutineScope,
    private val store: DeviceStore,
    private val api: () -> ApiClient?,
    /** Every app this TV can open, as [AppsReport.list] makes it. */
    private val apps: suspend () -> List<ReportedApp>,
    private val clock: () -> Long = System::currentTimeMillis,
    private val delayMs: Long = 2_000,
) {
    private val lock = Mutex()

    /** A report waits to start: it reads the apps once it does, so further changes meanwhile are in it. */
    private var due = false

    /** On start, coming to the front, and an app installed, updated or removed: bursts become one report. */
    fun reportSoon() {
        if (due) return
        due = true
        scope.launch {
            delay(delayMs)
            lock.withLock {
                due = false
                report()
            }
        }
    }

    private suspend fun report() {
        val api = api() ?: return
        try {
            val list = apps()
            val installed = list.map { it.app }
            val hash = AppsReport.hash(installed)
            val settings = store.current()
            if (!AppsReport.due(hash, settings.appsReportHash, settings.appsReportedAt, clock())) return
            val missing = api.reportApps(installed).missingImages
            val pngs = list.mapNotNull { a -> a.app.image?.let { sha -> a.png?.let { sha to it } } }.toMap()
            for (sha in missing) pngs[sha]?.let { api.uploadAppImage(sha, it) }
            // Not when the TV paired again or changed servers meanwhile.
            if (this.api() === api) store.setAppsReport(hash, clock())
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // Unreachable, refused (a server without app cards answers 404), or PackageManager trouble: next time.
        }
    }
}
