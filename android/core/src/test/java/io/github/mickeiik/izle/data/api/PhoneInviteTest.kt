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

/** The TV's "Connect a phone" routes and their models, against an in-process MockWebServer (no network). */
class PhoneInviteTest {
    private val server = MockWebServer()

    @Before
    fun setUp() = server.start()

    @After
    fun tearDown() = server.close()

    private fun client() = ApiClient(server.url("/izle/"), "device-token", OkHttpClient())

    @Test
    fun theInviteIsPostedWithTheDeviceToken() = runBlocking {
        server.enqueue(json(200, """{"code":"483920","invite":"aW52aXRl_-","expiresAt":"2026-10-26T10:05:00.000Z","extra":1}"""))
        assertEquals(PhoneInvite("483920", "aW52aXRl_-", "2026-10-26T10:05:00.000Z"), client().phoneInvite())
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/izle/api/v1/tv/phones/invite", request.url.encodedPath)
        assertEquals("Bearer device-token", request.headers["Authorization"])
    }

    @Test
    fun theLongPollAnswersOpenClaimedExpiredOrNotFound() = runBlocking {
        server.enqueue(json(200, """{"status":"open","code":"483920","expiresAt":"2026-10-26T10:05:00.000Z"}"""))
        server.enqueue(json(200, """{"status":"claimed","phone":{"id":"abcdefabcdef","name":"Pixel 8"}}"""))
        server.enqueue(json(410, """{"error":"expired","status":"expired"}"""))
        server.enqueue(json(404, """{"error":"not_found"}"""))
        server.enqueue(json(400, """{"error":"invalid_request"}"""))
        val api = client()

        val open = api.phoneInviteWait()
        assertEquals(PhoneInviteStatus.OPEN, open.status)
        assertEquals("483920", open.code)
        assertNull(open.phone)
        val request = server.takeRequest()
        assertEquals("GET", request.method)
        assertEquals("/izle/api/v1/tv/phones/invite", request.url.encodedPath)
        assertEquals("25", request.url.queryParameter("wait"))
        assertEquals("Bearer device-token", request.headers["Authorization"])

        val claimed = api.phoneInviteWait(waitSec = 0)
        assertEquals(PhoneInviteStatus(PhoneInviteStatus.CLAIMED, phone = InvitedPhone("abcdefabcdef", "Pixel 8")), claimed)
        assertEquals("0", server.takeRequest().url.queryParameter("wait"))

        assertEquals(PhoneInviteStatus(PhoneInviteStatus.EXPIRED), api.phoneInviteWait())
        assertEquals(PhoneInviteStatus(PhoneInviteStatus.NOT_FOUND), api.phoneInviteWait())
        val bad = assertThrows(ApiException::class.java) { runBlocking { api.phoneInviteWait() } }
        assertEquals("invalid_request", bad.code)
    }

    @Test
    fun theInviteIsCancelledWithTheDeviceToken() = runBlocking {
        server.enqueue(MockResponse.Builder().code(204).build())
        client().cancelPhoneInvite()
        val request = server.takeRequest()
        assertEquals("DELETE", request.method)
        assertEquals("/izle/api/v1/tv/phones/invite", request.url.encodedPath)
        assertEquals("Bearer device-token", request.headers["Authorization"])
    }

    @Test
    fun aRefusedInviteSaysWhy() {
        server.enqueue(json(429, """{"error":"rate_limited"}""").newBuilder().addHeader("Retry-After", "120").build())
        val limited = assertThrows(ApiException::class.java) { runBlocking { client().phoneInvite() } }
        assertEquals("rate_limited", limited.code)
        assertEquals(120L, limited.retryAfterSec)
    }
}
