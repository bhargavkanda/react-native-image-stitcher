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
 * finding #4A) noted this is by-convention only.  The current AR
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
 * Construction: tens of ns (one heap allocation for the wrapper +
 * one volatile write of the bytes reference).  `takeOnce()`: tens
 * of ns (one synchronized read + one null-out).  Negligible vs the
 * underlying NV21 array's KB-scale memory footprint and the
 * ms-scale frame-processing cost — but not a free pointer hop.
 *
 * ## Thread-safety
 *
 * `takeOnce()` and `available` are `synchronized` on the wrapper
 * itself.  Producers should still extract on a single thread (the
 * frame producer); the synchronization defends against the
 * pathological case where two threads race to extract.
 */
class TransferredNV21(bytes: ByteArray) {
    init {
        // Empty arrays would propagate as "0 bytes of pixel data with
        // a non-zero width/height" downstream and crash inside the
        // C++ ingest with a far less actionable error.  Catch at
        // construction.  Critic-finding [MAJOR][B].
        require(bytes.isNotEmpty()) {
            "TransferredNV21 requires a non-empty byte array " +
                "(received zero-length)"
        }
    }

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
     *
     * Concurrency note: `@Volatile` on the bytes field plus the
     * `synchronized(this)` block here together guarantee both
     * visibility AND atomicity across threads.  The `@Volatile` is
     * defensive for any future non-synchronized read; today every
     * accessor goes through the synchronized block.
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

    // Note: an `available` property was considered and removed in
    // pre-merge review (critic-finding [MAJOR][B]).  Any
    // `if (handle.available) handle.takeOnce()` pattern is
    // inherently TOCTOU-racy — another thread could win the
    // takeOnce() between the check and the use.  Consumers should
    // call `takeOnce()` directly and catch the `IllegalStateException`
    // if they need recovery semantics.  No internal caller used
    // `available`; YAGNI removed it.
}
