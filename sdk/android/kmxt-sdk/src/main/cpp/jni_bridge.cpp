#include "kmxt/core.hpp"
#include "kmxt/native_runtime.hpp"

#include <jni.h>

#include <cstdint>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
std::string from_jstring(JNIEnv* env, jstring value) {
    if (value == nullptr) throw std::invalid_argument("null Java string");
    const char* chars = env->GetStringUTFChars(value, nullptr);
    if (chars == nullptr) throw std::runtime_error("Java string conversion failed");
    std::string result(chars);
    env->ReleaseStringUTFChars(value, chars);
    return result;
}

jstring as_jstring(JNIEnv* env, const std::string& value) {
    return env->NewStringUTF(value.c_str());
}

jstring invalid_response(JNIEnv* env) {
    return as_jstring(env, R"({"valid":false,"code":"INVALID_RESPONSE"})");
}

jstring native_sha256(JNIEnv* env, jobject, jstring value) {
    try {
        return as_jstring(env, kmxt::sha256_hex(from_jstring(env, value)));
    } catch (...) {
        return as_jstring(env, "");
    }
}

jstring native_begin_activation(JNIEnv* env, jobject) {
    return as_jstring(env, kmxt::android::begin_request(kmxt::android::RequestKind::activation));
}

jstring native_begin_verification(JNIEnv* env, jobject) {
    return as_jstring(env, kmxt::android::begin_request(kmxt::android::RequestKind::verification));
}

jstring native_begin_unbind(JNIEnv* env, jobject) {
    return as_jstring(env, kmxt::android::begin_request(kmxt::android::RequestKind::unbind));
}

jstring native_begin_model_lease(JNIEnv* env, jobject) {
    return as_jstring(env, kmxt::android::begin_model_request());
}

void native_cancel_model_lease(JNIEnv*, jobject) {
    kmxt::android::cancel_model_request();
}

jstring native_validate_activation(JNIEnv* env, jobject, jstring envelope) {
    try {
        return as_jstring(env, kmxt::android::validate_activation(from_jstring(env, envelope)));
    } catch (...) {
        return invalid_response(env);
    }
}

jstring native_validate_verification(JNIEnv* env, jobject, jstring envelope) {
    try {
        return as_jstring(env, kmxt::android::validate_verification(from_jstring(env, envelope)));
    } catch (...) {
        return invalid_response(env);
    }
}

jstring native_validate_unbind(JNIEnv* env, jobject, jstring envelope) {
    try {
        return as_jstring(env, kmxt::android::validate_unbind(from_jstring(env, envelope)));
    } catch (...) {
        return invalid_response(env);
    }
}

jstring native_validate_model_lease(JNIEnv* env, jobject,
                                    jstring envelope, jstring artifact_id) {
    try {
        return as_jstring(env, kmxt::android::validate_model_lease(
            from_jstring(env, envelope), from_jstring(env, artifact_id)));
    } catch (...) {
        return invalid_response(env);
    }
}

jbyteArray native_decrypt_model_lease(JNIEnv* env, jobject,
                                      jlong handle, jbyteArray ciphertext_array) {
    if (handle <= 0 || ciphertext_array == nullptr) return nullptr;
    const jsize length = env->GetArrayLength(ciphertext_array);
    if (length <= 0) return nullptr;
    std::vector<unsigned char> ciphertext(static_cast<std::size_t>(length));
    env->GetByteArrayRegion(ciphertext_array, 0, length,
        reinterpret_cast<jbyte*>(ciphertext.data()));
    if (env->ExceptionCheck()) {
        kmxt::secure_clear(ciphertext);
        return nullptr;
    }
    std::vector<unsigned char> plaintext;
    const bool decrypted = kmxt::android::decrypt_model_lease(
        static_cast<std::uint64_t>(handle), ciphertext, plaintext);
    kmxt::secure_clear(ciphertext);
    if (!decrypted || plaintext.empty()
        || plaintext.size() > static_cast<std::size_t>(std::numeric_limits<jsize>::max())) {
        kmxt::secure_clear(plaintext);
        return nullptr;
    }
    jbyteArray result = env->NewByteArray(static_cast<jsize>(plaintext.size()));
    if (result != nullptr) {
        env->SetByteArrayRegion(result, 0, static_cast<jsize>(plaintext.size()),
            reinterpret_cast<const jbyte*>(plaintext.data()));
    }
    kmxt::secure_clear(plaintext);
    return env->ExceptionCheck() ? nullptr : result;
}

void native_release_model_lease(JNIEnv*, jobject, jlong handle) {
    if (handle > 0) kmxt::android::release_model_lease(static_cast<std::uint64_t>(handle));
}

void native_clear_authorization(JNIEnv*, jobject) {
    kmxt::android::clear_authorization_state();
}

jstring native_stable_environment(JNIEnv* env, jobject) {
    return env->NewStringUTF("abi=arm64-v8a\npointer_bits=64");
}
}  // namespace

// Author: 花落, MIT License. Dynamic registration removes descriptive JNI exports.
extern "C" JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {
    JNIEnv* env = nullptr;
    if (vm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6) != JNI_OK) return JNI_ERR;
    jclass native_core = env->FindClass("top/moluhualuo/kmxt/NativeCore");
    if (native_core == nullptr) return JNI_ERR;
    const JNINativeMethod methods[] = {
        {"sha256", "(Ljava/lang/String;)Ljava/lang/String;", reinterpret_cast<void*>(native_sha256)},
        {"beginActivationRequest", "()Ljava/lang/String;", reinterpret_cast<void*>(native_begin_activation)},
        {"beginVerificationRequest", "()Ljava/lang/String;", reinterpret_cast<void*>(native_begin_verification)},
        {"beginUnbindRequest", "()Ljava/lang/String;", reinterpret_cast<void*>(native_begin_unbind)},
        {"beginModelLeaseRequest", "()Ljava/lang/String;", reinterpret_cast<void*>(native_begin_model_lease)},
        {"cancelModelLeaseRequest", "()V", reinterpret_cast<void*>(native_cancel_model_lease)},
        {"validateActivationEnvelope", "(Ljava/lang/String;)Ljava/lang/String;",
            reinterpret_cast<void*>(native_validate_activation)},
        {"validateVerificationEnvelope", "(Ljava/lang/String;)Ljava/lang/String;",
            reinterpret_cast<void*>(native_validate_verification)},
        {"validateUnbindEnvelope", "(Ljava/lang/String;)Ljava/lang/String;",
            reinterpret_cast<void*>(native_validate_unbind)},
        {"validateModelLeaseEnvelope", "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
            reinterpret_cast<void*>(native_validate_model_lease)},
        {"decryptModelLease", "(J[B)[B", reinterpret_cast<void*>(native_decrypt_model_lease)},
        {"releaseModelLease", "(J)V", reinterpret_cast<void*>(native_release_model_lease)},
        {"clearAuthorization", "()V", reinterpret_cast<void*>(native_clear_authorization)},
        {"stableEnvironment", "()Ljava/lang/String;", reinterpret_cast<void*>(native_stable_environment)},
    };
    if (env->RegisterNatives(native_core, methods,
            static_cast<jint>(sizeof(methods) / sizeof(methods[0]))) != JNI_OK) return JNI_ERR;
    return JNI_VERSION_1_6;
}
