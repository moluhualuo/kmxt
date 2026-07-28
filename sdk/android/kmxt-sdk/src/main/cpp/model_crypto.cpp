#include "kmxt/core.hpp"

#include <openssl/crypto.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <openssl/x509.h>

#include <array>
#include <memory>
#include <string>
#include <vector>

namespace {
using Pkey = std::unique_ptr<EVP_PKEY, decltype(&EVP_PKEY_free)>;
using PkeyContext = std::unique_ptr<EVP_PKEY_CTX, decltype(&EVP_PKEY_CTX_free)>;
using CipherContext = std::unique_ptr<EVP_CIPHER_CTX, decltype(&EVP_CIPHER_CTX_free)>;

constexpr char kWrapSalt[] = "kmxt-model-lease-salt";

bool aes_gcm_decrypt(const std::vector<unsigned char>& key,
                     const std::vector<unsigned char>& nonce,
                     const std::vector<unsigned char>& tag,
                     const std::vector<unsigned char>& ciphertext,
                     const std::string& associated_data,
                     std::vector<unsigned char>& plaintext) {
    if (key.size() != 32 || nonce.size() != 12 || tag.size() != 16 || ciphertext.empty()) {
        return false;
    }
    CipherContext context(EVP_CIPHER_CTX_new(), EVP_CIPHER_CTX_free);
    if (!context || EVP_DecryptInit_ex(context.get(), EVP_aes_256_gcm(), nullptr, nullptr, nullptr) != 1
        || EVP_CIPHER_CTX_ctrl(context.get(), EVP_CTRL_GCM_SET_IVLEN,
            static_cast<int>(nonce.size()), nullptr) != 1
        || EVP_DecryptInit_ex(context.get(), nullptr, nullptr, key.data(), nonce.data()) != 1) {
        return false;
    }
    int written = 0;
    if (!associated_data.empty()
        && EVP_DecryptUpdate(context.get(), nullptr, &written,
            reinterpret_cast<const unsigned char*>(associated_data.data()),
            static_cast<int>(associated_data.size())) != 1) {
        return false;
    }
    plaintext.assign(ciphertext.size(), 0);
    if (EVP_DecryptUpdate(context.get(), plaintext.data(), &written,
            ciphertext.data(), static_cast<int>(ciphertext.size())) != 1) {
        kmxt::secure_clear(plaintext);
        return false;
    }
    int total = written;
    if (EVP_CIPHER_CTX_ctrl(context.get(), EVP_CTRL_GCM_SET_TAG,
            static_cast<int>(tag.size()), const_cast<unsigned char*>(tag.data())) != 1
        || EVP_DecryptFinal_ex(context.get(), plaintext.data() + total, &written) != 1) {
        kmxt::secure_clear(plaintext);
        return false;
    }
    plaintext.resize(static_cast<std::size_t>(total + written));
    return true;
}

bool derive_wrapping_key(const std::vector<unsigned char>& private_key,
                         const std::vector<unsigned char>& server_public_key,
                         const std::string& associated_data,
                         std::vector<unsigned char>& wrapping_key) {
    if (private_key.size() != 32 || server_public_key.size() != 44
        || associated_data.empty() || associated_data.size() > 2048) return false;
    const unsigned char* encoded = server_public_key.data();
    Pkey server(d2i_PUBKEY(nullptr, &encoded, static_cast<long>(server_public_key.size())), EVP_PKEY_free);
    Pkey client(EVP_PKEY_new_raw_private_key(EVP_PKEY_X25519, nullptr,
        private_key.data(), private_key.size()), EVP_PKEY_free);
    if (!server || !client || EVP_PKEY_id(server.get()) != EVP_PKEY_X25519) return false;
    PkeyContext context(EVP_PKEY_CTX_new(client.get(), nullptr), EVP_PKEY_CTX_free);
    if (!context || EVP_PKEY_derive_init(context.get()) != 1
        || EVP_PKEY_derive_set_peer(context.get(), server.get()) != 1) return false;
    std::size_t shared_size = 0;
    if (EVP_PKEY_derive(context.get(), nullptr, &shared_size) != 1 || shared_size != 32) return false;
    std::vector<unsigned char> shared(shared_size);
    if (EVP_PKEY_derive(context.get(), shared.data(), &shared_size) != 1) {
        kmxt::secure_clear(shared);
        return false;
    }
    std::array<unsigned char, EVP_MAX_MD_SIZE> prk{};
    unsigned int prk_size = 0;
    const auto* extracted = HMAC(EVP_sha256(), kWrapSalt, sizeof(kWrapSalt) - 1,
        shared.data(), shared.size(), prk.data(), &prk_size);
    kmxt::secure_clear(shared);
    if (!extracted || prk_size != 32) {
        OPENSSL_cleanse(prk.data(), prk.size());
        return false;
    }
    std::vector<unsigned char> info(associated_data.begin(), associated_data.end());
    info.push_back(1);
    std::array<unsigned char, EVP_MAX_MD_SIZE> expanded{};
    unsigned int expanded_size = 0;
    const auto* expanded_result = HMAC(EVP_sha256(), prk.data(), static_cast<int>(prk_size),
        info.data(), info.size(), expanded.data(), &expanded_size);
    OPENSSL_cleanse(prk.data(), prk.size());
    kmxt::secure_clear(info);
    if (!expanded_result || expanded_size < 32) {
        OPENSSL_cleanse(expanded.data(), expanded.size());
        return false;
    }
    wrapping_key.assign(expanded.begin(), expanded.begin() + 32);
    OPENSSL_cleanse(expanded.data(), expanded.size());
    return true;
}
}  // namespace

namespace kmxt {

// Author: 花落. Native lease cryptography is distributed under the MIT License.
void secure_clear(std::vector<unsigned char>& value) {
    if (!value.empty()) OPENSSL_cleanse(value.data(), value.size());
    value.clear();
    value.shrink_to_fit();
}

bool generate_x25519_ephemeral(X25519Ephemeral& output) {
    secure_clear(output.private_key);
    output.public_key_base64url.clear();
    PkeyContext context(EVP_PKEY_CTX_new_id(EVP_PKEY_X25519, nullptr), EVP_PKEY_CTX_free);
    EVP_PKEY* generated = nullptr;
    if (!context || EVP_PKEY_keygen_init(context.get()) != 1
        || EVP_PKEY_keygen(context.get(), &generated) != 1) return false;
    Pkey key(generated, EVP_PKEY_free);
    std::size_t private_size = 32;
    output.private_key.assign(private_size, 0);
    if (EVP_PKEY_get_raw_private_key(key.get(), output.private_key.data(), &private_size) != 1
        || private_size != 32) {
        secure_clear(output.private_key);
        return false;
    }
    const int public_size = i2d_PUBKEY(key.get(), nullptr);
    if (public_size != 44) {
        secure_clear(output.private_key);
        return false;
    }
    std::vector<unsigned char> public_key(static_cast<std::size_t>(public_size));
    unsigned char* cursor = public_key.data();
    if (i2d_PUBKEY(key.get(), &cursor) != public_size) {
        secure_clear(output.private_key);
        return false;
    }
    output.public_key_base64url = encode_base64url(public_key);
    return !output.public_key_base64url.empty();
}

bool unwrap_model_key(const std::vector<unsigned char>& private_key,
                      const std::string& server_public_key_base64url,
                      const std::string& iv_base64url,
                      const std::string& tag_base64url,
                      const std::string& ciphertext_base64url,
                      const std::string& associated_data,
                      std::vector<unsigned char>& content_key) {
    secure_clear(content_key);
    auto server_public_key = decode_base64url(server_public_key_base64url);
    auto iv = decode_base64url(iv_base64url);
    auto tag = decode_base64url(tag_base64url);
    auto ciphertext = decode_base64url(ciphertext_base64url);
    std::vector<unsigned char> wrapping_key;
    const bool derived = server_public_key.size() == 44 && iv.size() == 12 && tag.size() == 16
        && ciphertext.size() == 32
        && derive_wrapping_key(private_key, server_public_key, associated_data, wrapping_key);
    const bool decrypted = derived
        && aes_gcm_decrypt(wrapping_key, iv, tag, ciphertext, associated_data, content_key)
        && content_key.size() == 32;
    secure_clear(wrapping_key);
    secure_clear(server_public_key);
    secure_clear(iv);
    secure_clear(tag);
    secure_clear(ciphertext);
    if (!decrypted) secure_clear(content_key);
    return decrypted;
}

bool decrypt_model_ciphertext(const std::vector<unsigned char>& content_key,
                              const std::string& nonce_base64url,
                              const std::string& tag_base64url,
                              const std::vector<unsigned char>& ciphertext,
                              std::vector<unsigned char>& plaintext) {
    auto nonce = decode_base64url(nonce_base64url);
    auto tag = decode_base64url(tag_base64url);
    const bool result = aes_gcm_decrypt(content_key, nonce, tag, ciphertext, {}, plaintext);
    secure_clear(nonce);
    secure_clear(tag);
    if (!result) secure_clear(plaintext);
    return result;
}

}  // namespace kmxt
