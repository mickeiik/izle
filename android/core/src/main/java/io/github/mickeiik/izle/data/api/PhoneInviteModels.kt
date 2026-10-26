package io.github.mickeiik.izle.data.api

import kotlinx.serialization.Serializable

// "Connect a phone" from the TV (docs/spec/server-api-v1.md): the TV's invite and its long-poll answers.

/** `POST /tv/phones/invite`: [invite] goes in the QR code, [code] (6 digits) is typed in izle companion. */
@Serializable
data class PhoneInvite(val code: String, val invite: String, val expiresAt: String)

/** The phone that claimed an invite. */
@Serializable
data class InvitedPhone(val id: String, val name: String)

/**
 * `GET /tv/phones/invite?wait=`: [status] [OPEN] (with [code] and [expiresAt]) or [CLAIMED] (with [phone]); the
 * client maps 410 to [EXPIRED] and 404 (this TV has no invite) to [NOT_FOUND].
 */
@Serializable
data class PhoneInviteStatus(
    val status: String,
    val code: String? = null,
    val expiresAt: String? = null,
    val phone: InvitedPhone? = null,
) {
    companion object {
        const val OPEN = "open"
        const val CLAIMED = "claimed"
        const val EXPIRED = "expired"
        const val NOT_FOUND = "not_found"
    }
}
