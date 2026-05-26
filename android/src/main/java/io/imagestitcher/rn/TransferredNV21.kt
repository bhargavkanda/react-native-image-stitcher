// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn

/**
 * v0.10.0 (audit #4A) — single-use NV21 byte-array handle that
 * enforces the engine's pixel-data ownership contract at runtime.
 *
 * ## Why this exists
 *
 * `IncrementalStitcher.ingestFromARCameraView` accepts an
 * `nv21PixelData` parameter that the engine retains for ~50 ms
 * after the producer thread returns (until the `workScope`
 * coroutine consumes it).  The documented contract is
 * "callers MUST treat the array as transferred — do not mutate it
 * or return it to a buffer pool after calling this method."
 *
 * The v0.10.0 audit (`docs/plans/handoff/2026-05-26-autonomous-run-handoff.md`
 * finding #4) noted this is by-convention only.  The current AR
 * caller (`RNSARCameraView`) passes the same `packed.nv21` array
 * as BOTH `grayData` (consumed synchronously inside the gate)
 * AND `nv21PixelData` (consumed asynchronously).  Today no race
 * because the sync read finishes before the async coroutine reads,
 * but a future refactor that reorders consumption would silently
 * corrupt frames.
 *
 * Wrapping the bytes in `TransferredNV21` turns the documentation
 * contract into a runtime contract: callers can only extract the
 * bytes once via `takeOnce()`; the second call throws.  The
 * misuse is caught at the call site, not at the engine.
 *
 * ## Cost
 *
 * Construction: one nullable assignment (a few ns).  `takeOnce()`:
 * one synchronized read + one null-out (a few ns).  Negligible vs
 * the underlying NV21 array's KB-scale memory footprint and the
 * ms-scale frame-processing cost.
 *
 * ## Thread-safety
 *
 * `takeOnce()` and `available` are `synchronized` on the wrapper
 * itself.  Producers should still extract on a single thread (the
 * frame producer); the synchronization defends against the
 * pathological case where two threads race to extract.
 */
class TransferredNV21(bytes: ByteArray) {
    @Volatile
    private var bytes: ByteArray? = bytes

    /**
     * Take the wrapped bytes.  Throws on second call.
     *
     * Consumers should call this exactly once — typically once per
     * frame, on the producer thread, immediately before handing
     * the bytes to the async work queue:
     *
     * ```kotlin
     * val pixelBytes: ByteArray? = if (hasPixelData) nv21PixelData!!.takeOnce() else null
     * workScope.launch {
     *     // pixelBytes is captured by value; no race.
     *     engine.addFramePixelData(nv21 = pixelBytes!!, ...)
     * }
     * ```
     */
    fun takeOnce(): ByteArray = synchronized(this) {
        val b = bytes ?: error(
            "TransferredNV21.takeOnce() called twice — bytes already transferred. " +
                "Check that you're not passing the same TransferredNV21 instance to " +
                "two consumers (e.g., a sync gate-eval call AND an async workScope.launch)."
        )
        bytes = null
        b
    }

    /**
     * True if the bytes are still available.  Useful for defensive
     * checks; consumers normally just call `takeOnce()` directly
     * and let it throw on misuse.
     */
    val available: Boolean
        get() = synchronized(this) { bytes != null }
}
