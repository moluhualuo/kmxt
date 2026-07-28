package top.moluhualuo.kmxt

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import java.security.MessageDigest

/**
 * Collects this process's own APK binding facts for WS4 anti-repackaging:
 * package name, versionCode, and signing certificate SHA-256.
 * Author: 花落, MIT License.
 *
 * 纯客户端采集，判定权在服务端（与应用注册的绑定约束比对）。任何读取失败均静默降级为 null，
 * 由服务端按应用是否注册绑定决定放行或拒绝。
 */
internal object ClientBinding {

    data class Facts(
        val packageName: String?,
        val versionCode: Long?,
        val certSha256: String?,
    )

    fun collect(context: Context): Facts {
        val packageName = runCatching { context.packageName }.getOrNull()
        val versionCode = runCatching { readVersionCode(context) }.getOrNull()
        val certSha256 = runCatching { readCertSha256(context) }.getOrNull()
        return Facts(packageName, versionCode, certSha256)
    }

    private fun readVersionCode(context: Context): Long {
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            info.longVersionCode
        } else {
            @Suppress("DEPRECATION")
            info.versionCode.toLong()
        }
    }

    private fun readCertSha256(context: Context): String? {
        val pm = context.packageManager
        val packageName = context.packageName
        val certificates = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val info = pm.getPackageInfo(packageName, PackageManager.GET_SIGNING_CERTIFICATES)
            val signingInfo = info.signingInfo
            when {
                signingInfo == null -> emptyList()
                signingInfo.hasMultipleSigners() -> signingInfo.apkContentsSigners.toList()
                else -> signingInfo.signingCertificateHistory.toList()
            }
        } else {
            @Suppress("DEPRECATION")
            val info = pm.getPackageInfo(packageName, PackageManager.GET_SIGNATURES)
            @Suppress("DEPRECATION")
            info.signatures?.toList() ?: emptyList()
        }
        val first = certificates.firstOrNull() ?: return null
        val digest = MessageDigest.getInstance("SHA-256").digest(first.toByteArray())
        return digest.joinToString("") { "%02x".format(it) }
    }
}
