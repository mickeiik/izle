package io.github.mickeiik.izle.data.api

import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.buffer
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import java.io.IOException

/** Live events from `GET /api/v1/tv/events`. */
sealed interface ServerEvent {
    /** The stream is connected. */
    data object Open : ServerEvent

    /** The device's state version changed; re-fetch `/tv/state` when it differs from the one shown. */
    data class State(val version: Long) : ServerEvent

    /**
     * An owner command; the TV acknowledges it once handled. The payload fields of every known type are flattened
     * here (null when absent or of the wrong JSON type), so a command of a type this TV does not know, or with an
     * unexpected payload, still arrives and is acknowledged instead of being replayed for two minutes.
     */
    data class Command(
        val id: Long,
        val type: String,
        val itemId: String? = null,
        val episodeId: String? = null,
        val deltaMs: Long? = null,
        val positionMs: Long? = null,
        val text: String? = null,
        val durationSec: Int? = null,
    ) : ServerEvent

    companion object {
        /** Maps one SSE message to an event; unknown event types and malformed data are ignored (null). */
        fun parse(type: String?, data: String): ServerEvent? = try {
            when (type) {
                "state" -> State(ApiJson.decodeFromString(StateData.serializer(), data).version)
                "command" -> ApiJson.decodeFromString(CommandData.serializer(), data).let {
                    val payload = it.payload as? JsonObject ?: JsonObject(emptyMap())
                    Command(
                        id = it.id,
                        type = it.type,
                        itemId = payload.string("itemId"),
                        episodeId = payload.string("episodeId"),
                        deltaMs = payload.number("deltaMs")?.longOrNull,
                        positionMs = payload.number("positionMs")?.longOrNull,
                        text = payload.string("text"),
                        durationSec = payload.number("durationSec")?.intOrNull,
                    )
                }
                else -> null
            }
        } catch (e: IllegalArgumentException) {
            null
        }
    }
}

@Serializable
private data class StateData(val version: Long)

@Serializable
private data class CommandData(val id: Long, val type: String, val payload: JsonElement? = null)

private fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

private fun JsonObject.number(key: String): JsonPrimitive? = (this[key] as? JsonPrimitive)?.takeIf { !it.isString }

/**
 * Server-sent events as a cold [Flow]. The flow fails with [ApiException] (401 = the device was removed) or
 * [IOException] when the stream breaks; the caller reconnects with backoff. The client's read timeout is the
 * dead-connection watchdog: the server sends a `: ping` comment every 20 s, so 60 s of silence fails the read.
 */
class EventsClient(sseHttp: OkHttpClient) {
    private val factory: EventSource.Factory = EventSources.createFactory(sseHttp)

    fun events(api: ApiClient): Flow<ServerEvent> = callbackFlow {
        val request = api.authorize(Request.Builder().url(api.eventsUrl).header("Accept", "text/event-stream")).build()
        val source = factory.newEventSource(request, object : EventSourceListener() {
            override fun onOpen(eventSource: EventSource, response: Response) {
                trySend(ServerEvent.Open)
            }

            override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                ServerEvent.parse(type, data)?.let { trySend(it) }
            }

            override fun onClosed(eventSource: EventSource) {
                close(IOException("event stream closed"))
            }

            override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
                val status = response?.code
                close(
                    when {
                        status != null && status !in 200..299 -> ApiException(status, "http_$status")
                        t is IOException -> t
                        else -> IOException("event stream failed", t)
                    },
                )
            }
        })
        awaitClose { source.cancel() }
    }.buffer(Channel.UNLIMITED)
}
