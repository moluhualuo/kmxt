package top.moluhualuo.kmxt

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import javax.net.ssl.SSLException

class KmxtLicenseClient(
    context: Context,
    private val config: KmxtConfig,
    httpClient: OkHttpClient? = null,
    private val clientVersion: String? = null,
) {
    private val applicationContext = context.applicationContext
    private val sessions = SessionStore(applicationContext, config.appId)
    private val client = httpClient ?: OkHttpClient.Builder()
        .followRedirects(false)
        .followSslRedirects(false)
        .build()

    suspend fun activate(licenseKey: String): AuthorizationStatus = withContext(Dispatchers.IO) {
        val request = commonRequest(beginNonce(NativeCore.beginActivationRequest()))
            .put("licenseKey", licenseKey)
        val envelope = post("/api/v1/client/activate", request)
        val validation = validateAuthorization(envelope, activation = true)
        val token = validation.payload.optString("sessionToken")
        if (token.isBlank()) throw LicenseException(LicenseErrorCode.INVALID_RESPONSE, "Activation response omitted the session token")
        sessions.save(token)
        validation.status
    }

    suspend fun verify(): AuthorizationStatus = withContext(Dispatchers.IO) {
        val token = sessions.load() ?: throw LicenseException(
            LicenseErrorCode.NOT_ACTIVATED, "No encrypted KMXT session is available")
        try {
            validateAuthorization(
                post("/api/v1/client/verify", commonRequest(
                    beginNonce(NativeCore.beginVerificationRequest()),
                ).put("sessionToken", token)),
                activation = false,
            ).status
        } catch (error: LicenseException) {
            if (error.code in setOf(LicenseErrorCode.SESSION_EXPIRED, LicenseErrorCode.DEVICE_MISMATCH)) clearSession()
            throw error
        }
    }

    suspend fun unbind(): DeviceUnbindStatus = withContext(Dispatchers.IO) {
        val token = sessions.load() ?: throw LicenseException(
            LicenseErrorCode.NOT_ACTIVATED, "No encrypted KMXT session is available")
        try {
            val status = validateUnbind(
                post("/api/v1/client/unbind", commonRequest(
                    beginNonce(NativeCore.beginUnbindRequest()),
                ).put("sessionToken", token)))
            sessions.clear()
            status
        } catch (error: LicenseException) {
            if (error.code in setOf(LicenseErrorCode.SESSION_EXPIRED, LicenseErrorCode.DEVICE_MISMATCH)) clearSession()
            throw error
        }
    }

    /**
     * Requests a short-lived, device-bound content key for an active encrypted artifact.
     * The X25519 private key is ephemeral and never leaves this process.
     * Failed or cancelled requests erase their pending native state.
     * Author: 花落, MIT License.
     */
    suspend fun requestModelLease(artifactId: String): ModelLease {
        var abandonedLease: ModelLease? = null
        try {
            val lease = withContext(Dispatchers.IO) {
                require(artifactId.length == 36) { "artifactId must be a UUID" }
                val token = sessions.load() ?: throw LicenseException(
                    LicenseErrorCode.NOT_ACTIVATED, "No encrypted KMXT session is available")
                val nativeRequest = beginModelLeaseRequest()
                val request = commonRequest(nativeRequest.nonce)
                    .put("sessionToken", token)
                    .put("clientPublicKey", nativeRequest.clientPublicKey)
                validateModelLease(
                    envelope = post("/api/v1/client/artifacts/$artifactId/lease", request),
                    artifactId = artifactId,
                ).also { abandonedLease = it }
            }
            abandonedLease = null
            return lease
        } catch (error: Throwable) {
            try {
                NativeCore.cancelModelLeaseRequest()
            } catch (cleanupError: Throwable) {
                error.addSuppressed(cleanupError)
            }
            try {
                abandonedLease?.wipe()
            } catch (cleanupError: Throwable) {
                error.addSuppressed(cleanupError)
            }
            if (error is LicenseException && error.code in setOf(
                    LicenseErrorCode.SESSION_EXPIRED,
                    LicenseErrorCode.DEVICE_MISMATCH,
                )) {
                clearSession()
            }
            throw error
        }
    }

    /**
     * 通道 B：读取公开公告与版本策略。无需卡密会话，未激活用户也可调用。
     *
     * 花落 / MIT：调用方必须把它当作「纯展示数据」，不得用返回值做任何放行判断。
     * 强制更新的真正拒绝点在服务端（activate/verify 返回 426 CLIENT_UPDATE_REQUIRED），
     * 这里的 policy 只用于把「为什么被拒」告诉用户。若把放行判断建在这个通道上，
     * 攻击者只要断掉这一个请求就能绕过强制更新——这正是要避免的漏洞。
     *
     * 响应经原生层验签 + 形状校验 + 序号防回滚；通过后水位才落盘。
     */
    suspend fun fetchNotices(): NoticeBundle = withContext(Dispatchers.IO) {
        val envelope = get("/api/v1/client/apps/${config.appId}/notices")
        val minimumSequence = sessions.loadNoticeSequence()
        val payload = nativePayload(
            NativeCore.validateNoticeEnvelope(envelope.toString(), minimumSequence),
        )
        val sequence = payload.optLong("sequence", 0L)
        sessions.saveNoticeSequence(sequence)
        NoticeBundle(
            sequence = sequence,
            issuedAt = payload.optString("issuedAt"),
            policy = readClientPolicy(payload.optJSONObject("clientPolicy"))
                ?: ClientPolicy(null, null, null, null),
            announcements = readAnnouncements(payload.optJSONArray("announcements")),
        )
    }

    fun clearSession() {
        sessions.clear()
        NativeCore.clearAuthorization()
    }

    private fun commonRequest(requestNonce: String) = JSONObject()
        .put("appId", config.appId)
        .put("deviceId", DeviceFingerprint.create(applicationContext))
        .put("timestamp", System.currentTimeMillis())
        .put("nonce", requestNonce)
        .apply { clientVersion?.let { put("clientVersion", it) } }
        // WS4 花落/MIT: 附带本 APK 的包名 / versionCode / 签名证书 SHA-256，供服务端强制
        // 防重打包绑定校验。采集失败静默跳过，由服务端按注册状态决定是否拒绝。
        .apply {
            val binding = ClientBinding.collect(applicationContext)
            binding.packageName?.let { put("packageName", it) }
            binding.versionCode?.let { put("versionCode", it) }
            binding.certSha256?.let { put("certSha256", it) }
        }

    private fun beginNonce(value: String): String = value.takeIf { it.isNotBlank() }
        ?: throw LicenseException(LicenseErrorCode.INVALID_RESPONSE, "Native request nonce is unavailable")

    private data class NativeModelRequest(val nonce: String, val clientPublicKey: String)

    private fun beginModelLeaseRequest(): NativeModelRequest {
        val request = try {
            JSONObject(NativeCore.beginModelLeaseRequest())
        } catch (error: Exception) {
            throw LicenseException(
                LicenseErrorCode.NOT_ACTIVATED,
                "Native authorization state is unavailable",
                cause = error,
            )
        }
        val nonce = request.optString("nonce")
        val clientPublicKey = request.optString("clientPublicKey")
        if (nonce.isBlank() || clientPublicKey.isBlank()) {
            throw LicenseException(
                LicenseErrorCode.NOT_ACTIVATED,
                "Native authorization state is unavailable",
            )
        }
        return NativeModelRequest(nonce, clientPublicKey)
    }

    private fun post(path: String, body: JSONObject): JSONObject = execute(
        baseRequest(path).post(body.toString().toRequestBody(JSON_MEDIA_TYPE)).build(),
    )

    // 花落 / MIT：通道 B 是只读 GET，复用 post 的响应处理（success/error/data 与错误码映射），
    // 避免两条路径对服务端错误的解释产生分歧。传输层约束（禁跳转、HTTPS）由同一个
    // OkHttpClient 与 KmxtConfig 的 https 断言保证，公告通道不放松任何一项。
    private fun get(path: String): JSONObject = execute(baseRequest(path).get().build())

    private fun baseRequest(path: String) = Request.Builder()
        .url(config.baseUrl.trimEnd('/') + path)
        .header("Accept", "application/json")
        .header("User-Agent", "KMXT-Android/0.5.0")

    private fun execute(request: Request): JSONObject {
        val raw = try {
            client.newCall(request).execute().use { response ->
                response.body?.string() ?: throw LicenseException(LicenseErrorCode.INVALID_RESPONSE, "Empty server response")
            }
        } catch (error: SSLException) {
            throw LicenseException(LicenseErrorCode.TLS_ERROR, "TLS verification failed", cause = error)
        } catch (error: IOException) {
            throw LicenseException(LicenseErrorCode.NETWORK_ERROR, "Online verification failed", cause = error)
        }
        val response = try { JSONObject(raw) } catch (error: Exception) {
            throw LicenseException(LicenseErrorCode.INVALID_RESPONSE, "Server response is not JSON", cause = error)
        }
        if (!response.optBoolean("success")) {
            val serverError = response.optJSONObject("error")
            val serverCode = serverError?.optString("code")
            throw LicenseException(mapServerCode(serverCode), serverError?.optString("message") ?: "Server rejected authorization", serverCode)
        }
        return response.optJSONObject("data")
            ?: throw LicenseException(LicenseErrorCode.INVALID_RESPONSE, "Server response omitted data")
    }

    private data class ValidatedAuthorization(
        val status: AuthorizationStatus,
        val payload: JSONObject,
    )

    private fun validateAuthorization(
        envelope: JSONObject,
        activation: Boolean,
    ): ValidatedAuthorization {
        val payload = nativePayload(
            if (activation) NativeCore.validateActivationEnvelope(envelope.toString())
            else NativeCore.validateVerificationEnvelope(envelope.toString()),
        )
        val status = AuthorizationStatus(
            licensed = true,
            code = payload.optString("code"),
            appId = payload.getString("appId"),
            licenseExpiresAt = payload.getString("licenseExpiresAt"),
            sessionExpiresAt = payload.getString("sessionExpiresAt"),
            heartbeatAfterSeconds = payload.getLong("heartbeatAfterSeconds"),
            // 花落 / MIT：通道 A 搭载的展示数据。原生层已经校验过形状并在非法时剥离，
            // 这里只做读取；缺失是正常状态（老服务端、或被原生层剥离），不抛异常。
            policy = readClientPolicy(payload.optJSONObject("clientPolicy")),
            announcements = readAnnouncements(payload.optJSONArray("announcements")),
        )
        return ValidatedAuthorization(status, payload)
    }

    private fun validateUnbind(envelope: JSONObject): DeviceUnbindStatus {
        val payload = nativePayload(
            NativeCore.validateUnbindEnvelope(envelope.toString()),
        )
        return DeviceUnbindStatus(
            unbound = true,
            code = payload.getString("code"),
            appId = payload.getString("appId"),
            bindingId = payload.getString("bindingId"),
            sessionsRevoked = payload.getLong("sessionsRevoked"),
        )
    }

    private fun validateModelLease(
        envelope: JSONObject,
        artifactId: String,
    ): ModelLease {
        val payload = nativePayload(
            NativeCore.validateModelLeaseEnvelope(envelope.toString(), artifactId),
        )
        val leaseId = payload.getString("leaseId")
        val bindingId = payload.getString("bindingId")
        val cipherSha256 = payload.getString("cipherSha256")
        val size = payload.getLong("size")
        val format = payload.getString("format")
        val name = payload.optString("name")
        val version = payload.optString("version")
        val keyVersion = payload.getLong("keyVersion")
        val encryption = payload.getJSONObject("encryption")
        val encryptionNonce = encryption.getString("nonce")
        val encryptionTag = encryption.getString("tag")
        val issuedAt = payload.optString("issuedAt")
        val expiresAt = payload.optString("expiresAt")
        val nativeHandle = payload.getLong("_nativeLeaseHandle")
        if (nativeHandle <= 0L) {
            throw LicenseException(LicenseErrorCode.INVALID_CLIENT_KEY, "Native model lease handle is invalid")
        }
        return ModelLease(
            artifactId = artifactId,
            name = name,
            version = version,
            format = format,
            cipherSha256 = cipherSha256,
            size = size,
            encryptionAlgorithm = "AES-256-GCM",
            encryptionNonce = encryptionNonce,
            encryptionTag = encryptionTag,
            keyVersion = keyVersion,
            leaseId = leaseId,
            bindingId = bindingId,
            issuedAt = issuedAt,
            expiresAt = expiresAt,
            nativeHandle = nativeHandle,
        )
    }

    /** 缺失或显式 null 的字段统一读成 null，避免把 JSON null 读成字符串 "null"。*/
    private fun optionalString(source: JSONObject, field: String): String? {
        if (!source.has(field) || source.isNull(field)) return null
        return source.optString(field).takeIf { it.isNotEmpty() }
    }

    private fun optionalLong(source: JSONObject, field: String): Long? {
        if (!source.has(field) || source.isNull(field)) return null
        return source.optLong(field, -1L).takeIf { it >= 0L }
    }

    private fun readClientPolicy(source: JSONObject?): ClientPolicy? {
        if (source == null) return null
        return ClientPolicy(
            minVersionCode = optionalLong(source, "minVersionCode"),
            latestVersionCode = optionalLong(source, "latestVersionCode"),
            latestVersionName = optionalString(source, "latestVersionName"),
            releaseNotes = optionalString(source, "releaseNotes"),
        )
    }

    private fun readAnnouncements(source: org.json.JSONArray?): List<Announcement> {
        if (source == null) return emptyList()
        val result = ArrayList<Announcement>(source.length())
        for (index in 0 until source.length()) {
            val item = source.optJSONObject(index) ?: continue
            val id = optionalString(item, "id") ?: continue
            val title = optionalString(item, "title") ?: continue
            val body = optionalString(item, "body") ?: continue
            result.add(Announcement(
                id = id,
                sequence = item.optLong("sequence", 0L),
                severity = AnnouncementSeverity.parse(optionalString(item, "severity")),
                title = title,
                body = body,
                publishedAt = optionalString(item, "publishedAt"),
            ))
        }
        return result
    }

    private fun mapServerCode(code: String?): LicenseErrorCode = when (code) {
        "LICENSE_EXPIRED", "LICENSE_DISABLED" -> LicenseErrorCode.LICENSE_EXPIRED
        "SESSION_EXPIRED" -> LicenseErrorCode.SESSION_EXPIRED
        "DEVICE_MISMATCH", "DEVICE_LIMIT_REACHED" -> LicenseErrorCode.DEVICE_MISMATCH
        "ARTIFACT_NOT_FOUND", "ARTIFACT_UNAVAILABLE" -> LicenseErrorCode.ARTIFACT_UNAVAILABLE
        "INVALID_CLIENT_KEY" -> LicenseErrorCode.INVALID_CLIENT_KEY
        // WS4 防重打包 / APK 签名绑定：服务端强制校验拒绝。
        "SIGNATURE_MISMATCH" -> LicenseErrorCode.SIGNATURE_MISMATCH
        "CLIENT_UPDATE_REQUIRED" -> LicenseErrorCode.CLIENT_UPDATE_REQUIRED
        "INTEGRITY_REJECTED" -> LicenseErrorCode.INTEGRITY_REJECTED
        else -> LicenseErrorCode.SERVER_REJECTED
    }

    private fun nativePayload(nativeResult: String): JSONObject {
        val result = try {
            JSONObject(nativeResult)
        } catch (error: Exception) {
            throw LicenseException(
                LicenseErrorCode.INVALID_RESPONSE,
                "Native authorization result is invalid",
                cause = error,
            )
        }
        if (!result.optBoolean("valid")) {
            val code = result.optString("code")
            throw LicenseException(mapNativeCode(code), "Native authorization rejected the response", code)
        }
        return result.optJSONObject("payload")
            ?: throw LicenseException(LicenseErrorCode.INVALID_RESPONSE, "Native authorization omitted payload")
    }

    private fun mapNativeCode(code: String): LicenseErrorCode = when (code) {
        "INVALID_SIGNATURE" -> LicenseErrorCode.INVALID_SIGNATURE
        "WRONG_KEY" -> LicenseErrorCode.WRONG_KEY
        "WRONG_APPLICATION" -> LicenseErrorCode.WRONG_APPLICATION
        "LICENSE_EXPIRED" -> LicenseErrorCode.LICENSE_EXPIRED
        "SESSION_EXPIRED" -> LicenseErrorCode.SESSION_EXPIRED
        "DEVICE_MISMATCH" -> LicenseErrorCode.DEVICE_MISMATCH
        "LEASE_EXPIRED" -> LicenseErrorCode.LEASE_EXPIRED
        "INVALID_CLIENT_KEY" -> LicenseErrorCode.INVALID_CLIENT_KEY
        "SERVER_REJECTED" -> LicenseErrorCode.SERVER_REJECTED
        else -> LicenseErrorCode.INVALID_RESPONSE
    }

    private companion object {
        val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
    }
}
