package io.github.mickeiik.izle.ui

import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.data.api.ApiException
import io.github.mickeiik.izle.data.api.PhoneInvite
import io.github.mickeiik.izle.data.api.PhoneInviteStatus
import io.github.mickeiik.izle.data.api.ServerUrls
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.HttpUrl
import java.io.IOException

enum class PhoneConnectProblem { Unreachable, Refused }

/** The "Connect a phone" screen (docs/ux/senior-tv.md, "Connect a phone"). */
sealed interface PhoneConnectUi {
    /** The invite is on its way. */
    data object Starting : PhoneConnectUi

    /** [link] is the QR code's content, [code] the 6 digits, [server] the address shown under them. */
    data class Showing(val code: String, val link: String, val server: String) : PhoneConnectUi

    /** [name]: the phone's, as it told the server. */
    data class Connected(val name: String) : PhoneConnectUi

    data class Failed(val problem: PhoneConnectProblem) : PhoneConnectUi
}

/** The two TV calls. Network failures throw [IOException], error answers [ApiException]. */
interface PhoneInviteApi {
    suspend fun create(): PhoneInvite

    /** Long-polls the invite; 410 answers `expired`, 404 `not_found`. */
    suspend fun wait(): PhoneInviteStatus

    /** The TV left the screen: the invite stops working on the server. */
    suspend fun cancel()
}

fun ApiClient.phoneInviteApi(): PhoneInviteApi = object : PhoneInviteApi {
    override suspend fun create() = phoneInvite()

    override suspend fun wait() = phoneInviteWait()

    override suspend fun cancel() = cancelPhoneInvite()
}

/**
 * Asks the server for an invite, shows it and long-polls until a phone claims it: "<name> connected" for 3 s. It
 * returns (the caller goes Home) then, when the invite expired (410, 404, or 5 minutes on the TV's clock), or after a
 * failure's message showed for 5 s. A lost long poll is tried again after 5 s with the same invite (the code on screen
 * stays valid; the 5 minutes still end it).
 */
object PhoneConnectLoop {
    const val CONNECTED_MS = 3_000L
    const val FAILED_MS = 5_000L
    const val INVITE_MS = 5 * 60_000L
    const val WAIT_RETRY_MS = 5_000L

    /** The QR code's content: the server's `/connect` page with the invite in the fragment (never sent to the server). */
    fun link(server: HttpUrl, invite: String): String = "${ServerUrls.display(server)}/connect#$invite"

    /** "483920" as "483 920". */
    fun spaced(code: String): String = if (code.length == 6) "${code.take(3)} ${code.drop(3)}" else code

    suspend fun run(api: PhoneInviteApi?, server: HttpUrl?, show: (PhoneConnectUi) -> Unit) {
        show(PhoneConnectUi.Starting)
        if (api == null || server == null) return fail(PhoneConnectProblem.Unreachable, show)
        val invite = try {
            api.create()
        } catch (e: IOException) {
            return fail(PhoneConnectProblem.Unreachable, show)
        } catch (e: ApiException) {
            return fail(PhoneConnectProblem.Refused, show)
        }
        show(PhoneConnectUi.Showing(invite.code, link(server, invite.invite), ServerUrls.display(server)))
        val outcome = withTimeoutOrNull(INVITE_MS) { awaitClaim(api) } ?: return
        when (outcome) {
            is Outcome.Claimed -> {
                show(PhoneConnectUi.Connected(outcome.name))
                delay(CONNECTED_MS)
            }
            Outcome.Gone -> Unit
            Outcome.Failed -> fail(PhoneConnectProblem.Refused, show)
        }
    }

    private sealed interface Outcome {
        data class Claimed(val name: String) : Outcome
        data object Gone : Outcome
        data object Failed : Outcome
    }

    private suspend fun awaitClaim(api: PhoneInviteApi): Outcome {
        while (true) {
            val answer = try {
                api.wait()
            } catch (e: IOException) {
                delay(WAIT_RETRY_MS)
                continue
            } catch (e: ApiException) {
                return Outcome.Failed
            }
            when (answer.status) {
                PhoneInviteStatus.OPEN -> continue
                PhoneInviteStatus.CLAIMED -> return Outcome.Claimed(answer.phone?.name.orEmpty())
                // expired, not_found (a replaced invite, a restarted server), or a status this TV does not know.
                else -> return Outcome.Gone
            }
        }
    }

    private suspend fun fail(problem: PhoneConnectProblem, show: (PhoneConnectUi) -> Unit) {
        show(PhoneConnectUi.Failed(problem))
        delay(FAILED_MS)
    }
}
