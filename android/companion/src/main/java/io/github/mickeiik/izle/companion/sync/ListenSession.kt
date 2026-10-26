// STUB for compilation; agent C's implementation replaces this file at integration.
package io.github.mickeiik.izle.companion.sync

import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.data.api.CompanionResolveRequest
import io.github.mickeiik.izle.data.api.CompanionResolveResponse
import io.github.mickeiik.izle.data.api.CompanionResponse
import io.github.mickeiik.izle.data.api.LinkTiming
import io.github.mickeiik.izle.data.api.NowResponse
import io.github.mickeiik.izle.player.MediaEngine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** What the session needs from the server (an [ApiClient] in the app, a fake in tests). */
interface CompanionApi {
    suspend fun now(deviceId: String, seq: Long?, waitSec: Int): NowResponse
    suspend fun resolve(deviceId: String, request: CompanionResolveRequest): CompanionResolveResponse
    suspend fun companion(deviceId: String): CompanionResponse
}

class ApiClientCompanionApi(private val api: ApiClient) : CompanionApi {
    override suspend fun now(deviceId: String, seq: Long?, waitSec: Int): NowResponse = api.now(deviceId, seq, waitSec)
    override suspend fun resolve(deviceId: String, request: CompanionResolveRequest): CompanionResolveResponse =
        api.companionResolve(deviceId, request)
    override suspend fun companion(deviceId: String): CompanionResponse = api.companion(deviceId)
}

data class ListenTarget(
    val deviceId: String,
    val episodeId: String,
    val sourceId: String,
    val language: String?,
    val itemTitle: String?,
    val episodeTitle: String?,
)

enum class ListenPhase { Idle, Starting, Listening }

enum class EndReason { Stopped, TvIdle, TvSwitchedToChannel, NoSuchSourceOnNextEpisode, StreamKeepsFailing, Unauthorized, Failed }

data class ListenState(
    val phase: ListenPhase = ListenPhase.Idle,
    val target: ListenTarget? = null,
    val timing: LinkTiming = LinkTiming(),
    val nudgeMs: Long = 0,
    val tvPositionMs: Double? = null,
    val phonePositionMs: Double? = null,
    val driftMs: Double? = null,
    val syncLabel: String? = null,
    val clockRttMs: Long? = null,
    val mediaKind: String? = null,
    val error: String? = null,
    val ended: EndReason? = null,
)

class ListenSession(
    private val api: CompanionApi,
    private val engine: MediaEngine,
    private val scope: CoroutineScope,
    private val absoluteUrl: (String) -> String?,
    private val wallClock: () -> Long = System::currentTimeMillis,
    private val timing: Timing = Timing(),
) {
    data class Timing(
        val tickMs: Long = 250,
        val longPollSec: Int = 25,
        val clockSampleMs: Long = 60_000,
        val idleStopMs: Long = 120_000,
        val seekHoldMs: Long = 1000,
        val seekLeadMs: Long = 150,
        val reResolveBeforeExpiryMs: Long = 60_000,
        val maxRecoveries: Int = 3,
        val retryMs: Long = 3000,
        val recoverDelayMs: Long = 2000,
    )

    private val _state = MutableStateFlow(ListenState())
    val state: StateFlow<ListenState> = _state.asStateFlow()

    fun start(target: ListenTarget, timing: LinkTiming, nudgeMs: Long) {
        _state.value = ListenState(phase = ListenPhase.Listening, target = target, timing = timing, nudgeMs = nudgeMs)
    }

    fun stop() {
        if (_state.value.phase == ListenPhase.Idle) return
        _state.value = ListenState(nudgeMs = _state.value.nudgeMs, ended = EndReason.Stopped)
    }

    fun setTiming(timing: LinkTiming) {}

    fun setNudgeMs(ms: Long) {}

    fun switchSource(sourceId: String, language: String?) {}

    fun release() {
        stop()
    }
}
