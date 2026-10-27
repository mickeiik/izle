package io.github.mickeiik.izle.companion.pairing

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.data.api.ApiException
import io.github.mickeiik.izle.data.api.ApprovedPairing
import io.github.mickeiik.izle.data.api.PendingCode
import io.github.mickeiik.izle.data.api.StatusDevice
import io.github.mickeiik.izle.data.api.orNullOnFailure
import io.github.mickeiik.izle.domain.IsoTime
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** A code a TV shows, as the list draws it: [minutesLeft] at the last read, [approvedAs] once approved from here. */
data class WaitingCode(val code: String, val minutesLeft: Int, val approved: Boolean, val approvedAs: String? = null)

/** What the TV list adds to the TVs: the codes that wait, and each TV's state from `GET /admin/status`. */
data class PairingState(
    val codes: List<WaitingCode> = emptyList(),
    val status: Map<String, StatusDevice> = emptyMap(),
)

/**
 * Pairing from the phone, for the TV list: the open codes and the TVs' state, read every [POLL_MS] between [start] and [stop]
 * (while the list is shown); approving a code (as a new TV or in place of one) and clearing one that is not ours.
 */
class PairingViewModel(private val api: ApiClient) : ViewModel() {
    private val _state = MutableStateFlow(PairingState())
    val state: StateFlow<PairingState> = _state.asStateFlow()

    /** The names codes were approved under here: the server's list says only that they were. */
    private val approvedNames = mutableMapOf<String, String>()

    private var polling: Job? = null

    /**
     * Reads now, then every [POLL_MS] until [stop]: while the list is shown. The wait runs off the main thread, on the
     * wall clock (the state is a thread-safe flow).
     */
    fun start() {
        if (polling?.isActive == true) return
        polling = viewModelScope.launch(Dispatchers.Default) {
            while (true) {
                refresh()
                delay(POLL_MS)
            }
        }
    }

    fun stop() {
        polling?.cancel()
        polling = null
    }

    /** Reads the codes and the TVs' state; what fails to read keeps what is shown. */
    suspend fun refresh() {
        val localNow = System.currentTimeMillis()
        val status = orNullOnFailure { api.status() }
        val codes = orNullOnFailure { api.pendingPairings() }
        val now = status?.serverNowMs?.takeIf { it > 0 } ?: localNow
        _state.update { s ->
            s.copy(
                status = status?.devices?.associateBy { it.id } ?: s.status,
                codes = codes?.let { waiting(it, now) } ?: s.codes,
            )
        }
    }

    private fun waiting(codes: List<PendingCode>, nowMs: Long): List<WaitingCode> = codes.mapNotNull { c ->
        val left = c.expiresAt?.let(IsoTime::parseEpochMs)?.let { minutesLeft(it, nowMs) }
        if (left == 0) return@mapNotNull null
        WaitingCode(c.code, left ?: 0, c.approved, approvedNames[c.code])
    }

    /**
     * Approves [code] as a new TV called [name] (blank: the server names it), or in place of the TV [replaces]. Null when
     * it worked (the codes are read again), else why not.
     */
    suspend fun approve(code: String, name: String?, replaces: String?): Exception? {
        val approved: ApprovedPairing = try {
            api.approvePairing(code, name?.trim()?.ifEmpty { null }, replaces)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (e is ApiException && e.code == "unknown_code") refresh()
            return e
        }
        approvedNames[code] = approved.name
        _state.update { s -> s.copy(codes = s.codes.map { if (it.code == code) it.copy(approved = true, approvedAs = approved.name) else it }) }
        refresh()
        return null
    }

    /** Clears [code] (not ours): a TV showing it asks for a new one. Null when it worked or was gone already, else why not. */
    suspend fun cancel(code: String): Exception? {
        val failed = try {
            api.cancelPairing(code)
            null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            e.takeUnless { it is ApiException && it.code == "unknown_code" }
        }
        if (failed == null) _state.update { s -> s.copy(codes = s.codes.filter { it.code != code }) }
        refresh()
        return failed
    }

    companion object {
        const val POLL_MS = 10_000L

        /** A TV's name: 1–60 characters. */
        const val NAME_MAX = 60
    }
}
