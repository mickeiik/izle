package io.github.mickeiik.izle.data.api

import io.github.mickeiik.izle.json
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Before
import org.junit.Test

/** The phone routes of [ApiClient] against an in-process MockWebServer (no network). */
class PhoneApiTest {
    private val server = MockWebServer()
    private val http = OkHttpClient()

    @Before
    fun setUp() = server.start()

    @After
    fun tearDown() = server.close()

    @Test
    fun aClaimSendsNoAuthorizationAndOnlyTheGivenField() = runBlocking {
        server.enqueue(json(201, CLAIM))
        server.enqueue(json(201, CLAIM))
        // A client made with a credential still claims without it.
        val api = ApiClient(server.url("/izle/"), "izph_old", http)
        val claim = api.claimPhone(PhoneClaimRequest(code = "483920", name = "Pixel 8"))
        assertEquals("izph_secret", claim.secret)
        assertEquals("tv-1", claim.deviceId)
        assertEquals(Phone("ph0123456789", "Pixel 8", "2026-10-26T10:00:00.000Z", null, "tv-1"), claim.phone)
        val byCode = server.takeRequest()
        assertEquals("POST", byCode.method)
        assertEquals("/izle/api/v1/phones/claim", byCode.url.encodedPath)
        assertNull(byCode.headers["Authorization"])
        assertEquals("""{"code":"483920","name":"Pixel 8"}""", byCode.body?.utf8())

        ApiClient(server.url("/"), null, http).claimPhone(PhoneClaimRequest(invite = "inv-abc_123", name = "Pixel 8"))
        val byInvite = server.takeRequest()
        assertNull(byInvite.headers["Authorization"])
        assertEquals("""{"invite":"inv-abc_123","name":"Pixel 8"}""", byInvite.body?.utf8())
    }

    @Test
    fun claimErrorsKeepTheirStatusAndRetryAfter() {
        server.enqueue(json(404, """{"error":"not_found"}"""))
        server.enqueue(MockResponse.Builder().code(429).addHeader("Retry-After", "120").body("""{"error":"rate_limited"}""").build())
        val api = ApiClient(server.url("/"), null, http)
        val notFound = assertThrows(ApiException::class.java) { runBlocking { api.claimPhone(PhoneClaimRequest(code = "000000", name = "p")) } }
        assertEquals(404, notFound.status)
        val limited = assertThrows(ApiException::class.java) { runBlocking { api.claimPhone(PhoneClaimRequest(code = "000000", name = "p")) } }
        assertEquals("rate_limited", limited.code)
        assertEquals(120L, limited.retryAfterSec)
    }

    @Test
    fun phonesAreListedAndDeletedWithTheSecret() = runBlocking {
        server.enqueue(
            json(
                200,
                """{"phones":[{"id":"ph0123456789","name":"Pixel 8","createdAt":"2026-10-26T10:00:00.000Z","lastUsedAt":null,"deviceId":null},
                {"id":"ph9876543210","name":"Tablet","createdAt":"2026-10-26T11:00:00.000Z","lastUsedAt":"2026-10-26T12:00:00.000Z","deviceId":"tv-1"}]}""",
            ),
        )
        server.enqueue(MockResponse.Builder().code(204).build())
        val api = ApiClient(server.url("/"), "izph_secret", http)
        val phones = api.phones().phones
        assertEquals(listOf("ph0123456789", "ph9876543210"), phones.map { it.id })
        assertNull(phones[0].lastUsedAt)
        assertEquals("tv-1", phones[1].deviceId)
        val list = server.takeRequest()
        assertEquals("GET", list.method)
        assertEquals("/api/v1/admin/phones", list.url.encodedPath)
        assertEquals("Bearer izph_secret", list.headers["Authorization"])

        api.deletePhone("ph/0")
        val delete = server.takeRequest()
        assertEquals("DELETE", delete.method)
        assertEquals("/api/v1/admin/phones/ph%2F0", delete.url.encodedPath)
        assertEquals("Bearer izph_secret", delete.headers["Authorization"])
    }

    private companion object {
        const val CLAIM = """{"phone":{"id":"ph0123456789","name":"Pixel 8","createdAt":"2026-10-26T10:00:00.000Z","lastUsedAt":null,
            "deviceId":"tv-1"},"secret":"izph_secret","deviceId":"tv-1"}"""
    }
}
