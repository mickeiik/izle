package io.github.mickeiik.izle.apps

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.provider.Settings
import io.github.mickeiik.izle.HomeActivity

/** Hidden menu → Settings → Home screen: "izle", "TV's own", or "izle · not chosen" (docs/ux/senior-tv.md, "Home screen"). */
enum class HomeScreenState { Izle, TvOwn, NotChosen }

/** The pure part of the Home screen row. */
object HomeScreenPlan {
    /** [offered]: izle's home entry is on; [homeOpens]: the package HOME opens now (the chooser's: none of the home apps). */
    fun state(offered: Boolean, homeOpens: String?, ownPackage: String): HomeScreenState = when {
        !offered -> HomeScreenState.TvOwn
        homeOpens == ownPackage -> HomeScreenState.Izle
        else -> HomeScreenState.NotChosen
    }

    /** What turning izle on does once its home entry is on. */
    enum class Next { Nothing, AskWithHome, OpenSettings }

    /**
     * [homeOpens] among [homeApps] (the packages with a home entry): another home screen fixed as the default, so
     * Android will not ask; izle: chosen before, nothing to do; neither: Android's chooser, which HOME opens.
     */
    fun afterOffering(homeOpens: String?, homeApps: Set<String>, ownPackage: String): Next = when {
        homeOpens == ownPackage -> Next.Nothing
        homeOpens != null && homeOpens in homeApps -> Next.OpenSettings
        else -> Next.AskWithHome
    }
}

/**
 * izle as the TV's launcher: a disabled activity ([HomeActivity]) carries the HOME filter, so an izle that was never
 * chosen never makes Android ask.
 */
class HomeScreenSwitch(private val context: Context) {
    private val pm: PackageManager get() = context.packageManager
    private val homeEntry = ComponentName(context, HomeActivity::class.java)

    fun state(): HomeScreenState = HomeScreenPlan.state(offered(), homeOpens(), context.packageName)

    /**
     * Turns izle's home entry on; the activities to start, the first that starts wins: HOME (Android asks which home
     * screen to use), Android's home-screen settings or TV settings when another home screen is fixed, or none.
     */
    fun turnOn(): List<Intent> {
        setOffered(true)
        val homeApps = pm.queryIntentActivities(HOME, PackageManager.MATCH_DEFAULT_ONLY).mapNotNull { it.activityInfo?.packageName }.toSet()
        return when (HomeScreenPlan.afterOffering(homeOpens(), homeApps, context.packageName)) {
            HomeScreenPlan.Next.Nothing -> emptyList()
            HomeScreenPlan.Next.AskWithHome -> listOf(Intent(HOME).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            HomeScreenPlan.Next.OpenSettings -> listOfNotNull(
                Intent(Settings.ACTION_HOME_SETTINGS).takeIf { pm.resolveActivity(it, 0) != null },
                Intent(Settings.ACTION_SETTINGS),
            ).map { it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) }
        }
    }

    /** izle stops offering itself: the next HOME opens the TV's own home screen. */
    fun turnOff() = setOffered(false)

    private fun offered(): Boolean = pm.getComponentEnabledSetting(homeEntry) == PackageManager.COMPONENT_ENABLED_STATE_ENABLED

    private fun setOffered(on: Boolean) {
        val setting = if (on) PackageManager.COMPONENT_ENABLED_STATE_ENABLED else PackageManager.COMPONENT_ENABLED_STATE_DISABLED
        pm.setComponentEnabledSetting(homeEntry, setting, PackageManager.DONT_KILL_APP)
    }

    private fun homeOpens(): String? = pm.resolveActivity(HOME, PackageManager.MATCH_DEFAULT_ONLY)?.activityInfo?.packageName

    companion object {
        val HOME: Intent get() = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
    }
}
