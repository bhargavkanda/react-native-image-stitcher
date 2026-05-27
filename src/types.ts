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
}

export interface QualityReport {
  passed: boolean;
  blurScore: number;
  brightnessScore: number;
  issues: QualityIssue[];
}

export interface QualityIssue {
  type: 'blur' | 'brightness_low' | 'brightness_high' | 'framing';
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

/**
 * v0.9.0 Layer 3 — one sampled frame delivered by `useFrameStream`
 * to the JS-thread handler.
 *
 * The JPEG file at `jpegPath` is the stream's own copy.  Hosts that
 * need long-term retention MUST copy the file synchronously inside
 * the handler — the same path may be overwritten by a subsequent
 * sample (slot reuse — see the hook's docstring for the rotation
 * policy).
 */
export interface SampledFrame {
  /** Absolute filesystem path to the JPEG.  No `file://` prefix. */
  jpegPath: string;

  /**
   * Pose at sample time.  `translation` is `undefined` in non-AR
   * mode (gyro provides rotation only; no spatial anchor).
   */
  pose: {
    rotation: [number, number, number, number];
    translation?: [number, number, number];
  };

  /** Frame timestamp (ms; per the v0.8.0 StitcherFrame contract). */
  timestamp: number;

  /** JPEG width / height in pixels. */
  width: number;
  height: number;
}

/**
 * v0.9.0 Layer 3 — options for `useFrameStream`.
 *
 * For worklet-native processing without JPEG roundtrip (OCR via
 * Vision/ML Kit, TFLite ML, LiDAR depth), use
 * `useThrottledFrameProcessor` (Layer 2) instead.
 */
export interface FrameStreamOptions {
  /**
   * Target sampling rate in Hertz.  Clamped to `[0.5, 10]`.  The
   * Layer 2 throttle gate enforces the rate inside the worklet;
   * ticks too close together are dropped silently.
   *
   * Clamp upper bound (10 Hz) is intentionally lower than Layer 2's
   * (30 Hz) — beyond 10 Hz the per-frame JPEG encode + JS-bridge
   * cost dominates the wall-clock budget.  Hosts that need higher
   * rates should be on Layer 2 with their own JPEG encoder call
   * (or no JPEG at all).
   */
  sampleHz: number;

  /**
   * JPEG quality (0-100).  Default 75.  Clamped silently to
   * `[1, 100]` by the underlying `save_frame_as_jpeg` native plugin.
   */
  quality?: number;

  /**
   * Directory to write JPEG files into.  Defaults to a per-app
   * `<cache>/rnis-frame-stream/` subdirectory.  The directory is
   * `mkdir -p`'d on first use; hosts that supply an existing
   * absolute path are responsible for its lifecycle.
   */
  outputDir?: string;
}

/**
 * v0.9.0 Layer 2 — options for `useThrottledFrameProcessor`.
 *
 * Wraps v0.8.0's `useFrameProcessor` with a monotonic-time throttle
 * gate so the supplied worklet fires at most `sampleHz` times per
 * second.  Use for sub-frame-rate worklet-native processing — native
 * OCR (Vision.framework / ML Kit), TFLite ML detection, LiDAR depth
 * processing — where the bbox / depth payloads are small enough to
 * bridge to JS via `runOnJS`.
 *
 * For JS-thread JPEG consumers (file-path OCR libraries, cloud
 * upload, thumbnail UI), use `useFrameStream` (Layer 3) instead.
 */
export interface ThrottledFrameProcessorOptions {
  /**
   * Target sampling rate in Hertz.  Clamped to `[0.5, 30]`.  Inside
   * the worklet a monotonic-time gate enforces the rate; ticks too
   * close together are silently dropped.
   *
   * The clamp upper bound (30 Hz) sits at typical AR rates on
   * mid-range Android devices — beyond that, the host should just
   * use `useFrameProcessor` directly (no throttle).  The clamp
   * lower bound (0.5 Hz) prevents accidentally-zero-divide values
   * + matches `useFrameStream`'s convention.
   */
  sampleHz: number;
}

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
}
