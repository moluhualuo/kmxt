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
import java.security.SecureRandom
import java.time.Instant
import android.util.Base64
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
        val request = commonRequest().put("licenseKey", licenseKey)
        val envelope = post("/api/v1/client/activate", request)
        val status = validate(envelope)
        val token = envelope.getJSONObject("payload").optString("sessionToken")
        if (token.isBlank()) throw LicenseException(LicenseErrorCode.INVALID_RESPONSE, "Activation response omitted the session token")
        sessions.save(token)
        status
    }

    suspend fun verify(): AuthorizationStatus = withContext(Dispatchers.IO) {
        val token = sessions.load() ?: throw LicenseException(
            LicenseErrorCode.NOT_ACTIVATED, "No encrypted KMXT session is available")
        try {
            validate(post("/api/v1/client/verify", commonRequest().put("sessionToken", token)))
        } catch (error: LicenseException) {
            if (error.code in setOf(LicenseErrorCode.SESSION_EXPIRED, LicenseErrorCode.DEVICE_MISMATCH)) sessions.clear()
            throw error
        }
    }

    fun clearSession() { sessions.clear() }

    private fun commonRequest() = JSONObject()
        .put("appId", config.appId)
        .put("deviceId", DeviceFingerprint.create(applicationContext))
        .put("timestamp", System.currentTimeMillis())
        .put("nonce", nonce())
        .apply { clientVersion?.let { put("clientVersion", it) } }

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

    private fun validate(envelope: JSONObject): AuthorizationStatus {
        if (envelope.optString("algorithm") != "Ed25519")
            throw LicenseException(LicenseErrorCode.INVALID_SIGNATURE, "Unexpected signing algorithm")
        if (envelope.optString("keyId") != config.keyId)
            throw LicenseException(LicenseErrorCode.WRONG_KEY, "Response was signed by an untrusted key")
        val payload = envelope.optJSONObject("payload")
            ?: throw LicenseException(LicenseErrorCode.INVALID_RESPONSE, "Signed payload is missing")
        if (!NativeCore.verifyEnvelope(payload.toString(), envelope.optString("signature"), config.publicKey))
            throw LicenseException(LicenseErrorCode.INVALID_SIGNATURE, "Ed25519 response verification failed")
        if (payload.optString("appId") != config.appId)
            throw LicenseException(LicenseErrorCode.WRONG_APPLICATION, "Signed response belongs to another application")
        val licenseExpiry = payload.optString("licenseExpiresAt")
        val sessionExpiry = payload.optString("sessionExpiresAt")
        try {
            val now = Instant.now()
            if (!Instant.parse(licenseExpiry).isAfter(now))
                throw LicenseException(LicenseErrorCode.LICENSE_EXPIRED, "License has expired")
            if (!Instant.parse(sessionExpiry).isAfter(now))
                throw LicenseException(LicenseErrorCode.SESSION_EXPIRED, "Session has expired")
        } catch (error: LicenseException) { throw error }
        catch (error: Exception) {
            throw LicenseException(LicenseErrorCode.INVALID_RESPONSE, "Signed expiry is invalid", cause = error)
        }
        if (!payload.optBoolean("licensed"))
            throw LicenseException(LicenseErrorCode.SERVER_REJECTED, "Server denied authorization")
        return AuthorizationStatus(
            licensed = true,
            code = payload.optString("code"),
            appId = config.appId,
            licenseExpiresAt = licenseExpiry,
            sessionExpiresAt = sessionExpiry,
            heartbeatAfterSeconds = payload.optLong("heartbeatAfterSeconds").coerceAtLeast(30),
        )
    }

    private fun nonce(): String {
        val bytes = ByteArray(18).also(SecureRandom()::nextBytes)
        return Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    }

    private fun mapServerCode(code: String?): LicenseErrorCode = when (code) {
        "LICENSE_EXPIRED", "LICENSE_DISABLED" -> LicenseErrorCode.LICENSE_EXPIRED
        "SESSION_EXPIRED" -> LicenseErrorCode.SESSION_EXPIRED
        "DEVICE_MISMATCH", "DEVICE_LIMIT_REACHED" -> LicenseErrorCode.DEVICE_MISMATCH
        else -> LicenseErrorCode.SERVER_REJECTED
    }

    private companion object {
        val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
    }
}
