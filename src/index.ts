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
export { LiveFrameStrip } from './camera/LiveFrameStrip';
export type { LiveFrameStripProps } from './camera/LiveFrameStrip';
export { useDeviceOrientation } from './camera/useDeviceOrientation';
export type { DeviceOrientation } from './camera/useDeviceOrientation';
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
