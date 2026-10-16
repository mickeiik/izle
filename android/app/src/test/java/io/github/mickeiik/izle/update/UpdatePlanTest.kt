package io.github.mickeiik.izle.update

import io.github.mickeiik.izle.data.api.CommandResult
import io.github.mickeiik.izle.ui.Screen
import io.github.mickeiik.izle.ui.UpdatePhase
import io.github.mickeiik.izle.ui.UpdateUi
import io.github.mickeiik.izle.update.UpdatePlan.Action
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdatePlanTest {
    private val update = AvailableUpdate("0.3.0", 300, "a".repeat(64), 12_345_678, auto = true)
    private val now = 1_800_000_000_000L

    /** Idle on Home, online, nothing open: the moment a silent TV updates itself. */
    private val idleHome = UpdatePlan.Context(
        capability = UpdateCapability.Silent,
        installedVersionCode = 200,
        screen = Screen.Home,
        menuOpen = false,
        autoplayShowing = false,
        playerInUse = false,
        online = true,
        idleMs = UpdatePlan.IDLE_MS,
        lastFailureAt = null,
        now = now,
    )

    private fun ignored(reason: String) = listOf(Action.Report(CommandResult.ignored(reason)))

    @Test
    fun aSilentTvInstallsByItselfOnlyWhenIdleOnHome() {
        assertTrue(UpdatePlan.autoInstall(update, idleHome))
        assertTrue(UpdatePlan.autoInstall(update, idleHome.copy(idleMs = 3_600_000)))
        val not = mapOf(
            "guided" to idleHome.copy(capability = UpdateCapability.Guided),
            "not idle long enough" to idleHome.copy(idleMs = UpdatePlan.IDLE_MS - 1),
            "in the player" to idleHome.copy(screen = Screen.Player, playerInUse = true),
            "the player still in use" to idleHome.copy(playerInUse = true),
            "the hidden menu" to idleHome.copy(menuOpen = true),
            "the autoplay countdown" to idleHome.copy(autoplayShowing = true),
            "offline" to idleHome.copy(online = false),
            "busy" to idleHome.copy(busy = true),
            "pairing" to idleHome.copy(screen = Screen.Pairing),
            "the address screen" to idleHome.copy(screen = Screen.Setup(canGoBack = true)),
            "the update screen" to idleHome.copy(screen = Screen.Update(UpdateUi("0.3.0", UpdatePhase.Installing))),
            "already this version" to idleHome.copy(installedVersionCode = 300),
            "a newer one installed" to idleHome.copy(installedVersionCode = 400),
        )
        for ((why, ctx) in not) assertFalse(why, UpdatePlan.autoInstall(update, ctx))
        assertFalse("the owner did not allow it", UpdatePlan.autoInstall(update.copy(auto = false), idleHome))
        assertFalse("nothing offered", UpdatePlan.autoInstall(null, idleHome))
    }

    @Test
    fun aFailureHoldsAutomaticAttemptsBackForSixHours() {
        val hour = 3_600_000L
        assertFalse(UpdatePlan.autoInstall(update, idleHome.copy(lastFailureAt = now - hour)))
        assertFalse(UpdatePlan.autoInstall(update, idleHome.copy(lastFailureAt = now - 6 * hour + 1)))
        assertTrue(UpdatePlan.autoInstall(update, idleHome.copy(lastFailureAt = now - 6 * hour)))
        assertTrue("a clock set back does not block it forever", UpdatePlan.autoInstall(update, idleHome.copy(lastFailureAt = now + hour)))
    }

    @Test
    fun theCommandInstallsSilentlyOrShowsThePressOkScreen() {
        val busyHome = idleHome.copy(idleMs = 0, menuOpen = true, autoplayShowing = true, lastFailureAt = now)
        assertEquals("the owner's command does not wait for idle", listOf(Action.Install(update, silent = true)), UpdatePlan.onCommand(update, 300, busyHome))
        val manual = update.copy(auto = false)
        assertEquals("auto only holds TVs back from updating by themselves", listOf(Action.Install(manual, silent = true)), UpdatePlan.onCommand(manual, null, idleHome))
        val guided = idleHome.copy(capability = UpdateCapability.Guided)
        assertEquals(listOf(Action.ShowGuided(update)), UpdatePlan.onCommand(update, 300, guided))
        assertEquals(listOf(Action.ShowGuided(update)), UpdatePlan.onCommand(update, null, guided))
    }

    @Test
    fun theCommandNeverInterruptsPlayback() {
        for (capability in UpdateCapability.entries) {
            val ctx = idleHome.copy(capability = capability)
            assertEquals(ignored(CommandResult.BUSY), UpdatePlan.onCommand(update, 300, ctx.copy(screen = Screen.Player, playerInUse = true)))
            assertEquals(ignored(CommandResult.BUSY), UpdatePlan.onCommand(update, 300, ctx.copy(screen = Screen.Player)))
            assertEquals(ignored(CommandResult.BUSY), UpdatePlan.onCommand(update, 300, ctx.copy(playerInUse = true)))
            assertEquals(ignored(CommandResult.BUSY), UpdatePlan.onCommand(update, 300, ctx.copy(busy = true)))
            val showing = ctx.copy(screen = Screen.Update(UpdateUi("0.3.0", UpdatePhase.Prompt(40))))
            assertEquals(ignored(CommandResult.BUSY), UpdatePlan.onCommand(update, 300, showing))
        }
    }

    @Test
    fun theCommandReasons() {
        assertEquals(ignored(CommandResult.UP_TO_DATE), UpdatePlan.onCommand(null, 300, idleHome))
        assertEquals(ignored(CommandResult.UP_TO_DATE), UpdatePlan.onCommand(update, 300, idleHome.copy(installedVersionCode = 300)))
        assertEquals(ignored(CommandResult.UP_TO_DATE), UpdatePlan.onCommand(update, 150, idleHome))
        for (screen in listOf(Screen.Starting, Screen.Pairing, Screen.Setup(canGoBack = false))) {
            assertEquals("$screen", ignored(CommandResult.NOT_READY), UpdatePlan.onCommand(update, 300, idleHome.copy(screen = screen)))
        }
    }

    @Test
    fun installStatusesByName() {
        assertEquals("pending_user_action", UpdatePlan.installStatusName(-1))
        assertEquals("success", UpdatePlan.installStatusName(0))
        assertEquals("failure_aborted", UpdatePlan.installStatusName(3))
        assertEquals("failure_storage", UpdatePlan.installStatusName(6))
        assertEquals("failure_incompatible", UpdatePlan.installStatusName(7))
        assertEquals("status_42", UpdatePlan.installStatusName(42))
        val reason = Regex("^[A-Za-z0-9_.:-]{1,64}$")
        for (status in -1..9) assertTrue(reason.matches(CommandResult.INSTALL_PREFIX + UpdatePlan.installStatusName(status)))
    }
}
