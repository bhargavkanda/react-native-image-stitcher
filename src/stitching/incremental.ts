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
  /**
   * V12.11 Step D — operator panned BACKWARDS past the running
   * max along the pan axis.  Engine has SKIPPED the paste; host
   * should auto-finalize the capture (the most useful pano is
   * what we have so far at the high-water mark).  Emitted by
   * the rectilinear engine only — cylindrical engines tolerate
   * reverse motion via their warp pipeline.
   */
  RejectedReverseDirection = 7,
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
  /**
   * V12.12 — engine-detected physical orientation, set from
   * `R_panToCam` at first frame.  TRUE for landscape capture
   * (vertical pan), FALSE for portrait (horizontal pan).  Stays
   * at the FIRST-FRAME determination thereafter.
   *
   * **This is the single source of truth for orientation across
   * the SDK + host.**  JS-side hooks (e.g. `useDeviceOrientation`,
   * `useWindowDimensions`) are unreliable when iOS interface-
   * orientation lock is on; pose-derived detection is.  UI
   * components that need to know orientation (band overlay, dim
   * bars, pan guide) MUST consume `state.isLandscape` rather
   * than re-detecting.
   *
   * Defaults to `false` before the first frame is accepted (no
   * pose to detect from yet).  Hosts can fall back to a JS hook
   * for the brief pre-capture preview if needed.
   */
  isLandscape: boolean;
  /**
   * V12.14.9 — running painted extent along the pan axis, in canvas
   * pixels.  Trailing edge of the most-recently-pasted slit.  Pre-
   * first-frame this is 0.  After first-frame ≈ slit pan-axis size
   * (~756 px for default kPanAxisFractionRect=0.7 on 1080-row sensor).
   * Grows toward `panExtent` as the user pans.
   *
   * Used by the band overlay to compute `fillRatio = paintedExtent /
   * panExtent`, which sizes the thumbnail proportional to pan
   * progress.  Replaces the V12.13 aspect-ratio-based formula that
   * required the user to pan >1920 px before the thumb visibly grew.
   *
   * Defaults to 0 before the first frame.
   */
  paintedExtent: number;
  /**
   * V12.14.9 — total canvas pan-axis extent in pixels (engine config,
   * default 5000).  Constant for the lifetime of a capture.  Used as
   * the denominator for the fillRatio computation.  Defaults to 0
   * before the first frame.
   */
  panExtent: number;
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
   * Engine mode (V15):
   *   'hybrid'           — Whole-frame projection + feature matching;
   *                        planar projection by default (was cylindrical
   *                        before V15; cylindrical can be re-enabled via
   *                        `config.hybridProjection`).
   *   'slitscan-rotate'  — V13.0a baseline (pose-only paste, rectilinear,
   *                        first-painted-wins) + 1D NCC for rotation
   *                        wobble correction.
   *   'slitscan-both'    — DEFAULT.  V13.0a baseline + no accept gate
   *                        + feather blend.  Iterate via `config`
   *                        overrides (toggle triangulation / 2D NCC /
   *                        RANSAC homography / paint mode etc.).
   *
   * Backward compat: 'firstwins-rectilinear' is mapped to
   * 'slitscan-rotate'.  Legacy 'firstwins', 'firstwins-zoomed', and
   * 'slitscan' fall back to 'slitscan-both' with a deprecation warning
   * in the native log.
   */
  engine?: 'hybrid' | 'slitscan-rotate' | 'slitscan-both' |
           // Deprecated — kept for type-compat during the V14 → V15 transition:
           'firstwins' | 'firstwins-zoomed' | 'firstwins-rectilinear' | 'slitscan';
  /**
   * V15 — per-stage correction config overrides.  Mode-driven defaults
   * are applied first (see RLISStitcherConfig +configForMode:); fields
   * present here override those defaults.  Any field may be omitted to
   * accept the default.
   */
  config?: Partial<StitcherConfig>;
}


/**
 * V15 — per-stage stitcher correction config.  Each field is a runtime
 * toggle/value; the native engine reads it on every ingest call.  All
 * fields optional (omit to accept the engine-mode default).
 */
export interface StitcherConfig {
  // Slit shaping (slit-scan engine only)
  /** Fraction of pan-axis the rectilinear slit retains per frame.
   *  Range 0.10 – 0.70, default 0.30 in V15 slit-scan modes. */
  kPanAxisFractionRect: number;
  /** Minimum pan-axis advance (px) before a frame is accepted.
   *  0 = accept on every consumeFrame (Apple-dense slit-scan, V15
   *  default).  50 = V13.0g default. */
  kMinAcceptDeltaPx: number;

  // Per-stage correction toggles
  /** V13.0e+ ORB triangulation + median-Z parallax correction. */
  enableTriangulation: boolean;
  /** V13.0g per-accept incremental Δt accumulator on top of triangulation. */
  enableTriAccumulator: boolean;
  /** V15 1D NCC perpendicular-axis wobble correction (slitscan-rotate
   *  default).  Independent of the other correction stages. */
  enable1dNcc: boolean;
  /** 1D NCC search radius in pixels (5 – 60). */
  nccSearchRadius1d: number;
  /** V13.0g 2D NCC fine-alignment after triangulation. */
  enable2dNcc: boolean;
  /** V14.0a RANSAC homography per slit + cv::warpPerspective.  When
   *  enabled and successful, supersedes the rectangular paste path. */
  enableRansacHomography: boolean;

  // Paint mode (slit-scan engine only)
  /** 'FirstPaintedWins' protects already-painted pixels (V13.0e+
   *  default).  'FeatherBlend' alpha-blends new content into already-
   *  painted overlap pixels (V13.0d-style; V15 slitscan-both default). */
  paintMode: 'FirstPaintedWins' | 'FeatherBlend';

  // Hybrid engine
  /** 'Cylindrical' (V12.x – V14.0a behaviour) or 'Planar' (V15 default;
   *  cv::detail::PlaneWarper).  Planar is well-behaved for pans <60°. */
  hybridProjection: 'Cylindrical' | 'Planar';

  /** V15.0b — when true (slit-scan modes), each accepted frame is
   *  warped onto a detected vertical plane (Trax-style "Virtual
   *  Ruler") rather than onto the pose-driven rectilinear canvas.
   *  Requires ARKit to detect a vertical plane during the capture
   *  (typically 2–5 s on non-LiDAR; sub-second on LiDAR).  Until a
   *  plane is detected, frames fall back to the standard pose-driven
   *  projection.  Composes with paint mode but skips the per-stage
   *  refinements (1D NCC, 2D NCC, RANSAC homography) since they're
   *  2D-image alignments that don't apply when the canvas is the
   *  actual 3D plane. */
  useDetectedPlane: boolean;
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
