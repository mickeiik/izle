package io.github.mickeiik.izle.ui.common

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.TextAutoSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.tv.material3.MaterialTheme
import io.github.mickeiik.izle.ui.theme.IzleBorders
import io.github.mickeiik.izle.ui.theme.IzleColors
import io.github.mickeiik.izle.ui.theme.IzleShapes
import io.github.mickeiik.izle.ui.theme.IzleSpacing

/** The widest the banner gets: the width inside the safe margins. */
private val BannerMaxWidth = 864.dp

/**
 * The owner's message: 30 sp bold, stepping down to 24 sp only when a long one would not fit otherwise, at most
 * three lines, dark on the warm accent so it stands out on any picture. Not focusable, no buttons: it goes away by
 * itself. On Home it sits in the top band ([HomeScreen]); elsewhere it is a [MessageBannerOverlay].
 */
@Composable
fun MessageBanner(
    text: String,
    modifier: Modifier = Modifier,
    textAlign: TextAlign = TextAlign.Start,
    /** Called when even 24 sp does not fit three lines and the end of the message is cut. */
    onCutShort: () -> Unit = {},
) {
    BasicText(
        text,
        style = MaterialTheme.typography.headlineSmall.copy(color = IzleColors.OnAccent, lineHeight = 1.25.em, textAlign = textAlign),
        maxLines = 3,
        overflow = TextOverflow.Ellipsis,
        autoSize = TextAutoSize.StepBased(minFontSize = 24.sp, maxFontSize = 30.sp, stepSize = 2.sp),
        onTextLayout = { if (it.hasVisualOverflow) onCutShort() },
        modifier = modifier
            .border(IzleBorders.OutlineWidth, IzleColors.BannerEdge, IzleShapes.Large)
            .background(IzleColors.Accent, IzleShapes.Large)
            .padding(horizontal = IzleSpacing.XLarge, vertical = IzleSpacing.Medium),
    )
}

/** The banner across the top of the screen, inside the safe margins: over the video, the hidden menu and overlays. */
@Composable
fun MessageBannerOverlay(text: String, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().padding(IzleSpacing.Safe), contentAlignment = Alignment.TopCenter) {
        MessageBanner(text, Modifier.widthIn(max = BannerMaxWidth), textAlign = TextAlign.Center)
    }
}
