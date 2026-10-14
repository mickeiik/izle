package io.github.mickeiik.izle.ui.common

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import io.github.mickeiik.izle.ui.theme.IzleColors

/**
 * The owner's message across the top of the screen (Home, or over the video while it keeps playing): 30 sp bold,
 * up to three lines, dark on the warm accent so it stands out on any picture. Not focusable, no buttons: it goes
 * away by itself.
 */
@Composable
fun MessageBanner(text: String, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().padding(horizontal = 48.dp, vertical = 24.dp), contentAlignment = Alignment.TopCenter) {
        Text(
            text,
            style = MaterialTheme.typography.headlineSmall,
            color = IzleColors.OnAccent,
            textAlign = TextAlign.Center,
            maxLines = 3,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.widthIn(max = 864.dp)
                .border(2.dp, Color(0x66000000), RoundedCornerShape(16.dp))
                .background(IzleColors.Accent, RoundedCornerShape(16.dp))
                .padding(horizontal = 32.dp, vertical = 16.dp),
        )
    }
}
