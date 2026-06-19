// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn

import com.facebook.react.bridge.WritableMap

/**
 * 0.19.0 — Android AR frame-processor plugin SPI (Swift twin:
 * `ios/Sources/RNImageStitcher/RNISARFramePlugin.swift`).
 *
 * Mirrors vision-camera's `FrameProcessorPlugin` registration ergonomics:
 * the *host app* implements this interface, registers an instance with
 * [RNSARPluginRegistry] at startup, and the SDK invokes [process] for every
 * ARCore frame while the registry is non-empty.  The SDK ships ONLY this
 * generic framework — no OCR or any other concrete plugin (the host writes
 * those against this contract).
 *
 * ## Threading & lifetime
 *
 * [process] runs on the **AR (GL render) thread**, synchronously, once per
 * ARCore frame.  The [ARFrameContext] handed in is a zero-copy view onto
 * the live frame — its byte buffers (`yPlane` / `nv21` / depth `bytes`) are
 * the SDK's own arrays and are reused on subsequent frames.  A plugin that
 * offloads heavy work to another thread **MUST copy** any bytes it needs
 * before returning from [process] (see [ARFrameContext]).
 *
 * ## Sync vs async results
 *
 *  - Return a non-null [WritableMap] for a *light, synchronous* result.  The
 *    SDK folds it into the throttled `onArFrame` `ARFrameMeta` event under
 *    `plugins[name]`, so it rides the existing channel for free.
 *  - Return `null` and call [RNSARPluginRegistry.emit] later (from the
 *    plugin's own queue) to deliver an *async* result over the dedicated
 *    `RNImageStitcherARPluginResult` device event.
 *
 * Plugins are responsible for their own throttling / work-offloading — the
 * SDK calls [process] on EVERY AR frame while the registry is non-empty.
 */
interface ARFramePlugin {
    /**
     * Stable, unique name for this plugin.  Used as the key under
     * `ARFrameMeta.plugins` for sync results and as the `plugin` field of
     * the `RNImageStitcherARPluginResult` event for async results.  The JS
     * side keys off this string, so keep it stable across app launches.
     */
    fun name(): String

    /**
     * Process one ARCore frame.  Return a light synchronous result map
     * (folded into the `onArFrame` event) or `null` (no sync result — emit
     * later via [RNSARPluginRegistry.emit] if needed).
     *
     * Runs on the AR thread.  Do NOT block: self-throttle and offload heavy
     * work.  Copy any [ARFrameContext] byte buffers you retain past the
     * call.
     */
    fun process(context: ARFrameContext): WritableMap?
}
