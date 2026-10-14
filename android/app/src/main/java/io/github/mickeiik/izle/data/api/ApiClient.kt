package io.github.mickeiik.izle.data.api

import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
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

/**
 * The TV side of the server API. Network failures surface as [IOException], error answers as [ApiException].
 * The device token is attached per request (never through an interceptor) so it cannot leak to media hosts that
 * share the OkHttp connection pool.
 */
class ApiClient(
    val baseUrl: HttpUrl,
    private val deviceToken: String?,
    private val http: OkHttpClient,
    private val longPollHttp: OkHttpClient = http,
    private val json: Json = ApiJson,
) {
    fun url(path: String): HttpUrl = baseUrl.resolve(path) ?: error("bad path $path")

    /** A server-handed URL (poster, media, subtitle) made absolute; null when unusable. */
    fun resolve(reference: String?): HttpUrl? = reference?.let { ServerUrls.resolve(baseUrl, it) }

    val eventsUrl: HttpUrl get() = url("api/v1/tv/events")

    fun authorize(builder: Request.Builder): Request.Builder =
        if (deviceToken != null) builder.header("Authorization", "Bearer $deviceToken") else builder

    // --- unauthenticated -----------------------------------------------------------------------------------------

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

    // --- TV ------------------------------------------------------------------------------------------------------

    suspend fun state(): TvState = get("api/v1/tv/state", TvState.serializer())

    suspend fun item(itemId: String): ItemDetailsResponse {
        val url = url("api/v1/tv/items/").newBuilder().addPathSegment(itemId).build()
        return exchange(authorize(Request.Builder().url(url)).build()).decode(ItemDetailsResponse.serializer())
    }

    /**
     * The server may spend up to 30 s in the owner's resolver module, longer than the default read timeout. The
     * answer carries the server's clock (`Date` header) as [ResolveResponse.serverDateMs] for expiry scheduling.
     */
    suspend fun resolve(request: ResolveRequest): ResolveResponse {
        val body = json.encodeToString(ResolveRequest.serializer(), request).toRequestBody(JSON)
        val raw = exchange(authorize(Request.Builder().url(url("api/v1/tv/resolve")).post(body)).build(), longPollHttp)
        return raw.decode(ResolveResponse.serializer()).copy(serverDateMs = raw.dateMs)
    }

    suspend fun progress(report: ProgressReport): ProgressAck =
        post("api/v1/tv/progress", json.encodeToString(ProgressReport.serializer(), report), ProgressAck.serializer())

    suspend fun ackCommand(id: Long) {
        exchange(authorize(Request.Builder().url(url("api/v1/tv/commands/$id/ack")).post(EMPTY_BODY)).build()).requireOk()
    }

    /** `202 {"ok":true}`; a server too old for the route answers 4xx, which the caller ignores like any failure. */
    suspend fun reportProblem(report: ProblemReport) {
        val body = json.encodeToString(ProblemReport.serializer(), report).toRequestBody(JSON)
        exchange(authorize(Request.Builder().url(url("api/v1/tv/problems")).post(body)).build()).requireOk()
    }

    // --- plumbing ------------------------------------------------------------------------------------------------

    private suspend fun <T> get(path: String, serializer: KSerializer<T>): T =
        exchange(authorize(Request.Builder().url(url(path))).build()).decode(serializer)

    private suspend fun <T> post(path: String, body: String, serializer: KSerializer<T>, client: OkHttpClient = http): T =
        exchange(authorize(Request.Builder().url(url(path)).post(body.toRequestBody(JSON))).build(), client).decode(serializer)

    private fun <T> RawResponse.decode(serializer: KSerializer<T>): T {
        requireOk()
        return try {
            json.decodeFromString(serializer, body)
        } catch (e: IllegalArgumentException) {
            throw ApiException(status, "bad_response")
        }
    }

    private fun RawResponse.requireOk() {
        if (status in 200..299) return
        val code = try {
            json.decodeFromString(ErrorBody.serializer(), body).error
        } catch (e: IllegalArgumentException) {
            "http_$status"
        }
        throw ApiException(status, code, retryAfter?.toLongOrNull())
    }

    /** [dateMs]: the `Date` header (the server's clock, whole seconds), if any. */
    private class RawResponse(val status: Int, val body: String, val retryAfter: String?, val dateMs: Long? = null)

    /** Runs the call on OkHttp's threads (the body is read there too) and cancels it with the coroutine. */
    private suspend fun exchange(request: Request, client: OkHttpClient = http): RawResponse =
        suspendCancellableCoroutine { cont ->
            val call = client.newCall(request)
            cont.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    cont.resumeWithException(e)
                }

                override fun onResponse(call: Call, response: Response) {
                    val raw = try {
                        response.use { RawResponse(it.code, it.body.string(), it.header("Retry-After"), it.headers.getDate("Date")?.time) }
                    } catch (e: IOException) {
                        cont.resumeWithException(e)
                        return
                    }
                    cont.resume(raw)
                }
            })
        }

    private companion object {
        val JSON = "application/json".toMediaType()
        val EMPTY_BODY: RequestBody = ByteArray(0).toRequestBody(null)
    }
}
