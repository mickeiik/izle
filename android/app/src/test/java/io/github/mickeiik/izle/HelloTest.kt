package io.github.mickeiik.izle

import org.junit.Assert.assertEquals
import org.junit.Test

class HelloTest {
    @Test
    fun decodesHelloIgnoringUnknownKeys() {
        assertEquals(Hello("izle", 0), HelloCodec.decode("""{"app":"izle","phase":0,"extra":true}"""))
    }
}
