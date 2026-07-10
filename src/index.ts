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
  CameraHandle,
  CameraCaptureResult,
  PanoramaCaptureResult,
  CameraErrorCode,
  CaptureSource,
  CaptureSourcesMode,
  CameraLens,
  StitchMode,
  Blender,
  SeamFinder,
  Warper,
  FramesDroppedInfo,
} from './camera/Camera';
// v0.22.0 — options/result for `CameraHandle.captureTorchPair`
// (fast preview-frame pair across a torch flip for torch-differential
// anti-screen-spoof probes).
export type {
  CaptureTorchPairOptions,
  TorchPairResult,
} from './camera/usePreviewFrameGrab';
// Non-fatal capture quality signals carried on `CameraCaptureResult.warnings`.
export type {
  CaptureWarning,
  CaptureWarningCode,
  CaptureWarningCopy,
} from './camera/captureWarnings';
// Default English warning templates (single source of truth; re-used by
// `DEFAULT_GUIDANCE_COPY`).  Exposed so a host can diff / extend them.
export { DEFAULT_CAPTURE_WARNING_COPY } from './camera/captureWarnings';

// Recoverable-stitch-failure → friendly Alert copy.  Hosts call this in
// their onError handler to surface actionable guidance ("pan more slowly",
// "pivot in place") instead of the raw cv::Stitcher diagnostic.  Pass an
// `overrides` map (keyed by `RECOVERABLE_STITCH_CODES`) to localise it.
export {
  userFacingStitchError,
  RECOVERABLE_STITCH_GUIDANCE,
  RECOVERABLE_STITCH_CODES,
} from './camera/cameraErrorMessages';
export type {
  UserFacingStitchError,
  UserFacingStitchErrorOverrides,
} from './camera/cameraErrorMessages';

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
// v0.13.1 — IncrementalPanGuide (drift marker) and PanoramaGuidance
// (pan-speed pill) are no longer part of the public API.  They remain
// in the tree as internal-only components but are not exported and not
// rendered by <Camera> (the `panGuide` / `panoramaGuidance` props were
// removed).  Re-introduce here if a host need resurfaces.
export { PanoramaBandOverlay } from './camera/PanoramaBandOverlay';
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
} from './camera/PanoramaSettings';
export type {
  CaptureBaseSettings,
  PanoramaSettings,
  BatchStitcherSettings,
  FrameSelectionSettings,
  FlowGateSettings,
} from './camera/PanoramaSettings';

// Settings → native config adapters.  Layer 2 hosts building their
// own capture flow on top of `incremental.start()` should always
// pass the result of the matching adapter as `config`; the bridge is
// the single source of truth for the JS↔native wire format.
export {
  panoramaSettingsToNativeConfig,
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
export type { DeviceOrientation } from './camera/useDeviceOrientation';

// v0.12.0 — orientation-aware Camera (R2-lite).  `useOrientationDrift`
// snapshots the device orientation at capture start and latches a
// `drifted` flag if the user rotates mid-capture.  Pairs with
// `OrientationDriftModal` for the auto-abandon UX flow.  The
// flagship `<Camera>` component wires both internally (PR-2);
// Layer-2 hosts using `CameraView` directly can compose the pair
// manually (see the modal's docstring for the integration pattern).
export { useOrientationDrift } from './camera/useOrientationDrift';
export type { UseOrientationDriftReturn } from './camera/useOrientationDrift';
export { OrientationDriftModal } from './camera/OrientationDriftModal';
export type { OrientationDriftModalProps } from './camera/OrientationDriftModal';

// ── Panorama capture GUIDANCE (feature/pano-ux-guidance) ──────────────
// The first-time-user pan-capture guidance surfaces, wired into Layer-1
// <Camera> automatically (panMode / panGuidance / maxPanDurationMs /
// lateralBudgetCm / rectCrop / showPreview / guidanceCopy props).  Exported for
// Layer-2 hosts composing their own capture UX on CameraView + the
// incremental engine.
//
// `PanMode` is the landscape-only-vs-both flag; `GuidanceCopy` +
// `DEFAULT_GUIDANCE_COPY` are the overridable copy surface.
export type { PanMode } from './camera/panModeGate';
export {
  DEFAULT_GUIDANCE_COPY,
} from './camera/cameraGuidanceCopy';
export type { GuidanceCopy } from './camera/cameraGuidanceCopy';
// Shared motion hook — one gyro + one accelerometer subscription feeding
// the pan-speed bucket (item 4) and the lateral-drift latch (item 6).
export { usePanMotion } from './camera/usePanMotion';
export type {
  UsePanMotionOptions,
  UsePanMotionReturn,
  PanSpeedBucket,
  PanAxis,
} from './camera/usePanMotion';
// Presentational guidance surfaces (each renders null when not visible).
export { RotateToLandscapePrompt } from './camera/RotateToLandscapePrompt';
export type { RotateToLandscapePromptProps } from './camera/RotateToLandscapePrompt';
export { PanHowToOverlay } from './camera/PanHowToOverlay';
export type { PanHowToOverlayProps } from './camera/PanHowToOverlay';
export { CaptureCountdownOverlay } from './camera/CaptureCountdownOverlay';
export type { CaptureCountdownOverlayProps } from './camera/CaptureCountdownOverlay';
export { CaptureFrameCounterOverlay } from './camera/CaptureFrameCounterOverlay';
export type { CaptureFrameCounterOverlayProps } from './camera/CaptureFrameCounterOverlay';
export { LateralMotionModal } from './camera/LateralMotionModal';
export type { LateralMotionModalProps } from './camera/LateralMotionModal';
export { RectCropPreview } from './camera/RectCropPreview';
export type {
  RectCropPreviewProps,
  RectCropResult,
  ImageRect,
} from './camera/RectCropPreview';
// Native perspective-rectify crop used by RectCropPreview's confirm
// path; hosts driving their own crop UI call it directly.
export { cropQuad } from './stitching/cropQuad';
export type { CropQuadOptions, CropQuadResult } from './stitching/cropQuad';
// File copy — pairs with the in-place `cropQuad` so a host can crop a COPY of
// a capture (preserving the original + landing the result on a fresh URI,
// avoiding image-cache collisions).
export { copyFile } from './utils/files';

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
export type { IncrementalState, AcceptedKeyframe } from './stitching/incremental';
export { useIncrementalStitcher } from './stitching/useIncrementalStitcher';
// v0.7.0 — Tier 1 subscriber API.  Fires on each accepted keyframe
// in batch-keyframe captures (see hook's docstring for engine-mode
// caveat).  Foundation for plugin-pattern host features (OCR per
// keyframe, packet detection, server-side analysis, etc.).
export { useKeyframeStream } from './stitching/useKeyframeStream';
// v0.8.0 — unified frame contract for the worklet processor.  Same
// JS-visible shape regardless of capture mode (AR vs non-AR).
export type {
  CameraFrame,
  CameraFrameProcessor,
  ARAnchor,
} from './stitching/CameraFrame';
// v0.18.0 — LIGHT per-frame AR metadata delivered via the `onArFrame`
// callback (main-thread, worklet-free).  See the type's docstring for why
// it bypasses the worklet path.  v0.19.0 adds `plugins` (sync results from
// host-registered AR plugins ride this same throttled event).
export type { ARFrameMeta } from './stitching/ARFrameMeta';
// v0.19.0 — the AR plugin framework's ASYNC result type, delivered via the
// `onArPluginResult` callback (a plugin's out-of-band `registry.emit(...)`
// result).  The SDK ships only the generic framework — no built-in plugins.
export type { ARPluginResult } from './stitching/ARFrameMeta';
// v0.20.0 — AR OVERLAY / ANNOTATION renderer data model.  A 2D shape anchored
// to a world point (or world quad) and reprojected to screen every AR frame.
// Drive it via the declarative `overlays` prop or the imperative ref methods
// (`setOverlays` / `addOverlay` / `updateOverlay` / `removeOverlay` /
// `clearOverlays`) on both `<Camera>` and `<ARCameraView>`.
export type { AROverlay } from './stitching/AROverlay';
// The shared imperative-overlay method signatures (the `<Camera>` /
// `<ARCameraView>` ref handles extend this).  Plus the agreed native channel
// names, for hosts / native plugins matching the wire contract.
export type { AROverlayMethods } from './camera/arOverlayController';
export {
  AR_OVERLAY_SET_METHOD,
  AR_OVERLAY_VIEW_COMMAND,
} from './camera/arOverlayController';
// NOTE: the host-worklet / frame-stream hooks `useFrameProcessor`,
// `useThrottledFrameProcessor` and `useFrameStream` (v0.8–v0.9) were
// archived in the batch-keyframe cleanup — they drove the third-party
// `__stitcherProxy` observer API, not batch-keyframe capture. Source is
// preserved under archive/src/stitching/ to build on later.
// vision-camera Frame Processor driver for non-AR captures.  As
// of v0.6 the only non-AR driver exported (the legacy
// `useIncrementalJSDriver` was removed; was deprecated in v0.5).
export { useFrameProcessorDriver } from './stitching/useFrameProcessorDriver';
export type {
  UseFrameProcessorDriverOptions,
  FrameProcessorDriverHandle,
} from './stitching/useFrameProcessorDriver';

// v0.11.0 — composable first-party stitching as a worklet function.
// Hosts that want to COMPOSE their own per-frame logic with the
// lib's stitching (instead of REPLACING it via the <Camera>
// `frameProcessor` prop) call this hook + invoke `stitcher.call`
// inside their own `useFrameProcessor` body.  See
// `docs/host-app-integration.md` § Tier 3 for the full pattern.
export { useStitcherWorklet } from './stitching/useStitcherWorklet';
export type {
  UseStitcherWorkletOptions,
  StitcherWorkletHandle,
  StitcherWorkletInput,
} from './stitching/useStitcherWorklet';

// ── Batch stitching ───────────────────────────────────────────────────
// Feed a video file straight to OpenCV's cv::Stitcher, bypassing the
// incremental pipeline.  Useful when you have content captured
// outside the SDK and just want a panorama out.
export { stitchVideo } from './stitching/stitchVideo';

// ── Image quality ─────────────────────────────────────────────────────
// Run the SDK's blur / brightness / veiling-glare checks on an arbitrary
// image file (e.g. a gallery import) — the same native `measure()` the
// <Camera> runs internally on shutter captures (surfaced there via
// `CameraCaptureResult.warnings`).  Returns a QualityReport whose `passed`
// only blocks on error-severity issues (blur); brightness + glare are
// advisory warnings.  Glare is opt-in via the optional `maxGlare`
// threshold (≈33; see cpp/glare.hpp).
export { runQualityCheck } from './quality/runQualityCheck';
export type {
  QualityThresholds,
  QualityReport,
  QualityIssue,
} from './types';
