#include "kmxt/core.hpp"

#include <nlohmann/json.hpp>
#include <openssl/buffer.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <openssl/pem.h>
#include <openssl/x509.h>

#include <array>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
using json = nlohmann::json;
using Pkey = std::unique_ptr<EVP_PKEY, decltype(&EVP_PKEY_free)>;
using PkeyContext = std::unique_ptr<EVP_PKEY_CTX, decltype(&EVP_PKEY_CTX_free)>;
using MdContext = std::unique_ptr<EVP_MD_CTX, decltype(&EVP_MD_CTX_free)>;
using CipherContext = std::unique_ptr<EVP_CIPHER_CTX, decltype(&EVP_CIPHER_CTX_free)>;

constexpr std::int64_t kNow = 120000;
constexpr char kAppId[] = "00000000-0000-4000-8000-000000000001";
constexpr char kArtifactId[] = "00000000-0000-4000-8000-000000000002";
constexpr char kKeyId[] = "native-test-key";

void require(bool condition, const std::string& message) {
    if (!condition) throw std::runtime_error(message);
}

Pkey signing_key() {
    std::array<unsigned char, 32> seed{};
    for (std::size_t index = 0; index < seed.size(); ++index) {
        seed[index] = static_cast<unsigned char>(index + 1);
    }
    return Pkey(EVP_PKEY_new_raw_private_key(
        EVP_PKEY_ED25519, nullptr, seed.data(), seed.size()), EVP_PKEY_free);
}

std::string public_key_pem(EVP_PKEY* key) {
    std::unique_ptr<BIO, decltype(&BIO_free)> bio(BIO_new(BIO_s_mem()), BIO_free);
    require(bio && PEM_write_bio_PUBKEY(bio.get(), key) == 1, "public key export failed");
    BUF_MEM* buffer = nullptr;
    BIO_get_mem_ptr(bio.get(), &buffer);
    require(buffer != nullptr, "public key buffer missing");
    return {buffer->data, buffer->length};
}

std::string sign_payload(EVP_PKEY* key, const json& payload) {
    const std::string canonical = kmxt::canonical_json(payload.dump());
    MdContext context(EVP_MD_CTX_new(), EVP_MD_CTX_free);
    require(context && EVP_DigestSignInit(context.get(), nullptr, nullptr, nullptr, key) == 1,
        "signature initialization failed");
    std::size_t signature_size = 0;
    require(EVP_DigestSign(context.get(), nullptr, &signature_size,
        reinterpret_cast<const unsigned char*>(canonical.data()), canonical.size()) == 1,
        "signature sizing failed");
    std::vector<unsigned char> signature(signature_size);
    require(EVP_DigestSign(context.get(), signature.data(), &signature_size,
        reinterpret_cast<const unsigned char*>(canonical.data()), canonical.size()) == 1,
        "signature failed");
    signature.resize(signature_size);
    return kmxt::encode_base64url(signature);
}

std::string envelope(EVP_PKEY* key, const json& payload, const std::string& key_id = kKeyId) {
    return json{
        {"algorithm", "Ed25519"},
        {"keyId", key_id},
        {"payload", payload},
        {"signature", sign_payload(key, payload)},
    }.dump();
}

void expect_result(const std::string& raw, bool valid, const std::string& code) {
    const json result = json::parse(raw);
    require(result.value("valid", false) == valid, "unexpected valid flag: " + raw);
    require(result.value("code", "") == code, "unexpected result code: " + raw);
}

json authorization_payload(const std::string& request_nonce, bool include_token) {
    json payload = {
        {"licensed", true},
        {"code", "LICENSE_VALID"},
        {"appId", kAppId},
        {"licenseId", "11111111-1111-4111-8111-111111111111"},
        {"bindingId", "22222222-2222-4222-8222-222222222222"},
        {"requestNonce", request_nonce},
        {"issuedAt", "1970-01-01T00:02:00.000Z"},
        {"licenseExpiresAt", "1970-01-02T00:00:00.000Z"},
        {"sessionExpiresAt", "1970-01-01T01:00:00.000Z"},
        {"heartbeatAfterSeconds", 300},
    };
    if (include_token) {
        payload["sessionToken"] = kmxt::encode_base64url(std::vector<unsigned char>(32, 7));
    }
    return payload;
}

json notice_payload(std::int64_t sequence = 5) {
    json announcements = json::array();
    if (sequence > 0) {
        announcements.push_back({
            {"id", "44444444-4444-4444-8444-444444444444"},
            {"sequence", sequence},
            {"severity", "warning"},
            {"title", "测试公告"},
            {"body", "这是一条测试公告的正文内容。\n可以包含换行。"},
            {"publishedAt", "1970-01-01T00:01:00.000Z"},
        });
    }
    return {
        {"type", "client_notice"},
        {"protocolVersion", 1},
        {"appId", kAppId},
        {"issuedAt", "1970-01-01T00:02:00.000Z"},
        {"sequence", sequence},
        {"clientPolicy", {
            {"minVersionCode", 100},
            {"latestVersionCode", 120},
            {"latestVersionName", "1.2.0"},
            {"releaseNotes", "修复已知问题。"},
        }},
        {"announcements", announcements},
    };
}

json model_payload(const std::string& request_nonce, const std::string& client_public_key) {
    const std::string lease_id = "33333333-3333-4333-8333-333333333333";
    const std::string binding_id = "22222222-2222-4222-8222-222222222222";
    const std::string version = "1.0.0";
    const std::string cipher_hash(64, 'a');
    const std::string associated_data = std::string(kAppId) + "|" + kArtifactId + "|"
        + version + "|" + cipher_hash + "|" + binding_id + "|" + lease_id + "|"
        + request_nonce;
    return {
        {"type", "model_lease"},
        {"protocolVersion", 1},
        {"appId", kAppId},
        {"artifactId", kArtifactId},
        {"name", "test-model"},
        {"version", version},
        {"format", "onnx"},
        {"cipherSha256", cipher_hash},
        {"size", 4096},
        {"encryption", {
            {"algorithm", "AES-256-GCM"},
            {"nonce", kmxt::encode_base64url(std::vector<unsigned char>(12, 1))},
            {"tag", kmxt::encode_base64url(std::vector<unsigned char>(16, 2))},
            {"chunkSize", 65536},
        }},
        {"keyVersion", 1},
        {"licenseId", "11111111-1111-4111-8111-111111111111"},
        {"bindingId", binding_id},
        {"leaseId", lease_id},
        {"jti", lease_id},
        {"clientKeyFingerprint", kmxt::sha256_hex(client_public_key)},
        {"requestNonce", request_nonce},
        {"issuedAt", "1970-01-01T00:02:00.000Z"},
        {"expiresAt", "1970-01-01T00:10:00.000Z"},
        {"wrapAlgorithm", "X25519-HKDF-SHA256-AES-256-GCM"},
        {"serverEphemeralPublicKey", kmxt::encode_base64url(std::vector<unsigned char>(44, 3))},
        {"wrappedDek", {
            {"iv", kmxt::encode_base64url(std::vector<unsigned char>(12, 4))},
            {"tag", kmxt::encode_base64url(std::vector<unsigned char>(16, 5))},
            {"ciphertext", kmxt::encode_base64url(std::vector<unsigned char>(32, 6))},
            {"associatedData", associated_data},
        }},
    };
}

std::vector<unsigned char> derive_shared(EVP_PKEY* private_key, EVP_PKEY* peer) {
    PkeyContext context(EVP_PKEY_CTX_new(private_key, nullptr), EVP_PKEY_CTX_free);
    require(context && EVP_PKEY_derive_init(context.get()) == 1
        && EVP_PKEY_derive_set_peer(context.get(), peer) == 1, "X25519 setup failed");
    std::size_t size = 0;
    require(EVP_PKEY_derive(context.get(), nullptr, &size) == 1, "X25519 sizing failed");
    std::vector<unsigned char> result(size);
    require(EVP_PKEY_derive(context.get(), result.data(), &size) == 1, "X25519 derive failed");
    result.resize(size);
    return result;
}

std::vector<unsigned char> hkdf_for_test(const std::vector<unsigned char>& shared,
                                         const std::string& associated_data) {
    constexpr char salt[] = "kmxt-model-lease-salt";
    std::array<unsigned char, EVP_MAX_MD_SIZE> prk{};
    unsigned int prk_size = 0;
    require(HMAC(EVP_sha256(), salt, sizeof(salt) - 1, shared.data(), shared.size(),
        prk.data(), &prk_size) != nullptr && prk_size == 32, "HKDF extract failed");
    std::vector<unsigned char> info(associated_data.begin(), associated_data.end());
    info.push_back(1);
    std::vector<unsigned char> key(32);
    unsigned int key_size = 0;
    require(HMAC(EVP_sha256(), prk.data(), prk_size, info.data(), info.size(),
        key.data(), &key_size) != nullptr && key_size == 32, "HKDF expand failed");
    return key;
}

struct Encrypted {
    std::vector<unsigned char> ciphertext;
    std::vector<unsigned char> tag;
};

Encrypted encrypt_for_test(const std::vector<unsigned char>& key,
                           const std::vector<unsigned char>& nonce,
                           const std::vector<unsigned char>& plaintext,
                           const std::string& associated_data) {
    CipherContext context(EVP_CIPHER_CTX_new(), EVP_CIPHER_CTX_free);
    require(context && EVP_EncryptInit_ex(context.get(), EVP_aes_256_gcm(), nullptr, nullptr, nullptr) == 1
        && EVP_CIPHER_CTX_ctrl(context.get(), EVP_CTRL_GCM_SET_IVLEN,
            static_cast<int>(nonce.size()), nullptr) == 1
        && EVP_EncryptInit_ex(context.get(), nullptr, nullptr, key.data(), nonce.data()) == 1,
        "AES-GCM setup failed");
    int written = 0;
    if (!associated_data.empty()) {
        require(EVP_EncryptUpdate(context.get(), nullptr, &written,
            reinterpret_cast<const unsigned char*>(associated_data.data()),
            static_cast<int>(associated_data.size())) == 1, "AES-GCM AAD failed");
    }
    Encrypted result{std::vector<unsigned char>(plaintext.size()), std::vector<unsigned char>(16)};
    require(EVP_EncryptUpdate(context.get(), result.ciphertext.data(), &written,
        plaintext.data(), static_cast<int>(plaintext.size())) == 1, "AES-GCM encrypt failed");
    int total = written;
    require(EVP_EncryptFinal_ex(context.get(), result.ciphertext.data() + total, &written) == 1,
        "AES-GCM final failed");
    result.ciphertext.resize(static_cast<std::size_t>(total + written));
    require(EVP_CIPHER_CTX_ctrl(context.get(), EVP_CTRL_GCM_GET_TAG,
        static_cast<int>(result.tag.size()), result.tag.data()) == 1, "AES-GCM tag failed");
    return result;
}

Pkey parse_public(const std::string& encoded) {
    const auto der = kmxt::decode_base64url(encoded);
    const unsigned char* cursor = der.data();
    return Pkey(d2i_PUBKEY(nullptr, &cursor, static_cast<long>(der.size())), EVP_PKEY_free);
}

std::string public_der(EVP_PKEY* key) {
    const int size = i2d_PUBKEY(key, nullptr);
    require(size > 0, "DER sizing failed");
    std::vector<unsigned char> der(static_cast<std::size_t>(size));
    unsigned char* cursor = der.data();
    require(i2d_PUBKEY(key, &cursor) == size, "DER export failed");
    return kmxt::encode_base64url(der);
}

void test_model_crypto() {
    kmxt::X25519Ephemeral client;
    require(kmxt::generate_x25519_ephemeral(client), "client X25519 generation failed");
    Pkey client_public = parse_public(client.public_key_base64url);
    PkeyContext generator(EVP_PKEY_CTX_new_id(EVP_PKEY_X25519, nullptr), EVP_PKEY_CTX_free);
    EVP_PKEY* generated = nullptr;
    require(generator && EVP_PKEY_keygen_init(generator.get()) == 1
        && EVP_PKEY_keygen(generator.get(), &generated) == 1, "server X25519 generation failed");
    Pkey server(generated, EVP_PKEY_free);
    auto shared = derive_shared(server.get(), client_public.get());
    const std::string associated_data = "app|artifact|version|hash|binding|lease|nonce";
    auto wrapping_key = hkdf_for_test(shared, associated_data);
    const std::vector<unsigned char> dek(32, 0x42);
    const std::vector<unsigned char> wrap_iv(12, 0x11);
    const Encrypted wrapped = encrypt_for_test(wrapping_key, wrap_iv, dek, associated_data);
    std::vector<unsigned char> unwrapped;
    require(kmxt::unwrap_model_key(client.private_key, public_der(server.get()),
        kmxt::encode_base64url(wrap_iv), kmxt::encode_base64url(wrapped.tag),
        kmxt::encode_base64url(wrapped.ciphertext), associated_data, unwrapped),
        "native model key unwrap failed");
    require(unwrapped == dek, "unwrapped DEK mismatch");

    const std::vector<unsigned char> model(1024, 0x5a);
    const std::vector<unsigned char> model_nonce(12, 0x22);
    const Encrypted encrypted_model = encrypt_for_test(dek, model_nonce, model, {});
    std::vector<unsigned char> decrypted_model;
    require(kmxt::decrypt_model_ciphertext(dek, kmxt::encode_base64url(model_nonce),
        kmxt::encode_base64url(encrypted_model.tag), encrypted_model.ciphertext,
        decrypted_model), "native model decrypt failed");
    require(decrypted_model == model, "decrypted model mismatch");
    auto bad_tag = encrypted_model.tag;
    bad_tag.front() ^= 1;
    require(!kmxt::decrypt_model_ciphertext(dek, kmxt::encode_base64url(model_nonce),
        kmxt::encode_base64url(bad_tag), encrypted_model.ciphertext, decrypted_model),
        "tampered model tag was accepted");
}
}  // namespace

int main() {
    try {
        const std::string canonical =
            R"({"appId":"00000000-0000-0000-0000-000000000000","licensed":true})";
        require(kmxt::canonical_json(
            R"({"licensed":true,"appId":"00000000-0000-0000-0000-000000000000"})") == canonical,
            "canonical JSON mismatch");
        require(kmxt::sha256_hex("abc") ==
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            "SHA-256 mismatch");

        Pkey key = signing_key();
        require(key != nullptr, "test signing key unavailable");
        const std::string public_key = public_key_pem(key.get());
        const std::string nonce = kmxt::encode_base64url(std::vector<unsigned char>(18, 9));

        json activation = authorization_payload(nonce, true);
        expect_result(kmxt::validate_authorization_envelope(envelope(key.get(), activation),
            kAppId, kKeyId, public_key, nonce, kNow, true), true, "OK");
        expect_result(kmxt::validate_authorization_envelope(envelope(key.get(), activation),
            kAppId, kKeyId, public_key, "wrong-nonce", kNow, true), false, "INVALID_RESPONSE");
        expect_result(kmxt::validate_authorization_envelope(envelope(key.get(), activation),
            kAppId, "wrong-key", public_key, nonce, kNow, true), false, "WRONG_KEY");
        json tampered_envelope = json::parse(envelope(key.get(), activation));
        tampered_envelope["payload"]["appId"] = "attacker";
        expect_result(kmxt::validate_authorization_envelope(tampered_envelope.dump(),
            kAppId, kKeyId, public_key, nonce, kNow, true), false, "INVALID_SIGNATURE");
        activation["licenseExpiresAt"] = "1970-01-01T00:01:59.999Z";
        expect_result(kmxt::validate_authorization_envelope(envelope(key.get(), activation),
            kAppId, kKeyId, public_key, nonce, kNow, true), false, "LICENSE_EXPIRED");

        json verification = authorization_payload(nonce, false);
        expect_result(kmxt::validate_authorization_envelope(envelope(key.get(), verification),
            kAppId, kKeyId, public_key, nonce, kNow, false), true, "OK");
        verification["sessionToken"] = kmxt::encode_base64url(std::vector<unsigned char>(32, 1));
        expect_result(kmxt::validate_authorization_envelope(envelope(key.get(), verification),
            kAppId, kKeyId, public_key, nonce, kNow, false), false, "INVALID_RESPONSE");

        const json unbind = {
            {"unbound", true}, {"code", "DEVICE_UNBOUND"}, {"appId", kAppId},
            {"bindingId", "22222222-2222-4222-8222-222222222222"},
            {"sessionsRevoked", 1}, {"requestNonce", nonce},
            {"issuedAt", "1970-01-01T00:02:00.000Z"},
        };
        expect_result(kmxt::validate_unbind_envelope(envelope(key.get(), unbind),
            kAppId, kKeyId, public_key, nonce, kNow), true, "OK");
        expect_result(kmxt::validate_unbind_envelope(envelope(key.get(), unbind),
            kAppId, kKeyId, public_key, "wrong-nonce", kNow), false, "INVALID_RESPONSE");

        const std::string client_public_key =
            kmxt::encode_base64url(std::vector<unsigned char>(44, 8));
        json lease = model_payload(nonce, client_public_key);
        expect_result(kmxt::validate_model_lease_envelope(envelope(key.get(), lease),
            kAppId, kKeyId, public_key, kArtifactId, nonce, client_public_key, kNow), true, "OK");
        expect_result(kmxt::validate_model_lease_envelope(envelope(key.get(), lease),
            kAppId, kKeyId, public_key, kArtifactId, "wrong-nonce", client_public_key, kNow),
            false, "WRONG_APPLICATION");
        lease["wrappedDek"]["associatedData"] = "tampered";
        expect_result(kmxt::validate_model_lease_envelope(envelope(key.get(), lease),
            kAppId, kKeyId, public_key, kArtifactId, nonce, client_public_key, kNow),
            false, "INVALID_RESPONSE");

        // 花落 / MIT：通道 B 公告信封测试向量。验证新鲜度窗口、防回滚序号、形状校验。
        json notice = notice_payload(5);
        expect_result(kmxt::validate_notice_envelope(envelope(key.get(), notice),
            kAppId, kKeyId, public_key, kNow, 0), true, "OK");
        // minSequence = 5 时，sequence = 5 刚好及格。
        expect_result(kmxt::validate_notice_envelope(envelope(key.get(), notice),
            kAppId, kKeyId, public_key, kNow, 5), true, "OK");
        // minSequence = 6 时，sequence = 5 被拒收（回滚）。
        expect_result(kmxt::validate_notice_envelope(envelope(key.get(), notice),
            kAppId, kKeyId, public_key, kNow, 6), false, "NOTICE_ROLLBACK");
        // sequence = 0 表示无公告，不受防回滚限制。
        json empty_notice = notice_payload(0);
        expect_result(kmxt::validate_notice_envelope(envelope(key.get(), empty_notice),
            kAppId, kKeyId, public_key, kNow, 100), true, "OK");
        // 类型错误拒收。
        notice["type"] = "wrong_type";
        expect_result(kmxt::validate_notice_envelope(envelope(key.get(), notice),
            kAppId, kKeyId, public_key, kNow, 0), false, "INVALID_RESPONSE");
        notice["type"] = "client_notice";
        // 新鲜度窗口之外拒收（10 分钟）。
        notice["issuedAt"] = "1970-01-01T00:13:00.000Z";
        expect_result(kmxt::validate_notice_envelope(envelope(key.get(), notice),
            kAppId, kKeyId, public_key, kNow, 0), false, "INVALID_RESPONSE");
        notice["issuedAt"] = "1970-01-01T00:02:00.000Z";
        // 公告数组形状错误时整体拒收。
        notice["announcements"] = "not-an-array";
        expect_result(kmxt::validate_notice_envelope(envelope(key.get(), notice),
            kAppId, kKeyId, public_key, kNow, 0), false, "INVALID_RESPONSE");
        notice["announcements"] = json::array();
        // 版本策略 minVersionCode > latestVersionCode 拒收。
        notice["clientPolicy"]["minVersionCode"] = 200;
        expect_result(kmxt::validate_notice_envelope(envelope(key.get(), notice),
            kAppId, kKeyId, public_key, kNow, 0), false, "INVALID_RESPONSE");

        test_model_crypto();
        std::cout << "KMXT native core vectors passed" << std::endl;
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << std::endl;
        return 1;
    }
}
