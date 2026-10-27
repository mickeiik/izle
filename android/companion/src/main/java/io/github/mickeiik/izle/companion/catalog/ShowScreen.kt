package io.github.mickeiik.izle.companion.catalog

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import io.github.mickeiik.izle.companion.ui.design.EmptyState
import io.github.mickeiik.izle.companion.ui.design.IzleTheme
import io.github.mickeiik.izle.data.api.ApiClient

/**
 * A show's page (docs/ux/companion-catalog.md "A show's page"), full screen over the tabs; the root draws its top bar
 * (back arrow, the show's title). Placeholder until the show page lands.
 */
@Composable
fun ShowScreen(api: ApiClient, tvId: String, tvName: String, itemId: String, onMessage: (String) -> Unit, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize()) {
        EmptyState(itemId, Modifier.padding(IzleTheme.spacing.lg))
    }
}
