package top.moluhualuo.kmxt

data class KmxtConfig(
    val baseUrl: String,
    val appId: String,
    val protocolVersion: Int = 1,
) {
    init {
        require(baseUrl.startsWith("https://")) { "KMXT requires an HTTPS baseUrl" }
        require(appId.length == 36) { "appId must be a UUID" }
        require(protocolVersion == 1) { "Unsupported KMXT protocol version" }
    }
}

enum class LicenseErrorCode {
    NETWORK_ERROR, TLS_ERROR, INVALID_RESPONSE, INVALID_SIGNATURE, WRONG_APPLICATION,
    WRONG_KEY, LICENSE_EXPIRED, SESSION_EXPIRED, DEVICE_MISMATCH, NOT_ACTIVATED,
    SERVER_REJECTED, ARTIFACT_UNAVAILABLE, LEASE_EXPIRED, INVALID_CLIENT_KEY,
    // WS4 防重打包 / APK 签名绑定：服务端拒绝的三类客户端完整性错误。
    SIGNATURE_MISMATCH, CLIENT_UPDATE_REQUIRED, INTEGRITY_REJECTED,
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

// Author: 花落. Signed device self-unbind results are distributed under the MIT License.
data class DeviceUnbindStatus(
    val unbound: Boolean,
    val code: String,
    val appId: String,
    val bindingId: String,
    val sessionsRevoked: Long,
)

/** Short-lived model metadata backed by a one-use native DEK handle. Author: 花落, MIT License. */
class ModelLease internal constructor(
    val artifactId: String,
    val name: String,
    val version: String,
    val format: String,
    val cipherSha256: String,
    val size: Long,
    val encryptionAlgorithm: String,
    val encryptionNonce: String?,
    val encryptionTag: String?,
    val keyVersion: Long,
    val leaseId: String,
    val bindingId: String,
    val issuedAt: String,
    val expiresAt: String,
    private var nativeHandle: Long,
) {
    /** The DEK stays in C++; only authenticated plaintext crosses JNI. */
    @Synchronized
    fun decrypt(ciphertext: ByteArray): ByteArray {
        val handle = nativeHandle
        if (handle <= 0L) {
            throw LicenseException(LicenseErrorCode.INVALID_CLIENT_KEY, "Model lease handle is unavailable")
        }
        nativeHandle = 0L
        return NativeCore.decryptModelLease(handle, ciphertext)
            ?: throw LicenseException(LicenseErrorCode.INVALID_CLIENT_KEY, "Native model decryption failed")
    }

    /** Erases an unused DEK in native memory. Safe to call after decrypt(). */
    @Synchronized
    fun wipe() {
        val handle = nativeHandle
        nativeHandle = 0L
        if (handle > 0L) NativeCore.releaseModelLease(handle)
    }
}
