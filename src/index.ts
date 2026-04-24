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
export { useVideoCapture } from './camera/useVideoCapture';
export type {
  UseVideoCaptureReturn,
  VideoCaptureState,
  ExtractFramesOptions,
  ExtractFramesResult,
} from './camera/useVideoCapture';

// ── Quality ──────────────────────────────────────────────────────────────
export { runQualityCheck } from './quality/runQualityCheck';

// ── Stitching ────────────────────────────────────────────────────────────
export {
  stitchFrames,
  StitchNotImplementedError,
} from './stitching/stitchFrames';
export type {
  StitchFramesOptions,
  StitchFramesResult,
} from './stitching/stitchFrames';
