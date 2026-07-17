#include "kmxt/core.hpp"
#include <nlohmann/json.hpp>

namespace kmxt {
std::string canonical_json(const std::string& value) {
    const auto parsed = nlohmann::json::parse(value);
    return parsed.dump(-1, ' ', false, nlohmann::json::error_handler_t::strict);
}
}
