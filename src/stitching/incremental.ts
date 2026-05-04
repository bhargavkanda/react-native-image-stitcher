/**
 * Incremental panorama-stitching native module bindings.
 *
 * See docs/site-content/design/2026-04-30-realtime-incremental-stitching.md
 * for the architectural rationale.  This file is the type-safe JS
 * wrapper around the RN bridge; `useIncrementalStitcher` is the hook
 * host code consumes; `IncrementalStitcherView` renders the live
 * panorama preview.
 */

import { NativeModules, NativeEventEmitter } from 'react-native';
import type { EmitterSubscription, NativeModule } from 'react-native';


/**
 * Per-frame outcome returned by the engine.  Mirrors the iOS
 * `RLISFrameOutcome` enum and the Android equivalent — numeric
 * values are kept identical so the JS layer doesn't branch on
 * platform.
 */
export enum IncrementalOutcome {
  /** High-confidence accept — silent UX. */
  AcceptedHigh = 0,
  /** Accept with marginal confidence — show subtle yellow ring. */
  AcceptedMedium = 1,
  /** Frame too close to the previous accepted — wait for more pan. */
  SkippedTooClose = 2,
  /** Frame too far past the overlap window — show "slow down" hint. */
  RejectedTooFar = 3,
  /** Too few feature matches — show "scene too uniform" hint. */
  RejectedSceneUniform = 4,
  /** RANSAC failed or homography degenerate — show "alignment lost". */
  RejectedAlignmentLost = 5,
  /** AR tracking quality was poor — skip silently. */
  SkippedTrackingPoor = 6,
}


export interface IncrementalState {
  /**
   * Path to the latest panorama snapshot JPEG (file path, no
   * `file://` prefix).  Present only on accepted frames where a
   * snapshot was written.  Renders directly via RN's `<Image>`.
   */
  panoramaPath: string | null;
  /** Width of the latest snapshot in pixels.  0 if no snapshot. */
  width: number;
  /** Height of the latest snapshot in pixels.  0 if no snapshot. */
  height: number;
  /** Total frames accepted into the panorama since `start()`. */
  acceptedCount: number;
  /** What happened to the most recent ARFrame the engine processed. */
  outcome: IncrementalOutcome;
  /** Composite confidence score [0, 1] for the most recent frame. */
  confidence: number;
  /**
   * Estimated FoV-overlap with the previous accepted frame, in
   * percent.  Useful for pacing UX.  -1 if first frame.
   */
  overlapPercent: number;
  /** Wall-clock ms the most recent addPixelBuffer call took. */
  processingMs: number;
}


export interface IncrementalStartOptions {
  /** Compose-resolution width in pixels (default 720 for portrait, 960 for landscape). */
  composeWidth?: number;
  /** Compose-resolution height in pixels (default 960 for portrait, 720 for landscape). */
  composeHeight?: number;
  /** Pre-allocated canvas width (default 5000). */
  canvasWidth?: number;
  /** Pre-allocated canvas height (default 5000 — square so either
   *  pan axis fits without runtime grow logic). */
  canvasHeight?: number;
  /** Feather-blend band width in pixels (default 20).  Unused after
   *  v5 hard-seam switch but kept for backwards compatibility. */
  featherPx?: number;
  /** JPEG quality for live snapshots [1, 100] (default 75). */
  snapshotJpegQuality?: number;
  /**
   * Emit a snapshot on every Nth accepted frame (default 1 — every
   * accept).  Higher values save disk I/O at the cost of staler
   * preview.  Useful on lower-end Android.
   */
  snapshotEveryNAccepts?: number;
  /**
   * Per-frame rotation applied before any stitching work, in degrees.
   * Must be one of `0`, `90`, `180`, `270`.  Compute from the device's
   * physical orientation:
   *   portrait              → 90  (CW; panorama grows horizontally
   *                                for the user's left↔right pan)
   *   portrait-upside-down  → 270 (CCW)
   *   landscape-left        → 0   (sensor already aligned)
   *   landscape-right       → 0   (sensor already aligned)
   *
   * Default `90` because most shelf scans are done in portrait.
   */
  frameRotationDegrees?: 0 | 90 | 180 | 270;
  /**
   * Engine mode:
   *   'hybrid'                — Cylindrical projection + KLT optical-flow
   *                             refinement + feather blend.
   *   'firstwins'             — Cylindrical projection + V12.4 central-70%
   *                             slit-scan crop + first-painted-wins overlay.
   *                             Original V12.4 firstwins behaviour, no
   *                             viewport zoom — kept as a baseline.
   *   'firstwins-zoomed'      — Same engine as 'firstwins' but JS applies
   *                             a viewport-zoom transform so the live
   *                             camera preview shows EXACTLY the central
   *                             region that gets painted (matches Apple's
   *                             pano viewport-vs-output relationship).
   *                             No native engine change vs 'firstwins'.
   *   'firstwins-rectilinear' — Skip cylindrical warp entirely.  First
   *                             frame is pasted raw onto the canvas
   *                             (matches the live viewport pixel-for-pixel).
   *                             Subsequent frames contribute a narrow
   *                             central strip placed by ARKit pose at
   *                             canvas_Y = -f·pitch_delta (landscape) or
   *                             canvas_X = -f·yaw_delta (portrait).
   *                             Zero cylindrical-projection curvature.
   *                             Limit: very wide pans (>~70° per direction)
   *                             will stretch at the edges due to inherent
   *                             rectilinear projection limits.
   *
   * Default 'hybrid' is the safer choice.
   */
  engine?: 'hybrid' | 'firstwins' | 'firstwins-zoomed' | 'firstwins-rectilinear';
}


export interface IncrementalFinalizeResult {
  /** Path to the final panorama JPEG written to `outputPath`. */
  panoramaPath: string;
  width: number;
  height: number;
  acceptedCount: number;
  /** Frames the engine queue dropped due to backpressure (diagnostic). */
  droppedBackpressure: number;
}


interface NativeIncrementalModule {
  start(options: IncrementalStartOptions): Promise<{ ok: true }>;
  /**
   * Finalize the running capture and write the final panorama JPEG.
   * `outputPath` is optional — when empty/omitted the native side
   * creates a path under the app's tmp directory and returns it
   * inside the `panoramaPath` field of the result.
   */
  finalize(options: { outputPath?: string; quality?: number }): Promise<IncrementalFinalizeResult>;
  cancel(): Promise<{ ok: true }>;
  getState(): Promise<IncrementalState | null>;
  /** PiP investigation only — write a JS-side message into the
   *  Swift-side rlis-debug.log so we get a single timeline. */
  appendDebugLog?(message: string): Promise<{ ok: true }>;
}


/**
 * Lazy-resolve the native module.  Returns null on platforms that
 * don't have it registered yet (e.g. older builds without the new
 * native code).  Callers fall back to the batch stitcher in that
 * case.
 */
export function getIncrementalNativeModule(): NativeIncrementalModule | null {
  const m = (NativeModules as Record<string, unknown>)['RetaiLensIncrementalStitcher'];
  if (!m || typeof m !== 'object') return null;
  // The cast is safe — RN runtime sees only `Function` for each
  // method but TypeScript's structural type system is happy with
  // a record of any-callable.
  return m as NativeIncrementalModule;
}


/**
 * Whether the native incremental stitcher is registered and ready.
 * Equivalent to `getIncrementalNativeModule() !== null`; provided
 * as a convenience export so host code reads cleanly.
 */
export function incrementalStitcherIsAvailable(): boolean {
  return getIncrementalNativeModule() !== null;
}


/**
 * Subscribe to per-frame state updates emitted by the native engine.
 * The returned `EmitterSubscription` MUST be removed when no longer
 * needed (`subscription.remove()`); leaks here cause memory growth
 * across captures.
 */
export function subscribeIncrementalState(
  listener: (state: IncrementalState) => void,
): EmitterSubscription | null {
  const native = getIncrementalNativeModule();
  if (!native) return null;
  // Cast through the structural NativeModule type — the bridge
  // module IS an RCTEventEmitter at runtime, which exposes
  // addListener/removeListeners as part of the contract.  TS just
  // can't see the iOS side's class hierarchy.
  const emitter = new NativeEventEmitter(
    NativeModules.RetaiLensIncrementalStitcher as unknown as NativeModule,
  );
  return emitter.addListener('RetaiLensIncrementalStateUpdate', listener);
}
