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
    // 花落 / MIT：公告通道拒绝历史信封重放（原生 sequence 防回滚）。
    NOTICE_ROLLBACK,
}

/** 公告严重级别。未知取值一律降级为 INFO，绝不因新增级别让旧客户端拒绝展示。*/
enum class AnnouncementSeverity { INFO, WARNING, CRITICAL;

    internal companion object {
        fun parse(value: String?): AnnouncementSeverity = when (value) {
            "critical" -> CRITICAL
            "warning" -> WARNING
            else -> INFO
        }
    }
}

/**
 * 一条已通过原生验签与形状校验的公告。title/body 保证是不含控制字符的纯文本
 * （body 允许 \n 分段），展示层必须按纯文本渲染，禁止交给 WebView 或任何 HTML 解析器。
 * Author: 花落, MIT License.
 */
data class Announcement(
    val id: String,
    val sequence: Long,
    val severity: AnnouncementSeverity,
    val title: String,
    val body: String,
    val publishedAt: String?,
)

/**
 * 服务端下发的版本策略。minVersionCode 是强制更新的唯一事实来源，
 * 真正的拒绝发生在服务端（426 CLIENT_UPDATE_REQUIRED）；这里的字段只用于引导展示。
 * Author: 花落, MIT License.
 */
data class ClientPolicy(
    val minVersionCode: Long?,
    val latestVersionCode: Long?,
    val latestVersionName: String?,
    val releaseNotes: String?,
) {
    /** 本机 versionCode 是否低于服务端要求。策略缺失时一律返回 false，不自行加严。*/
    fun updateRequired(currentVersionCode: Long): Boolean {
        val minimum = minVersionCode ?: return false
        return currentVersionCode < minimum
    }
}

/** 通道 B 的公开公告响应：无需卡密会话，仍经过程序 Ed25519 验签。*/
data class NoticeBundle(
    val sequence: Long,
    val issuedAt: String,
    val policy: ClientPolicy,
    val announcements: List<Announcement>,
)

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
    // 花落 / MIT：通道 A 搭载的展示数据。给默认值以保证既有调用方源码兼容；
    // 原生层在形状非法时会剥离这两个字段，因此这里出现 null / 空列表是正常状态。
    val policy: ClientPolicy? = null,
    val announcements: List<Announcement> = emptyList(),
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
