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

    private fun post(path: String, body: JSONObject): JSONObject {
        val request = Request.Builder()
            .url(config.baseUrl.trimEnd('/') + path)
            .header("Accept", "application/json")
            .header("User-Agent", "KMXT-Android/0.5.0")
            .post(body.toString().toRequestBody(JSON_MEDIA_TYPE))
            .build()
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
