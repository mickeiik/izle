package io.github.mickeiik.izle.data.api

import kotlinx.serialization.Serializable

/**
 * A phone connected from a TV (hidden menu → Settings → Connect a phone): its own owner-level secret. [deviceId]: the
 * TV it connected through, null once that TV is deleted; [lastUsedAt] null until first use.
 */
@Serializable
data class Phone(
    val id: String,
    val name: String,
    val createdAt: String? = null,
    val lastUsedAt: String? = null,
    val deviceId: String? = null,
)

/** `POST /api/v1/phones/claim`: exactly one of [invite] (the TV's QR code) and [code] (its 6 digits), and the phone's name. */
@Serializable
data class PhoneClaimRequest(val invite: String? = null, val code: String? = null, val name: String)

/** The claim's answer: [secret] (`izph_…`) is shown only here; [deviceId] is the TV that showed the invite. */
@Serializable
data class PhoneClaim(val phone: Phone, val secret: String, val deviceId: String? = null)

/** `GET /api/v1/admin/phones`, oldest first. */
@Serializable
data class PhonesResponse(val phones: List<Phone> = emptyList())
