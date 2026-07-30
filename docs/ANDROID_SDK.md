# Android SDK 接入

作者：花落；协议：MIT。首版支持 Android API 24 与 `arm64-v8a`。

## 构建

要求 Android Gradle Plugin 8.7、JDK 17、NDK、CMake 3.22 和 vcpkg。以 `sdk/android/vcpkg.json` 安装 Android arm64-v8a 目标的 `openssl`。nlohmann/json 使用仓库内固定的纯头文件，不走 vcpkg CMake 包，避免 Android NDK 构建误引入 Windows/MSYS2 系统头。C++ 核心使用 C++17，并先构建为 `kmxt_core` 静态库，再链接到 `kmxt_jni`。

仓库根 `.gitignore` 排除 Gradle、Kotlin、CMake、各模块 `build/` 和本地
`sdk/android/third_party/` 构建树。构建所需的 Android arm64 OpenSSL 头文件与静态库固定在
已跟踪的 `sdk/android/prebuilt/openssl/3.6.3/arm64-v8a`；不要提交上游完整源码树、对象文件、
依赖文件或测试密钥材料。AAR、APK 和本地 CMake 输出仍属于生成物。

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

仓库只保留 Android arm64 预编译 root：

- `sdk/android/prebuilt/openssl/3.6.3/arm64-v8a`

如需复现该预编译库，应从 OpenSSL 官方发布源下载 3.6.3 源码包，在仓库外的临时
工作目录验证校验值并构建，完成后只更新上述 prebuilt root 及其许可/校验文档。

复现构建命令：

```bash
cd /tmp/openssl-3.6.3
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
- SHA-256：`c3bb65e68f05ffa038e14901918d3b2581e52a11b59aba75269d43d2e0b828bc`
- Native：仅包含 `jni/arm64-v8a/libkmxt_jni.so`
- ELF：`ELF64`、`DYN`、`AArch64`
- OpenSSL 静态库：`sdk/android/prebuilt/openssl/3.6.3/arm64-v8a/lib/libcrypto.a`，SHA-256 `551EC903C9AB7DF25468D368009F78C2BEE5742A93375DD5806F5F47ED62EDD1`

nlohmann/json 3.12.0 纯头文件固定在 `cpp/third_party/nlohmann`，对应 MIT 文本为 `cpp/third_party/nlohmann.LICENSE.MIT`。这样 Android NDK 构建不会误引入 Windows/MSYS2 系统头；vcpkg 构建仍可继续提供 OpenSSL。

AAR 的 `classes.jar` 内置 `META-INF/LICENSE.KMXT.txt`、`META-INF/LICENSE.nlohmann-json.txt` 和 `META-INF/LICENSE.OpenSSL.txt`。KMXT 和 nlohmann/json 使用 MIT，OpenSSL 3.6.3 使用 Apache-2.0。

Android library manifest 提供默认 PNG 应用图标 `@mipmap/kmxt_launcher`、圆形图标 `@mipmap/kmxt_launcher_round` 和默认标签 `KMXT`，用于测试安装包或未设置图标的接入方应用；正式接入时宿主 app 可在自己的 manifest 中覆盖 `android:icon`、`android:roundIcon` 和 `android:label`。

## Demo App

`sdk/android/demo-app` 是本地接入示例应用，不参与线上部署。它依赖 `:kmxt-sdk`，提供卡密输入、激活、会话验证、主动解绑和仅清除本机会话按钮，并使用 PNG launcher 图标，避免把 instrumentation test APK 当作正式应用安装。

默认配置位于 `demo-app/build.gradle.kts` 的 BuildConfig 字段：

- `KMXT_BASE_URL`
- `KMXT_APP_ID`
- `KMXT_KEY_ID`
- `KMXT_PUBLIC_KEY`

从后台“程序”页下载 Android JSON/头文件后，将对应字段替换到 demo app，再构建：

```powershell
$env:GRADLE_OPTS='-Dorg.gradle.internal.instrumentation.agent=false'
$env:ANDROID_HOME='D:\exploitation\cmdline-tools\androidSDK'
$env:ANDROID_SDK_ROOT=$env:ANDROID_HOME
D:\ck\gardle\gradle-8.14.2\bin\gradle.bat --no-daemon --console=plain :demo-app:assembleDebug
```

产物路径：`sdk/android/demo-app/build/outputs/apk/debug/demo-app-debug.apk`。当前 badging 已确认 `top.moluhualuo.kmxt.demo.MainActivity` 为 launcher activity，图标为 `res/mipmap-*-v4/kmxt_launcher.png`，native-code 为 `arm64-v8a`。

## 配置与接口

从后台”程序”页下载 JSON 和 `.hpp`，或调用 `GET /api/v1/apps/:appId/client-config`。ScreenYolo app-specific AAR 的 Kotlin 配置只内置 `baseUrl`、`appId` 和协议版本；`keyId`、Ed25519 公钥和 applicationId 映射编译进 native trust store，不内置卡密或私钥。

```kotlin
val client = KmxtLicenseClient(context, KmxtConfig(
    baseUrl = “https://kmxt.moluhualuo.top”,
    appId = BuildConfig.KMXT_APP_ID,
))

val activated = client.activate(licenseKey)
val verified = client.verify()
val unbound = client.unbind()
val notices = client.fetchNotices()
val lease = client.requestModelLease(artifactId)
try {
    // Read the local .vmp packed in APK assets, verify cipherSha256/size, then let the
    // one-use native handle decrypt. Ciphertext ships with the APK; the server never hosts it.
    nativeModelLoader.openEncrypted(lease.decrypt(ciphertext))
} finally {
    lease.wipe()
}
client.clearSession()
```

`activate`、`verify` 和 `unbind` 均不在主线程执行网络。每次调用独立保存本次请求 Nonce，并在 Ed25519 验签后严格比较签名载荷的 `requestNonce`；旧响应重放、字段缺失或错 nonce 均失败关闭。`activate` 和 `verify` 只有在 HTTPS、JSON、keyId、Ed25519、appId、requestNonce 与到期时间全部通过时才返回授权；`unbind` 只有在签名、固定程序、requestNonce、`unbound=true` 和 `DEVICE_UNBOUND` 全部通过后才清除 Keystore 加密会话。网络、TLS、解析或签名失败均不会误报解绑成功。会话令牌由 Android Keystore 中不可导出的 AES-GCM 密钥加密后保存。

`unbind()` 返回 `DeviceUnbindStatus`，包含 `bindingId` 和服务端实际撤销的 `sessionsRevoked`。若服务端返回 `SESSION_EXPIRED` 或 `DEVICE_MISMATCH`，SDK 会清除已经不可继续使用的本地会话；其他网络或签名错误保留会话，调用方可在网络恢复后重试。

### 公告与版本策略

`activate` 和 `verify` 的授权响应自动包含 `clientPolicy` 和 `announcements`：

- `clientPolicy.minVersionCode`：硬性最低版本要求，低于此版本应禁用激活按钮
- `clientPolicy.latestVersionCode/latestVersionName/releaseNotes`：建议更新信息
- `announcements`：当前有效的系统公告列表（最多 3 条，按序号倒序）

未激活用户可通过 `fetchNotices(appId)` 从独立公开端点获取相同内容：

```kotlin
val notices = client.fetchNotices(appId)
val policy = notices.clientPolicy
val announcements = notices.announcements

// 检查版本策略
if (policy.minVersionCode != null && BuildConfig.VERSION_CODE < policy.minVersionCode) {
    // 禁用激活按钮，提示强制更新
    showForceUpdateDialog(policy.latestVersionName, policy.releaseNotes)
    return
}

// 渲染公告
for (announcement in announcements) {
    addAnnouncementCard(announcement.severity, announcement.title, announcement.body)
}
```

**客户端验证要求**：

1. 验证 Ed25519 签名和固定 `keyId`
2. 验证 `payload.appId` 与当前程序一致
3. 验证 `payload.type === 'client_notice'`（仅 `fetchNotices`）
4. 检查 `issuedAt` 时间戳新鲜度（容忍 5 分钟内）
5. **防回滚**：SDK 自动比较 `payload.sequence` 与 SharedPreferences 中的 `lastSeenSequence`
   - 如果 `sequence < lastSeenSequence`，抛出 `LicenseException.NOTICE_ROLLBACK`
   - 如果 `sequence >= lastSeenSequence`，更新持久化记录
6. 检查版本策略并禁用激活（当 `versionCode < minVersionCode` 时）
7. 渲染公告时使用纯文本 `TextView`，按 `severity` 分配颜色（`critical` 红色、`warning` 橙色、`info` 蓝色）

**容错处理**：

- `fetchNotices()` 签名验证失败或服务不可用（503）时抛出异常
- 调用方应 `catch` 异常并跳过公告显示，不阻塞激活流程
- `activate` 和 `verify` 响应中的公告解析失败不影响授权结果（容错设计）

`KmxtLifecycleVerifier` 可注册到进程或 Activity 生命周期：每次前台恢复立即 `verify()`，成功后按签名响应中的 `heartbeatAfterSeconds` 循环；失败即停止并通过监听器返回结构化错误。SDK 不实现离线宽限。

Native 固定向量位于 `cpp/tests/core_test.cpp`，覆盖规范 JSON、SHA-256、Ed25519 正确签名和篡改拒绝。具备 host vcpkg 环境时用 `-DKMXT_BUILD_TESTS=ON` 配置 CMake 并执行 `ctest`。

Windows 本机也可直接复用 MSYS2 MinGW64 环境，无需 CMake：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/test-native.ps1
```

脚本以 `-Wall -Wextra -Werror` 编译 canonical JSON、OpenSSL crypto、native lease crypto 和 validator，生成 `.runtime/native-test/libkmxt_core.a` 静态库并运行固定向量。可用 `-MsysRoot` 指定不同的 MSYS2 根目录。

本机验证使用 Gradle 8.14.2、NDK 28、API 33 arm64 真机。`androidTest` 覆盖设备指纹同进程稳定性、Keystore 会话保存/读取/清除，以及明文 HTTP 配置拒绝；运行 `connectedDebugAndroidTest` 时同样需要提供 Android arm64 OpenSSL 根目录。本次在 Xiaomi Mi 10 / Android 13 上完成 3 个 instrumentation tests，`lintRelease`、`assembleRelease`、host native 向量、Node 测试和 Node 语法检查均通过。

## 设备指纹

输入字段为 `ANDROID_ID`、包名、所有签名证书 SHA-256 和稳定 Native 环境字段。字段带标签并按名称排序，再由 Native OpenSSL SHA-256 输出摘要。明确不读取 IMEI、真实 MAC、序列号、系统版本或 `Build.FINGERPRINT`。SDK 与服务日志均不得输出卡密、会话令牌或完整设备指纹。

## 错误

`LicenseException.code` 区分网络、TLS、响应解析、签名、公钥、程序、授权到期、会话到期、设备不符、未激活和服务拒绝。调用方在任何异常下都必须关闭受保护功能，不得把 HTTP 200 本身当成授权成功。

## 模型租约

`requestModelLease(artifactId)` 需要已有 Keystore 加密会话。SDK 每次调用在 native 生成
临时 X25519 密钥对和新的 Nonce；收到响应后在 C++ 依次检查 Ed25519、
固定 `keyId/appId/artifactId`、原请求 Nonce、客户端公钥指纹、租约时间和
包裹算法，然后使用 HKDF-SHA256/AES-GCM 解出 32 字节 DEK 并保存为一次性 handle。
HTTP、解析、验签、解包等任意失败以及协程取消都会调用 native cancel，立即擦除尚未
消费的 X25519 私钥和请求 Nonce；只有成功交付 `ModelLease` 时才保留其 handle。

`ModelLease` 不暴露 `contentKey`；`decrypt()` 消费 native handle，调用方仍必须在
`finally` 中执行 `wipe()` 清理未使用 handle；不得写入 SharedPreferences、数据库、日志或缓存。
密文 `.vmp` 随 APK 打包在本地 assets，服务端不托管密文；调用方从本地读入密文后先用
租约签发的 `cipherSha256/size` 校验完整性，再交 native 用 DEK 解密。Native 以签名载荷的 `expiresAt` 作为 handle 硬期限，并限制
内存 handle 表容量；到期 handle 立即不可用，其 DEK 和物理表项在后续 handle 操作时
惰性擦除。清理后容量仍满则拒绝创建新 handle，不覆盖仍有效条目。

`clearSession()` 会同时清除 Keystore 会话、native 授权状态和全部未消费 DEK handle。
心跳、解绑或租约验证识别出 `SESSION_EXPIRED`/`DEVICE_MISMATCH` 后执行该清理；服务端
撤销不会凭空推送到离线进程，客户端必须持续在线验证。当前实现使用进程内临时 X25519 私钥；硬件 Keystore
持有证明与服务端 attestation 校验是下一阶段，不应把软件设备指纹视为硬件证明。
