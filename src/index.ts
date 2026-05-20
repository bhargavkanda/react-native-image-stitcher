// SPDX-License-Identifier: Apache-2.0
/**
 * react-native-image-stitcher — public API surface.
 *
 * Two layers:
 *   1. The high-level `<Camera>` component for hosts that want a
 *      drop-in capture experience.  Tap = photo, hold + pan + release
 *      = panorama.  Single mount, all UI included.
 *   2. The lower-level building blocks (views, hooks, stitching
 *      engine bindings, settings modal, status overlays) for hosts
 *      that want to compose their own capture UX while reusing the
 *      battle-tested camera and stitching internals.
 *
 * Layer 1 (`<Camera>`) is the recommended starting point.  Reach for
 * layer 2 when the high-level component doesn't give you enough
 * control — e.g., the private `retailens-camera-sdk` adds
 * measurement + packet detection on top of these building blocks.
 *
 * Public/private split: this lib is the open-source foundation.  The
 * `retailens-camera-sdk` package depends on this lib (peer dep) and
 * adds RetaiLens-specific features on top.
 */

// ─────────────────────────────────────────────────────────────────────
// Layer 1 — the high-level <Camera> component
// ─────────────────────────────────────────────────────────────────────
export { Camera, CameraError } from './camera/Camera';
export type {
  CameraProps,
  CameraCaptureResult,
  CameraErrorCode,
  CaptureSource,
  CameraLens,
  StitchMode,
  Blender,
  SeamFinder,
  Warper,
  FramesDroppedInfo,
} from './camera/Camera';

// ─────────────────────────────────────────────────────────────────────
// AR foundation (public since 0.1.0)
// ─────────────────────────────────────────────────────────────────────
// Hosts that want raw AR pose access (e.g., to build their own
// measurement/detection on top) consume these directly.
export { useARSession, ARTrackingState } from './ar/useARSession';
export type {
  UseARSessionReturn,
  FramePose,
} from './ar/useARSession';

// ─────────────────────────────────────────────────────────────────────
// IMU translation gate (public since 0.1.0)
// ─────────────────────────────────────────────────────────────────────
// Hosts running their own non-AR capture flow can reuse this hook to
// get the same translation-budget gating logic <Camera> uses internally.
export { useIMUTranslationGate } from './sensors/useIMUTranslationGate';
export type {
  UseIMUTranslationGateOptions,
  UseIMUTranslationGateReturn,
} from './sensors/useIMUTranslationGate';

// ═════════════════════════════════════════════════════════════════════
// Layer 2 — composable building blocks (added in 0.1.1)
// ═════════════════════════════════════════════════════════════════════

// ── Camera view components ────────────────────────────────────────────
// Drop-in replacements for vision-camera's raw <Camera> (non-AR) and a
// parallel ARKit/ARCore-backed view (AR).  Use these when you need to
// hand-compose your capture UI instead of mounting <Camera>.
export { ARCameraView } from './camera/ARCameraView';
export type { ARCameraViewHandle, ARCameraViewProps } from './camera/ARCameraView';
export { CameraView } from './camera/CameraView';
export type { CameraViewProps } from './camera/CameraView';

// ── UI components ─────────────────────────────────────────────────────
// Presentational pieces of the standard capture screen.  Each is a
// pure component; the host wires the props.
export { CaptureHeader } from './camera/CaptureHeader';
export { CaptureControlsBar } from './camera/CaptureControlsBar';
export { CapturePreview } from './camera/CapturePreview';
export type { CapturePreviewAction } from './camera/CapturePreview';
export { CaptureStatusOverlay } from './camera/CaptureStatusOverlay';
export type { CaptureStatusPhase } from './camera/CaptureStatusOverlay';
export { CaptureThumbnailStrip } from './camera/CaptureThumbnailStrip';
export type { CaptureThumbnailItem } from './camera/CaptureThumbnailStrip';
export { IncrementalPanGuide } from './camera/IncrementalPanGuide';
export { PanoramaBandOverlay } from './camera/PanoramaBandOverlay';
export { PanoramaGuidance } from './camera/PanoramaGuidance';
export {
  PanoramaSettingsModal,
  DEFAULT_PANORAMA_SETTINGS,
} from './camera/PanoramaSettingsModal';
export type { PanoramaSettings } from './camera/PanoramaSettingsModal';
export { ViewportCropOverlay } from './camera/ViewportCropOverlay';

// ── Capture hooks ─────────────────────────────────────────────────────
// vision-camera wrappers (useCapture / useVideoCapture) + a
// device-orientation reader that works under iOS portrait-lock.
export { useCapture } from './camera/useCapture';
export type { TakePhotoCallOptions } from './camera/useCapture';
export { useVideoCapture } from './camera/useVideoCapture';
export { useDeviceOrientation } from './camera/useDeviceOrientation';

// ── Incremental stitching engine ──────────────────────────────────────
// JS bindings around the native `IncrementalStitcher` module.  Use
// these when you need finer control than <Camera>'s built-in
// hold-to-pan flow (e.g., feeding frames from a custom source, or
// reading the engine's running state to drive a custom UI).
export {
  IncrementalOutcome,
  incrementalStitcherIsAvailable,
  subscribeIncrementalState,
  getIncrementalNativeModule,
  cleanupOldKeyframes,
} from './stitching/incremental';
export type { IncrementalState } from './stitching/incremental';
export { useIncrementalStitcher } from './stitching/useIncrementalStitcher';
export { useIncrementalJSDriver } from './stitching/useIncrementalJSDriver';

// ── Batch stitching ───────────────────────────────────────────────────
// Feed a video file straight to OpenCV's cv::Stitcher, bypassing the
// incremental pipeline.  Useful when you have content captured
// outside the SDK and just want a panorama out.
export { stitchVideo } from './stitching/stitchVideo';
