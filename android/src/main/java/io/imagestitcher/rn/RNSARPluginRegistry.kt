// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicReference

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

    // ── 0.20.0 — native-plugin overlay path ──────────────────────────────
    //
    // A native plugin can place AR overlays DIRECTLY (native→native, zero JS
    // latency) via [setOverlays] / [addOverlay] / [removeOverlay] /
    // [clearOverlays].  These write the **plugin namespace** of the bound
    // view's [AROverlayStore]; the renderer draws the UNION of plugin + JS
    // overlays, so a JS `setOverlays` never clobbers plugin overlays (and
    // vice-versa).
    //
    // We CACHE the latest plugin overlay set here so a view that binds AFTER
    // a plugin placed overlays (e.g. plugin registered + overlays set in
    // MainApplication.onCreate, before any ARCameraView mounts) still picks
    // them up — [RNSARCameraView] replays the cache into its store when it
    // binds (see [currentPluginOverlays]).
    private val pluginOverlays = AtomicReference<List<AROverlayData>>(emptyList())

    /**
     * Replace the ENTIRE native-plugin overlay set.  Merges with (does NOT
     * clobber) JS-set overlays — the renderer draws the union.  Safe from
     * any thread (a plugin's own work queue, typically).
     *
     * @param overlays the plugin overlays to render (an empty list clears
     *                 the plugin namespace; JS overlays untouched).
     */
    @JvmStatic
    fun setOverlays(overlays: List<AROverlayData>) {
        pluginOverlays.set(overlays.toList())
        boundStore()?.setPluginOverlays(overlays)
    }

    /** Add or replace one plugin overlay by id. */
    @JvmStatic
    fun addOverlay(overlay: AROverlayData) {
        pluginOverlays.updateAndGet { cur ->
            val idx = cur.indexOfFirst { it.id == overlay.id }
            if (idx < 0) cur + overlay else cur.toMutableList().also { it[idx] = overlay }
        }
        boundStore()?.addPluginOverlay(overlay)
    }

    /** Remove one plugin overlay by id (no-op if unknown). */
    @JvmStatic
    fun removeOverlay(id: String) {
        pluginOverlays.updateAndGet { cur -> cur.filterNot { it.id == id } }
        boundStore()?.removePluginOverlay(id)
    }

    /** Clear ALL plugin overlays (JS overlays untouched). */
    @JvmStatic
    fun clearOverlays() {
        pluginOverlays.set(emptyList())
        boundStore()?.clearPluginOverlays()
    }

    /**
     * The cached plugin overlay set — replayed into a freshly-bound view's
     * store so plugins that placed overlays before any view mounted still
     * render.  Called by [RNSARCameraView.onAttachedToWindow].
     */
    @JvmStatic
    internal fun currentPluginOverlays(): List<AROverlayData> = pluginOverlays.get()

    /// The bound AR camera view's overlay store, or null when no view is
    /// mounted yet (overlays land in the cache until one binds).
    private fun boundStore(): AROverlayStore? =
        RNSARSession.instance?.boundOverlayStore()

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
