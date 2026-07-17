#include "kmxt/core.hpp"
#include <cassert>
#include <string>

int main() {
    const std::string canonical =
        R"({"appId":"00000000-0000-0000-0000-000000000000","licensed":true})";
    assert(kmxt::canonical_json(
        R"({"licensed":true,"appId":"00000000-0000-0000-0000-000000000000"})") == canonical);
    assert(kmxt::sha256_hex("abc") ==
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");

    const std::string public_key =
        "-----BEGIN PUBLIC KEY-----\n"
        "MCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=\n"
        "-----END PUBLIC KEY-----\n";
    const std::string signature =
        "978QNY8Meqdv3Un3OVwCkig5e9f1BxmScHzlADgDw3M34-fzAhcSXH0OxzAvzSdVnZO695dQqOwVdiOZmVA7Dg";
    assert(kmxt::verify_ed25519(canonical, signature, public_key));
    assert(!kmxt::verify_ed25519(canonical + " ", signature, public_key));
    return 0;
}
