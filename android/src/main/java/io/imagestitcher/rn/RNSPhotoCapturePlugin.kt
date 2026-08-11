// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn

import android.util.Log
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.google.ar.core.Frame
import java.util.concurrent.CopyOnWriteArrayList

/**
 * The photo-capture plugin hook (Android; iOS twin: `RNSPhotoCapturePlugin`
 * in `RNSPhotoCapturePlugin.swift`).
 *
 * `RNSARCameraView.fulfilTakePhoto` owns the AR photo pipeline (frame grab →
 * JPEG encode → promise).  Host apps that need native per-photo work —
 * extracting extra per-frame data into sidecar files, stamping custom
 * metadata — register a plugin here instead of forking the capture path.
 * The library ships ONLY this generic plumbing; no concrete plugin.
 *
 * ## Contract (all four clauses are load-bearing)
 *
 * **Synchronous, after the JPEG.**  [photoCaptured] runs inside the take-
 * photo fulfilment, after the JPEG is on disk and before the promise
 * resolves.  The plugin may read the photo file and may write sidecar files
 * next to `photoPath`; anything it reports is guaranteed to describe files
 * that already exist when JS sees the result.
 *
 * **DO NOT RETAIN THE FRAME.**  `frame` is ARCore's POOL-BACKED [Frame] for
 * the render tick that produced the photo.  It is valid ONLY for the
 * duration of the call — the next `session.update()` recycles it, after
 * which every accessor throws or returns garbage.  Copy out whatever you
 * need (pose values, a depth image via `acquireDepthImage16Bits` — and
 * `close()` any acquired Image before returning) and let the reference go.
 * Storing the Frame in a field, a closure, or a queue is a contract
 * violation the library cannot detect; the immediate-use pattern (do all
 * frame reads inline, return a plain [WritableMap]) is the enforcement.
 *
 * **Budget.**  The call runs on the GL render thread inside the take-photo
 * fulfilment: its cost adds to the promise latency 1:1 AND stalls the AR
 * render loop for its duration.  Stay in the tens-of-milliseconds range;
 * offload heavier work to your own thread AFTER copying what you need.
 *
 * **Errors are reported, never thrown.**  A failing plugin returns `null`
 * (or a payload describing the failure).  As a second line of defence the
 * capture path also catches anything a plugin throws and proceeds without
 * its payload — a plugin can never fail the photo — but throwing is still a
 * contract violation, not a supported error channel.
 *
 * ## Result merge
 *
 * The returned map is merged into the takePhoto result: the library's own
 * keys (`path`, `width`, `height`, `isMirrored`, `isRawPhoto`, `pose`, …)
 * always win, and between plugins the first to claim a key wins — identical
 * to iOS' `RNSPhotoCapturePayload.merge`.  With NO plugin registered the
 * library's behaviour (and its result payload) is byte-identical to a build
 * without this hook.
 */
interface RNSPhotoCapturePlugin {
    /**
     * Called synchronously inside takePhoto with the EXACT ARCore [Frame]
     * whose camera image became the photo, after the JPEG is written.
     * `options` is the full takePhoto options map as JS sent it, so a host
     * can route per-call flags to its plugin without a library change.
     * See the interface docs for the frame-lifetime + budget contract.
     */
    fun photoCaptured(
        frame: Frame,
        photoPath: String,
        options: ReadableMap,
    ): WritableMap?
}

/**
 * Process-wide registry of [RNSPhotoCapturePlugin]s.  The host registers
 * plugins at startup (typically `MainApplication.onCreate`); the capture
 * path reads [plugins] per photo and skips ALL plugin work while the
 * registry is empty.
 *
 * Backed by a [CopyOnWriteArrayList] — same threading discipline as
 * [RNSARPluginRegistry]: register/unregister (main thread) never race the
 * GL thread's read, and iteration needs no lock.
 */
object RNSPhotoCapturePluginRegistry {

    private const val TAG = "RNSPhotoCapturePlugin"

    private val registered = CopyOnWriteArrayList<RNSPhotoCapturePlugin>()

    /** Register a plugin.  Idempotent for the same instance. */
    @JvmStatic
    fun register(plugin: RNSPhotoCapturePlugin) {
        registered.addIfAbsent(plugin)
    }

    /** Remove a previously registered plugin.  No-op if absent. */
    @JvmStatic
    fun unregister(plugin: RNSPhotoCapturePlugin) {
        registered.remove(plugin)
    }

    /** Whether any plugin is registered — the capture path's cheap gate. */
    @JvmStatic
    val isEmpty: Boolean
        get() = registered.isEmpty()

    /** Snapshot of registered plugins in registration order. */
    @JvmStatic
    fun plugins(): List<RNSPhotoCapturePlugin> = registered.toList()

    /**
     * Capture-path entry point: run every plugin against the captured frame
     * and fold their payloads into [result].
     *
     * Merge rule (must stay identical to iOS `RNSPhotoCapturePayload`):
     * keys already present in [result] always win — a plugin can never
     * clobber a library field, and between plugins the first to claim a key
     * keeps it.  A plugin that throws is logged and skipped; the photo is
     * never failed by its plugins.
     */
    internal fun invoke(
        frame: Frame,
        photoPath: String,
        options: ReadableMap,
        result: WritableMap,
    ) {
        for (plugin in registered) {
            val payload = try {
                plugin.photoCaptured(frame, photoPath, options)
            } catch (t: Throwable) {
                // Contract violation (errors must be REPORTED, not thrown) —
                // isolate it so a broken plugin cannot fail the photo.
                Log.w(TAG, "photoCaptured threw — payload dropped: $t")
                null
            } ?: continue
            mergePayload(result, payload)
        }
    }

    /** Copy every key of [payload] that [result] does not already have. */
    private fun mergePayload(result: WritableMap, payload: ReadableMap) {
        val keys = payload.keySetIterator()
        while (keys.hasNextKey()) {
            val key = keys.nextKey()
            if (result.hasKey(key)) continue
            when (payload.getType(key)) {
                com.facebook.react.bridge.ReadableType.Null ->
                    result.putNull(key)
                com.facebook.react.bridge.ReadableType.Boolean ->
                    result.putBoolean(key, payload.getBoolean(key))
                com.facebook.react.bridge.ReadableType.Number ->
                    result.putDouble(key, payload.getDouble(key))
                com.facebook.react.bridge.ReadableType.String ->
                    result.putString(key, payload.getString(key))
                com.facebook.react.bridge.ReadableType.Map ->
                    result.putMap(key, payload.getMap(key))
                com.facebook.react.bridge.ReadableType.Array ->
                    result.putArray(key, payload.getArray(key))
            }
        }
    }
}
