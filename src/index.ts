/**
 * @retailens/capture-sdk — public API surface.
 *
 * This file is the ONLY module host apps import from.  Everything
 * downstream (camera, quality, stitching) is wired through here so
 * internal refactors don't cascade into import-path churn in
 * retailens-mobile.
 */

// ── Types ────────────────────────────────────────────────────────────────
export type {
  ICaptureSDK,
  CaptureSDKConfig,
  CaptureResult,
  QualityReport,
  QualityIssue,
  QualityThresholds,
  CaptureThemeConfig,
  DeviceMetadata,
} from './types';

// ── Camera ───────────────────────────────────────────────────────────────
export { useCapture } from './camera/useCapture';
export type {
  UseCaptureOptions,
  UseCaptureReturn,
} from './camera/useCapture';
export { CameraView } from './camera/CameraView';
export type { CameraViewProps } from './camera/CameraView';
export { ARCameraView } from './camera/ARCameraView';
export type { ARCameraViewProps, ARCameraViewHandle } from './camera/ARCameraView';
export { CameraShutter } from './camera/CameraShutter';
export type {
  CameraShutterProps,
  CameraShutterHandle,
} from './camera/CameraShutter';
export { CaptureThumbnailStrip } from './camera/CaptureThumbnailStrip';
export type {
  CaptureThumbnailStripProps,
  CaptureThumbnailItem,
} from './camera/CaptureThumbnailStrip';
export { CaptureStatusOverlay } from './camera/CaptureStatusOverlay';
export type {
  CaptureStatusOverlayProps,
  CaptureStatusPhase,
} from './camera/CaptureStatusOverlay';
export { CaptureHeader } from './camera/CaptureHeader';
export type { CaptureHeaderProps } from './camera/CaptureHeader';
export { CaptureControlsBar } from './camera/CaptureControlsBar';
export type { CaptureControlsBarProps } from './camera/CaptureControlsBar';
export { PanoramaGuidance } from './camera/PanoramaGuidance';
export type {
  PanoramaGuidanceProps,
  PanoramaSpeedBucket,
} from './camera/PanoramaGuidance';
/**
 * @deprecated V16 Phase 2 — superseded by `<PanoramaBandOverlay />`,
 *   which now subsumes per-keyframe thumbnails in addition to the
 *   single cumulative panorama thumb.  Export kept for backward
 *   compatibility; will be removed in a future major version.
 */
export { LiveFrameStrip } from './camera/LiveFrameStrip';
export type { LiveFrameStripProps } from './camera/LiveFrameStrip';
export {
  PanoramaSettingsModal,
  DEFAULT_PANORAMA_SETTINGS,
} from './camera/PanoramaSettingsModal';
export type {
  PanoramaSettings,
  PanoramaSettingsModalProps,
} from './camera/PanoramaSettingsModal';
export { useDeviceOrientation } from './camera/useDeviceOrientation';
export type { DeviceOrientation } from './camera/useDeviceOrientation';

export { PanoramaBandOverlay } from './camera/PanoramaBandOverlay';
export type { PanoramaBandOverlayProps } from './camera/PanoramaBandOverlay';

export { IncrementalPanGuide } from './camera/IncrementalPanGuide';
export type { IncrementalPanGuideProps } from './camera/IncrementalPanGuide';

export { ViewportCropOverlay } from './camera/ViewportCropOverlay';
export type { ViewportCropOverlayProps } from './camera/ViewportCropOverlay';

// ── AR (Phase 4) ────────────────────────────────────────────────────────
// ARKit (iOS) / ARCore (Android) session wrapper.  Foundation for
// pose-driven stitching (Phase 5), measurement (Phase 6), and
// detection-then-measure (Phase 7).  See
// docs/site-content/design/2026-04-29-ar-measurement-and-detection.md.
export { useARSession, ARTrackingState } from './ar/useARSession';
export type {
  UseARSessionReturn,
  FramePose,
} from './ar/useARSession';
export { CapturePreview } from './camera/CapturePreview';
export type {
  CapturePreviewProps,
  CapturePreviewAction,
  CapturePreviewActionVariant,
} from './camera/CapturePreview';
// Kept for back-compat with anyone who imported it during Phase 2.6;
// host code prefers <CapturePreview> directly so the same component
// renders thumbnail tap + post-stitch confirm.
export { PanoramaConfirmModal } from './camera/PanoramaConfirmModal';
export type { PanoramaConfirmModalProps } from './camera/PanoramaConfirmModal';
export { useVideoCapture } from './camera/useVideoCapture';
export type {
  UseVideoCaptureReturn,
  VideoCaptureState,
  ExtractFramesOptions,
  ExtractFramesResult,
} from './camera/useVideoCapture';

// ── Quality ──────────────────────────────────────────────────────────────
export { runQualityCheck } from './quality/runQualityCheck';
export { normaliseOrientation } from './quality/normaliseOrientation';
export type { NormaliseOrientationResult } from './quality/normaliseOrientation';

// ── Stitching ────────────────────────────────────────────────────────────
export {
  stitchFrames,
  StitchNotImplementedError,
} from './stitching/stitchFrames';
export type {
  StitchFramesOptions,
  StitchFramesResult,
} from './stitching/stitchFrames';
export { stitchVideo } from './stitching/stitchVideo';
export type { StitchVideoOptions } from './stitching/stitchVideo';

// ── Incremental (Phase 0 — live panorama, replaces stitchVideo flow) ────
// See docs/site-content/design/2026-04-30-realtime-incremental-stitching.md.
export {
  IncrementalOutcome,
  incrementalStitcherIsAvailable,
  subscribeIncrementalState,
  getIncrementalNativeModule,
} from './stitching/incremental';
export type {
  IncrementalState,
  IncrementalStartOptions,
  IncrementalFinalizeResult,
  ARPlaneStatus,
} from './stitching/incremental';
export { useIncrementalStitcher } from './stitching/useIncrementalStitcher';
export type {
  UseIncrementalStitcherReturn,
  IncrementalHint,
} from './stitching/useIncrementalStitcher';
export { useIncrementalAndroidDriver } from './stitching/useIncrementalAndroidDriver';
export type {
  UseIncrementalAndroidDriverOptions,
  IncrementalAndroidDriverHandle,
} from './stitching/useIncrementalAndroidDriver';
export { IncrementalStitcherView } from './stitching/IncrementalStitcherView';
export type { IncrementalStitcherViewProps } from './stitching/IncrementalStitcherView';

// ── Phase 6: Measurement ─────────────────────────────────────────────────
export {
  measureDistance,
  measureRegion,
  MeasurementNotAvailableError,
} from './measure/measure';
// FramePose is re-exported from useARSession above; the measure
// module re-uses the same shape so we don't list it again here.
export type {
  MeasurementConfidence,
  MeasureDistanceOptions,
  MeasureDistanceResult,
  MeasureRegionOptions,
  MeasureRegionResult,
} from './measure/measure';
export { MeasurementOverlay } from './measure/MeasurementOverlay';
export type {
  MeasurementMode,
  MeasurementOverlayProps,
} from './measure/MeasurementOverlay';

// ── Phase 7: On-edge packet detection ────────────────────────────────────
export {
  runPacketDetection,
  packetDetectionIsAvailable,
} from './detect/detect';
export type {
  DetectionBBox,
  DetectedItem,
  RunPacketDetectionOptions,
  RunPacketDetectionResult,
} from './detect/detect';
