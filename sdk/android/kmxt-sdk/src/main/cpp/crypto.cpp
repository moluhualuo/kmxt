#include "kmxt/core.hpp"
#include <openssl/evp.h>
#include <openssl/pem.h>
#include <array>
#include <iomanip>
#include <memory>
#include <sstream>
#include <vector>

namespace {
std::vector<unsigned char> decode_base64url(std::string value) {
    for (auto& character : value) {
        if (character == '-') character = '+';
        else if (character == '_') character = '/';
    }
    while (value.size() % 4 != 0) value.push_back('=');
    std::vector<unsigned char> output((value.size() * 3) / 4 + 1);
    int length = EVP_DecodeBlock(output.data(),
        reinterpret_cast<const unsigned char*>(value.data()), static_cast<int>(value.size()));
    if (length < 0) return {};
    while (!value.empty() && value.back() == '=') { --length; value.pop_back(); }
    output.resize(static_cast<std::size_t>(length));
    return output;
}
}

namespace kmxt {
std::string sha256_hex(const std::string& value) {
    std::array<unsigned char, 32> digest{};
    unsigned int length = 0;
    auto context = std::unique_ptr<EVP_MD_CTX, decltype(&EVP_MD_CTX_free)>(EVP_MD_CTX_new(), EVP_MD_CTX_free);
    EVP_DigestInit_ex(context.get(), EVP_sha256(), nullptr);
    EVP_DigestUpdate(context.get(), value.data(), value.size());
    EVP_DigestFinal_ex(context.get(), digest.data(), &length);
    std::ostringstream result;
    for (unsigned int index = 0; index < length; ++index)
        result << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(digest[index]);
    return result.str();
}

bool verify_ed25519(const std::string& payload, const std::string& encoded_signature,
                    const std::string& public_key_pem) {
    const auto signature = decode_base64url(encoded_signature);
    auto bio = std::unique_ptr<BIO, decltype(&BIO_free)>(
        BIO_new_mem_buf(public_key_pem.data(), static_cast<int>(public_key_pem.size())), BIO_free);
    auto key = std::unique_ptr<EVP_PKEY, decltype(&EVP_PKEY_free)>(
        PEM_read_bio_PUBKEY(bio.get(), nullptr, nullptr, nullptr), EVP_PKEY_free);
    if (!key || signature.empty() || EVP_PKEY_id(key.get()) != EVP_PKEY_ED25519) return false;
    auto context = std::unique_ptr<EVP_MD_CTX, decltype(&EVP_MD_CTX_free)>(EVP_MD_CTX_new(), EVP_MD_CTX_free);
    if (EVP_DigestVerifyInit(context.get(), nullptr, nullptr, nullptr, key.get()) != 1) return false;
    return EVP_DigestVerify(context.get(), signature.data(), signature.size(),
        reinterpret_cast<const unsigned char*>(payload.data()), payload.size()) == 1;
}
}
