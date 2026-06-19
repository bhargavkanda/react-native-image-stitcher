// SPDX-License-Identifier: Apache-2.0

/**
 * v0.18.0 — LIGHT per-frame AR metadata delivered to JS on the MAIN
 * thread via a normal callback (`onArFrame`), bypassing worklets entirely.
 *
 * ## Why a callback, NOT a worklet
 *
 * The AR worklet path (`arFrameProcessor` + the `__stitcherProxy` JSI
 * registry) deep-copies the worklet's whole closure into the AR worklet
 * runtime via react-native-worklets-core's `WorkletInvoker`.  When the
 * worklet captures a host object (e.g. a `createRunOnJS` callback) that
 * closure-wrap recurses without termination → stack overflow → SIGBUS the
 * instant AR mode mounts (verified on device).  Worklets can therefore
 * only safely capture a worklets-core *shared value* — an awkward,
 * poll-from-JS pattern for getting structured data back.
 *
 * `onArFrame` sidesteps the whole problem: native builds the metadata and
 * emits it as a plain `RNImageStitcherARFrame` device event carrying a
 * JSON object; the JS side subscribes via `NativeEventEmitter` and invokes
 * the host callback on the main thread.  No worklet, no closure-wrap, no
 * shared-value polling.  This is the recommended way to read AR metadata.
 *
 * ## Cost / gating
 *
 * The metadata is intentionally LIGHT — no pixel / vertex / face byte
 * marshaling.  `depth` reports only the depth map's dimensions + whether a
 * confidence channel exists (no buffer copy); `mesh` reports only anchor /
 * vertex / face *counts*.  Native gates each costly field on the matching
 * extraction flag (`depth` ⇐ `enableDepth`, `mesh` ⇐ `enableMesh`,
 * `anchors` ⇐ `enableAnchors`); `intrinsics` / `pose` / `trackingState` are
 * always present.  Emission is gated on a TS-set enabled flag (only true
 * when `onArFrame` is provided) and throttled to `arFrameMetaInterval` ms
 * (default 100 ≈ 10 Hz) on the native side.
 */
export interface ARFrameMeta {
  /** Frame-capture timestamp in NANOSECONDS (AR-framework monotonic clock). */
  timestamp: number;

  /** AR tracking quality at this frame. */
  trackingState: 'notAvailable' | 'limited' | 'normal';

  /**
   * Camera pose in world coordinates at frame-capture time.
   *
   *   - `rotation` — quaternion `(x, y, z, w)`, matching the convention
   *     used throughout the engine + the `CameraFrame.pose` field.
   *   - `translation` — metres in world space `[x, y, z]`.
   */
  pose: {
    rotation: [number, number, number, number];
    translation: [number, number, number];
  };

  /**
   * Camera intrinsics for this frame — focal lengths (`fx`, `fy`) and
   * principal point (`cx`, `cy`) in PIXELS at the `imageWidth × imageHeight`
   * capture resolution.  Always attempted (not gated); `null` only when the
   * AR framework didn't provide them for this frame.
   */
  intrinsics: {
    fx: number;
    fy: number;
    cx: number;
    cy: number;
    imageWidth: number;
    imageHeight: number;
  } | null;

  /**
   * Depth-map summary — dimensions + whether a per-pixel confidence channel
   * is available.  NO pixel buffer is copied (that's the costly part).
   * Present only when the `enableDepth` prop is on AND the device produced a
   * depth map this frame; `null` otherwise.
   */
  depth: {
    width: number;
    height: number;
    hasConfidence: boolean;
  } | null;

  /**
   * Tracked AR anchors visible in this frame (planes / images / points /
   * mesh).  Empty array when `enableAnchors` is on but nothing is tracked;
   * effectively empty when `enableAnchors` is off.  `transform` is a 4×4
   * row-major anchor→world matrix (16 numbers).
   */
  anchors: Array<{
    id: string;
    type: 'plane' | 'image' | 'point' | 'mesh';
    alignment?: 'horizontal' | 'vertical';
    extent?: [number, number];
    classification?: string;
    transform: number[];
  }>;

  /**
   * Scene-reconstruction mesh summary — anchor / vertex / face COUNTS only
   * (no vertex / face byte marshaling).  Present only when `enableMesh` is
   * on; `null` otherwise.
   */
  mesh: {
    anchorCount: number;
    vertexCount: number;
    faceCount: number;
  } | null;
}
