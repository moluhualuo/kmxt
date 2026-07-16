# Android SDK 接入

作者：花落；协议：MIT。首版支持 Android API 24 与 `arm64-v8a`。

## 构建

要求 Android Gradle Plugin 8.7、JDK 17、NDK、CMake 3.22 和 vcpkg。以 `sdk/android/vcpkg.json` 安装 Android arm64-v8a 目标的 `openssl`。nlohmann/json 使用仓库内固定的纯头文件，不走 vcpkg CMake 包，避免 Android NDK 构建误引入 Windows/MSYS2 系统头。C++ 核心使用 C++17，并先构建为 `kmxt_core` 静态库，再链接到 `kmxt_jni`。

```bash
cd sdk/android
./gradlew :kmxt-sdk:assembleRelease -Pandroid.injected.cmake.configure.arguments=-DCMAKE_TOOLCHAIN_FILE=/opt/vcpkg/scripts/buildsystems/vcpkg.cmake
```

本机现有 Android SDK 使用 Gradle `8.14.2`、NDK `28.0.13004108` 与 CMake `3.22.1`。如已有 arm64-v8a OpenSSL 静态包，可直接指定，不依赖 vcpkg toolchain：

```powershell
gradle :kmxt-sdk:assembleRelease `
  -Pkmxt.opensslRoot=D:/path/to/android/arm64-v8a
```

`kmxt.opensslRoot` 必须包含 `include/openssl`，并包含 vcpkg 布局的 `lib/libcrypto.a` 或兼容旧布局的 `libcrypto.a`；该库必须为 Android arm64-v8a 目标，不能误用 Windows 主机库。

当前本机构建使用 OpenSSL `3.6.3`，源码包 SHA-512 与 vcpkg `ports/openssl` 中的校验值一致。由于本机没有完整 Visual Studio，vcpkg 的 host 依赖构建会卡在 `x64-windows`/PowerShell Core 下载阶段；因此本次使用 MSYS2 Perl、mingw32-make 与 Android NDK clang 手工生成 Android arm64 OpenSSL root。

项目内 SDK 目录保留源码库和构建产物：

- 源码包：`sdk/android/third_party/openssl/3.6.3/openssl-3.6.3.tar.gz`
- 源码树：`sdk/android/third_party/openssl/3.6.3/source`
- Android arm64 预编译 root：`sdk/android/prebuilt/openssl/3.6.3/arm64-v8a`

复现构建命令：

```bash
cd /f/kmxt/sdk/android/third_party/openssl/3.6.3/source
export ANDROID_NDK_ROOT=/d/exploitation/cmdline-tools/androidSDK/ndk/28.0.13004108
export ANDROID_NDK_HOME=$ANDROID_NDK_ROOT
export PATH=$ANDROID_NDK_ROOT/toolchains/llvm/prebuilt/windows-x86_64/bin:/usr/bin:/mingw64/bin:$PATH
perl Configure android-arm64 -D__ANDROID_API__=24 no-shared no-module no-apps no-tests no-docs --prefix=/f/kmxt/sdk/android/prebuilt/openssl/3.6.3/arm64-v8a
mingw32-make -j4 build_libs
mingw32-make install_sw
```

Gradle 默认使用项目内 `sdk/android/prebuilt/openssl/3.6.3/arm64-v8a`；如需临时替换，可继续用 `-Pkmxt.opensslRoot=...` 覆盖。最终 AAR 构建命令：

```powershell
$env:GRADLE_OPTS='-Dorg.gradle.internal.instrumentation.agent=false'
$env:ANDROID_HOME='D:\exploitation\cmdline-tools\androidSDK'
$env:ANDROID_SDK_ROOT=$env:ANDROID_HOME
D:\ck\gardle\gradle-8.14.2\bin\gradle.bat --no-daemon --console=plain `
  :kmxt-sdk:assembleRelease
```

当前 release AAR：

- 路径：`sdk/android/kmxt-sdk/build/outputs/aar/kmxt-sdk-release.aar`
- SHA-256：`C6ACCB3E5CE38021E6D7F3DFC99C30C1AEE52AC22BBC65CD981AAE616E67E239`
- Native：仅包含 `jni/arm64-v8a/libkmxt_jni.so`
- ELF：`ELF64`、`DYN`、`AArch64`
- OpenSSL 静态库：`sdk/android/prebuilt/openssl/3.6.3/arm64-v8a/lib/libcrypto.a`，SHA-256 `551EC903C9AB7DF25468D368009F78C2BEE5742A93375DD5806F5F47ED62EDD1`

nlohmann/json 3.12.0 纯头文件固定在 `cpp/third_party/nlohmann`，对应 MIT 文本为 `cpp/third_party/nlohmann.LICENSE.MIT`。这样 Android NDK 构建不会误引入 Windows/MSYS2 系统头；vcpkg 构建仍可继续提供 OpenSSL。

AAR 的 `classes.jar` 内置 `META-INF/LICENSE.KMXT.txt`、`META-INF/LICENSE.nlohmann-json.txt` 和 `META-INF/LICENSE.OpenSSL.txt`。KMXT 和 nlohmann/json 使用 MIT，OpenSSL 3.6.3 使用 Apache-2.0。

Android library manifest 提供默认 PNG 应用图标 `@mipmap/kmxt_launcher`、圆形图标 `@mipmap/kmxt_launcher_round` 和默认标签 `KMXT`，用于测试安装包或未设置图标的接入方应用；正式接入时宿主 app 可在自己的 manifest 中覆盖 `android:icon`、`android:roundIcon` 和 `android:label`。

## 配置与接口

从后台“程序”页下载 JSON 和 `.hpp`，或调用 `GET /api/v1/apps/:appId/client-config`。应用只内置 `baseUrl`、`appId`、`keyId`、Ed25519 公钥和协议版本，不内置卡密或私钥。

```kotlin
val client = KmxtLicenseClient(context, KmxtConfig(
    baseUrl = "https://kmxt.moluhualuo.top",
    appId = BuildConfig.KMXT_APP_ID,
    keyId = BuildConfig.KMXT_KEY_ID,
    publicKey = BuildConfig.KMXT_PUBLIC_KEY,
))

val activated = client.activate(licenseKey)
val verified = client.verify()
client.clearSession()
```

三个主接口均不在主线程执行网络。`activate` 和 `verify` 只有在 HTTPS、JSON、keyId、Ed25519、appId 与到期时间全部通过时才返回授权；网络、TLS、解析、签名或到期失败均拒绝授权。会话令牌由 Android Keystore 中不可导出的 AES-GCM 密钥加密后保存。

`KmxtLifecycleVerifier` 可注册到进程或 Activity 生命周期：每次前台恢复立即 `verify()`，成功后按签名响应中的 `heartbeatAfterSeconds` 循环；失败即停止并通过监听器返回结构化错误。SDK 不实现离线宽限。

Native 固定向量位于 `cpp/tests/core_test.cpp`，覆盖规范 JSON、SHA-256、Ed25519 正确签名和篡改拒绝。具备 host vcpkg 环境时用 `-DKMXT_BUILD_TESTS=ON` 配置 CMake 并执行 `ctest`。

Windows 本机也可直接复用 MSYS2 MinGW64 环境，无需 CMake：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/test-native.ps1
```

脚本以 `-Wall -Wextra -Werror` 编译两个核心源文件，生成 `.runtime/native-test/libkmxt_core.a` 静态库并运行相同固定向量。可用 `-MsysRoot` 指定不同的 MSYS2 根目录。

本机验证使用 Gradle 8.14.2、NDK 28、API 33 arm64 真机。`androidTest` 覆盖设备指纹同进程稳定性、Keystore 会话保存/读取/清除，以及明文 HTTP 配置拒绝；运行 `connectedDebugAndroidTest` 时同样需要提供 Android arm64 OpenSSL 根目录。本次在 Xiaomi Mi 10 / Android 13 上完成 3 个 instrumentation tests，`lintRelease`、`assembleRelease`、host native 向量、Node 测试和 Node 语法检查均通过。

## 设备指纹

输入字段为 `ANDROID_ID`、包名、所有签名证书 SHA-256 和稳定 Native 环境字段。字段带标签并按名称排序，再由 Native OpenSSL SHA-256 输出摘要。明确不读取 IMEI、真实 MAC、序列号、系统版本或 `Build.FINGERPRINT`。SDK 与服务日志均不得输出卡密、会话令牌或完整设备指纹。

## 错误

`LicenseException.code` 区分网络、TLS、响应解析、签名、公钥、程序、授权到期、会话到期、设备不符、未激活和服务拒绝。调用方在任何异常下都必须关闭受保护功能，不得把 HTTP 200 本身当成授权成功。
