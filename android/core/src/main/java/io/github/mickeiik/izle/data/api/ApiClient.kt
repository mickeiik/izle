package io.github.mickeiik.izle.data.api

import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.KSerializer
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** The server answered with an error status. `code` is the API error code (`not_allowed`, `expired`, …). */
class ApiException(val status: Int, val code: String, val retryAfterSec: Long? = null) : Exception("HTTP $status $code")

/** An error answer, with its API error code (`http_<status>` without one). Public: the TV app's APK download uses it. */
fun apiError(status: Int, body: String, retryAfter: String? = null): ApiException {
    val code = runCatching { ApiJson.decodeFromString(ErrorBody.serializer(), body).error }.getOrNull() ?: "http_$status"
    return ApiException(status, code, retryAfter?.toLongOrNull())
}

/** What [block] returns, or null when the server could not be reached or answered with an error. */
inline fun <T> orNullOnFailure(block: () -> T): T? = try {
    block()
} catch (e: Exception) {
    if (e is IOException || e is ApiException) null else throw e
}

/**
 * The server API: the TV routes, and the admin routes the companion app uses. Network failures surface as
 * [IOException], error answers as [ApiException]. [token] is a device token on a TV and an access token (`izat_…`)
 * in the companion app, sent as the same bearer header. It and [userAgent] (read anew: it changes with the update
 * capability) are attached per request, never through an interceptor, so they cannot leak to media hosts that share
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

    suspend fun devices(): DevicesResponse = get(url("api/v1/admin/devices"), DevicesResponse.serializer())

    suspend fun companion(deviceId: String): CompanionResponse =
        get(device(deviceId).addPathSegment("companion").build(), CompanionResponse.serializer())

    /** `seq` + `waitSec` > 0: a long-poll (on longPollHttp) that returns on the next now-playing write. */
    suspend fun now(deviceId: String, seq: Long? = null, waitSec: Int = 0): NowResponse {
        val builder = device(deviceId).addPathSegment("now")
        if (seq != null) builder.addQueryParameter("seq", seq.toString())
        val url = builder.addQueryParameter("wait", waitSec.toString()).build()
        val raw = exchange(authorize(Request.Builder().url(url)).build(), if (waitSec > 0) longPollHttp else http)
        return raw.decode(NowResponse.serializer())
    }

    /** On the long-poll client (the resolver may take up to 30 s); fills serverDateMs. */
    suspend fun companionResolve(deviceId: String, request: CompanionResolveRequest): CompanionResolveResponse {
        val url = device(deviceId).addPathSegment("companion").addPathSegment("resolve").build()
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

    /** `api/v1/admin/devices/:id`; ids are path segments, never concatenated (they may contain anything). */
    private fun device(deviceId: String): HttpUrl.Builder =
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
    }
}
