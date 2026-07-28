cmake_minimum_required(VERSION 3.22.1)
project(kmxt_core LANGUAGES CXX)

find_package(OpenSSL REQUIRED COMPONENTS Crypto)

# Keep the Android include graph target-pure: importing a host MinGW CMake package would
# leak Windows system headers into the NDK sysroot. nlohmann/json is MIT licensed.
if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/third_party/nlohmann/json.hpp")
    add_library(kmxt_nlohmann_json INTERFACE)
    target_include_directories(kmxt_nlohmann_json INTERFACE
        "${CMAKE_CURRENT_SOURCE_DIR}/third_party")
    add_library(nlohmann_json::nlohmann_json ALIAS kmxt_nlohmann_json)
else()
    find_package(nlohmann_json CONFIG REQUIRED)
endif()

add_library(kmxt_core STATIC canonical_json.cpp crypto.cpp model_crypto.cpp validation.cpp)
target_compile_features(kmxt_core PUBLIC cxx_std_17)
target_include_directories(kmxt_core PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_link_libraries(kmxt_core PUBLIC OpenSSL::Crypto nlohmann_json::nlohmann_json)
target_compile_options(kmxt_core PRIVATE
    -fvisibility=hidden -fvisibility-inlines-hidden
    -ffunction-sections -fdata-sections -fstack-protector-strong -D_FORTIFY_SOURCE=2)

if(ANDROID)
    add_library(kmxt_jni SHARED jni_bridge.cpp native_runtime.cpp)
    target_compile_features(kmxt_jni PRIVATE cxx_std_17)
    target_compile_options(kmxt_jni PRIVATE
        -fvisibility=hidden -fvisibility-inlines-hidden
        -ffunction-sections -fdata-sections -fstack-protector-strong -D_FORTIFY_SOURCE=2)
    target_link_libraries(kmxt_jni PRIVATE kmxt_core log)
    if(CMAKE_BUILD_TYPE STREQUAL "Release" OR CMAKE_BUILD_TYPE STREQUAL "RelWithDebInfo")
        target_link_options(kmxt_jni PRIVATE
            "-Wl,--version-script=${CMAKE_CURRENT_SOURCE_DIR}/export.map"
            -Wl,--gc-sections -Wl,--exclude-libs,ALL -Wl,--strip-all
            -Wl,-z,relro -Wl,-z,now -Wl,-z,noexecstack -Wl,--build-id=sha1)
    endif()
endif()

option(KMXT_BUILD_TESTS "Build host-side KMXT core vectors" OFF)
if(KMXT_BUILD_TESTS)
    enable_testing()
    add_executable(kmxt_core_test tests/core_test.cpp)
    target_link_libraries(kmxt_core_test PRIVATE kmxt_core)
    add_test(NAME kmxt_core_vectors COMMAND kmxt_core_test)

    # Author: 花落, MIT License. Exercise authorization-bound native secret lifetime on host.
    add_executable(kmxt_runtime_state_test tests/runtime_state_test.cpp native_runtime.cpp)
    target_compile_definitions(kmxt_runtime_state_test PRIVATE KMXT_NATIVE_RUNTIME_TESTING=1)
    target_link_libraries(kmxt_runtime_state_test PRIVATE kmxt_core)
    add_test(NAME kmxt_runtime_state COMMAND kmxt_runtime_state_test)
endif()
