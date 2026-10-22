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

/** Idle on Home, online, nothing open, version 200 installed: the moment a silent TV updates itself. */
fun idleHome(now: Long) = UpdatePlan.Context(
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

class UpdatePlanTest {
    private val update = AvailableUpdate("0.3.0", 300, "a".repeat(64), 12_345_678, auto = true)
    private val now = 1_800_000_000_000L
    private val idleHome = idleHome(now)

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
        // A clock set back (a failure "in the future") does not block it forever.
        val failedAt = mapOf(now - hour to false, now - 6 * hour + 1 to false, now - 6 * hour to true, now + hour to true)
        for ((at, installs) in failedAt) {
            assertEquals("failed ${now - at} ms ago", installs, UpdatePlan.autoInstall(update, idleHome.copy(lastFailureAt = at)))
        }
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
            val busy = listOf(
                ctx.copy(screen = Screen.Player, playerInUse = true),
                ctx.copy(screen = Screen.Player),
                ctx.copy(playerInUse = true),
                ctx.copy(busy = true),
                ctx.copy(screen = Screen.Update(UpdateUi("0.3.0", UpdatePhase.Prompt(40)))),
            )
            for (busyCtx in busy) assertEquals("$busyCtx", ignored(CommandResult.BUSY), UpdatePlan.onCommand(update, 300, busyCtx))
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
        val names = mapOf(
            -1 to "pending_user_action", 0 to "success", 3 to "failure_aborted", 6 to "failure_storage", 7 to "failure_incompatible",
            42 to "status_42",
        )
        for ((status, name) in names) assertEquals(name, UpdatePlan.installStatusName(status))
        val reason = Regex("^[A-Za-z0-9_.:-]{1,64}$")
        for (status in -1..9) assertTrue(reason.matches(CommandResult.INSTALL_PREFIX + UpdatePlan.installStatusName(status)))
    }

    @Test
    fun silentNeedsAndroid12TheGrantAndNoRefusal() {
        val table = listOf(
            Triple(25, true, false) to UpdateCapability.Guided, // the Freebox Player Mini v2 (Android 7.1.1)
            Triple(30, true, false) to UpdateCapability.Guided,
            Triple(31, false, false) to UpdateCapability.Guided,
            Triple(31, true, false) to UpdateCapability.Silent,
            Triple(36, true, false) to UpdateCapability.Silent,
            Triple(36, true, true) to UpdateCapability.Guided,
            Triple(36, false, true) to UpdateCapability.Guided,
        )
        for ((input, expected) in table) {
            val (sdk, grant, refused) = input
            assertEquals("$input", expected, UpdateCapabilities.of(sdk, grant, refused))
        }
        // The `User-Agent` built from it: see AppUpdaterTest.theUserAgentWaitsForTheStoredRefusal.
    }
}
