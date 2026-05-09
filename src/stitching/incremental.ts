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
  /**
   * V16 — pose-driven keyframe gate rejected the frame because it
   * overlapped >= (1 − overlapThreshold) with the last accepted
   * keyframe.  Host should keep showing the same status — user is
   * mid-pan between two natural keyframe boundaries.  No UX hint
   * needed (this is the expected behaviour 90% of the time when
   * pose-based selection is on).
   */
  SkippedKeyframeOverlap = 8,
  /**
   * V16 — pose-driven keyframe gate rejected the frame because the
   * capture has hit `keyframeMaxCount` (default 6).  Host should
   * auto-finalize since no more frames will be accepted.
   */
  SkippedKeyframeMaxReached = 9,
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
  /**
   * V16 — pose-driven keyframe gate's max-keyframes cap for the
   * current capture.  When > 0, the JS status pill renders
   * `Keyframes: acceptedCount / keyframeMax` so the operator can see
   * the budget remaining.  When 0, the keyframe gate is disabled
   * (frameSelectionMode = "time-based") and the host should display
   * acceptedCount as a raw counter without a denominator.
   *
   * Defaults to 0 before the first frame and stays 0 for the entire
   * capture when the gate is disabled.
   */
  keyframeMax: number;
  /**
   * V16 Phase 1 — populated by the `batch-keyframe` engine on each
   * keyframe-accepted event.  Path to the JPEG saved under the
   * session directory.  Host can render a thumbnail from this path
   * in `LiveFrameStrip` so the operator sees what the gate accepted.
   * Undefined for other engines and for non-accept events.
   */
  batchKeyframeThumbnailPath?: string;
  /**
   * V16 Phase 1 — zero-based keyframe index assigned by the
   * collector when the JPEG was saved.  Useful as a stable React key
   * for the thumbnail strip.
   */
  batchKeyframeIndex?: number;
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
  engine?: 'hybrid' | 'slitscan-rotate' | 'slitscan-both' | 'batch-keyframe' |
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

  /** V15.0c — where on the camera frame the per-accept sliver is taken.
   *  'Center' (V13.x default), 'Bottom' (leading edge for top-to-bottom
   *  pan), or 'Top' (leading edge for bottom-to-top pan). */
  sliverPosition: 'Center' | 'Bottom' | 'Top';

  /** V15.0c — when true, the FIRST accepted frame paints the entire
   *  camera frame at canvas (0, 0); subsequent frames still use the
   *  configured sliver clip.  Default false; set true when sliverPosition
   *  is Bottom/Top so the canvas is anchored with full-frame content. */
  firstFrameFullFrame: boolean;

  /** **DEPRECATED in V15.0d** — use `planeSource` instead.
   *
   *  V15.0b boolean toggle for the plane-projected stitch path.
   *  Kept for backward compat: when `planeSource` is left at its
   *  default (Disabled), `useDetectedPlane = true` upgrades it to
   *  ARKitDetected.  New callers should set `planeSource` directly. */
  useDetectedPlane: boolean;

  /** V15.0d — source of the plane used by the V15.0b plane-projected
   *  stitch path.
   *
   *  - 'Disabled' (default): no plane projection; slit-scan path runs.
   *  - 'ARKitDetected': use ARKit's first vertical plane that aligns
   *    with the camera's view direction (filter threshold:
   *    `arkitPlaneAlignmentThreshold`).  Falls back to slit-scan
   *    silently when no aligned plane is found.
   *  - 'Virtual': synthesize a plane at first frame: origin =
   *    camera_pos + `virtualPlaneDepthMeters` × camera_forward;
   *    normal = -camera_forward.  Always works; no ARKit dependency.
   *
   *  Field testing showed ARKit plane detection often picks the WRONG
   *  surface (side wall, doorframe) — Virtual mode is the safer
   *  default for arbitrary scenes.  ARKitDetected wins when ARKit
   *  finds the correct fixture face. */
  planeSource: 'Disabled' | 'ARKitDetected' | 'Virtual';

  /** V15.0d — depth (metres) at which the synthetic plane is placed
   *  in front of the camera when `planeSource = Virtual`.  Set to
   *  the user's typical scan distance.  Range 0.3 – 5.0 m.  Default
   *  1.5 m. */
  virtualPlaneDepthMeters: number;

  /** V15.0d — minimum dot product between an ARKit-detected plane's
   *  surface normal and the camera's facing direction for the plane
   *  to be accepted (when `planeSource = ARKitDetected`).  1.0 =
   *  plane perfectly facing camera; 0.0 = plane edge-on; negative
   *  = facing away.  Range 0.0 – 1.0.  Default 0.6 (≈53° max angle
   *  off-camera). */
  arkitPlaneAlignmentThreshold: number;

  /** V15.0g — how the plane-projection helper renders each frame onto
   *  the canvas.  Affects ARKitDetected and Virtual modes; ignored
   *  when planeSource = Disabled.
   *
   *  - 'Trapezoidal' (V15.0b legacy): geometrically-correct 3D
   *    raycast.  Each camera pixel maps to its plane intersection.
   *    Result is a trapezoid that grows distorted with tilt
   *    (cooler-bottom-2.3×-wider-than-top problem).
   *  - 'Rectified' (V15.0g default): camera frame pasted as a clean
   *    rectangle around its plane-projected anchor.  Eliminates the
   *    tilt-induced trapezoidal distortion at the cost of strict 3D-
   *    correctness — the camera's per-pixel perspective stays inside
   *    the rectangle but doesn't reconcile across tilts. */
  planeProjectionStyle: 'Trapezoidal' | 'Rectified';

  /** V15.0d — 2D NCC search half-window in pixels.  Was hardcoded
   *  ±12 in V15.0c.4.  Smaller = less wandering on repetitive
   *  textures (peg holes, slatted panels), but easier to miss the
   *  true overlap when pose noise is high.  Range 4 – 30.  Default
   *  12. */
  nccSearchMargin2d: number;

  /** V15.0d — 2D NCC confidence threshold below which the correction
   *  is rejected.  Was hardcoded 0.75 in V15.0c.4.  Higher = stricter,
   *  fewer false matches on repetitive textures, but more frames
   *  where NCC silently doesn't fire.  Range 0.30 – 0.99.  Default
   *  0.75. */
  nccConfidenceThreshold2d: number;

  /** V15.0d (1B) — exponential-moving-average smoothing on 2D NCC
   *  corrections.  When enabled, the applied correction is
   *  `α × current + (1−α) × prev` instead of just `current`.  Damps
   *  single-frame snaps to spurious peaks.  Default false. */
  enableNcc2dEmaSmoothing: boolean;

  /** V15.0d — EMA weight on the CURRENT-frame NCC correction
   *  (1 − α weight on the previous correction).  Range 0.05 – 0.95.
   *  Default 0.4 (60% prev / 40% current — heavy damping). */
  ncc2dEmaAlpha: number;

  /** V15.0d (1C) — pan-axis-aware 2D NCC.  When enabled, the cross-
   *  axis (perpendicular to pan) NCC correction is clamped tighter
   *  than the pan-axis (since 1D NCC + pose already handle cross-
   *  axis wobble).  Default false. */
  enableNcc2dPanAxisLock: boolean;

  /** V15.0d — cross-axis clamp (pixels) for the pan-axis-aware mode.
   *  Range 0 – 30.  Default 5. */
  ncc2dCrossAxisLockPx: number;

  // Frame selection (V16)

  /** V16 — how the engine decides which ARFrames to ingest.
   *
   *  - 'time-based' (default): every frame the AR delegate delivers
   *    is forwarded to the engine; the engine's existing internal
   *    gate (kMinAcceptDeltaPx, time-throttled snapshot) decides
   *    accept/reject.  Backward-compatible with all prior versions.
   *  - 'pose-based': frames are pre-filtered by a Swift-side
   *    KeyframeGate.  A frame is forwarded only when its projection
   *    onto the latched ARKit plane has at least
   *    `keyframeOverlapThreshold` of NEW area vs the last accepted
   *    keyframe.  Bounded to `keyframeMaxCount` frames per capture.
   *    Mirrors how iOS Camera and Samsung Pano actually work.
   *
   *  Pose-based requires `planeSource` != 'Disabled' for the gate to
   *  engage; with no plane available the gate degrades silently to
   *  passthrough. */
  frameSelectionMode: 'time-based' | 'pose-based';

  /** V16 — required fraction of NEW content per keyframe in pose-
   *  based mode.  Range 0.10 – 0.80.  Default 0.40 (= the new frame
   *  must share at most 60% of its plane footprint with the last
   *  accepted keyframe).  Lower = more keyframes per capture +
   *  more redundancy + better feature matching but higher memory.
   *  Higher = fewer keyframes + less margin for blurry frames. */
  keyframeOverlapThreshold: number;

  /** V16 — hard cap on keyframes per capture in pose-based mode.
   *  Range 3 – 10.  Default 6 (matches Samsung's typical behaviour).
   *  Once reached, all subsequent frames are rejected and the host
   *  should auto-finalize. */
  keyframeMaxCount: number;
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


/**
 * V15.0e — ARKit plane detection state, polled by the capture screen
 * UI when planeSource=ARKitDetected.  Used to render a status pill:
 *
 *   - status === 'searching': no candidate plane seen yet.  UI shows
 *     a red/amber "Looking for wall plane…" pill and a hint to aim
 *     at a textured area for a few seconds.
 *   - status === 'evaluating': ARKit found candidate plane(s) but
 *     the alignment filter rejected them all.  UI shows the
 *     bestAlignment so the operator can see they're CLOSE
 *     ("plane found but off-axis (best 0.45)") and aim more
 *     directly at the wall.
 *   - status === 'ready': plane is latched.  UI shows green "Plane
 *     locked" and enables the Capture (hold-to-scan) button.
 */
export interface ARPlaneStatus {
  status: 'searching' | 'evaluating' | 'ready';
  hasPlane: boolean;
  /** Best rejected-alignment score seen so far.  -1 = no candidate yet.
   *  Range [-1, 1]; positive when at least one candidate was evaluated. */
  bestAlignment: number;
  /** Current alignment threshold (matches the engine config). */
  threshold: number;
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
  /** V15.0e — poll AR plane detection state.  Polled at ~2 Hz when
   *  planeSource=ARKitDetected so the status pill updates live. */
  getARPlaneStatus(): Promise<ARPlaneStatus>;
  /** V15.0g — clear the latched ARKit plane and re-evaluate all
   *  currently-tracked vertical planes against the camera's CURRENT
   *  aim, picking the largest plane that passes the alignment
   *  threshold.  Called by the capture screen on hold-to-scan press
   *  so the latched plane reflects what the operator is aiming at
   *  right NOW, not whichever plane ARKit noticed first. */
  relatchARPlane(): Promise<{ latched: boolean }>;
  /** V16 — arm the pose-driven keyframe gate to force-accept the
   *  next ARFrame regardless of overlap.  Called by the capture
   *  screen on shutter release so the trailing edge of the scan
   *  isn't truncated when the user releases mid-pan.  No-op when
   *  the gate is disabled (frameSelectionMode = 'time-based'). */
  markNextFrameAsLastKeyframe(): Promise<{ ok: true }>;
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
