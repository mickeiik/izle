package io.github.mickeiik.izle

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** Phase 0 toolchain smoke: proves the serialization compiler plugin runs under AGP 9 built-in Kotlin. */
@Serializable
data class Hello(val app: String, val phase: Int)

object HelloCodec {
    private val json = Json { ignoreUnknownKeys = true }

    fun decode(text: String): Hello = json.decodeFromString(Hello.serializer(), text)
}
