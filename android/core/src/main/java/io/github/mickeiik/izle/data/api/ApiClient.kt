package io.github.mickeiik.izle.data.api

import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/**
 * The server answered with an error status. `code` is the API error code (`not_allowed`, `expired`, …); [runId] is
 * the run already going of a `409 check_running`; [issues] those of a `422 invalid_catalog` (a refused reload).
 */
class ApiException(
    val status: Int,
    val code: String,
    val retryAfterSec: Long? = null,
    val runId: String? = null,
    val issues: List<CatalogIssue> = emptyList(),
) : Exception("HTTP $status $code")

/** An error answer, with its API error code (`http_<status>` without one). Public: the TV app's APK download uses it. */
fun apiError(status: Int, body: String, retryAfter: String? = null): ApiException {
    val error = runCatching { ApiJson.decodeFromString(ErrorBody.serializer(), body) }.getOrNull()
    return ApiException(status, error?.error ?: "http_$status", retryAfter?.toLongOrNull(), error?.runId, error?.issues.orEmpty())
}

/** What [block] returns, or null when the server could not be reached or answered with an error. */
inline fun <T> orNullOnFailure(block: () -> T): T? = try {
    block()
} catch (e: Exception) {
    if (e is IOException || e is ApiException) null else throw e
}

/**
 * The server API: the TV routes, and the admin routes the companion app uses. Network failures surface as
 * [IOException], error answers as [ApiException]. [token] is a device token on a TV and a phone secret (`izph_…`)
 * in the companion app (or the admin token in a debug build), sent as the same bearer header. It and [userAgent]
 * (read anew: it changes with the update capability) are attached per request, never through an interceptor, so they cannot leak to media hosts that share
 * the OkHttp connection pool.
 */
class ApiClient(
    private val baseUrl: HttpUrl,
    private val token: String?,
    private val http: OkHttpClient,
    private val longPollHttp: OkHttpClient = http,
    private val userAgent: () -> String? = { null },
) {
    private fun url(path: String): HttpUrl = baseUrl.resolve(path) ?: error("bad path $path")

    /**
     * For the calls the server may work on for minutes: a check of every source of an episode (20 s each) and a catalog
     * reload (it hashes every poster). Shares [longPollHttp]'s pool.
     */
    private val slowHttp: OkHttpClient by lazy {
        longPollHttp.newBuilder().readTimeout(SLOW_CALL_MIN, TimeUnit.MINUTES).callTimeout(SLOW_CALL_MIN, TimeUnit.MINUTES).build()
    }

    /** A server-handed URL made absolute; null when unusable. */
    fun resolve(reference: String?): HttpUrl? = reference?.let { ServerUrls.resolve(baseUrl, it) }

    val eventsUrl: HttpUrl get() = url("api/v1/tv/events")

    fun authorize(builder: Request.Builder): Request.Builder {
        withUserAgent(builder)
        return if (token != null) builder.header("Authorization", "Bearer $token") else builder
    }

    private fun withUserAgent(builder: Request.Builder): Request.Builder {
        userAgent()?.let { builder.header("User-Agent", it) }
        return builder
    }

    suspend fun healthz() {
        exchange(Request.Builder().url(url("healthz")).build()).requireOk()
    }

    suspend fun pairStart(): PairStart =
        exchange(Request.Builder().url(url("api/v1/pair/start")).post(EMPTY_BODY).build()).decode(PairStart.serializer())

    /** Long-polls for the owner's approval. An expired or already delivered code answers `expired`. */
    suspend fun pairWait(code: String, pairToken: String, waitSec: Int = 25): PairWait {
        val url = url("api/v1/pair/wait").newBuilder()
            .addQueryParameter("code", code)
            .addQueryParameter("wait", waitSec.toString())
            .build()
        val raw = exchange(Request.Builder().url(url).header("Authorization", "Bearer $pairToken").build(), longPollHttp)
        if (raw.status == 410) return PairWait(status = "expired")
        return raw.decode(PairWait.serializer())
    }

    suspend fun state(): TvState = get(url("api/v1/tv/state"), TvState.serializer())

    suspend fun item(itemId: String): ItemDetailsResponse =
        get(url("api/v1/tv/items/").newBuilder().addPathSegment(itemId).build(), ItemDetailsResponse.serializer())

    /** On the long-poll client: the server may spend up to 30 s in the owner's resolver module. */
    suspend fun resolve(request: ResolveRequest): ResolveResponse {
        val raw = exchange(jsonPost("api/v1/tv/resolve", ResolveRequest.serializer(), request), longPollHttp)
        return raw.decode(ResolveResponse.serializer()).copy(serverDateMs = raw.dateMs)
    }

    suspend fun progress(report: ProgressReport) {
        exchange(jsonPost("api/v1/tv/progress", ProgressReport.serializer(), report)).requireOk()
    }

    suspend fun ackCommand(id: Long) {
        exchange(authorize(Request.Builder().url(url("api/v1/tv/commands/$id/ack")).post(EMPTY_BODY)).build()).requireOk()
    }

    suspend fun reportCommandResult(id: Long, result: CommandResult) {
        exchange(jsonPost("api/v1/tv/commands/$id/result", CommandResult.serializer(), result)).requireOk()
    }

    suspend fun reportProblem(report: ProblemReport) {
        exchange(jsonPost("api/v1/tv/problems", ProblemReport.serializer(), report)).requireOk()
    }

    /** Null when the server stores none (`204`). */
    suspend fun app(): AvailableUpdate? {
        val raw = exchange(authorize(Request.Builder().url(url("api/v1/tv/app"))).build())
        if (raw.status == 204) return null
        val info = raw.decode(AvailableUpdate.serializer())
        if (info.versionCode <= 0 || info.size <= 0 || !SHA256.matches(info.sha256)) throw ApiException(raw.status, "bad_response")
        return info.copy(sha256 = info.sha256.lowercase())
    }

    /** Streamed by [io.github.mickeiik.izle.update.ApkDownloader]. */
    fun apkRequest(): Request = authorize(Request.Builder().url(url("api/v1/tv/app/apk"))).build()

    /** "Connect a phone": a new invite for this TV (the previous one stops working). */
    suspend fun phoneInvite(): PhoneInvite =
        exchange(authorize(Request.Builder().url(url("api/v1/tv/phones/invite")).post(EMPTY_BODY)).build()).decode(PhoneInvite.serializer())

    /** This TV left "Connect a phone": its open invite stops working (`204`). */
    suspend fun cancelPhoneInvite() {
        exchange(authorize(Request.Builder().url(url("api/v1/tv/phones/invite")).delete()).build()).requireOk()
    }

    /** Long-polls this TV's latest invite (on longPollHttp): `open`, `claimed`, `expired` (410) or `not_found` (404). */
    suspend fun phoneInviteWait(waitSec: Int = 25): PhoneInviteStatus {
        val url = url("api/v1/tv/phones/invite").newBuilder().addQueryParameter("wait", waitSec.toString()).build()
        val raw = exchange(authorize(Request.Builder().url(url)).build(), longPollHttp)
        if (raw.status == 410) return PhoneInviteStatus(PhoneInviteStatus.EXPIRED)
        if (raw.status == 404) return PhoneInviteStatus(PhoneInviteStatus.NOT_FOUND)
        return raw.decode(PhoneInviteStatus.serializer())
    }

    suspend fun devices(): DevicesResponse = get(url("api/v1/admin/devices"), DevicesResponse.serializer())

    suspend fun companion(deviceId: String): CompanionResponse =
        get(deviceUrl(deviceId).addPathSegment("companion").build(), CompanionResponse.serializer())

    /** `seq` + `waitSec` > 0: a long-poll (on longPollHttp) that returns on the next now-playing write. */
    suspend fun now(deviceId: String, seq: Long? = null, waitSec: Int = 0): NowResponse {
        val builder = deviceUrl(deviceId).addPathSegment("now")
        if (seq != null) builder.addQueryParameter("seq", seq.toString())
        val url = builder.addQueryParameter("wait", waitSec.toString()).build()
        val raw = exchange(authorize(Request.Builder().url(url)).build(), if (waitSec > 0) longPollHttp else http)
        return raw.decode(NowResponse.serializer())
    }

    /** On the long-poll client (the resolver may take up to 30 s); fills serverDateMs. */
    suspend fun companionResolve(deviceId: String, request: CompanionResolveRequest): CompanionResolveResponse {
        val url = deviceUrl(deviceId).addPathSegment("companion").addPathSegment("resolve").build()
        val raw = exchange(jsonRequest(url, "POST", CompanionResolveRequest.serializer(), request), longPollHttp)
        return raw.decode(CompanionResolveResponse.serializer()).copy(serverDateMs = raw.dateMs)
    }

    suspend fun putLink(episodeId: String, sourceId: String, update: LinkUpdate): LinkResponse =
        exchange(jsonRequest(link(episodeId, sourceId).build(), "PUT", LinkUpdate.serializer(), update))
            .decode(LinkResponse.serializer())

    suspend fun copyLinkToItem(episodeId: String, sourceId: String): CopyToItemResponse {
        val url = link(episodeId, sourceId).addPathSegment("copy-to-item").build()
        return exchange(authorize(Request.Builder().url(url).post(EMPTY_BODY)).build()).decode(CopyToItemResponse.serializer())
    }

    // Phones: a phone claims an invite the TV shows and gets its own owner-level secret (`izph_…`).

    /** Without an Authorization header: the invite (or the code) is the credential. */
    suspend fun claimPhone(request: PhoneClaimRequest): PhoneClaim {
        val body = ApiJson.encodeToString(PhoneClaimRequest.serializer(), request).toRequestBody(JSON)
        return exchange(Request.Builder().url(url("api/v1/phones/claim")).post(body).build()).decode(PhoneClaim.serializer())
    }

    suspend fun phones(): PhonesResponse = get(url("api/v1/admin/phones"), PhonesResponse.serializer())

    /** `204`; a phone may delete itself (its secret answers `401` from then on). */
    suspend fun deletePhone(phoneId: String) {
        val url = url("api/v1/admin/phones").newBuilder().addPathSegment(phoneId).build()
        exchange(authorize(Request.Builder().url(url).delete()).build()).requireOk()
    }

    // The admin routes of a TV's page (the companion app): its Home, remote commands, the catalog and the event log.

    /** The TV with its Home list and sections (`GET admin/devices/:id`). */
    suspend fun device(deviceId: String): DeviceDetail = get(deviceUrl(deviceId).build(), DeviceDetail.serializer())

    /** `PATCH`: only the fields given are sent (the name and language settings are not the companion's to change). */
    suspend fun updateDevice(deviceId: String, homeColumns: Int? = null, homeRows: Int? = null): AdminDevice {
        val body = buildJsonObject {
            homeColumns?.let { put("homeColumns", it) }
            homeRows?.let { put("homeRows", it) }
        }
        return exchange(jsonRequest(deviceUrl(deviceId).build(), "PATCH", body)).decode(DeviceUpdated.serializer()).device
    }

    /** `POST …/commands` (`202`): [fields] go next to `type` (`itemId`, `deltaMs`, `text`, …). */
    suspend fun sendCommand(deviceId: String, type: String, fields: Map<String, JsonPrimitive> = emptyMap()): CommandSent {
        val body = buildJsonObject {
            put("type", type)
            fields.forEach { (key, value) -> put(key, value) }
        }
        val url = deviceUrl(deviceId).addPathSegment("commands").build()
        return exchange(jsonRequest(url, "POST", body)).decode(CommandSent.serializer())
    }

    /** A command while the server keeps it (7 days); `result` stays null until the TV reports. */
    suspend fun command(deviceId: String, commandId: Long): CommandInfo {
        val url = deviceUrl(deviceId).addPathSegment("commands").addPathSegment(commandId.toString()).build()
        return get(url, CommandResponse.serializer()).command
    }

    /** One single change to the Home list (never the whole list): the answer holds the list as it is now. */
    suspend fun addHomeItem(deviceId: String, itemId: String, sectionId: String? = null, position: Int? = null): HomeChange {
        val body = buildJsonObject {
            put("itemId", itemId)
            sectionId?.let { put("sectionId", it) }
            position?.let { put("position", it) }
        }
        return homeChange(jsonRequest(homeUrl(deviceId, "items").build(), "POST", body))
    }

    /** Moves a show to [position] (0-based, in [sectionId] or the section it is in). `404 not_on_home` / `unknown_section`. */
    suspend fun moveHomeItem(deviceId: String, itemId: String, sectionId: String? = null, position: Int? = null): HomeChange {
        val body = buildJsonObject {
            sectionId?.let { put("sectionId", it) }
            position?.let { put("position", it) }
        }
        return homeChange(jsonRequest(homeUrl(deviceId, "items").addPathSegment(itemId).build(), "PATCH", body))
    }

    suspend fun removeHomeItem(deviceId: String, itemId: String): HomeChange =
        homeChange(authorize(Request.Builder().url(homeUrl(deviceId, "items").addPathSegment(itemId).build()).delete()).build())

    suspend fun addSection(deviceId: String, title: String, layout: String? = null, position: Int? = null): HomeChange {
        val body = buildJsonObject {
            put("title", title)
            layout?.let { put("layout", it) }
            position?.let { put("position", it) }
        }
        return homeChange(jsonRequest(homeUrl(deviceId, "sections").build(), "POST", body))
    }

    suspend fun updateSection(deviceId: String, sectionId: String, title: String? = null, layout: String? = null, position: Int? = null): HomeChange {
        val body = buildJsonObject {
            title?.let { put("title", it) }
            layout?.let { put("layout", it) }
            position?.let { put("position", it) }
        }
        return homeChange(jsonRequest(homeUrl(deviceId, "sections").addPathSegment(sectionId).build(), "PATCH", body))
    }

    /** The section's shows move to the end of the untitled one. */
    suspend fun deleteSection(deviceId: String, sectionId: String): HomeChange =
        homeChange(authorize(Request.Builder().url(homeUrl(deviceId, "sections").addPathSegment(sectionId).build()).delete()).build())

    /** Where OK continues a series on this TV. */
    suspend fun setCursor(deviceId: String, itemId: String, episodeId: String) {
        val body = buildJsonObject {
            put("itemId", itemId)
            put("episodeId", episodeId)
        }
        exchange(jsonRequest(deviceUrl(deviceId).addPathSegment("cursor").build(), "PUT", body)).requireOk()
    }

    /** Where OK continues each series on this TV, and its saved positions (see [DeviceProgress.okPlays]). */
    suspend fun deviceProgress(deviceId: String): DeviceProgress =
        get(deviceUrl(deviceId).addPathSegment("progress").build(), DeviceProgress.serializer())

    /**
     * `GET admin/catalog/search`: [kinds] `movie`, `series`, `live`; [notOnDevice] leaves out that TV's Home; [since]
     * (ISO 8601 UTC) only what was first seen then or later, or has an episode that was; [sort] a [CatalogSearch] `SORT_…`.
     */
    suspend fun catalogSearch(
        q: String = "",
        kinds: List<String> = emptyList(),
        notOnDevice: String? = null,
        playable: Boolean? = null,
        offset: Int = 0,
        limit: Int = 50,
        since: String? = null,
        sort: String? = null,
    ): CatalogSearch {
        val url = url("api/v1/admin/catalog/search").newBuilder().apply {
            if (q.isNotEmpty()) addQueryParameter("q", q)
            if (kinds.isNotEmpty()) addQueryParameter("kind", kinds.joinToString(","))
            notOnDevice?.let { addQueryParameter("notOnDevice", it) }
            playable?.let { addQueryParameter("playable", it.toString()) }
            since?.let { addQueryParameter("since", it) }
            sort?.let { addQueryParameter("sort", it) }
            addQueryParameter("offset", offset.toString())
            addQueryParameter("limit", limit.toString())
        }.build()
        return get(url, CatalogSearch.serializer())
    }

    suspend fun catalogItem(itemId: String): AdminItem {
        val url = url("api/v1/admin/catalog/items").newBuilder().addPathSegment(itemId).build()
        return get(url, ItemResponse.serializer()).item
    }

    /** The loaded catalog with its build history and what its newest build changed. */
    suspend fun catalog(): AdminCatalog = get(url("api/v1/admin/catalog"), AdminCatalog.serializer())

    /** What one build of the history changed (also one beyond the 50 [catalog] lists); `404 unknown_build`. */
    suspend fun catalogBuild(buildId: String): BuildChanges =
        get(url("api/v1/admin/catalog/builds").newBuilder().addPathSegment(buildId).build(), BuildChanges.serializer())

    /**
     * Re-reads the bundle on the server (on longPollHttp: validating every poster takes a while). A refused bundle is
     * `422 invalid_catalog` with its [ApiException.issues], and the catalog loaded before stays.
     */
    suspend fun reloadCatalog(): AdminCatalog {
        val request = authorize(Request.Builder().url(url("api/v1/admin/catalog/reload")).post(EMPTY_BODY)).build()
        return exchange(request, slowHttp).decode(CatalogResponse.serializer()).catalog
    }

    /**
     * The event log after [after] (null: the answer is empty and its `last` is where to follow from). [waitSec] > 0 is a
     * long-poll (on longPollHttp). [types] may end in `.` (a prefix); events without a device pass [devices].
     */
    suspend fun adminEvents(after: Long?, waitSec: Int = 0, types: List<String> = emptyList(), devices: List<String> = emptyList()): EventsPage {
        val url = url("api/v1/admin/events").newBuilder().apply {
            after?.let { addQueryParameter("after", it.toString()) }
            addQueryParameter("wait", waitSec.toString())
            if (types.isNotEmpty()) addQueryParameter("types", types.joinToString(","))
            if (devices.isNotEmpty()) addQueryParameter("devices", devices.joinToString(","))
        }.build()
        val raw = exchange(authorize(Request.Builder().url(url)).build(), if (waitSec > 0) longPollHttp else http)
        return raw.decode(EventsPage.serializer())
    }

    // Checks: a batch run over a TV's Home or one show, followed until it ends. One runs at a time on the server.

    /**
     * Checks [deviceId]'s Home: [mode] `quick` (what OK plays on each entry) or `full` (every episode that may play).
     * While another run goes: `409 check_running` with its [ApiException.runId], to follow that one instead.
     */
    suspend fun startHomeCheck(deviceId: String, mode: String): CheckRun = startCheck(
        buildJsonObject {
            put("deviceId", deviceId)
            put("mode", mode)
        },
    )

    /** Checks every episode of [itemId] that may play, or the channel; `409 check_running` as [startHomeCheck]. */
    suspend fun startShowCheck(itemId: String): CheckRun = startCheck(buildJsonObject { put("itemId", itemId) })

    private suspend fun startCheck(body: JsonObject): CheckRun =
        exchange(jsonRequest(checksUrl().build(), "POST", body)).decode(RunResponse.serializer()).run

    /**
     * A run as it is; with [seq] and [waitMs] > 0 a long-poll (on longPollHttp) that answers once the run's seq is past
     * [seq], or after [waitMs] (at most 25 000). `404 unknown_check`: only the last run is kept.
     */
    suspend fun checkRun(runId: String, seq: Long? = null, waitMs: Int = 0): CheckRun {
        val waiting = seq != null && waitMs > 0
        val url = checksUrl().addPathSegment(runId).apply {
            if (seq != null) addQueryParameter("seq", seq.toString())
            if (waiting) addQueryParameter("wait", waitMs.toString())
        }.build()
        return exchange(authorize(Request.Builder().url(url)).build(), if (waiting) longPollHttp else http).decode(RunResponse.serializer()).run
    }

    /** The running run, else the last one that ended, else null. */
    suspend fun currentCheck(): CheckRun? = get(checksUrl().addPathSegment("current").build(), CurrentRunResponse.serializer()).run

    /** Stops a running run (`cancelled`; what it checked stays stored); a run that ended is answered as it is. */
    suspend fun cancelCheck(runId: String): CheckRun =
        exchange(authorize(Request.Builder().url(checksUrl().addPathSegment(runId).build()).delete()).build()).decode(RunResponse.serializer()).run

    /**
     * The stored reports of an episode, or of a channel by its item id; with [itemId] that item's (an episode id may
     * equal a channel's). `404 unknown_item` / `unknown_episode`.
     */
    suspend fun checkPlayable(playableId: String, itemId: String? = null): PlayableChecks {
        val url = checksUrl().addPathSegment("playables").addPathSegment(playableId).apply {
            itemId?.let { addQueryParameter("itemId", it) }
        }.build()
        return get(url, PlayableChecks.serializer())
    }

    /**
     * Checks every source of [episodeId], or of the channel [itemId] (exactly one), now, one after the other, and stores
     * the reports; on longPollHttp (each source may take 20 s).
     */
    suspend fun checkNow(episodeId: String? = null, itemId: String? = null): PlayableReport {
        require((episodeId == null) != (itemId == null)) { "exactly one of episodeId and itemId" }
        val body = buildJsonObject {
            episodeId?.let { put("episodeId", it) }
            itemId?.let { put("itemId", it) }
        }
        val raw = exchange(jsonRequest(url("api/v1/admin/diagnostics/resolve"), "POST", body), slowHttp)
        return raw.decode(PlayableReport.serializer())
    }

    private fun checksUrl(): HttpUrl.Builder = url("api/v1/admin/checks").newBuilder()

    private suspend fun homeChange(request: Request): HomeChange = exchange(request).decode(HomeChange.serializer())

    /** `api/v1/admin/devices/:id/home/<kind>` (`items` or `sections`). */
    private fun homeUrl(deviceId: String, kind: String): HttpUrl.Builder =
        deviceUrl(deviceId).addPathSegment("home").addPathSegment(kind)

    private fun jsonRequest(url: HttpUrl, method: String, body: JsonObject): Request =
        authorize(Request.Builder().url(url).method(method, ApiJson.encodeToString(JsonObject.serializer(), body).toRequestBody(JSON))).build()

    /** `api/v1/admin/devices/:id`; ids are path segments, never concatenated (they may contain anything). */
    private fun deviceUrl(deviceId: String): HttpUrl.Builder =
        url("api/v1/admin/devices").newBuilder().addPathSegment(deviceId)

    private fun link(episodeId: String, sourceId: String): HttpUrl.Builder =
        url("api/v1/admin/companion/links").newBuilder().addPathSegment(episodeId).addPathSegment(sourceId)

    private suspend fun <T> get(url: HttpUrl, serializer: KSerializer<T>): T =
        exchange(authorize(Request.Builder().url(url)).build()).decode(serializer)

    private fun <T> jsonPost(path: String, serializer: KSerializer<T>, body: T): Request =
        jsonRequest(url(path), "POST", serializer, body)

    private fun <T> jsonRequest(url: HttpUrl, method: String, serializer: KSerializer<T>, body: T): Request {
        val json = ApiJson.encodeToString(serializer, body).toRequestBody(JSON)
        return authorize(Request.Builder().url(url).method(method, json)).build()
    }

    private fun <T> RawResponse.decode(serializer: KSerializer<T>): T {
        requireOk()
        return try {
            ApiJson.decodeFromString(serializer, body)
        } catch (e: IllegalArgumentException) {
            throw ApiException(status, "bad_response")
        }
    }

    private fun RawResponse.requireOk() {
        if (status !in 200..299) throw apiError(status, body, retryAfter)
    }

    /** [dateMs]: the `Date` header (the server's clock, whole seconds). */
    private class RawResponse(val status: Int, val body: String, val retryAfter: String?, val dateMs: Long? = null)

    /** Runs the call on OkHttp's threads (the body is read there too) and cancels it with the coroutine. */
    private suspend fun exchange(request: Request, client: OkHttpClient = http): RawResponse =
        suspendCancellableCoroutine { cont ->
            val call = client.newCall(withUserAgent(request.newBuilder()).build())
            cont.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    cont.resumeWithException(e)
                }

                override fun onResponse(call: Call, response: Response) {
                    val raw = try {
                        response.use { RawResponse(it.code, it.body.string(), it.header("Retry-After"), it.headers.getDate("Date")?.time) }
                    } catch (e: IOException) {
                        return cont.resumeWithException(e)
                    }
                    cont.resume(raw)
                }
            })
        }

    private companion object {
        val JSON = "application/json".toMediaType()
        val EMPTY_BODY: RequestBody = ByteArray(0).toRequestBody(null)
        val SHA256 = Regex("^[0-9a-fA-F]{64}$")
        const val SLOW_CALL_MIN = 5L
    }
}
