#pragma once
#include <string>

// Author: 花落. Distributed under the MIT License.
namespace kmxt {
std::string canonical_json(const std::string& json);
std::string sha256_hex(const std::string& value);
bool verify_ed25519(const std::string& canonical_payload,
                    const std::string& signature_base64url,
                    const std::string& public_key_pem);
}
