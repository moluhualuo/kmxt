package top.moluhualuo.kmxt

import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class SessionStoreInstrumentedTest {
    private val context = ApplicationProvider.getApplicationContext<android.content.Context>()

    @Test fun keystoreSessionPersistsAndClears() {
        val store = SessionStore(context, "00000000-0000-0000-0000-000000000001")
        store.clear()
        store.save("test-session-token-never-log-this")
        assertEquals("test-session-token-never-log-this", store.load())
        store.clear()
        assertNull(store.load())
    }

    @Test fun cleartextBaseUrlIsRejected() {
        assertThrows(IllegalArgumentException::class.java) {
            KmxtConfig(
                baseUrl = "http://license.invalid",
                appId = "00000000-0000-0000-0000-000000000001",
                keyId = "test-key",
                publicKey = "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
            )
        }
    }
}
