#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace kmxt::android {

enum class RequestKind { activation, verification, unbind };

std::string begin_request(RequestKind kind);
std::string begin_model_request();
void cancel_model_request();
std::string validate_activation(const std::string& envelope_json);
std::string validate_verification(const std::string& envelope_json);
std::string validate_unbind(const std::string& envelope_json);
std::string validate_model_lease(const std::string& envelope_json,
    const std::string& expected_artifact_id);
void clear_authorization_state();
bool decrypt_model_lease(std::uint64_t handle,
    const std::vector<unsigned char>& ciphertext, std::vector<unsigned char>& plaintext);
void release_model_lease(std::uint64_t handle);

#if defined(KMXT_NATIVE_RUNTIME_TESTING)
namespace testing {
void authorize_for_test(const std::string& binding_id, std::int64_t ttl_millis);
std::uint64_t store_lease_for_test(std::int64_t ttl_millis,
    std::uint64_t expected_epoch = 0);
std::size_t lease_count_for_test();
std::uint64_t authorization_epoch_for_test();
void seed_pending_model_for_test();
bool pending_model_present_for_test();
}  // namespace testing
#endif

}  // namespace kmxt::android
