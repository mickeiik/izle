package io.github.mickeiik.izle.companion.activity

import android.os.Looper
import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.json
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * The real [ActivityViewModel] against an in-process server: the log read from the start page by page, the newest 300
 * kept, then followed by long-poll; a gap reads it all again; a filter reads anew with its types; a continue point's
 * episode looked up in the catalog.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class ActivityViewModelTest {
    private val server = MockWebServer()
    private val requests = CopyOnWriteArrayList<RecordedRequest>()
    private val scope = MainScope()
    private val longPolls = AtomicInteger()

    @Before
    fun setUp() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                val url = request.url
                if (url.encodedPath == "/api/v1/admin/catalog/items/cam") return json(200, ITEM)
                if (url.encodedPath != "/api/v1/admin/events") return json(404, """{"error":"not_found"}""")
                val after = url.queryParameter("after")?.toLong()
                return when {
                    url.queryParameter("wait") != "25" -> when (after) {
                        0L -> page(1L..500L, gap = true) // the oldest events were pruned: no matter, this is the start
                        500L -> page(501L..600L)
                        else -> page(LongRange.EMPTY, last = after ?: 0)
                    }
                    longPolls.incrementAndGet() == 1 -> page(601L..601L, cursor = true)
                    longPolls.get() == 2 -> json(200, """{"events":[],"last":601,"gap":true}""")
                    else -> page(LongRange.EMPTY, last = 601).newBuilder().headersDelay(1, TimeUnit.SECONDS).build()
                }
            }
        }
        server.start()
    }

    @After
    fun tearDown() {
        scope.cancel()
        server.close()
    }

    @Test
    fun readsPageByPageKeepsTheNewestAndFollows() {
        val vm = ActivityViewModel(ApiClient(server.url("/"), "izph_test", OkHttpClient()), "tv-1")
        val follow = scope.launch { vm.follow() }
        waitUntil("the read and the first long-poll") { vm.state.value.events.firstOrNull()?.id == 601L }
        val s = vm.state.value
        assertEquals(300, s.events.size)
        assertEquals(listOf(601L, 600L, 599L), s.events.take(3).map { it.id })
        assertEquals(302L, s.events.last().id)

        val all = requests.filter { it.url.encodedPath == "/api/v1/admin/events" }
        // First where the log stands (no `after`), so a filter matching nothing does not follow from 0.
        assertEquals(null, all.first().url.queryParameter("after"))
        val reads = all.filter { it.url.queryParameter("after") != null }
        assertEquals(listOf("0", "500"), reads.take(2).map { it.url.queryParameter("after") })
        assertEquals("500", reads.first().url.queryParameter("limit"))
        assertEquals("tv-1", reads.first().url.queryParameter("devices"))
        assertEquals(ACTIVITY_TYPES.joinToString(","), reads.first().url.queryParameter("types"))
        assertEquals("600", reads[2].url.queryParameter("after"))

        // The continue point names its episode by id: the show is read from the catalog once.
        waitUntil("the lookup") { "cam.e3" in vm.state.value.context.episodes }
        assertEquals(1, requests.count { it.url.encodedPath == "/api/v1/admin/catalog/items/cam" })

        // The second long-poll says gap: the log is read again from the start.
        waitUntil("the re-read") { requests.count { it.url.queryParameter("after") == "0" } == 2 }
        follow.cancel()

        vm.select(ActivityFilter.Remote)
        assertEquals(emptyList<Any>(), vm.state.value.events)
        val again = scope.launch { vm.follow() }
        waitUntil("the filtered read") { requests.any { it.url.queryParameter("types") == "command.sent,command.result" } }
        again.cancel()
    }

    @Test
    fun aFilterMatchingNothingFollowsFromTheLogsHeadNotFromTheStart() {
        // The oldest events were purged and none of the kept ones matches: reading from 0 finds nothing, and following
        // from 0 would be answered with a gap at once, again and again.
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                val url = request.url
                if (url.encodedPath != "/api/v1/admin/events") return json(404, """{"error":"not_found"}""")
                val after = url.queryParameter("after")?.toLong()
                return when {
                    after == null -> json(200, """{"events":[],"last":900,"gap":false}""")
                    url.queryParameter("wait") != "25" -> json(200, """{"events":[],"last":$after,"gap":${after < 799}}""")
                    after < 799 -> json(200, """{"events":[],"last":$after,"gap":true}""")
                    else -> page(LongRange.EMPTY, last = after).newBuilder().headersDelay(1, TimeUnit.SECONDS).build()
                }
            }
        }
        val vm = ActivityViewModel(ApiClient(server.url("/"), "izph_test", OkHttpClient()), "tv-1")
        vm.select(ActivityFilter.Remote)
        val follow = scope.launch { vm.follow() }
        waitUntil("the long-poll from the head") {
            requests.any { it.url.queryParameter("wait") == "25" && it.url.queryParameter("after") == "900" }
        }
        mainLooper.idle()
        Thread.sleep(200)
        mainLooper.idle()
        follow.cancel()
        assertEquals(1, requests.count { it.url.queryParameter("after") == "0" })
        assertEquals(0, requests.count { it.url.queryParameter("wait") == "25" && it.url.queryParameter("after") != "900" })
        assertEquals(true, vm.state.value.loaded)
        assertEquals(emptyList<Any>(), vm.state.value.events)
    }

    private fun page(ids: LongRange, gap: Boolean = false, last: Long = ids.last, cursor: Boolean = false): MockResponse {
        val events = ids.joinToString(",") { id ->
            if (cursor) """{"id":$id,"at":"2026-10-27T14:05:00.000Z","type":"cursor.changed","deviceId":"tv-1","actor":{"type":"owner"},"data":{"itemId":"cam","episodeId":"cam.e3"}}"""
            else """{"id":$id,"at":"2026-10-27T14:05:00.000Z","type":"device.online","deviceId":"tv-1","actor":{"type":"tv"},"data":{}}"""
        }
        return json(200, """{"events":[$events],"last":$last,"gap":$gap}""")
    }

    private val mainLooper get() = shadowOf(Looper.getMainLooper())

    private fun waitUntil(what: String, condition: () -> Boolean) {
        repeat(500) {
            mainLooper.idle()
            if (condition()) return
            Thread.sleep(10)
        }
        fail("Timed out waiting for $what; requests: ${requests.map { "${it.method} ${it.url}" }}")
    }

    private companion object {
        const val ITEM = """{"item":{"id":"cam","kind":"series","title":"Caminandes","episodes":[
            {"id":"cam.e3","season":1,"number":3,"title":"Llamigos","playbackAllowed":true}]}}"""
    }
}
