package io.github.mickeiik.izle.ui.phone

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import io.github.mickeiik.izle.R
import io.github.mickeiik.izle.ui.PhoneConnectLoop
import io.github.mickeiik.izle.ui.PhoneConnectProblem
import io.github.mickeiik.izle.ui.PhoneConnectUi
import io.github.mickeiik.izle.ui.common.Spinner
import io.github.mickeiik.izle.ui.common.fullScreen
import io.github.mickeiik.izle.ui.theme.IzleColors
import io.github.mickeiik.izle.ui.theme.IzleSpacing
import io.nayuki.qrcodegen.QrCode
import kotlin.math.floor

/** 4 modules of white around the code, as the QR standard asks, so phones find it on a dark screen. */
private const val QUIET_ZONE = 4

/** A little under half the 540 dp canvas: a version 5 code gets about 10 px modules on a 1080p TV, readable from a sofa. */
private val QrSize = 248.dp

/** Hidden menu → Settings → Connect a phone (docs/ux/senior-tv.md, "Connect a phone"). Nothing to focus: Back goes Home. */
@Composable
fun ConnectPhoneScreen(ui: PhoneConnectUi) {
    val title = stringResource(R.string.settings_connect_phone)
    Box(Modifier.fullScreen()) {
        when (ui) {
            PhoneConnectUi.Starting -> Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(IzleSpacing.XLarge),
                modifier = Modifier.align(Alignment.Center),
            ) {
                Text(title, style = MaterialTheme.typography.displaySmall, color = IzleColors.OnSurface)
                Spinner()
            }
            is PhoneConnectUi.Showing -> Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(IzleSpacing.XXLarge),
                modifier = Modifier.align(Alignment.Center),
            ) {
                QrCodeImage(ui.link, Modifier.size(QrSize))
                Column(Modifier.width(520.dp)) {
                    Text(title, style = MaterialTheme.typography.displaySmall, color = IzleColors.OnSurface)
                    Spacer(Modifier.height(IzleSpacing.Medium))
                    Text(
                        PhoneConnectLoop.spaced(ui.code),
                        style = MaterialTheme.typography.displayLarge.copy(fontFamily = FontFamily.Monospace, letterSpacing = 8.sp),
                        color = IzleColors.Accent,
                        maxLines = 1,
                    )
                    Spacer(Modifier.height(IzleSpacing.Medium))
                    Text(stringResource(R.string.phone_instructions), style = MaterialTheme.typography.bodyLarge, color = IzleColors.OnSurface)
                    Spacer(Modifier.height(IzleSpacing.Medium))
                    Text(ui.server, style = MaterialTheme.typography.bodySmall, color = IzleColors.Dim, maxLines = 1)
                }
            }
            is PhoneConnectUi.Connected -> Message(
                if (ui.name.isBlank()) stringResource(R.string.phone_connected_unnamed) else stringResource(R.string.phone_connected, ui.name),
                IzleColors.OnSurface,
            )
            is PhoneConnectUi.Failed -> Message(
                stringResource(if (ui.problem == PhoneConnectProblem.Unreachable) R.string.setup_error_unreachable else R.string.phone_failed),
                IzleColors.Error,
            )
        }
        Text(
            stringResource(R.string.phone_back_hint),
            style = MaterialTheme.typography.bodySmall,
            color = IzleColors.Dim,
            modifier = Modifier.align(Alignment.BottomCenter),
        )
    }
}

/** One short line, large, in the middle of the screen. */
@Composable
private fun Message(text: String, color: Color) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text(text, style = MaterialTheme.typography.displaySmall, color = color, textAlign = TextAlign.Center, maxLines = 2)
    }
}

/**
 * [text] as a QR code (error correction M, raised when it fits the same size), black on white with its quiet zone.
 * Each module is a whole number of pixels so its edges stay sharp; the leftover pixels widen the white border.
 */
@Composable
fun QrCodeImage(text: String, modifier: Modifier = Modifier) {
    val qr = remember(text) { QrCode.encodeText(text, QrCode.Ecc.MEDIUM) }
    val description = stringResource(R.string.phone_qr_description)
    Canvas(modifier.semantics { contentDescription = description }) {
        drawRect(Color.White)
        val modules = qr.size + 2 * QUIET_ZONE
        val module = floor(size.minDimension / modules).coerceAtLeast(1f)
        val origin = Offset((size.width - module * qr.size) / 2, (size.height - module * qr.size) / 2)
        val cell = Size(module, module)
        for (y in 0 until qr.size) {
            for (x in 0 until qr.size) {
                if (qr.getModule(x, y)) drawRect(Color.Black, Offset(origin.x + x * module, origin.y + y * module), cell)
            }
        }
    }
}
