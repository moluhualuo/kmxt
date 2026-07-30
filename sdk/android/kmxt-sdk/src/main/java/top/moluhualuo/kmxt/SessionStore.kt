package top.moluhualuo.kmxt

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal class SessionStore(context: Context, appId: String) {
    private val preferences = context.getSharedPreferences("kmxt.session", Context.MODE_PRIVATE)
    private val entryName = "session.$appId"
    private val noticeEntryName = "notice.sequence.$appId"
    private val alias = "kmxt.session.aes.$appId"

    fun save(token: String) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val encrypted = cipher.doFinal(token.toByteArray(Charsets.UTF_8))
        val value = Base64.encodeToString(cipher.iv + encrypted, Base64.NO_WRAP)
        preferences.edit().putString(entryName, value).apply()
    }

    fun load(): String? {
        return try {
            val bytes = Base64.decode(preferences.getString(entryName, null) ?: return null, Base64.NO_WRAP)
            if (bytes.size <= 12) return null
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
            String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8)
        } catch (_: Exception) {
            clear()
            null
        }
    }

    fun clear() { preferences.edit().remove(entryName).apply() }

    /**
     * 公告防回滚水位。刻意用明文存储而不走 Keystore 加密：
     *
     * 花落 / MIT：这个值不是秘密，只是一个单调计数器，且威胁模型里能改写本应用
     * SharedPreferences 的攻击者（root / 同 uid）本来就能直接改内存里的判定结果，
     * 加密它换不到任何实际安全收益。把水位调低的最坏后果是「看到一条十分钟新鲜度
     * 窗口内的旧公告」，不影响任何授权决策。会话令牌是真正的秘密，仍然加密。
     */
    fun loadNoticeSequence(): Long = preferences.getLong(noticeEntryName, 0L)

    /** 只增不减：并发或乱序写入都不会把水位拉低。*/
    fun saveNoticeSequence(sequence: Long) {
        if (sequence <= 0L) return
        synchronized(this) {
            if (sequence <= preferences.getLong(noticeEntryName, 0L)) return
            preferences.edit().putLong(noticeEntryName, sequence).apply()
        }
    }

    private fun key(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keyStore.getKey(alias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(alias,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .build())
        return generator.generateKey()
    }
}
