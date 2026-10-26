package io.github.mickeiik.izle

import mockwebserver3.MockResponse
import java.security.MessageDigest

/** A JSON answer of an in-process test server. */
fun json(code: Int, body: String): MockResponse =
    MockResponse.Builder().code(code).addHeader("Content-Type", "application/json").body(body).build()

fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
