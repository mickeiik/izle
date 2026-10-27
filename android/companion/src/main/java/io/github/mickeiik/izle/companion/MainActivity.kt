package io.github.mickeiik.izle.companion

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import io.github.mickeiik.izle.companion.connect.ConnectLink
import io.github.mickeiik.izle.companion.ui.CompanionRoot
import io.github.mickeiik.izle.companion.ui.CompanionViewModel
import io.github.mickeiik.izle.companion.ui.design.IzleTheme

/**
 * The only activity: connecting, the TV picker, the phones and a TV's page (see [CompanionRoot]). It also opens the
 * connect link ([ConnectLink]) that the server's `/connect` page hands over after the camera scanned a TV's QR code.
 */
class MainActivity : ComponentActivity() {
    private val vm: CompanionViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        // A recreated activity gets its intent again: the invite was claimed already (it is single use).
        if (savedInstanceState == null) openLink(intent)
        setContent { IzleTheme { CompanionRoot(vm) } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        openLink(intent)
    }

    private fun openLink(intent: Intent?) {
        if (intent?.action != Intent.ACTION_VIEW) return
        ConnectLink.parse(intent.dataString)?.let(vm::connectWithLink)
    }
}
