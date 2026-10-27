package io.github.mickeiik.izle.companion.activity

import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import io.github.mickeiik.izle.data.api.ApiClient

/** A TV's event log, newest first, live (docs/ux/companion-tv.md, "Activity"). Placeholder: the Activity slice replaces it. */
@Composable
fun ActivityScreen(api: ApiClient, tvId: String, tvName: String, modifier: Modifier = Modifier) {
    Box(modifier)
}
