package top.moluhualuo.kmxt

import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/** Verifies immediately on every foreground transition and then at the signed heartbeat interval. */
class KmxtLifecycleVerifier(
    private val client: KmxtLicenseClient,
    private val scope: CoroutineScope,
    private val listener: (Result<AuthorizationStatus>) -> Unit,
) : DefaultLifecycleObserver {
    private var heartbeat: Job? = null

    override fun onStart(owner: LifecycleOwner) {
        heartbeat?.cancel()
        heartbeat = scope.launch {
            while (isActive) {
                val result = runCatching { client.verify() }
                listener(result)
                val interval = result.getOrNull()?.heartbeatAfterSeconds ?: break
                delay(interval * 1_000)
            }
        }
    }

    override fun onStop(owner: LifecycleOwner) {
        heartbeat?.cancel()
        heartbeat = null
    }
}
