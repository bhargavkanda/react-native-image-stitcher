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
// As of v0.2 this hook is implemented on `react-native-sensors` raw
// accelerometer + JS IIR gravity subtraction (was `expo-sensors`'
// fused DeviceMotion through 0.1.x — see the hook's file header).
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
export { CaptureDebugOverlay } from './camera/CaptureDebugOverlay';
export type { CaptureDebugOverlayProps } from './camera/CaptureDebugOverlay';
// 2026-05-22 (audit F9) — composable debug pills.  Layer-1 <Camera>
// mounts all of them automatically when settings.debug is on;
// Layer-2 hosts compose their own debug surface from these primitives.
export { CaptureMemoryPill } from './camera/CaptureMemoryPill';
export type { CaptureMemoryPillProps } from './camera/CaptureMemoryPill';
export { CaptureKeyframePill } from './camera/CaptureKeyframePill';
export type { CaptureKeyframePillProps } from './camera/CaptureKeyframePill';
export { CaptureOrientationPill } from './camera/CaptureOrientationPill';
export type { CaptureOrientationPillProps } from './camera/CaptureOrientationPill';
export {
  CaptureStitchStatsToast,
  useStitchStatsToast,
} from './camera/CaptureStitchStatsToast';
export type {
  CaptureStitchStatsToastProps,
  UseStitchStatsToastReturn,
} from './camera/CaptureStitchStatsToast';
export { CaptureThumbnailStrip } from './camera/CaptureThumbnailStrip';
export type { CaptureThumbnailItem } from './camera/CaptureThumbnailStrip';
export { IncrementalPanGuide } from './camera/IncrementalPanGuide';
export { PanoramaBandOverlay } from './camera/PanoramaBandOverlay';
export { PanoramaGuidance } from './camera/PanoramaGuidance';
// Settings modal — the modal is in `PanoramaSettingsModal.tsx`, but
// the type tree + defaults + JS↔native bridge live in dedicated
// files since v0.4 (F10).  The modal is now a thin presentational
// component over the typed structure.
export { PanoramaSettingsModal } from './camera/PanoramaSettingsModal';
export type { PanoramaSettingsModalProps } from './camera/PanoramaSettingsModal';

// Settings types — the v0.4 engine-discriminated structures.  Three
// disjoint top-level types (one per stitching engine), each composed
// of named sub-trees the corresponding native engine actually reads.
// See `./camera/PanoramaSettings.ts` for the rationale and the
// field-by-field native-consumer references.
export {
  DEFAULT_PANORAMA_SETTINGS,
  DEFAULT_FLOW_GATE_SETTINGS,
  DEFAULT_SLITSCAN_SETTINGS,
  DEFAULT_HYBRID_SETTINGS,
} from './camera/PanoramaSettings';
export type {
  CaptureBaseSettings,
  PanoramaSettings,
  BatchStitcherSettings,
  FrameSelectionSettings,
  FlowGateSettings,
  SlitscanSettings,
  SlitscanPaintingSettings,
  SlitscanRegistrationSettings,
  SlitscanAdvancedSettings,
  Ncc1dSettings,
  Ncc2dSettings,
  PlaneProjectionSettings,
  HybridSettings,
} from './camera/PanoramaSettings';

// Settings → native config adapters.  Layer 2 hosts building their
// own capture flow on top of `incremental.start()` should always
// pass the result of the matching adapter as `config`; the bridge is
// the single source of truth for the JS↔native wire format.
export {
  panoramaSettingsToNativeConfig,
  slitscanSettingsToNativeConfig,
  hybridSettingsToNativeConfig,
} from './camera/PanoramaSettingsBridge';
export type { NativeConfigDict } from './camera/PanoramaSettingsBridge';
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
