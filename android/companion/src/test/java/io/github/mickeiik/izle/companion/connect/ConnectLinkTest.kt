package io.github.mickeiik.izle.companion.connect

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

/** The connect link the server's `/connect` page opens: `izle-companion://connect?server=…&invite=…`. */
class ConnectLinkTest {
    @Test
    fun aValidLink() {
        assertEquals(
            ConnectLink("http://192.168.1.10:8787/izle", "Ab-_09xyz"),
            ConnectLink.parse("izle-companion://connect?server=http%3A%2F%2F192.168.1.10%3A8787%2Fizle&invite=Ab-_09xyz"),
        )
        assertEquals(
            "the order and other parameters do not matter",
            ConnectLink("https://tv.example", "inv"),
            ConnectLink.parse("IZLE-COMPANION://Connect?x=1&invite=inv&server=https%3A%2F%2Ftv.example"),
        )
    }

    @Test
    fun missingOrEmptyParameters() {
        assertNull(ConnectLink.parse("izle-companion://connect?server=http%3A%2F%2Ftv"))
        assertNull(ConnectLink.parse("izle-companion://connect?invite=abc"))
        assertNull(ConnectLink.parse("izle-companion://connect?server=&invite=abc"))
        assertNull(ConnectLink.parse("izle-companion://connect?server=http%3A%2F%2Ftv&invite="))
        assertNull(ConnectLink.parse("izle-companion://connect"))
        assertNull(ConnectLink.parse("izle-companion://connect?server=http%3A%2F%2Ftv&invite=%zz"))
    }

    @Test
    fun anotherHostOrSchemeOrNoLink() {
        assertNull(ConnectLink.parse("izle-companion://pair?server=http%3A%2F%2Ftv&invite=abc"))
        assertNull(ConnectLink.parse("https://connect?server=http%3A%2F%2Ftv&invite=abc"))
        assertNull(ConnectLink.parse("http://tv.local:8787/connect#abc"))
        assertNull(ConnectLink.parse("not a link"))
        assertNull(ConnectLink.parse(""))
        assertNull(ConnectLink.parse(null))
    }

    @Test
    fun theInviteIsNeverPrinted() {
        val link = ConnectLink.parse("izle-companion://connect?server=http%3A%2F%2Ftv&invite=secret-invite")!!
        assertFalse(link.toString().contains("secret-invite"))
    }
}
