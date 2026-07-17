package top.moluhualuo.kmxt.demo

import android.app.Activity
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import top.moluhualuo.kmxt.KmxtConfig
import top.moluhualuo.kmxt.KmxtLicenseClient
import top.moluhualuo.kmxt.LicenseException

// Author: 花落. MIT License. Demo app intentionally keeps UI dependency-free.
class MainActivity : Activity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var client: KmxtLicenseClient
    private lateinit var licenseInput: EditText
    private lateinit var statusText: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        client = KmxtLicenseClient(this, demoConfig(), clientVersion = BuildConfig.VERSION_NAME)
        setContentView(buildContent())
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private fun demoConfig() = KmxtConfig(
        baseUrl = BuildConfig.KMXT_BASE_URL,
        appId = BuildConfig.KMXT_APP_ID,
        keyId = BuildConfig.KMXT_KEY_ID,
        publicKey = BuildConfig.KMXT_PUBLIC_KEY.replace("\\n", "\n"),
    )

    private fun buildContent(): ScrollView {
        licenseInput = EditText(this).apply {
            hint = "输入卡密"
            setSingleLine(true)
        }
        statusText = TextView(this).apply {
            text = "未验证"
            textSize = 15f
        }
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(40, 56, 40, 56)
            addView(TextView(context).apply {
                text = "KMXT SDK Demo"
                textSize = 24f
                gravity = Gravity.CENTER
            }, matchWidth())
            addView(TextView(context).apply {
                text = "替换 BuildConfig 中的 appId、keyId 和公钥后，可测试激活与心跳。"
                textSize = 14f
                gravity = Gravity.CENTER
            }, matchWidth(top = 12))
            addView(licenseInput, matchWidth(top = 28))
            addView(button("激活卡密") { activate() }, matchWidth(top = 18))
            addView(button("验证会话") { verify() }, matchWidth(top = 12))
            addView(button("清除会话") {
                client.clearSession()
                statusText.text = "本机会话已清除"
            }, matchWidth(top = 12))
            addView(statusText, matchWidth(top = 24))
        }
        return ScrollView(this).apply { addView(root) }
    }

    private fun button(label: String, action: () -> Unit) = Button(this).apply {
        text = label
        setOnClickListener { action() }
    }

    private fun activate() = scope.launch {
        val key = licenseInput.text.toString().trim()
        if (key.isBlank()) {
            statusText.text = "请输入卡密"
            return@launch
        }
        runSdkCall("激活") { client.activate(key) }
    }

    private fun verify() = scope.launch {
        runSdkCall("验证") { client.verify() }
    }

    private suspend fun runSdkCall(label: String, call: suspend () -> top.moluhualuo.kmxt.AuthorizationStatus) {
        statusText.text = "$label 中..."
        try {
            val status = call()
            statusText.text = "$label 成功\ncode=${status.code}\nlicenseExpiresAt=${status.licenseExpiresAt}\nsessionExpiresAt=${status.sessionExpiresAt}"
        } catch (error: LicenseException) {
            statusText.text = "$label 失败\ncode=${error.code}\nmessage=${error.message}"
        } catch (error: Exception) {
            statusText.text = "$label 异常\n${error.javaClass.simpleName}: ${error.message}"
        }
    }

    private fun matchWidth(top: Int = 0) = LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT,
    ).apply { topMargin = top }
}
