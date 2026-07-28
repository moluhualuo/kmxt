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
    static const std::array<const char*, 6> formats = {
        "onnx", "ncnn-param", "ncnn-bin", "tflite", "dlc", "bundle",
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

}  // namespace kmxt
