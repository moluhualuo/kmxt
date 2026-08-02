#include "kmxt/core.hpp"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdint>
#include <limits>
#include <string>

namespace {
using json = nlohmann::json;

constexpr std::int64_t kClockSkewMs = 5LL * 60LL * 1000LL;
constexpr std::int64_t kMaxModelLeaseMs = 15LL * 60LL * 1000LL;
constexpr std::int64_t kMaxModelBytes = 2LL * 1024LL * 1024LL * 1024LL;

// 花落 / MIT：公告与版本策略的形状上限。通道 B 没有请求 nonce，只能靠 issuedAt
// 新鲜度窗口收敛重放范围，所以这里的窗口比授权信封的时钟偏移更严格地单独定义。
constexpr std::int64_t kNoticeFreshnessMs = 10LL * 60LL * 1000LL;
constexpr std::size_t kMaxNoticeItems = 3;
// 服务端按「字符数」限长（title 100 / body 2000），此处按字节比较，
// 因此统一放大 4 倍取 UTF-8 单字符最坏情况，既不误杀中文也不给出无界缓冲。
constexpr std::size_t kMaxNoticeTitleBytes = 400;
constexpr std::size_t kMaxNoticeBodyBytes = 8000;
constexpr std::size_t kMaxVersionNameBytes = 64;
constexpr std::size_t kMaxReleaseNotesBytes = 8000;
constexpr std::int64_t kMaxVersionCode = 2147483647LL;
constexpr std::int64_t kMaxNoticeSequence = 1LL << 40;

std::string failed(const char* code) {
    return json{{"valid", false}, {"code", code}}.dump();
}

std::string accepted(const json& payload) {
    return json{{"valid", true}, {"code", "OK"}, {"payload", payload}}.dump();
}

bool is_string(const json& value, const char* field) {
    return value.contains(field) && value[field].is_string();
}

bool is_uuid(const std::string& value) {
    if (value.size() != 36) return false;
    for (std::size_t index = 0; index < value.size(); ++index) {
        if (index == 8 || index == 13 || index == 18 || index == 23) {
            if (value[index] != '-') return false;
        } else if (!std::isxdigit(static_cast<unsigned char>(value[index]))) {
            return false;
        }
    }
    return value[14] >= '1' && value[14] <= '5'
        && (value[19] == '8' || value[19] == '9'
            || value[19] == 'a' || value[19] == 'A'
            || value[19] == 'b' || value[19] == 'B');
}

bool is_hex_sha256(const std::string& value) {
    return value.size() == 64 && std::all_of(value.begin(), value.end(), [](unsigned char c) {
        return std::isdigit(c) || (c >= 'a' && c <= 'f');
    });
}

bool is_leap_year(int year) {
    return year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
}

std::int64_t days_from_civil(int year, unsigned month, unsigned day) {
    year -= month <= 2;
    const int era = (year >= 0 ? year : year - 399) / 400;
    const unsigned year_of_era = static_cast<unsigned>(year - era * 400);
    const unsigned day_of_year = (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1;
    const unsigned day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    return static_cast<std::int64_t>(era) * 146097 + static_cast<int>(day_of_era) - 719468;
}

bool parse_iso8601_millis_impl(const std::string& value, std::int64_t& output) {
    if (value.size() != 24 || value[4] != '-' || value[7] != '-'
        || value[10] != 'T' || value[13] != ':' || value[16] != ':'
        || value[19] != '.' || value[23] != 'Z') return false;
    const std::array<int, 17> digit_positions = {
        0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18, 20, 21, 22,
    };
    for (int position : digit_positions) {
        if (!std::isdigit(static_cast<unsigned char>(value[position]))) return false;
    }
    const auto number = [&](int offset, int length) {
        int result = 0;
        for (int index = 0; index < length; ++index) result = result * 10 + value[offset + index] - '0';
        return result;
    };
    const int year = number(0, 4);
    const int month = number(5, 2);
    const int day = number(8, 2);
    const int hour = number(11, 2);
    const int minute = number(14, 2);
    const int second = number(17, 2);
    const int millis = number(20, 3);
    if (year < 1970 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
    static constexpr int month_days[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
    const int max_day = month_days[month - 1] + (month == 2 && is_leap_year(year) ? 1 : 0);
    if (day < 1 || day > max_day) return false;
    const std::int64_t days = days_from_civil(year, static_cast<unsigned>(month), static_cast<unsigned>(day));
    output = (((days * 24 + hour) * 60 + minute) * 60 + second) * 1000 + millis;
    return output >= 0;
}

bool signed_payload(const std::string& envelope_json,
                    const std::string& expected_key_id,
                    const std::string& public_key_pem,
                    json& payload,
                    std::string& error) {
    try {
        const json envelope = json::parse(envelope_json);
        if (!envelope.is_object() || !is_string(envelope, "algorithm")
            || envelope["algorithm"] != "Ed25519") {
            error = "INVALID_SIGNATURE";
            return false;
        }
        if (!is_string(envelope, "keyId") || envelope["keyId"] != expected_key_id) {
            error = "WRONG_KEY";
            return false;
        }
        if (!envelope.contains("payload") || !envelope["payload"].is_object()
            || !is_string(envelope, "signature")) {
            error = "INVALID_RESPONSE";
            return false;
        }
        payload = envelope["payload"];
        if (!kmxt::verify_ed25519(kmxt::canonical_json(payload.dump()),
                envelope["signature"].get<std::string>(), public_key_pem)) {
            error = "INVALID_SIGNATURE";
            return false;
        }
        return true;
    } catch (...) {
        error = "INVALID_RESPONSE";
        return false;
    }
}

bool integer_between(const json& object, const char* field, std::int64_t min, std::int64_t max) {
    if (!object.contains(field) || !object[field].is_number_integer()) return false;
    const auto value = object[field].get<std::int64_t>();
    return value >= min && value <= max;
}

bool exact_decoded_size(const json& object, const char* field, std::size_t expected) {
    if (!is_string(object, field)) return false;
    return kmxt::decode_base64url(object[field].get<std::string>()).size() == expected;
}

/**
 * 公告文本的原生复检。服务端已经拒收标记与控制字符，这里再查一遍：
 * 这些字符串会直接进入 Android 展示层，一旦服务端被攻陷或存在绕过，
 * 原生层必须是最后一道拒收点，而不是把内容原样交给 Kotlin。
 * 允许 LF 分段（与服务端 multiline 规则一致），拒收其余 C0 控制字符与 DEL。
 */
bool is_display_text(const std::string& value, std::size_t max_bytes, bool allow_newline) {
    if (value.empty() || value.size() > max_bytes) return false;
    for (const unsigned char character : value) {
        if (character == 0x0a) {
            if (!allow_newline) return false;
            continue;
        }
        if (character < 0x20 || character == 0x7f) return false;
    }
    return true;
}

bool optional_display_text(const json& object, const char* field,
                           std::size_t max_bytes, bool allow_newline) {
    // 字段缺失或显式 null 都视为「未配置」，直接通过：老服务端不会带这些字段，
    // 新客户端不能因此拒收合法响应。字段存在但类型或内容非法则必须失败。
    if (!object.contains(field) || object[field].is_null()) return true;
    if (!object[field].is_string()) return false;
    return is_display_text(object[field].get<std::string>(), max_bytes, allow_newline);
}

bool optional_version_code(const json& object, const char* field) {
    if (!object.contains(field) || object[field].is_null()) return true;
    if (!object[field].is_number_integer()) return false;
    const auto value = object[field].get<std::int64_t>();
    return value >= 0 && value <= kMaxVersionCode;
}

/**
 * 版本策略校验。缺失整个 clientPolicy 对象是合法的（未配置强制更新）。
 * 存在则每个字段都必须形状正确，且 minVersionCode 不得高于 latestVersionCode——
 * 后者会把全部客户端永久锁死，服务端已拒收，原生层同样不接受。
 */
bool valid_client_policy(const json& payload) {
    if (!payload.contains("clientPolicy") || payload["clientPolicy"].is_null()) return true;
    if (!payload["clientPolicy"].is_object()) return false;
    const json& policy = payload["clientPolicy"];
    if (!optional_version_code(policy, "minVersionCode")
        || !optional_version_code(policy, "latestVersionCode")
        || !optional_display_text(policy, "latestVersionName", kMaxVersionNameBytes, false)
        || !optional_display_text(policy, "releaseNotes", kMaxReleaseNotesBytes, true)) {
        return false;
    }
    if (policy.contains("minVersionCode") && !policy["minVersionCode"].is_null()
        && policy.contains("latestVersionCode") && !policy["latestVersionCode"].is_null()
        && policy["minVersionCode"].get<std::int64_t>()
            > policy["latestVersionCode"].get<std::int64_t>()) {
        return false;
    }
    return true;
}

/**
 * 公告数组校验。缺失视为空列表；存在则条数、每条的字段形状、severity 枚举
 * 与序号单调性都必须成立。sequence 必须严格递减（服务端按序号倒序下发），
 * 这样客户端拿到的最大序号一定是首条，防回滚比较无需重新排序。
 */
bool valid_announcements(const json& payload) {
    if (!payload.contains("announcements") || payload["announcements"].is_null()) return true;
    if (!payload["announcements"].is_array()) return false;
    const json& items = payload["announcements"];
    if (items.size() > kMaxNoticeItems) return false;
    static const std::array<const char*, 3> severities = {"info", "warning", "critical"};
    std::int64_t previous_sequence = kMaxNoticeSequence + 1;
    for (const json& item : items) {
        if (!item.is_object()) return false;
        if (!is_string(item, "id") || !is_uuid(item["id"].get<std::string>())) return false;
        if (!integer_between(item, "sequence", 1, kMaxNoticeSequence)) return false;
        const std::int64_t sequence = item["sequence"].get<std::int64_t>();
        if (sequence >= previous_sequence) return false;
        previous_sequence = sequence;
        const std::string severity = item.value("severity", "");
        if (std::find(severities.begin(), severities.end(), severity) == severities.end()) {
            return false;
        }
        if (!is_string(item, "title")
            || !is_display_text(item["title"].get<std::string>(), kMaxNoticeTitleBytes, false)) {
            return false;
        }
        if (!is_string(item, "body")
            || !is_display_text(item["body"].get<std::string>(), kMaxNoticeBodyBytes, true)) {
            return false;
        }
        if (item.contains("publishedAt") && !item["publishedAt"].is_null()) {
            std::int64_t published = 0;
            if (!item["publishedAt"].is_string()
                || !parse_iso8601_millis_impl(item["publishedAt"].get<std::string>(), published)) {
                return false;
            }
        }
    }
    return true;
}

/**
 * 通道 A：授权响应里搭载的公告与版本策略。
 *
 * 花落 / MIT：这里刻意「剥离」而不是「拒收」。载荷已经通过 Ed25519 验签，畸形内容
 * 只可能来自服务端自身的 bug，而不是攻击者伪造。若因为一条公告格式不对就否掉整个
 * 授权响应，一个纯展示字段的服务端缺陷会直接演变成全体客户端断授权。因此形状不合法
 * 时把这两个字段删掉再放行授权——展示层拿不到数据（fail-closed），授权不受影响。
 */
void strip_invalid_client_context(json& payload) {
    if (!valid_client_policy(payload)) payload.erase("clientPolicy");
    if (!valid_announcements(payload)) payload.erase("announcements");
}

}  // namespace

namespace kmxt {

bool parse_iso8601_millis(const std::string& value, std::int64_t& output) {
    return parse_iso8601_millis_impl(value, output);
}

// Author: 花落, MIT License. Security decisions stay in native code; callers receive data only after acceptance.
std::string validate_authorization_envelope(const std::string& envelope_json,
                                            const std::string& expected_app_id,
                                            const std::string& expected_key_id,
                                            const std::string& public_key_pem,
                                            const std::string& expected_request_nonce,
                                            std::int64_t now_millis,
                                            bool require_session_token) {
    json payload;
    std::string error;
    if (!signed_payload(envelope_json, expected_key_id, public_key_pem, payload, error)) return failed(error.c_str());
    if (!is_string(payload, "appId") || payload["appId"] != expected_app_id) return failed("WRONG_APPLICATION");
    if (!is_string(payload, "requestNonce")
        || payload["requestNonce"] != expected_request_nonce) return failed("INVALID_RESPONSE");
    if (!payload.value("licensed", false) || payload.value("code", "") != "LICENSE_VALID") {
        return failed("SERVER_REJECTED");
    }
    if (!is_string(payload, "licenseId") || !is_uuid(payload["licenseId"].get<std::string>())
        || !is_string(payload, "bindingId") || !is_uuid(payload["bindingId"].get<std::string>())) {
        return failed("INVALID_RESPONSE");
    }
    std::int64_t issued = 0;
    std::int64_t license_expiry = 0;
    std::int64_t session_expiry = 0;
    if (!is_string(payload, "issuedAt") || !parse_iso8601_millis(payload["issuedAt"], issued)
        || issued < now_millis - kClockSkewMs || issued > now_millis + kClockSkewMs
        || !is_string(payload, "licenseExpiresAt")
        || !parse_iso8601_millis(payload["licenseExpiresAt"], license_expiry)
        || !is_string(payload, "sessionExpiresAt")
        || !parse_iso8601_millis(payload["sessionExpiresAt"], session_expiry)) {
        return failed("INVALID_RESPONSE");
    }
    if (license_expiry <= now_millis) return failed("LICENSE_EXPIRED");
    if (session_expiry <= now_millis || session_expiry > license_expiry) return failed("SESSION_EXPIRED");
    if (!integer_between(payload, "heartbeatAfterSeconds", 30, 86400)) return failed("INVALID_RESPONSE");
    if (require_session_token) {
        if (!exact_decoded_size(payload, "sessionToken", 32)) {
            return failed("INVALID_RESPONSE");
        }
    } else if (payload.contains("sessionToken")) {
        return failed("INVALID_RESPONSE");
    }
    // 公告与版本策略是搭载的展示数据，形状非法只剥离、不否决授权（见注释）。
    strip_invalid_client_context(payload);
    return accepted(payload);
}

std::string validate_unbind_envelope(const std::string& envelope_json,
                                     const std::string& expected_app_id,
                                     const std::string& expected_key_id,
                                     const std::string& public_key_pem,
                                     const std::string& expected_request_nonce,
                                     std::int64_t now_millis) {
    json payload;
    std::string error;
    if (!signed_payload(envelope_json, expected_key_id, public_key_pem, payload, error)) return failed(error.c_str());
    if (!is_string(payload, "appId") || payload["appId"] != expected_app_id) return failed("WRONG_APPLICATION");
    if (!is_string(payload, "requestNonce")
        || payload["requestNonce"] != expected_request_nonce) return failed("INVALID_RESPONSE");
    if (!payload.value("unbound", false) || payload.value("code", "") != "DEVICE_UNBOUND") {
        return failed("SERVER_REJECTED");
    }
    if (!is_string(payload, "bindingId") || !is_uuid(payload["bindingId"].get<std::string>())
        || !integer_between(payload, "sessionsRevoked", 0, std::numeric_limits<std::int32_t>::max())) {
        return failed("INVALID_RESPONSE");
    }
    std::int64_t issued = 0;
    if (!is_string(payload, "issuedAt") || !parse_iso8601_millis(payload["issuedAt"], issued)
        || issued < now_millis - kClockSkewMs || issued > now_millis + kClockSkewMs) {
        return failed("INVALID_RESPONSE");
    }
    return accepted(payload);
}

std::string validate_model_lease_envelope(const std::string& envelope_json,
                                          const std::string& expected_app_id,
                                          const std::string& expected_key_id,
                                          const std::string& public_key_pem,
                                          const std::string& expected_artifact_id,
                                          const std::string& expected_request_nonce,
                                          const std::string& client_public_key,
                                          std::int64_t now_millis) {
    json payload;
    std::string error;
    if (!signed_payload(envelope_json, expected_key_id, public_key_pem, payload, error)) return failed(error.c_str());
    if (payload.value("type", "") != "model_lease"
        || payload.value("appId", "") != expected_app_id
        || payload.value("artifactId", "") != expected_artifact_id
        || payload.value("requestNonce", "") != expected_request_nonce) {
        return failed("WRONG_APPLICATION");
    }
    if (payload.value("protocolVersion", -1) != 1) return failed("INVALID_RESPONSE");
    if (payload.value("clientKeyFingerprint", "") != sha256_hex(client_public_key)) {
        return failed("INVALID_CLIENT_KEY");
    }
    if (payload.value("wrapAlgorithm", "") != "X25519-HKDF-SHA256-AES-256-GCM") {
        return failed("INVALID_RESPONSE");
    }
    const std::string lease_id = payload.value("leaseId", "");
    const std::string binding_id = payload.value("bindingId", "");
    const std::string version = payload.value("version", "");
    const std::string cipher_hash = payload.value("cipherSha256", "");
    if (!is_uuid(lease_id) || !is_uuid(binding_id) || payload.value("jti", "") != lease_id
        || version.empty() || version.size() > 64 || !is_hex_sha256(cipher_hash)
        || !integer_between(payload, "size", 1, kMaxModelBytes)
        || !integer_between(payload, "keyVersion", 1, 1000000)) {
        return failed("INVALID_RESPONSE");
    }
    // 花落/MIT: 'so' / 'dex' 复用同一 AES-256-GCM + 租约协议，密文同样随 APK assets 打包。
    // 必须与服务端 model-delivery-service.js 的 ARTIFACT_FORMATS 保持同步——服务端先加了
    // 这两档而此处漏改，会让 .so/.dex 租约在信封校验阶段被拒成 INVALID_RESPONSE，
    // 表层现象是「解密失败」，实际 decrypt 从未执行。
    static const std::array<const char*, 8> formats = {
        "onnx", "ncnn-param", "ncnn-bin", "tflite", "dlc", "bundle", "so", "dex",
    };
    const std::string format = payload.value("format", "");
    if (std::find(formats.begin(), formats.end(), format) == formats.end()
        || payload.value("name", "").empty()) {
        return failed("INVALID_RESPONSE");
    }
    if (!payload.contains("encryption") || !payload["encryption"].is_object()) return failed("INVALID_RESPONSE");
    const json& encryption = payload["encryption"];
    if (encryption.value("algorithm", "") != "AES-256-GCM"
        || !exact_decoded_size(encryption, "nonce", 12)
        || !exact_decoded_size(encryption, "tag", 16)) {
        return failed("INVALID_RESPONSE");
    }
    if (encryption.contains("chunkSize") && !encryption["chunkSize"].is_null()
        && !integer_between(encryption, "chunkSize", 64 * 1024, 64 * 1024 * 1024)) {
        return failed("INVALID_RESPONSE");
    }
    std::int64_t issued = 0;
    std::int64_t expires = 0;
    if (!is_string(payload, "issuedAt") || !parse_iso8601_millis(payload["issuedAt"], issued)
        || !is_string(payload, "expiresAt") || !parse_iso8601_millis(payload["expiresAt"], expires)
        || issued > now_millis + kClockSkewMs || expires <= now_millis
        || expires <= issued || expires - issued > kMaxModelLeaseMs
        || expires > now_millis + kMaxModelLeaseMs) {
        return failed("LEASE_EXPIRED");
    }
    if (!payload.contains("wrappedDek") || !payload["wrappedDek"].is_object()
        || !exact_decoded_size(payload, "serverEphemeralPublicKey", 44)) {
        return failed("INVALID_RESPONSE");
    }
    const json& wrapped = payload["wrappedDek"];
    if (!exact_decoded_size(wrapped, "iv", 12) || !exact_decoded_size(wrapped, "tag", 16)
        || !exact_decoded_size(wrapped, "ciphertext", 32)) {
        return failed("INVALID_RESPONSE");
    }
    const std::string expected_associated_data = expected_app_id + "|" + expected_artifact_id + "|"
        + version + "|" + cipher_hash + "|" + binding_id + "|" + lease_id + "|" + expected_request_nonce;
    if (wrapped.value("associatedData", "") != expected_associated_data) return failed("INVALID_RESPONSE");
    return accepted(payload);
}

/**
 * 通道 B：公开公告信封。整个载荷都是展示数据，因此形状不合法就整体拒收。
 *
 * 花落 / MIT：这个通道没有请求 nonce，可被重放，用两层收敛：
 *   1. issuedAt 必须落在 kNoticeFreshnessMs 新鲜度窗口内，把重放限制在十分钟量级；
 *   2. sequence 必须不低于调用方持久化的 min_accepted_sequence，拒绝历史信封回滚。
 * 两者都不涉及授权决策，最坏情况是展示一条十分钟内的旧公告。
 */
std::string validate_notice_envelope(const std::string& envelope_json,
                                     const std::string& expected_app_id,
                                     const std::string& expected_key_id,
                                     const std::string& public_key_pem,
                                     std::int64_t now_millis,
                                     std::int64_t min_accepted_sequence) {
    json payload;
    std::string error;
    if (!signed_payload(envelope_json, expected_key_id, public_key_pem, payload, error)) {
        return failed(error.c_str());
    }
    if (!is_string(payload, "appId") || payload["appId"] != expected_app_id) {
        return failed("WRONG_APPLICATION");
    }
    if (payload.value("type", "") != "client_notice") return failed("INVALID_RESPONSE");
    if (payload.value("protocolVersion", -1) != 1) return failed("INVALID_RESPONSE");
    std::int64_t issued = 0;
    if (!is_string(payload, "issuedAt")
        || !parse_iso8601_millis(payload["issuedAt"].get<std::string>(), issued)
        || issued < now_millis - kNoticeFreshnessMs
        || issued > now_millis + kClockSkewMs) {
        return failed("INVALID_RESPONSE");
    }
    // sequence 为 0 表示当前没有可下发公告，是合法状态，客户端据此清空本地展示。
    if (!integer_between(payload, "sequence", 0, kMaxNoticeSequence)) {
        return failed("INVALID_RESPONSE");
    }
    if (min_accepted_sequence > 0
        && payload["sequence"].get<std::int64_t>() < min_accepted_sequence) {
        return failed("NOTICE_ROLLBACK");
    }
    if (!valid_client_policy(payload) || !valid_announcements(payload)) {
        return failed("INVALID_RESPONSE");
    }
    return accepted(payload);
}

}  // namespace kmxt
