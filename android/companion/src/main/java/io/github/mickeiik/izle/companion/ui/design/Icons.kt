package io.github.mickeiik.izle.companion.ui.design

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/** The icons `material-icons-core` lacks (Material's own paths), tinted like any icon. */
object IzleIcons {
    val SkipPrevious: ImageVector = icon("SkipPrevious", "M6,6h2v12H6zM9.5,12l8.5,6V6z")
    val SkipNext: ImageVector = icon("SkipNext", "M6,18l8.5,-6L6,6v12zM16,6v12h2V6h-2z")
    val Pause: ImageVector = icon("Pause", "M6,19h4V5H6v14zM14,5v14h4V5h-4z")
    val FastRewind: ImageVector = icon("FastRewind", "M11,18V6l-8.5,6 8.5,6zM11.5,12l8.5,6V6l-8.5,6z")
    val FastForward: ImageVector = icon("FastForward", "M4,18l8.5,-6L4,6v12zM13,6v12l8.5,-6L13,6z")
    val Stop: ImageVector = icon("Stop", "M6,6h12v12H6z")
    val Headphones: ImageVector = icon(
        "Headphones",
        "M12,3c-4.97,0 -9,4.03 -9,9v7c0,1.1 0.9,2 2,2h4v-8H5v-1c0,-3.87 3.13,-7 7,-7s7,3.13 7,7v1h-4v8h4c1.1,0 2,-0.9 2,-2v-7c0,-4.97 -4.03,-9 -9,-9z",
    )
    val Message: ImageVector = icon(
        "ChatBubbleOutline",
        "M20,2H4c-1.1,0 -2,0.9 -2,2v18l4,-4h14c1.1,0 2,-0.9 2,-2V4c0,-1.1 -0.9,-2 -2,-2zM20,16H5.17L4,17.17V4h16v12z",
    )
    val DragHandle: ImageVector = icon("DragHandle", "M20,9H4v2h16V9zM4,15h16v-2H4v2z")
    val ExpandMore: ImageVector = icon("ExpandMore", "M16.59,8.59L12,13.17 7.41,8.59 6,10l6,6 6,-6z")
    val ExpandLess: ImageVector = icon("ExpandLess", "M12,8l-6,6 1.41,1.41L12,10.83l4.59,4.58L18,14z")

    private fun icon(name: String, path: String): ImageVector =
        ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f)
            .addPath(addPathNodes(path), fill = SolidColor(Color.Black))
            .build()
}
