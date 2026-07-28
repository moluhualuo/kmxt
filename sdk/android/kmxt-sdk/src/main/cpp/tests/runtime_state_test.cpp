#include "kmxt/core.hpp"
#include "kmxt/native_runtime.hpp"

#include <chrono>
#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace {
void require(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}
}  // namespace

int main() {
    try {
        // Author: 花落, MIT License. Revocation must invalidate every outstanding native secret.
        kmxt::android::clear_authorization_state();
        kmxt::android::testing::authorize_for_test("binding-a", 60'000);
        const std::uint64_t first_epoch =
            kmxt::android::testing::authorization_epoch_for_test();

        std::vector<std::uint64_t> handles;
        for (int index = 0; index < 16; ++index) {
            const auto handle = kmxt::android::testing::store_lease_for_test(60'000);
            require(handle != 0, "bounded lease handle was not created");
            handles.push_back(handle);
        }
        require(kmxt::android::testing::store_lease_for_test(60'000) == 0,
            "lease handle capacity was not enforced");
        require(kmxt::android::testing::lease_count_for_test() == 16,
            "lease handle count mismatch");

        kmxt::android::clear_authorization_state();
        require(kmxt::android::testing::lease_count_for_test() == 0,
            "authorization clear retained DEK handles");
        std::vector<unsigned char> plaintext;
        require(!kmxt::android::decrypt_model_lease(handles.front(), {0}, plaintext),
            "revoked lease handle remained usable");

        kmxt::android::testing::authorize_for_test("binding-a", 60'000);
        require(kmxt::android::testing::store_lease_for_test(60'000, first_epoch) == 0,
            "stale authorization epoch inserted a lease handle");
        require(kmxt::android::testing::store_lease_for_test(5) != 0,
            "short signed lease was not stored");
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
        require(kmxt::android::testing::lease_count_for_test() == 0,
            "expired lease handle was not wiped lazily");

        kmxt::android::testing::seed_pending_model_for_test();
        require(kmxt::android::testing::pending_model_present_for_test(),
            "pending model key setup failed");
        kmxt::android::cancel_model_request();
        require(!kmxt::android::testing::pending_model_present_for_test(),
            "cancel retained the pending X25519 private key");

        std::int64_t parsed = 0;
        require(kmxt::parse_iso8601_millis("1970-01-01T00:10:00.000Z", parsed)
                && parsed == 600'000,
            "signed lease expiry parser mismatch");
        require(!kmxt::parse_iso8601_millis("1970-01-01T00:10:00Z", parsed),
            "non-canonical signed expiry was accepted");

        std::cout << "KMXT native runtime state passed" << std::endl;
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << std::endl;
        return 1;
    }
}
