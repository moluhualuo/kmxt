package top.moluhualuo.kmxt

import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Test

class FingerprintInstrumentedTest {
    @Test fun fingerprintIsStableWithinProcess() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        assertEquals(DeviceFingerprint.create(context), DeviceFingerprint.create(context))
    }
}
