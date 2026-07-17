package top.moluhualuo.kmxt

// Author: 花落. Distributed under the MIT License.
internal object NativeCore {
    init { System.loadLibrary("kmxt_jni") }
    external fun sha256(value: String): String
    external fun verifyEnvelope(payload: String, signature: String, publicKey: String): Boolean
    external fun stableEnvironment(): String
}
