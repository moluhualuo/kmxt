package top.moluhualuo.kmxt

import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import java.security.MessageDigest

internal object DeviceFingerprint {
    @SuppressLint("HardwareIds")
    fun create(context: Context): String {
        val packageName = context.packageName
        val fields = sortedMapOf(
            "android_id" to (Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID) ?: ""),
            "native_environment" to NativeCore.stableEnvironment(),
            "package_name" to packageName,
            "signing_certificate_sha256" to signingCertificateDigest(context),
        )
        val canonical = fields.entries.joinToString("\n") { "${it.key}=${it.value}" }
        return NativeCore.sha256(canonical)
    }

    @Suppress("DEPRECATION")
    private fun signingCertificateDigest(context: Context): String {
        val signatures = if (Build.VERSION.SDK_INT >= 28) {
            val info = context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
            info.signingInfo?.apkContentsSigners.orEmpty()
        } else {
            context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_SIGNATURES).signatures.orEmpty()
        }
        val digest = MessageDigest.getInstance("SHA-256")
        return signatures.map { signature ->
            digest.digest(signature.toByteArray()).joinToString("") { "%02x".format(it) }
        }.sorted().joinToString(",")
    }
}
