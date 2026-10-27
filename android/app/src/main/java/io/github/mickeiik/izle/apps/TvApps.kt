package io.github.mickeiik.izle.apps

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.pm.ResolveInfo
import android.graphics.Bitmap
import android.graphics.drawable.Drawable
import androidx.core.content.ContextCompat
import androidx.core.graphics.drawable.toBitmap
import io.github.mickeiik.izle.data.api.InstalledApp
import io.github.mickeiik.izle.domain.HomeTile
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import java.io.ByteArrayOutputStream
import kotlin.math.min
import kotlin.math.roundToInt

/** An app's picture: its TV banner (16:9) when it has one ([banner]), else its icon. */
class AppPicture(val bitmap: Bitmap, val banner: Boolean)

/**
 * The apps installed on this TV, as PackageManager says now: those it can open (a TV launch entry, else a launch
 * entry; izle left out), their names, pictures and launch intents. Names and pictures on Home come from here, never
 * from the server.
 */
class TvApps(private val context: Context) {
    private val pm: PackageManager get() = context.packageManager

    private val _changes = MutableStateFlow(0)

    /** Bumped when an app is installed, updated or removed while izle runs: Home asks again. */
    val changes: StateFlow<Int> = _changes.asStateFlow()

    /** The PNGs of the report by package, kept while the package is not updated: drawing them all is slow on a TV. */
    private val reportPictures = HashMap<String, Pair<Long, ByteArray?>>()

    /** Registered while the activity lives: [onChange] gets every other package's install, update or removal. */
    fun watch(onChange: () -> Unit): BroadcastReceiver {
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                if (intent.data?.schemeSpecificPart == context.packageName) return
                _changes.update { it + 1 }
                onChange()
            }
        }
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_PACKAGE_ADDED)
            addAction(Intent.ACTION_PACKAGE_REMOVED)
            addAction(Intent.ACTION_PACKAGE_CHANGED)
            addAction(Intent.ACTION_PACKAGE_REPLACED)
            addDataScheme("package")
        }
        // The system sends these; nothing else may.
        ContextCompat.registerReceiver(context, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
        return receiver
    }

    /** The card for [appId], or null when this TV cannot open it. */
    fun card(appId: String): HomeTile.App? = launchEntry(appId)?.let { HomeTile.App(appId, label(it, appId)) }

    /** Its TV launch entry, else its launch entry, in a new task. */
    fun launchIntent(appId: String): Intent? {
        if (appId == context.packageName) return null
        val intent = try {
            pm.getLeanbackLaunchIntentForPackage(appId) ?: pm.getLaunchIntentForPackage(appId)
        } catch (e: RuntimeException) {
            null
        }
        return intent?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }

    /** For Home: the banner at its own size (at most 640 × 360 px), else the icon (at most 384 px). */
    fun picture(appId: String): AppPicture? = launchEntry(appId)?.let { draw(it, bannerMax = 640 to 360, iconMax = 384) }

    /** Every app this TV can open, with the PNG of its picture (banner at most 320 × 180 px, else icon at most 192 px). */
    @Synchronized
    fun report(): List<ReportedApp> {
        val entries = launchEntries()
        val apps = entries.map { ri ->
            val appId = ri.activityInfo.packageName
            val png = reportPicture(appId, ri)
            ReportedApp(InstalledApp(appId, label(ri, appId), png?.let(AppsReport::sha256)), png)
        }
        reportPictures.keys.retainAll(entries.map { it.activityInfo.packageName }.toSet())
        return AppsReport.list(apps, context.packageName)
    }

    /** One entry per package: a TV launch entry before a launch entry. */
    private fun launchEntries(): List<ResolveInfo> {
        val byPackage = LinkedHashMap<String, ResolveInfo>()
        for (category in listOf(Intent.CATEGORY_LEANBACK_LAUNCHER, Intent.CATEGORY_LAUNCHER)) {
            for (ri in pm.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(category), 0)) {
                val appId = ri.activityInfo?.packageName ?: continue
                if (appId != context.packageName) byPackage.putIfAbsent(appId, ri)
            }
        }
        return byPackage.values.toList()
    }

    private fun launchEntry(appId: String): ResolveInfo? {
        val intent = launchIntent(appId) ?: return null
        return try {
            pm.resolveActivity(intent, 0)
        } catch (e: RuntimeException) {
            null
        }
    }

    private fun label(ri: ResolveInfo, appId: String): String = ri.loadLabel(pm).toString().trim().ifEmpty { appId }

    private fun reportPicture(appId: String, ri: ResolveInfo): ByteArray? {
        val updatedAt = try {
            pm.getPackageInfo(appId, 0).lastUpdateTime
        } catch (e: PackageManager.NameNotFoundException) {
            return null
        }
        reportPictures[appId]?.let { (at, png) -> if (at == updatedAt) return png }
        val png = draw(ri, bannerMax = 320 to 180, iconMax = 192)?.let { picture ->
            ByteArrayOutputStream().use { out ->
                picture.bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
                out.toByteArray()
            }
        }
        reportPictures[appId] = updatedAt to png
        return png
    }

    /** The banner (the activity's, else the app's) or the icon, scaled down to fit, never up. */
    private fun draw(ri: ResolveInfo, bannerMax: Pair<Int, Int>, iconMax: Int): AppPicture? = try {
        val banner = ri.activityInfo.loadBanner(pm)
        if (banner != null) {
            AppPicture(bitmap(banner, bannerMax.first, bannerMax.second), banner = true)
        } else {
            AppPicture(bitmap(ri.loadIcon(pm), iconMax, iconMax), banner = false)
        }
    } catch (e: RuntimeException) {
        // A broken resource of another app: no picture.
        null
    }

    private fun bitmap(drawable: Drawable, maxWidth: Int, maxHeight: Int): Bitmap {
        val w = drawable.intrinsicWidth.takeIf { it > 0 } ?: maxWidth
        val h = drawable.intrinsicHeight.takeIf { it > 0 } ?: maxHeight
        val scale = min(1f, min(maxWidth.toFloat() / w, maxHeight.toFloat() / h))
        return drawable.toBitmap((w * scale).roundToInt().coerceAtLeast(1), (h * scale).roundToInt().coerceAtLeast(1), Bitmap.Config.ARGB_8888)
    }
}
