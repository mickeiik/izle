package io.github.mickeiik.izle.companion

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import io.github.mickeiik.izle.companion.ui.CompanionRoot
import io.github.mickeiik.izle.companion.ui.theme.CompanionTheme

/** The only activity: pairing, the TV picker and Listen along (see [CompanionRoot]). */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContent { CompanionTheme { CompanionRoot() } }
    }
}
