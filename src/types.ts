// SPDX-License-Identifier: Apache-2.0
/**
 * Internal type definitions for `react-native-image-stitcher`.
 *
 * These are NOT re-exported from `src/index.ts` — they are consumed
 * by internal modules (`useCapture`, `runQualityCheck`) and adapted
 * to the public surface (e.g., `CameraCaptureResult` in
 * `src/camera/Camera.tsx`) before reaching consumers.
 *
 * If something here needs to become public, expose it deliberately
 * from `src/index.ts` rather than encouraging deep imports.
 */

// ── Quality-check result types ────────────────────────────────────────────
// These are used by `quality/runQualityCheck.ts` and the internal
// `useCapture` hook.  Algorithm details: Laplacian variance for blur,
// mean luminance for brightness.

export interface QualityThresholds {
  /** Minimum Laplacian variance for blur detection */
  minBlurScore: number;
  /** Minimum brightness (0-255) */
  minBrightness: number;
  /** Maximum brightness (0-255) */
  maxBrightness: number;
  /**
   * Mean dark-channel 0..255 over the product region (see cpp/glare.hpp).
   * When set, a non-blocking veiling-glare warning fires if the score
   * exceeds it. OPTIONAL — omit to disable the glare check entirely.
   * Recommended ≈ 33 (calibrated; consumer-owned single source of truth).
   */
  maxGlare?: number;
}

export interface QualityReport {
  passed: boolean;
  blurScore: number;
  brightnessScore: number;
  issues: QualityIssue[];
}

export interface QualityIssue {
  type: 'blur' | 'brightness_low' | 'brightness_high' | 'framing' | 'glare';
  message: string;
  severity: 'warning' | 'error';
}

// ── Device metadata captured at takePhoto time ────────────────────────────
// Internal-only.  `useCapture` populates this from native side; the
// public `CameraCaptureResult` (in Camera.tsx) doesn't include it
// because most public consumers don't want it and shouldn't pay for
// the round-trip-to-native cost in their type contract.

export interface DeviceMetadata {
  platform: 'ios' | 'android';
  osVersion: string;
  deviceModel: string;
  cameraId: string;
  flashEnabled: boolean;
}

// ── Internal CaptureResult shape returned by useCapture.takePhoto ─────────
// `Camera.tsx` adapts this into the public `CameraCaptureResult` (a
// discriminated union of photo + panorama) before emitting `onCapture`.

export interface CaptureResult {
  /** Unique device-generated UUID */
  deviceUuid: string;
  /** Local file path to compressed image */
  compressedUri: string;
  /** Local file path to original image (if retained) */
  originalUri?: string;
  /** Image width in pixels, after EXIF orientation correction. */
  width: number;
  /** Image height in pixels, after EXIF orientation correction. */
  height: number;
  /** Whether this is a stitched panoramic image */
  isStitched: boolean;
  /** Capture timestamp (ISO 8601) */
  capturedAt: string;
  /** Quality check results (if enabled) */
  qualityReport?: QualityReport;
  /** Device metadata at capture time */
  deviceMetadata: DeviceMetadata;
  /**
   * iOS `captureDepthData` — path of the `<photo>.depth.bin` sidecar
   * (float32 metres + JSON header; see `extractPhotoDepth`) saved next to
   * `compressedUri`.  Absent on Android, on depth-less devices/formats,
   * and whenever the opt-in is off.
   */
  depthPath?: string;
}
