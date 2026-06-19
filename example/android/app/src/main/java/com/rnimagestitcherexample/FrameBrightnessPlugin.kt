package com.rnimagestitcherexample

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import io.imagestitcher.rn.ARFrameContext
import io.imagestitcher.rn.ARFramePlugin

/**
 * 0.19.0 — TINY sample [ARFramePlugin] proving the AR plugin framework
 * end-to-end on Android (Swift twin: example/ios `FrameBrightnessPlugin`).
 *
 * The SDK ships ONLY the generic framework (no OCR / no concrete plugins) —
 * this lives in the EXAMPLE app to demonstrate the host-side contract:
 * implement [ARFramePlugin], register it with `RNSARPluginRegistry` at
 * startup, read the result in JS.
 *
 * Computes the mean luma (Y plane) of each ARCore frame and returns a SYNC
 * result `{ "brightness": <0..1> }`.  The SDK folds this into the throttled
 * `onArFrame` event under `meta.plugins.frameBrightness`, which the example
 * `App.tsx` surfaces in its on-screen AR overlay.
 *
 * ## Why sync (not async)
 *
 * Mean luma is microseconds of arithmetic — cheap enough to run inline on
 * the AR thread and return synchronously.  Heavier plugins (OCR, ML) would
 * instead return `null`, COPY the bytes they need (`ctx.nv21.copyOf()`),
 * offload to their own queue, and later call
 * `RNSARPluginRegistry.emit("...", result)` to deliver over the async
 * `RNImageStitcherARPluginResult` event.
 *
 * ## Subsampling
 *
 * We sample every Nth pixel ([STRIDE]) of the Y plane rather than summing
 * all ~2M luma bytes per frame — mean brightness is stable under heavy
 * subsampling and this keeps the per-frame cost trivial.
 */
class FrameBrightnessPlugin : ARFramePlugin {

    override fun name(): String = PLUGIN_NAME

    override fun process(context: ARFrameContext): WritableMap? {
        val w = context.width
        val h = context.height
        val ySize = w * h
        if (ySize <= 0 || context.nv21.size < ySize) return null

        // Mean luma over a strided sample of the Y plane.  Y bytes are
        // unsigned 0..255 stored in signed Kotlin Bytes → mask with 0xFF.
        // Read directly from the NV21 array (Y plane is the first ySize
        // bytes) — no copy needed since we consume it synchronously here.
        val nv21 = context.nv21
        var sum = 0L
        var count = 0
        var i = 0
        while (i < ySize) {
            sum += (nv21[i].toInt() and 0xFF)
            count++
            i += STRIDE
        }
        if (count == 0) return null

        val brightness = (sum.toDouble() / count) / 255.0  // 0..1

        return Arguments.createMap().apply {
            putDouble("brightness", brightness)
        }
    }

    companion object {
        /// Plugin name — the key under `meta.plugins` on the JS side.
        const val PLUGIN_NAME = "frameBrightness"

        /// Sample every Nth Y-plane byte (mean luma is stable under heavy
        /// subsampling; keeps per-frame cost trivial).
        private const val STRIDE = 64
    }
}
