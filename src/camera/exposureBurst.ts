// SPDX-License-Identifier: Apache-2.0
/**
 * exposureBurst — JS plumbing for `CameraHandle.captureExposureBurst`
 * (v0.22.0): N consecutive video-stream frames captured at a FIXED
 * SHORT exposure, saved as JPEGs, with auto-exposure restored after.
 *
 * ## What this is for
 *
 * Display-refresh / PWM **rolling-shutter banding** probing.  A real
 * scene photographed at a very short exposure (≤ 2 ms) looks uniform;
 * an emissive display (LCD/OLED showing a photo of the scene) refreshes
 * top-to-bottom, so a rolling-shutter sensor at short exposure records
 * it as horizontal luminance BANDS.  A consumer (e.g. an anti-spoof
 * pipeline) row-mean-FFTs these frames over its region of interest to
 * decide "screen vs. real" — that analysis is deliberately NOT part of
 * this library; this file only provides the capture primitive.
 *
 * ## Division of labour
 *
 *   - JS (this file + Camera.tsx): AR-mode rejection, single-flight,
 *     output-path composition, arming the worklet-side frame tap.
 *   - `useStitcherWorklet`: when armed, forwards every producer-thread
 *     frame to the `rnis_exposure_burst_sink` Frame Processor plugin
 *     (BEFORE its own eval-throttle, so the burst sees every frame).
 *   - Native (`RNISExposureBurst` module + the sink plugin):
 *     applies the manual exposure to vision-camera's running session,
 *     gates frames on the exposure actually being live, JPEG-encodes N
 *     frames, restores auto-exposure, resolves.
 *
 * ## Why frames come from the VIDEO stream, not takePhoto
 *
 * Still-photo pipelines on modern phones run multi-frame fusion (Smart
 * HDR / Deep Fusion / Android vendor equivalents) that merges several
 * integrations into one output — which would AVERAGE AWAY the very
 * banding phase differences the probe needs.  Video-stream frames are
 * single-integration by construction, and the frame-processor tap the
 * lib already runs for panorama keyframes delivers them with no extra
 * session reconfiguration.
 */

import { NativeModules } from 'react-native';
import { Worklets, type ISharedValue } from 'react-native-worklets-core';


/** Options for {@link CameraHandle.captureExposureBurst}. */
export interface ExposureBurstOptions {
  /**
   * How many consecutive frames to capture.  Default `3`.
   * Clamped to `[1, 10]` natively (the frames are held as full-size
   * pixel copies until encoded, so large counts cost real memory).
   */
  frameCount?: number;
  /**
   * Target exposure duration in MILLISECONDS.  Default `2`.  Clamped
   * natively to the device's supported exposure range (the actual
   * value used is reported on the result as `exposureDurationMs`).
   * Display-refresh banding needs the exposure well under one refresh
   * period (16.7 ms @ 60 Hz), which is why the default is 2 ms.
   */
  exposureDurationMs?: number;
  /**
   * Sensor sensitivity (ISO) to pair with the short exposure.
   *
   *   - iOS default: the current auto-exposure ISO scaled by
   *     `currentExposure / targetExposure` (keeps the frame usable),
   *     clamped to the format's ISO range.
   *   - Android default: `800`, clamped to the sensor's range (the
   *     running session exposes no per-frame AE actuals to scale
   *     from).  Pass an explicit value if your scene needs it.
   */
  iso?: number;
  /** JPEG quality 1–100.  Default `85`. */
  quality?: number;
  /**
   * Directory to write `burst-<ts>/frame-<i>.jpg` under.  Defaults to
   * the lib's canonical capture dir.  Bare path or `file://` URI.
   */
  outputDir?: string;
  /**
   * Overall native timeout in ms (exposure apply + collection +
   * encode).  Default `5000`.  On timeout the burst rejects and
   * auto-exposure is restored.
   */
  timeoutMs?: number;
}


/** Result of {@link CameraHandle.captureExposureBurst}. */
export interface ExposureBurstResult {
  /**
   * Absolute BARE file paths of the captured JPEGs, in capture order.
   * Pixels are in the camera sensor's native (landscape) orientation
   * with NO rotation applied and NO EXIF orientation tag — image rows
   * are sensor rows, which is exactly the axis rolling-shutter banding
   * runs along.  Consumers that need display orientation must rotate
   * themselves (and account for the row-axis change in any banding
   * analysis).
   */
  frames: string[];
  /**
   * Pixel width of the frames (sensor-oriented).  Frames come from the
   * FRAME-PROCESSOR stream, so dimensions are stream-bound: Android's
   * CameraX ImageAnalysis stream is typically 640×480 (observed on the
   * Galaxy A35); iOS delivers the camera's pinned 4:3 video format
   * (≥1440p on modern iPhones).  480 sensor rows comfortably resolve
   * display-refresh banding (bands are a low-frequency row signal).
   */
  width: number;
  /** Pixel height of the frames (sensor-oriented). */
  height: number;
  /** Exposure duration actually applied, in ms (after clamping). */
  exposureDurationMs: number;
  /** ISO actually applied (after clamping). */
  iso: number;
  /**
   * Per-frame capture timestamps in NANOSECONDS (monotonic camera
   * clock), same order as `frames`.  Lets a consumer verify the
   * frames are consecutive (gaps ≈ one frame interval) before
   * trusting a multi-frame analysis.
   */
  timestampsNs: number[];
}


/** Shape of the `RNISExposureBurst` native module. */
interface ExposureBurstNativeModule {
  capture(options: {
    /** react tag of the mounted vision-camera view (Android session lookup). */
    viewTag: number;
    /** vision-camera `device.id` (iOS `AVCaptureDevice` uniqueID / Android camera2 id). */
    deviceId: string;
    frameCount: number;
    exposureDurationMs: number;
    /** -1 = platform default (see ExposureBurstOptions.iso). */
    iso: number;
    quality: number;
    /** Absolute dir the native side writes `frame-<i>.jpg` into (created on demand). */
    outputDir: string;
    timeoutMs: number;
  }): Promise<ExposureBurstResult>;
}


export function getExposureBurstNativeModule(): ExposureBurstNativeModule | null {
  const m = (NativeModules as Record<string, unknown>).RNISExposureBurst;
  if (!m || typeof m !== 'object') return null;
  return m as ExposureBurstNativeModule;
}


/**
 * Module-level armed flag read by EVERY `useStitcherWorklet` instance's
 * worklet body (module-level on purpose: a host that composes its own
 * frame processor via `useStitcherWorklet` runs a DIFFERENT hook
 * instance than the `<Camera>`-internal driver, and a per-instance
 * flag armed on one would never be seen by the other).  `1` = forward
 * frames to the burst sink plugin; `0` = skip (one shared-value read
 * per frame, no plugin-call overhead when idle).
 *
 * The flag is a coarse gate only — the native controller does the
 * precise per-frame gating (exposure-applied timestamp, frame count)
 * and simply ignores sink calls while no burst is in flight.
 */
export const exposureBurstArmed: ISharedValue<number> = Worklets.createSharedValue(0);


/** Arm/disarm the worklet-side frame tap.  Called by `<Camera>` around the native capture. */
export function setExposureBurstArmed(on: boolean): void {
  exposureBurstArmed.value = on ? 1 : 0;
}


/** Name of the vc Frame Processor plugin that receives tapped frames. */
export const EXPOSURE_BURST_SINK_PLUGIN = 'rnis_exposure_burst_sink';
