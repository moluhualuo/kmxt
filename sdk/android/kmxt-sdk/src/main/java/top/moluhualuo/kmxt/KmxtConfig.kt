package top.moluhualuo.kmxt

data class KmxtConfig(
    val baseUrl: String,
    val appId: String,
    val keyId: String,
    val publicKey: String,
    val protocolVersion: Int = 1,
) {
    init {
        require(baseUrl.startsWith("https://")) { "KMXT requires an HTTPS baseUrl" }
        require(appId.length == 36) { "appId must be a UUID" }
        require(keyId.isNotBlank() && publicKey.contains("BEGIN PUBLIC KEY"))
        require(protocolVersion == 1) { "Unsupported KMXT protocol version" }
    }
}

enum class LicenseErrorCode {
    NETWORK_ERROR, TLS_ERROR, INVALID_RESPONSE, INVALID_SIGNATURE, WRONG_APPLICATION,
    WRONG_KEY, LICENSE_EXPIRED, SESSION_EXPIRED, DEVICE_MISMATCH, NOT_ACTIVATED,
    SERVER_REJECTED,
}

class LicenseException(
    val code: LicenseErrorCode,
    message: String,
    val serverCode: String? = null,
    cause: Throwable? = null,
) : Exception(message, cause)

data class AuthorizationStatus(
    val licensed: Boolean,
    val code: String,
    val appId: String,
    val licenseExpiresAt: String,
    val sessionExpiresAt: String,
    val heartbeatAfterSeconds: Long,
)
