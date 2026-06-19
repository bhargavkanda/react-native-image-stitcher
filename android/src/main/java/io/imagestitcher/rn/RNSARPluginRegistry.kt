// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import java.util.concurrent.CopyOnWriteArrayList

/**
 * 0.19.0 — process-wide registry of [ARFramePlugin]s (iOS twin:
 * `RNISARPluginRegistry`).
 *
 * The host app registers native plugins HERE at startup (typically from its
 * `MainApplication.onCreate`); the SDK's AR per-frame path
 * ([RNSARCameraView.forwardToIncremental]) reads [plugins] each frame and,
 * when the list is non-empty, builds one [ARFrameContext] and calls every
 * plugin's [ARFramePlugin.process].
 *
 * Doubles as the **async result channel**: a plugin that returned `null`
 * from `process` (deferring heavy work to its own queue) calls [emit] later
 * to deliver its result to JS over the `RNImageStitcherARPluginResult`
 * device event.
 *
 * ## Threading
 *
 * Backed by a [CopyOnWriteArrayList], so [register] / [unregister] (usually
 * on the main thread at startup) never race the AR thread's [plugins] read.
 * [emit] is safe from any thread — it routes through the singleton
 * [RNSARSession]'s React context, which guards a torn-down Catalyst
 * instance internally.
 */
object RNSARPluginRegistry {

    private const val TAG = "RNSARPluginRegistry"

    /// Event name carrying an ASYNC plugin result to JS.  MUST match the
    /// iOS `supportedEvents` entry + the TS `NativeEventEmitter`
    /// subscription string exactly.
    const val AR_PLUGIN_RESULT_EVENT = "RNImageStitcherARPluginResult"

    private val registered = CopyOnWriteArrayList<ARFramePlugin>()

    /**
     * Register a plugin.  Idempotent by [ARFramePlugin.name]: registering a
     * plugin whose name matches an existing one REPLACES the old instance
     * (so a host re-registering on a JS reload doesn't accumulate
     * duplicates).  Safe to call from any thread.
     */
    @JvmStatic
    fun register(plugin: ARFramePlugin) {
        val name = plugin.name()
        // Drop any prior plugin with the same name, then add the new one.
        registered.removeAll { it.name() == name }
        registered.add(plugin)
        Log.i(TAG, "register: '$name' (now ${registered.size} plugin(s))")
    }

    /**
     * Unregister the plugin with the given [name] (no-op if none match).
     * Safe to call from any thread.
     */
    @JvmStatic
    fun unregister(name: String) {
        val removed = registered.removeAll { it.name() == name }
        if (removed) Log.i(TAG, "unregister: '$name' (now ${registered.size} plugin(s))")
    }

    /**
     * Snapshot of the currently-registered plugins.  Read once per AR frame
     * by the SDK; the [CopyOnWriteArrayList] makes iteration race-free
     * against concurrent [register] / [unregister].
     */
    @JvmStatic
    fun plugins(): List<ARFramePlugin> = registered

    /** Cheap fast-path read for the AR thread: "do we have any plugins?". */
    @JvmStatic
    fun isEmpty(): Boolean = registered.isEmpty()

    /**
     * Emit an ASYNC plugin result to JS over the
     * `RNImageStitcherARPluginResult` device event.
     *
     * Event body: `{ plugin: <pluginName>, result: <result> }` — the same
     * shape the TS `onArPluginResult` prop consumes.  Routes through the
     * singleton [RNSARSession]'s `DeviceEventManagerModule` emitter (the
     * SAME channel `onArFrame` uses), so RN drops the event when no JS
     * listener is attached and a torn-down Catalyst instance is swallowed
     * silently.
     *
     * Safe from any thread (the plugin's own work queue, typically).
     *
     * @param pluginName the emitting plugin's [ARFramePlugin.name].
     * @param result     the plugin's result map (consumed by JS verbatim).
     */
    @JvmStatic
    fun emit(pluginName: String, result: WritableMap) {
        val session = RNSARSession.instance
        if (session == null) {
            Log.d(TAG, "emit('$pluginName'): no RNSARSession instance yet — dropping")
            return
        }
        val body: WritableMap = Arguments.createMap().apply {
            putString("plugin", pluginName)
            putMap("result", result)
        }
        session.emitArPluginResult(body)
    }
}
