#pragma once
#include <cstdint>
#include <string>
#include <vector>

// Author: 花落. Distributed under the MIT License.
namespace kmxt {
struct X25519Ephemeral {
    std::vector<unsigned char> private_key;
    std::string public_key_base64url;
};

std::string canonical_json(const std::string& json);
std::string sha256_hex(const std::string& value);
bool verify_ed25519(const std::string& canonical_payload,
                    const std::string& signature_base64url,
                    const std::string& public_key_pem);
std::vector<unsigned char> decode_base64url(const std::string& value);
std::string encode_base64url(const std::vector<unsigned char>& value);
void secure_clear(std::vector<unsigned char>& value);
bool parse_iso8601_millis(const std::string& value, std::int64_t& output);
bool generate_x25519_ephemeral(X25519Ephemeral& output);
bool unwrap_model_key(const std::vector<unsigned char>& private_key,
    const std::string& server_public_key_base64url, const std::string& iv_base64url,
    const std::string& tag_base64url, const std::string& ciphertext_base64url,
    const std::string& associated_data, std::vector<unsigned char>& content_key);
bool decrypt_model_ciphertext(const std::vector<unsigned char>& content_key,
    const std::string& nonce_base64url, const std::string& tag_base64url,
    const std::vector<unsigned char>& ciphertext, std::vector<unsigned char>& plaintext);
std::string validate_authorization_envelope(const std::string& envelope_json,
    const std::string& expected_app_id, const std::string& expected_key_id,
    const std::string& public_key_pem, const std::string& expected_request_nonce,
    std::int64_t now_millis, bool require_session_token);
std::string validate_unbind_envelope(const std::string& envelope_json,
    const std::string& expected_app_id, const std::string& expected_key_id,
    const std::string& public_key_pem, const std::string& expected_request_nonce,
    std::int64_t now_millis);
std::string validate_model_lease_envelope(const std::string& envelope_json,
    const std::string& expected_app_id, const std::string& expected_key_id,
    const std::string& public_key_pem, const std::string& expected_artifact_id,
    const std::string& expected_request_nonce, const std::string& client_public_key,
    std::int64_t now_millis);
// 花落 / MIT：公开公告信封校验。无请求 nonce，靠 issuedAt 新鲜度与
// min_accepted_sequence 防回滚收敛重放；不参与任何授权决策。
std::string validate_notice_envelope(const std::string& envelope_json,
    const std::string& expected_app_id, const std::string& expected_key_id,
    const std::string& public_key_pem, std::int64_t now_millis,
    std::int64_t min_accepted_sequence);
}
