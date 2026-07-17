#include "kmxt/core.hpp"
#include <jni.h>
#include <string>

namespace {
std::string from_jstring(JNIEnv* env, jstring value) {
    if (!value) return {};
    const char* chars = env->GetStringUTFChars(value, nullptr);
    std::string result(chars);
    env->ReleaseStringUTFChars(value, chars);
    return result;
}
}

extern "C" JNIEXPORT jstring JNICALL
Java_top_moluhualuo_kmxt_NativeCore_sha256(JNIEnv* env, jobject, jstring value) {
    return env->NewStringUTF(kmxt::sha256_hex(from_jstring(env, value)).c_str());
}

extern "C" JNIEXPORT jboolean JNICALL
Java_top_moluhualuo_kmxt_NativeCore_verifyEnvelope(JNIEnv* env, jobject,
    jstring payload, jstring signature, jstring public_key) {
    try {
        const auto canonical = kmxt::canonical_json(from_jstring(env, payload));
        return kmxt::verify_ed25519(canonical, from_jstring(env, signature),
            from_jstring(env, public_key)) ? JNI_TRUE : JNI_FALSE;
    } catch (...) { return JNI_FALSE; }
}

extern "C" JNIEXPORT jstring JNICALL
Java_top_moluhualuo_kmxt_NativeCore_stableEnvironment(JNIEnv* env, jobject) {
    return env->NewStringUTF("abi=arm64-v8a\npointer_bits=64");
}
