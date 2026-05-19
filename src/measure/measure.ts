/**
 * measure.ts — Phase 6 measurement API.
 *
 * Wraps the native RetaiLensMeasure module (iOS) which uses an
 * SfM-flavoured plane-projection approach: extract yaw range from
 * ARKit poses, assume a scene depth (default 0.70 m for shelf-arm-
 * length capture), compute pixels-per-metre, convert pixel
 * distances/regions to centimetres.
 *
 * Accuracy caveats baked into this approximation:
 *   - Single-depth assumption.  Packets at different distances
 *     measure inconsistently.
 *   - Panoramic captures are mostly rotational, so we can't do
 *     proper SfM-triangulation (small baselines).  Plane projection
 *     is the honest trade-off.
 *   - Lens distortion at extreme angles isn't corrected.
 *
 * The `confidence` field returned with every measurement reflects
 * input quality.  Surface it to the operator so they know whether
 * to trust a number or recapture.
 *
 * Cross-platform note: Android port uses an analogous ARCore-based
 * native module exposing the same JS surface (Phase 4 catch-up).
 */

import { NativeModules } from 'react-native';


export type MeasurementConfidence = 'high' | 'medium' | 'low';


export interface FramePose {
  tx: number; ty: number; tz: number;
  qx: number; qy: number; qz: number; qw: number;
  fx: number; fy: number; cx: number; cy: number;
  imageWidth: number; imageHeight: number;
  timestampMs: number;
  trackingState: number;
}


export interface MeasureDistanceOptions {
  /** Width of the saved panorama image in pixels. */
  panoramaWidth: number;
  /** Height of the saved panorama image in pixels. */
  panoramaHeight: number;
  /** ARKit pose log captured alongside the panorama. */
  framePoses: FramePose[];
  /** First pinned point in panorama pixel coordinates. */
  pointA: { x: number; y: number };
  /** Second pinned point in panorama pixel coordinates. */
  pointB: { x: number; y: number };
  /** Optional override for the assumed scene depth (metres). */
  sceneDepthMeters?: number;
}


export interface MeasureDistanceResult {
  distanceCm: number;
  confidence: MeasurementConfidence;
  /** Diagnostic — pixels-per-metre used.  Useful to debug bad measurements. */
  pixelsPerMetre: number;
}


export interface MeasureRegionOptions {
  panoramaWidth: number;
  panoramaHeight: number;
  framePoses: FramePose[];
  topLeft: { x: number; y: number };
  bottomRight: { x: number; y: number };
  sceneDepthMeters?: number;
}


export interface MeasureRegionResult {
  widthCm: number;
  heightCm: number;
  confidence: MeasurementConfidence;
  pixelsPerMetre: number;
}


export class MeasurementNotAvailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MeasurementNotAvailableError';
  }
}


function getNative(): {
  measureDistance: (opts: MeasureDistanceOptions) => Promise<MeasureDistanceResult>;
  measureRegion: (opts: MeasureRegionOptions) => Promise<MeasureRegionResult>;
} {
  const native: unknown =
    (NativeModules as Record<string, unknown>)['RetaiLensMeasure'];
  if (
    !native
    || typeof native !== 'object'
    || typeof (native as { measureDistance?: unknown }).measureDistance !== 'function'
  ) {
    throw new MeasurementNotAvailableError(
      'react-native-image-stitcher: RetaiLensMeasure native module is not '
      + 'registered.  Phase 6 ships iOS first; Android port comes alongside '
      + 'the ARCore catch-up.',
    );
  }
  return native as {
    measureDistance: (opts: MeasureDistanceOptions) => Promise<MeasureDistanceResult>;
    measureRegion: (opts: MeasureRegionOptions) => Promise<MeasureRegionResult>;
  };
}


/**
 * Measure the real-world distance between two points pinned on a
 * saved panorama.  Returns centimetres + a confidence indicator.
 *
 * Throws `MeasurementNotAvailableError` if the panorama wasn't
 * captured in AR mode (no `framePoses`) or the native module
 * isn't registered.
 */
export async function measureDistance(
  options: MeasureDistanceOptions,
): Promise<MeasureDistanceResult> {
  if (!options.framePoses || options.framePoses.length < 2) {
    throw new MeasurementNotAvailableError(
      'measureDistance: at least 2 framePoses are required.  '
      + 'This panorama was likely captured before AR mode was enabled.',
    );
  }
  return getNative().measureDistance(options);
}


/**
 * Measure the real-world width and height of a rectangular region
 * pinned on a saved panorama.  Returns centimetres + a confidence
 * indicator.
 *
 * Throws `MeasurementNotAvailableError` if the panorama wasn't
 * captured in AR mode (no `framePoses`) or the native module
 * isn't registered.
 */
export async function measureRegion(
  options: MeasureRegionOptions,
): Promise<MeasureRegionResult> {
  if (!options.framePoses || options.framePoses.length < 2) {
    throw new MeasurementNotAvailableError(
      'measureRegion: at least 2 framePoses are required.  '
      + 'This panorama was likely captured before AR mode was enabled.',
    );
  }
  return getNative().measureRegion(options);
}
