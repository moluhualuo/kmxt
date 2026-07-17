plugins {
    id("com.android.application")
    kotlin("android")
}

android {
    namespace = "top.moluhualuo.kmxt.demo"
    compileSdk = 35

    defaultConfig {
        applicationId = "top.moluhualuo.kmxt.demo"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "0.5.0-demo"
        ndk { abiFilters += "arm64-v8a" }

        buildConfigField("String", "KMXT_BASE_URL", "\"https://kmxt.moluhualuo.top\"")
        buildConfigField("String", "KMXT_APP_ID", "\"00000000-0000-0000-0000-000000000000\"")
        buildConfigField("String", "KMXT_KEY_ID", "\"replace-with-key-id\"")
        buildConfigField("String", "KMXT_PUBLIC_KEY", "\"-----BEGIN PUBLIC KEY-----\\nREPLACE_WITH_PUBLIC_KEY\\n-----END PUBLIC KEY-----\"")
    }

    buildFeatures { buildConfig = true }

    compileOptions {
        isCoreLibraryDesugaringEnabled = true
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation(project(":kmxt-sdk"))
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.3")
}
