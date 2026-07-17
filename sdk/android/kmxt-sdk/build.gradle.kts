plugins {
    id("com.android.library")
    kotlin("android")
}

val kmxtDefaultOpenSslRoot = file("../prebuilt/openssl/3.6.3/arm64-v8a").absolutePath
val kmxtOpenSslRoot = providers.gradleProperty("kmxt.opensslRoot").orNull ?: kmxtDefaultOpenSslRoot
val kmxtOpenSslCryptoLibrary = kmxtOpenSslRoot?.let { root ->
    file("$root/lib/libcrypto.a").takeIf { it.exists() } ?: file("$root/libcrypto.a")
}

android {
    namespace = "top.moluhualuo.kmxt"
    compileSdk = 35
    ndkVersion = "28.0.13004108"
    defaultConfig {
        minSdk = 24
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        ndk { abiFilters += "arm64-v8a" }
        externalNativeBuild {
            cmake {
                cppFlags += listOf("-std=c++17", "-fvisibility=hidden")
                kmxtOpenSslRoot?.let { root ->
                    arguments += listOf(
                        "-DOPENSSL_USE_STATIC_LIBS=TRUE",
                        "-DOPENSSL_INCLUDE_DIR=$root/include",
                        "-DOPENSSL_CRYPTO_LIBRARY=${kmxtOpenSslCryptoLibrary?.absolutePath}",
                    )
                }
            }
        }
        consumerProguardFiles("consumer-rules.pro")
    }
    externalNativeBuild {
        cmake { path = file("src/main/cpp/CMakeLists.txt"); version = "3.22.1" }
    }
    buildFeatures { buildConfig = false }
    compileOptions {
        isCoreLibraryDesugaringEnabled = true
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    lint { disable += "ChromeOsAbiSupport" }
}

dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.3")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("androidx.lifecycle:lifecycle-common:2.8.7")
    androidTestImplementation("androidx.test:core:1.6.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("junit:junit:4.13.2")
}
