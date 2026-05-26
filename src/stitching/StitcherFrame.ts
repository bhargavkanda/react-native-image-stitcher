// SPDX-License-Identifier: Apache-2.0

/**
 * v0.8.0 — unified frame contract for the lib's worklet processor.
 *
 * Worklets registered via the v0.8.0 `useFrameProcessor` hook (also in
 * this directory) receive a `StitcherFrame` regardless of capture mode.
 * The lib-owned worklet runtime guarantees the same JS-visible shape
 * whether the underlying source is a vision-camera `Frame` (non-AR
 * mode, sourced from the FP plugin) or an ARKit `ARFrame` / ARCore
 * `Frame` (AR mode, sourced from a lib-managed delegate that the AR
 * worklet runtime drives).
 *
 * ## Why structural (NOT `extends Frame`)
 *
 * vision-camera's iOS `Frame` is `CMSampleBufferRef`-shaped; ARFrame's
 * `capturedImage` (a `CVPixelBufferRef`) can be wrapped into one
 * (Phase-0 audit confirmed the iOS path).  But vision-camera's
 * **Android** `Frame` is `androidx.camera.core.ImageProxy`-coupled —
 * ARCore does NOT produce `ImageProxy` instances.  Forcing
 * `StitcherFrame extends Frame` would either (a) require reverse-
 * engineering ImageProxy on Android (intractable + fragile), or
 * (b) make the type asymmetric per platform.  Both are worse than
 * making `StitcherFrame` a structural sibling type that vc Frames
 * happen to satisfy (because vc Frames carry the same width / height /
 * orientation / pixelFormat / timestamp / toArrayBuffer surface).
 *
 * The `__source: 'vc' | 'ar'` discriminator lets worklets gate on
 * mode without a typeof / try-catch dance — e.g., skip work that
 * needs AR tracking state when the source is `'vc'`.
 *
 * ## Buffer lifetime
 *
 * The underlying camera buffer (CMSampleBufferRef / ImageProxy /
 * ARFrame.capturedImage) is valid only for the duration of the worklet
 * call.  Worklets that need to retain frame data MUST copy
 * synchronously inside the worklet body (via `toArrayBuffer()` or via
 * a JPEG-encode frame-processor plugin).  Returning a reference and
 * reading it later will read into freed memory.
 */
export interface StitcherFrame {
  // ── vision-camera-shaped fields (structural compat) ─────────────
  // Worklets written against a vc `Frame` work unchanged against a
  // `StitcherFrame` (the fields below are a strict subset of vc
  // Frame's JS-visible surface).

  /** Pixel width of the camera image. */
  width: number;

  /** Pixel height of the camera image. */
  height: number;

  /**
   * Pixel format identifier.  Both modes today emit `'yuv'` (NV12 on
   * iOS, NV21 on Android).  Other vision-camera formats may appear
   * in future releases.
   */
  pixelFormat: 'yuv' | 'rgb' | 'unknown';

  /**
   * Display orientation tag, matching vision-camera's `Frame.orientation`.
   */
  orientation:
    | 'portrait'
    | 'portrait-upside-down'
    | 'landscape-left'
    | 'landscape-right';

  /**
   * Monotonic timestamp in **nanoseconds** (matches vision-camera's
   * `Frame.timestamp` convention).  Use timestamp deltas for
   * inter-frame timing; the absolute value is implementation-defined
   * and not comparable to `Date.now()`.
   */
  timestamp: number;

  /**
   * Copies the underlying pixel buffer into a JSI `ArrayBuffer`.
   * Worklet-callable.  Allocates O(width × height × bytesPerPixel)
   * each call — avoid in tight inner loops; prefer plugin-side
   * processing where possible.
   */
  toArrayBuffer(): ArrayBuffer;

  // ── Lib additions ─────────────────────────────────────────────

  /**
   * Camera pose at frame-capture time.  Always present.
   *
   * Rotation quaternion order is `(x, y, z, w)`; the lib uses
   * `q = q_yaw * q_pitch * q_roll` throughout the engine + sensor
   * fusion.  Same convention surfaced by the v0.7.0
   * `AcceptedKeyframe.pose` field.
   *
   * Translation is metres in world coordinates.  Populated by AR
   * mode (real ARKit / ARCore camera transform); undefined in
   * non-AR mode (gyro provides only rotation — no spatial anchor).
   */
  pose: {
    rotation: [number, number, number, number];
    translation?: [number, number, number];
  };

  /**
   * Discriminator for the frame source.  Lets worklets branch on
   * mode without try/catch on AR-only field access.
   *
   *   - `'vc'` — vision-camera Frame Processor (non-AR mode)
   *   - `'ar'` — AR-session frame (AR mode); arDepth / arAnchors /
   *     arTrackingState fields may be populated
   *
   * Prefixed with `__` to signal "library-internal discriminator;
   * worklets may read it but should not invent values for it".
   */
  __source: 'vc' | 'ar';

  // ── AR-only optional fields ───────────────────────────────────
  // Always undefined in `__source === 'vc'` mode.

  /**
   * Depth data when available — AR mode + a device that supports
   * the AR framework's depth API (iPhone Pro LiDAR; ARCore Depth
   * API on supported Android devices).
   *
   * Resolution is typically lower than the camera image (e.g.,
   * 256×192 on iPhone Pro LiDAR).  `confidenceMap` is per-pixel:
   * `0` = low, `1` = medium, `2` = high confidence.  `Float32`
   * depth in metres; `Uint8` confidence.
   */
  arDepth?: {
    width: number;
    height: number;
    depthMap: ArrayBuffer;
    confidenceMap?: ArrayBuffer;
  };

  /**
   * Tracked AR anchors visible in this frame.  Empty array if AR
   * is active but no anchors are tracked.  Undefined in non-AR mode.
   */
  arAnchors?: ARAnchor[];

  /**
   * AR tracking quality.  Worklets that should skip work when
   * tracking is degraded check this.  Undefined in non-AR mode.
   */
  arTrackingState?: 'notAvailable' | 'limited' | 'normal';
}

/**
 * v0.8.0 — public AR anchor type.  Subset of ARKit/ARCore anchor info
 * exposed to JS worklets.  Extend with plane-extent / image-name
 * fields as the JSI binding learns them.
 */
export interface ARAnchor {
  /** Stable per-session anchor identifier. */
  id: string;
  /** Anchor kind.  `'point'` is Android (ARCore) only. */
  type: 'plane' | 'image' | 'point';
  /**
   * 4×4 row-major transform from anchor space to world space.
   * 16 numbers.
   */
  transform: number[];
}

/**
 * v0.8.0 — worklet function signature for the unified frame processor.
 *
 * Must be a `'worklet'`-prefixed function (so it can run on the
 * worklet runtime).  Receives a `StitcherFrame` per camera frame; the
 * return value is ignored (use `runOnJS` / shared values to surface
 * results back to the JS thread).
 */
export type StitcherFrameProcessor = (frame: StitcherFrame) => void;
