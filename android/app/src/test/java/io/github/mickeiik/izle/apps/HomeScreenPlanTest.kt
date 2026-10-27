package io.github.mickeiik.izle.apps

import io.github.mickeiik.izle.apps.HomeScreenPlan.Next
import org.junit.Assert.assertEquals
import org.junit.Test

class HomeScreenPlanTest {
    private val izle = "io.github.mickeiik.izle"
    private val tvLauncher = "com.google.android.tvlauncher"

    @Test
    fun theRowReadsWhetherIzleIsOfferedAndChosen() {
        assertEquals(HomeScreenState.TvOwn, HomeScreenPlan.state(offered = false, homeOpens = tvLauncher, ownPackage = izle))
        assertEquals(HomeScreenState.Izle, HomeScreenPlan.state(offered = true, homeOpens = izle, ownPackage = izle))
        assertEquals(HomeScreenState.NotChosen, HomeScreenPlan.state(offered = true, homeOpens = tvLauncher, ownPackage = izle))
        // HOME opens Android's chooser: offered, not chosen yet.
        assertEquals(HomeScreenState.NotChosen, HomeScreenPlan.state(offered = true, homeOpens = "android", ownPackage = izle))
        assertEquals(HomeScreenState.NotChosen, HomeScreenPlan.state(offered = true, homeOpens = null, ownPackage = izle))
    }

    @Test
    fun turningIzleOnAsksWithHomeUnlessAnotherHomeScreenIsFixed() {
        val homeApps = setOf(izle, tvLauncher)
        // The chooser (its package has no home entry): HOME makes Android ask.
        assertEquals(Next.AskWithHome, HomeScreenPlan.afterOffering("android", homeApps, izle))
        assertEquals(Next.AskWithHome, HomeScreenPlan.afterOffering(null, homeApps, izle))
        // Another home screen stays the default: Android will not ask, its settings can change it.
        assertEquals(Next.OpenSettings, HomeScreenPlan.afterOffering(tvLauncher, homeApps, izle))
        // izle was chosen before: nothing to ask.
        assertEquals(Next.Nothing, HomeScreenPlan.afterOffering(izle, homeApps, izle))
    }
}
