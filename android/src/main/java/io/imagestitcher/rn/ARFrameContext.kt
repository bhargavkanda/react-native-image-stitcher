// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn

/**
 * 0.19.0 — zero-copy native view of one ARCore frame, handed to every
 * registered [ARFramePlugin.process] (iOS twin: `RNISARFrameContext`).
 *
 * The SDK builds ONE of these per AR frame — only when [RNSARPluginRegistry]
 * is non-empty — from the SAME `ARCore Frame` + pose the `onArFrame` meta
 * path uses, then passes it to each plugin in turn.  Zero-plugin apps never
 * pay for the build.
 *
 * ## Camera image
 *
 * ARCore hands the SDK a `YUV_420_888` camera image which is already packed
 * into a contiguous JVM-side NV21 byte array ([nv21]) before the ARCore
 * `Image` is closed (the SDK does this once per frame for its own stitch /
 * worklet paths — we reuse it here, no extra acquire).  Layout:
 *   - bytes `[0 .. width*height)`              = Y plane (luminance), dense,
 *                                                row stride = [width]
 *   - bytes `[width*height .. width*height*3/2)` = interleaved V-U chroma
 * [yPlane] is a convenience read-only window onto just the Y plane.
 *
 * ## Feature-point cloud — STRIDE-4 [x, y, z, confidence]
 *
 * [featurePoints], when non-null, is ARCore's sparse SLAM point cloud
 * (`Frame.acquirePointCloud().getPoints()`) copied out verbatim as a flat
 * `FloatArray` in ARCore's **native stride-4** layout: four floats per
 * point — `[x, y, z, confidence]` — in WORLD space (metres), where
 * `confidence` ∈ [0, 1] is ARCore's per-point tracking confidence.  Point
 * count is therefore `featurePoints.size / 4`.
 *
 * This layout DELIBERATELY DIFFERS from iOS's `RNISARFrameContext`
 * `featurePoints: [simd_float3]` (bare `x, y, z`, no confidence).  The
 * divergence is intentional, not an oversight: this field is read ONLY by
 * platform-specific NATIVE plugins (e.g. Phase C's Kotlin PCA liveness
 * plugin), never by cross-platform JS, so byte-parity with iOS buys
 * nothing.  ARCore's cloud is sparser and noisier than ARKit's, so the
 * per-point `confidence` is load-bearing — Phase C filters the cloud on it
 * before fitting a plane.  Dropping it to match iOS's stride-3 shape would
 * discard the one signal that makes the Android cloud usable.
 *
 * Null when `enableFeaturePoints` is off (zero ARCore cost — no
 * `acquirePointCloud`), or when ARCore couldn't deliver a cloud this frame
 * (not tracking / deadline / resource-exhausted — see
 * [RNSARCameraView.runArPlugins]).
 *
 * ## Lifetime — COPY BEFORE OFFLOADING
 *
 * [nv21] / [yPlane] / [depthBytes] are the SDK's own arrays, reused on the
 * next frame.  They are valid ONLY for the duration of the synchronous
 * [ARFramePlugin.process] call.  A plugin that hands bytes to another
 * thread (async OCR, network upload, etc.) **MUST copy** them first
 * (`bytes.copyOf()`), or it will read torn/overwritten data on the next AR
 * frame.  [featurePoints] follows the SAME contract — it is a fresh copy
 * of the (now-closed) ARCore `PointCloud`, but the SDK does not promise the
 * array reference survives the frame; copy it too before offloading.
 *
 * @property nv21            Full NV21 camera image (Y plane then interleaved VU).
 * @property width           Camera image width (px).
 * @property height          Camera image height (px).
 * @property timestampNs      ARCore frame timestamp (nanoseconds).
 * @property fx              Focal length x (px, at capture resolution).
 * @property fy              Focal length y (px).
 * @property cx              Principal point x (px).
 * @property cy              Principal point y (px).
 * @property imageWidth      Intrinsics reference image width (px).
 * @property imageHeight     Intrinsics reference image height (px).
 * @property poseRotation    Camera pose rotation quaternion `[x, y, z, w]`.
 * @property poseTranslation Camera pose translation `[x, y, z]` (metres, world).
 * @property trackingState   Contract enum string: "normal" | "limited" | "notAvailable".
 * @property depthBytes      Row-packed DEPTH16 (uint16/px, w*h*2 bytes) or null
 *                           (null unless `enableDepth` AND depth available this frame).
 * @property depthWidth      Depth map width (px), 0 when [depthBytes] is null.
 * @property depthHeight     Depth map height (px), 0 when [depthBytes] is null.
 * @property anchors         Anchor descriptor maps already collected for the
 *                           `onArFrame` event (empty unless `enableAnchors`).
 *                           Each map: { id, type, transform[16 row-major],
 *                           alignment?, extent? } — same shape the JS
 *                           `ARAnchor` contract uses.
 * @property featurePoints   ARCore SLAM point cloud, flat stride-4
 *                           `[x, y, z, confidence]` per point in world
 *                           metres, or null (null unless `enableFeaturePoints`
 *                           AND ARCore delivered a cloud this frame).  Count
 *                           = `featurePoints.size / 4`.  See the stride-4
 *                           section above for why this differs from iOS.
 */
class ARFrameContext(
    @JvmField val nv21: ByteArray,
    @JvmField val width: Int,
    @JvmField val height: Int,
    @JvmField val timestampNs: Double,
    @JvmField val fx: Double,
    @JvmField val fy: Double,
    @JvmField val cx: Double,
    @JvmField val cy: Double,
    @JvmField val imageWidth: Int,
    @JvmField val imageHeight: Int,
    @JvmField val poseRotation: DoubleArray,
    @JvmField val poseTranslation: DoubleArray,
    @JvmField val trackingState: String,
    @JvmField val depthBytes: ByteArray? = null,
    @JvmField val depthWidth: Int = 0,
    @JvmField val depthHeight: Int = 0,
    @JvmField val anchors: List<Map<String, Any?>> = emptyList(),
    @JvmField val featurePoints: FloatArray? = null,
) {
    /**
     * Read-only window onto JUST the Y (luminance) plane of [nv21] — the
     * first `width * height` bytes.  Cheap (no copy): a sliced, read-only
     * [java.nio.ByteBuffer] over the same backing array.  Convenient for
     * plugins that only need luma (brightness, simple CV gates).
     *
     * Like [nv21], valid only during [ARFramePlugin.process]; copy before
     * offloading.
     */
    val yPlane: java.nio.ByteBuffer
        get() = java.nio.ByteBuffer
            .wrap(nv21, 0, width * height)
            .slice()
            .asReadOnlyBuffer()
}
