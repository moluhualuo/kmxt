package top.moluhualuo.kmxt

import android.app.Activity
import android.os.Bundle
import android.view.Gravity
import android.widget.TextView

/**
 * Test-only launcher so USB-installed instrumentation packages show a KMXT icon.
 * Author: 花落. MIT License.
 */
class KmxtTestLauncherActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(TextView(this).apply {
            gravity = Gravity.CENTER
            text = "KMXT SDK Test"
            textSize = 18f
        })
    }
}
