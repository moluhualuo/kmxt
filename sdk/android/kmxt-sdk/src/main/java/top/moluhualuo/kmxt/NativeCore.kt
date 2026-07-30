package top.moluhualuo.kmxt

// Author: 花落. Distributed under the MIT License.
internal object NativeCore {
    init { System.loadLibrary("kmxt_jni") }

    external fun sha256(value: String): String
    external fun beginActivationRequest(): String
    external fun beginVerificationRequest(): String
    external fun beginUnbindRequest(): String
    external fun beginModelLeaseRequest(): String
    external fun cancelModelLeaseRequest()
    external fun validateActivationEnvelope(envelope: String): String
    external fun validateVerificationEnvelope(envelope: String): String
    external fun validateUnbindEnvelope(envelope: String): String
    external fun validateModelLeaseEnvelope(envelope: String, artifactId: String): String

    // 花落 / MIT：通道 B 公告信封校验。minSequence 为持久化的防回滚水位，由调用方读出后传入。
    external fun validateNoticeEnvelope(envelope: String, minSequence: Long): String
    external fun decryptModelLease(handle: Long, ciphertext: ByteArray): ByteArray?
    external fun releaseModelLease(handle: Long)
    external fun clearAuthorization()
    external fun stableEnvironment(): String
}
