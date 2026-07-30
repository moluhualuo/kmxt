#include "kmxt/core.hpp"
#include "kmxt/native_runtime.hpp"

#include <nlohmann/json.hpp>
#include <openssl/rand.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <fstream>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace {
using json = nlohmann::json;
using Clock = std::chrono::steady_clock;

constexpr auto kPendingTtl = std::chrono::minutes(5);
constexpr auto kMaxLeaseHandleTtl = std::chrono::minutes(15);
constexpr std::size_t kMaxLeaseHandles = 16;

struct TrustAnchor {
    const char* package_name;
    const char* app_id;
    const char* key_id;
    const char* public_key;
};

// Public trust roots are intentionally compiled into this app-specific AAR.
// Author: 花落. ScreenYolo trust binding is distributed under the MIT License.
constexpr std::array<TrustAnchor, 2> kTrustAnchors = {{
    {
        "com.example.screenyolo.free",
        "1feda666-3115-42d4-a34f-7f5e65083530",
        "7699e04d20295a6d",
        "-----BEGIN PUBLIC KEY-----\n"
        "MCowBQYDK2VwAyEAQ26CDZnecN0+0xtV4ejO7UPnxdKqeXyQrRSnJG7tmRg=\n"
        "-----END PUBLIC KEY-----\n",
    },
    {
        "com.example.screenyolo.paid",
        "0ea4807a-39ce-4a5c-85ea-506f72dc8541",
        "076f00b00287aea1",
        "-----BEGIN PUBLIC KEY-----\n"
        "MCowBQYDK2VwAyEAkk1PMbfCtLvyTay5N4KaOc5UumdCvqWM/7V/Mr7Y2M8=\n"
        "-----END PUBLIC KEY-----\n",
    },
}};

struct PendingRequest {
    std::string nonce;
    Clock::time_point created{};
    std::uint64_t authorization_epoch = 0;
};

struct PendingModelRequest {
    std::string nonce;
    std::string client_public_key;
    std::vector<unsigned char> private_key;
    Clock::time_point created{};
    std::uint64_t authorization_epoch = 0;
    std::uint64_t request_generation = 0;
};

struct LeaseSecret {
    std::vector<unsigned char> content_key;
    std::string cipher_sha256;
    std::string encryption_nonce;
    std::string encryption_tag;
    std::size_t ciphertext_size = 0;
    Clock::time_point expires{};
    std::uint64_t authorization_epoch = 0;
};

std::mutex state_mutex;
std::array<PendingRequest, 3> pending_requests;
PendingModelRequest pending_model;
std::string active_binding_id;
Clock::time_point authorization_deadline{};
std::unordered_map<std::uint64_t, LeaseSecret> lease_secrets;
std::uint64_t authorization_epoch = 1;
std::uint64_t model_request_generation = 1;

std::string failed(const char* code) {
    return json{{"valid", false}, {"code", code}}.dump();
}

std::int64_t current_time_millis() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
}

std::string process_name() {
    std::ifstream stream("/proc/self/cmdline", std::ios::binary);
    std::string value;
    std::getline(stream, value, '\0');
    const auto service = value.find(':');
    if (service != std::string::npos) value.resize(service);
    return value;
}

const TrustAnchor* current_trust_anchor() {
    const std::string package = process_name();
    for (const auto& anchor : kTrustAnchors) {
        if (package == anchor.package_name) return &anchor;
    }
    return nullptr;
}

std::size_t request_index(kmxt::android::RequestKind kind) {
    return static_cast<std::size_t>(kind);
}

std::string random_nonce() {
    std::vector<unsigned char> bytes(18);
    if (RAND_bytes(bytes.data(), static_cast<int>(bytes.size())) != 1) return {};
    const std::string result = kmxt::encode_base64url(bytes);
    kmxt::secure_clear(bytes);
    return result;
}

std::optional<PendingRequest> consume_request(kmxt::android::RequestKind kind) {
    std::scoped_lock lock(state_mutex);
    PendingRequest& pending = pending_requests[request_index(kind)];
    PendingRequest result = std::move(pending);
    pending = {};
    if (result.nonce.empty() || Clock::now() - result.created > kPendingTtl) return std::nullopt;
    return result;
}

void clear_pending_model(PendingModelRequest& request) {
    kmxt::secure_clear(request.private_key);
    request.nonce.clear();
    request.client_public_key.clear();
    request.created = {};
    request.authorization_epoch = 0;
    request.request_generation = 0;
}

std::optional<PendingModelRequest> consume_model_request() {
    std::scoped_lock lock(state_mutex);
    PendingModelRequest result = std::move(pending_model);
    pending_model = {};
    if (result.nonce.empty() || result.client_public_key.empty()
        || result.private_key.size() != 32 || Clock::now() - result.created > kPendingTtl) {
        clear_pending_model(result);
        return std::nullopt;
    }
    return result;
}

void advance_counter(std::uint64_t& value) {
    ++value;
    if (value == 0) value = 1;
}

void clear_lease_secrets_locked() {
    for (auto& entry : lease_secrets) kmxt::secure_clear(entry.second.content_key);
    lease_secrets.clear();
}

void clear_authorization_locked() {
    active_binding_id.clear();
    authorization_deadline = {};
    for (auto& pending : pending_requests) pending = {};
    clear_pending_model(pending_model);
    clear_lease_secrets_locked();
    advance_counter(authorization_epoch);
    advance_counter(model_request_generation);
}

void clear_authorization() {
    std::scoped_lock lock(state_mutex);
    clear_authorization_locked();
}

bool authorization_valid_locked() {
    return !active_binding_id.empty() && Clock::now() < authorization_deadline;
}

bool accept_authorization(const json& payload, bool replace_binding,
                          std::uint64_t expected_epoch) {
    const std::string binding = payload.value("bindingId", "");
    const auto heartbeat = payload.value("heartbeatAfterSeconds", 0LL);
    if (binding.empty() || heartbeat < 30 || heartbeat > 86400) return false;
    std::scoped_lock lock(state_mutex);
    if (authorization_epoch != expected_epoch) return false;
    if (replace_binding) clear_authorization_locked();
    if (!replace_binding && !active_binding_id.empty() && active_binding_id != binding) {
        clear_authorization_locked();
        return false;
    }
    active_binding_id = binding;
    const auto seconds = std::min<std::int64_t>(heartbeat + 30, 900);
    authorization_deadline = Clock::now() + std::chrono::seconds(seconds);
    return true;
}

struct AuthorizationSnapshot {
    std::string binding_id;
    std::uint64_t epoch = 0;
};

std::optional<AuthorizationSnapshot> authorized_snapshot() {
    std::scoped_lock lock(state_mutex);
    if (!authorization_valid_locked()) {
        if (!active_binding_id.empty() || !lease_secrets.empty()
            || !pending_model.private_key.empty()) {
            clear_authorization_locked();
        }
        return std::nullopt;
    }
    return AuthorizationSnapshot{active_binding_id, authorization_epoch};
}

std::string validate_authorization_common(const std::string& envelope_json,
                                          kmxt::android::RequestKind kind,
                                          bool require_session_token,
                                          bool replace_binding) {
    const TrustAnchor* trust = current_trust_anchor();
    const auto request_nonce = consume_request(kind);
    if (!trust || !request_nonce) {
        clear_authorization();
        return failed("INVALID_RESPONSE");
    }
    const std::string raw = kmxt::validate_authorization_envelope(
        envelope_json, trust->app_id, trust->key_id, trust->public_key,
        request_nonce->nonce, current_time_millis(), require_session_token);
    try {
        const json result = json::parse(raw);
        if (!result.value("valid", false)) {
            clear_authorization();
            return raw;
        }
        const json& payload = result.at("payload");
        if (!accept_authorization(payload, replace_binding,
                                  request_nonce->authorization_epoch)) {
            return failed("DEVICE_MISMATCH");
        }
        return raw;
    } catch (...) {
        clear_authorization();
        return failed("INVALID_RESPONSE");
    }
}

std::uint64_t random_handle() {
    for (int attempt = 0; attempt < 8; ++attempt) {
        std::uint64_t value = 0;
        if (RAND_bytes(reinterpret_cast<unsigned char*>(&value), sizeof(value)) != 1) return 0;
        value &= 0x7fffffffffffffffULL;
        if (value != 0 && lease_secrets.find(value) == lease_secrets.end()) return value;
    }
    return 0;
}

void clean_expired_leases_locked() {
    const auto now = Clock::now();
    for (auto iterator = lease_secrets.begin(); iterator != lease_secrets.end();) {
        if (now >= iterator->second.expires) {
            kmxt::secure_clear(iterator->second.content_key);
            iterator = lease_secrets.erase(iterator);
        } else {
            ++iterator;
        }
    }
}

std::uint64_t store_lease_locked(LeaseSecret secret) {
    clean_expired_leases_locked();
    if (lease_secrets.size() >= kMaxLeaseHandles || Clock::now() >= secret.expires) {
        kmxt::secure_clear(secret.content_key);
        return 0;
    }
    const std::uint64_t handle = random_handle();
    if (handle == 0) {
        kmxt::secure_clear(secret.content_key);
        return 0;
    }
    lease_secrets.emplace(handle, std::move(secret));
    return handle;
}
}  // namespace

namespace kmxt::android {

std::string begin_request(RequestKind kind) {
    if (!current_trust_anchor()) return {};
    const std::string nonce = random_nonce();
    if (nonce.empty()) return {};
    std::scoped_lock lock(state_mutex);
    pending_requests[request_index(kind)] = {nonce, Clock::now(), authorization_epoch};
    return nonce;
}

std::string begin_model_request() {
    if (!current_trust_anchor()) return {};
    X25519Ephemeral ephemeral;
    const std::string nonce = random_nonce();
    if (nonce.empty() || !generate_x25519_ephemeral(ephemeral)) return {};
    std::scoped_lock lock(state_mutex);
    if (!authorization_valid_locked()) {
        secure_clear(ephemeral.private_key);
        clear_authorization_locked();
        return {};
    }
    clear_pending_model(pending_model);
    advance_counter(model_request_generation);
    pending_model.nonce = nonce;
    pending_model.client_public_key = ephemeral.public_key_base64url;
    pending_model.private_key = std::move(ephemeral.private_key);
    pending_model.created = Clock::now();
    pending_model.authorization_epoch = authorization_epoch;
    pending_model.request_generation = model_request_generation;
    return json{{"nonce", nonce}, {"clientPublicKey", pending_model.client_public_key}}.dump();
}

void cancel_model_request() {
    std::scoped_lock lock(state_mutex);
    clear_pending_model(pending_model);
    advance_counter(model_request_generation);
}

std::string validate_activation(const std::string& envelope_json) {
    return validate_authorization_common(envelope_json, RequestKind::activation, true, true);
}

std::string validate_verification(const std::string& envelope_json) {
    return validate_authorization_common(envelope_json, RequestKind::verification, false, false);
}

std::string validate_unbind(const std::string& envelope_json) {
    const TrustAnchor* trust = current_trust_anchor();
    const auto request_nonce = consume_request(RequestKind::unbind);
    if (!trust || !request_nonce) return failed("INVALID_RESPONSE");
    const std::string raw = kmxt::validate_unbind_envelope(
        envelope_json, trust->app_id, trust->key_id, trust->public_key,
        request_nonce->nonce, current_time_millis());
    try {
        const json result = json::parse(raw);
        if (!result.value("valid", false)) return raw;
        const std::string binding = result.at("payload").value("bindingId", "");
        std::scoped_lock lock(state_mutex);
        if (authorization_epoch != request_nonce->authorization_epoch) {
            return failed("DEVICE_MISMATCH");
        }
        if (!active_binding_id.empty()
            && (!authorization_valid_locked() || active_binding_id != binding)) {
            clear_authorization_locked();
            return failed("DEVICE_MISMATCH");
        }
        clear_authorization_locked();
        return raw;
    } catch (...) {
        return failed("INVALID_RESPONSE");
    }
}

std::string validate_model_lease(const std::string& envelope_json,
                                 const std::string& expected_artifact_id) {
    const TrustAnchor* trust = current_trust_anchor();
    auto request = consume_model_request();
    if (!request) return failed("INVALID_RESPONSE");
    const auto authorization = authorized_snapshot();
    if (!trust || !authorization
        || request->authorization_epoch != authorization->epoch) {
        clear_pending_model(*request);
        return failed("INVALID_RESPONSE");
    }
    const std::int64_t wall_now = current_time_millis();
    const Clock::time_point steady_now = Clock::now();
    const std::string raw = kmxt::validate_model_lease_envelope(
        envelope_json, trust->app_id, trust->key_id, trust->public_key,
        expected_artifact_id, request->nonce, request->client_public_key,
        wall_now);
    const std::uint64_t request_epoch = request->authorization_epoch;
    const std::uint64_t request_generation = request->request_generation;
    LeaseSecret secret;
    std::uint64_t handle = 0;
    try {
        json result = json::parse(raw);
        if (!result.value("valid", false)) {
            clear_pending_model(*request);
            return raw;
        }
        json& payload = result.at("payload");
        if (payload.value("bindingId", "") != authorization->binding_id
            || payload.contains("_nativeLeaseHandle")) {
            clear_pending_model(*request);
            return failed("DEVICE_MISMATCH");
        }
        std::int64_t signed_expiry_millis = 0;
        if (!kmxt::parse_iso8601_millis(payload.at("expiresAt").get<std::string>(),
                                        signed_expiry_millis)
            || signed_expiry_millis <= wall_now) {
            clear_pending_model(*request);
            return failed("LEASE_EXPIRED");
        }
        const auto signed_remaining = std::chrono::milliseconds(signed_expiry_millis - wall_now);
        const Clock::time_point signed_deadline = steady_now + signed_remaining;
        const Clock::time_point local_deadline = steady_now + kMaxLeaseHandleTtl;
        const json& wrapped = payload.at("wrappedDek");
        const bool unwrapped = unwrap_model_key(
            request->private_key,
            payload.at("serverEphemeralPublicKey").get<std::string>(),
            wrapped.at("iv").get<std::string>(),
            wrapped.at("tag").get<std::string>(),
            wrapped.at("ciphertext").get<std::string>(),
            wrapped.at("associatedData").get<std::string>(),
            secret.content_key);
        clear_pending_model(*request);
        if (!unwrapped) {
            secure_clear(secret.content_key);
            return failed("INVALID_CLIENT_KEY");
        }
        const json& encryption = payload.at("encryption");
        secret.cipher_sha256 = payload.at("cipherSha256").get<std::string>();
        secret.encryption_nonce = encryption.at("nonce").get<std::string>();
        secret.encryption_tag = encryption.at("tag").get<std::string>();
        secret.ciphertext_size = payload.at("size").get<std::size_t>();
        secret.expires = std::min(signed_deadline, local_deadline);
        secret.authorization_epoch = request_epoch;
        {
            std::scoped_lock lock(state_mutex);
            if (!authorization_valid_locked()
                || authorization_epoch != request_epoch
                || model_request_generation != request_generation
                || active_binding_id != authorization->binding_id
                || Clock::now() >= secret.expires) {
                secure_clear(secret.content_key);
                return failed("LEASE_EXPIRED");
            }
            handle = store_lease_locked(std::move(secret));
        }
        if (handle == 0) {
            secure_clear(secret.content_key);
            return failed("INVALID_CLIENT_KEY");
        }
        payload["_nativeLeaseHandle"] = handle;
        return result.dump();
    } catch (...) {
        if (handle != 0) release_model_lease(handle);
        secure_clear(secret.content_key);
        clear_pending_model(*request);
        return failed("INVALID_RESPONSE");
    }
}

/**
 * 通道 B 校验。刻意不碰任何授权状态：公告是纯展示数据，未激活用户也要能读到，
 * 因此这里既不要求 authorization_valid_locked()，失败时也绝不调用 clear_authorization()。
 *
 * 花落 / MIT：把公告校验失败与授权状态耦合会造出一个新的攻击面——攻击者只要向
 * 公告端点回放一个畸形响应，就能把已激活用户的授权状态清掉，等于用一个展示通道
 * 拿到了远程踢线能力。信任锚仍取自 kTrustAnchors（未改动），验签一步不放松。
 */
std::string validate_notice(const std::string& envelope_json,
                            std::int64_t min_accepted_sequence) {
    const TrustAnchor* trust = current_trust_anchor();
    if (!trust) return failed("INVALID_RESPONSE");
    return kmxt::validate_notice_envelope(
        envelope_json, trust->app_id, trust->key_id, trust->public_key,
        current_time_millis(), min_accepted_sequence);
}

void clear_authorization_state() {
    std::scoped_lock lock(state_mutex);
    clear_authorization_locked();
}

bool decrypt_model_lease(std::uint64_t handle,
                         const std::vector<unsigned char>& ciphertext,
                         std::vector<unsigned char>& plaintext) {
    LeaseSecret secret;
    {
        std::scoped_lock lock(state_mutex);
        clean_expired_leases_locked();
        if (!authorization_valid_locked()) {
            clear_authorization_locked();
            return false;
        }
        const auto iterator = lease_secrets.find(handle);
        if (iterator == lease_secrets.end()) return false;
        if (iterator->second.authorization_epoch != authorization_epoch) {
            secure_clear(iterator->second.content_key);
            lease_secrets.erase(iterator);
            return false;
        }
        secret = std::move(iterator->second);
        lease_secrets.erase(iterator);
    }
    const std::string ciphertext_text(
        reinterpret_cast<const char*>(ciphertext.data()), ciphertext.size());
    const bool metadata_valid = ciphertext.size() == secret.ciphertext_size
        && sha256_hex(ciphertext_text) == secret.cipher_sha256;
    // 花落/MIT: .vmp 布局 = [12B nonce][16B tag][ciphertext]。cipherSha256/size 校验整块 blob
    // （与服务端 encryptModel 一致），但 AES-GCM 的实际密文是去掉前 28 字节头的部分。
    // nonce/tag 用租约下发值（与 blob 头逐字节相同，冗余自描述）。此前把整块 blob 当密文
    // 喂给 GCM 会把 nonce+tag 也当密文 → 认证必失败（"Native model decryption failed"）。
    constexpr std::size_t kVmpHeaderBytes = 12 + 16;
    const bool payload_present = ciphertext.size() > kVmpHeaderBytes;
    std::vector<unsigned char> model_ciphertext;
    if (metadata_valid && payload_present) {
        model_ciphertext.assign(ciphertext.begin() + kVmpHeaderBytes, ciphertext.end());
    }
    const bool decrypted = metadata_valid && payload_present && decrypt_model_ciphertext(
        secret.content_key, secret.encryption_nonce, secret.encryption_tag,
        model_ciphertext, plaintext);
    secure_clear(model_ciphertext);
    secure_clear(secret.content_key);
    if (!decrypted) secure_clear(plaintext);
    return decrypted;
}

void release_model_lease(std::uint64_t handle) {
    std::scoped_lock lock(state_mutex);
    clean_expired_leases_locked();
    const auto iterator = lease_secrets.find(handle);
    if (iterator == lease_secrets.end()) return;
    secure_clear(iterator->second.content_key);
    lease_secrets.erase(iterator);
}

#if defined(KMXT_NATIVE_RUNTIME_TESTING)
namespace testing {

void authorize_for_test(const std::string& binding_id, std::int64_t ttl_millis) {
    std::scoped_lock lock(state_mutex);
    clear_authorization_locked();
    active_binding_id = binding_id;
    authorization_deadline = Clock::now() + std::chrono::milliseconds(ttl_millis);
}

std::uint64_t store_lease_for_test(std::int64_t ttl_millis,
                                   std::uint64_t expected_epoch) {
    std::scoped_lock lock(state_mutex);
    if (!authorization_valid_locked()
        || (expected_epoch != 0 && expected_epoch != authorization_epoch)) return 0;
    LeaseSecret secret;
    secret.content_key.assign(32, 0x42);
    secret.cipher_sha256.assign(64, '0');
    secret.ciphertext_size = 1;
    secret.expires = Clock::now() + std::chrono::milliseconds(ttl_millis);
    secret.authorization_epoch = authorization_epoch;
    return store_lease_locked(std::move(secret));
}

std::size_t lease_count_for_test() {
    std::scoped_lock lock(state_mutex);
    clean_expired_leases_locked();
    return lease_secrets.size();
}

std::uint64_t authorization_epoch_for_test() {
    std::scoped_lock lock(state_mutex);
    return authorization_epoch;
}

void seed_pending_model_for_test() {
    std::scoped_lock lock(state_mutex);
    clear_pending_model(pending_model);
    pending_model.nonce = "test-nonce";
    pending_model.client_public_key = "test-public-key";
    pending_model.private_key.assign(32, 0x24);
    pending_model.created = Clock::now();
    pending_model.authorization_epoch = authorization_epoch;
    pending_model.request_generation = model_request_generation;
}

bool pending_model_present_for_test() {
    std::scoped_lock lock(state_mutex);
    return !pending_model.private_key.empty();
}

}  // namespace testing
#endif

}  // namespace kmxt::android
