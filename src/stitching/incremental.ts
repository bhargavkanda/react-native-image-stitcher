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
  /**
   * 2026-05-16 — realtime+batch fusion (Option A "Replace on
   * completion").  True between the moment a hybrid-engine
   * `finalize()` resolves with the live panorama AND the async
   * refinement of the same keyframes through cv::Stitcher completes.
   *
   * During the refinement window the host should render a small
   * "Refining…" pill so the operator knows a higher-quality result
   * is on the way; the operator can continue browsing / starting
   * another capture while the refinement runs.
   *
   * Stays false (or undefined) when the auto-trigger is a no-op —
   * e.g. when the hybrid engine had nothing on disk to refine.
   *
   * See: docs/site-content/design/2026-05-14-realtime-batch-fusion.md
   */
  isRefining?: boolean;
  /**
   * 2026-05-16 — realtime+batch fusion (Option A).  Path to the
   * refined panorama JPEG written by `cv::Stitcher`.  Emitted in a
   * single state event when the async refinement completes (after
   * the hybrid engine's `finalize()` has already returned the live
   * `panoramaPath`).
   *
   * Host code should treat this as the canonical panorama for the
   * remainder of the audit-capture flow when present, falling back
   * to `panoramaPath` when absent.  The refined output replaces the
   * live output in-place — operator UX-wise it's the same JPEG slot,
   * just sharper.
   *
   * Undefined when no refinement is in flight, when refinement fails,
   * or when the auto-trigger was skipped because there were no
   * keyframes on disk.
   */
  refinedPanoramaPath?: string;
}


export interface IncrementalStartOptions {
  /**
   * 2026-05-18 (Issue #2 regression fix) — frame source for the
   * iOS engine.
   *
   *   - 'arSession' (default) — engine registers as the
   *     ARSession's frame consumer.  Use in AR captures.  iOS
   *     bridge.start() requires `RNSARSession.start()` to
   *     have already been called.
   *
   *   - 'jsDriver' — engine skips AR-session registration; JS
   *     feeds frames via `processFrameAtPath`.  Use in iOS non-AR
   *     captures (vision-camera + gyro).  No AR session required.
   *
   * Android ignores this option — its engine always accepts
   * JS-driven frames.
   */
  frameSourceMode?: 'arSession' | 'jsDriver';
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
   *
   * @deprecated Use `captureOrientation` instead — it carries the
   *   landscape-left vs landscape-right distinction we need for
   *   correct output rotation per the two-modes spec
   *   (see memory/ar-stitching-two-modes.md).  Once Phase 3 of the
   *   captureOrientation migration lands this field is removed.
   */
  frameRotationDegrees?: 0 | 90 | 180 | 270;
  /**
   * Physical phone orientation at capture start, classified by the
   * accelerometer (`useDeviceOrientation`).  Drives the output
   * panorama's bake-rotation per the two supported capture modes:
   *
   *   AR-STITCHING-TWO-MODES — see memory/ar-stitching-two-modes.md
   *
   *   Mode A — landscape phone + vertical pan from top:
   *     'landscape-left'        → bake-rotate output 90° CCW
   *     'landscape-right'       → bake-rotate output 90° CW
   *       (mirror images of each other: world-up is on opposite
   *        sensor edges between L-left and L-right, so the
   *        rotations are opposite to land world-up at output-top)
   *
   *   Mode B — portrait phone + horizontal pan from left:
   *     'portrait'              → no bake-rotation
   *     'portrait-upside-down'  → bake-rotate output 180°
   *
   * Any other combination of phone orientation + pan direction is a
   * user deviation, not a supported mode.  The engine still runs
   * for unsupported combinations but the output rotation is a best-
   * effort: the same mapping is applied.
   *
   * Defaults to `'portrait'` (Mode B start state) if not supplied.
   */
  captureOrientation?:
    | 'portrait'
    | 'portrait-upside-down'
    | 'landscape-left'
    | 'landscape-right';
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
   *  - 'pose-based': frames are pre-filtered by a KeyframeGate.  A
   *    frame is forwarded only when its projection onto the latched
   *    ARKit plane has at least `keyframeOverlapThreshold` of NEW
   *    area vs the last accepted keyframe.  Bounded to
   *    `keyframeMaxCount` frames per capture.  Mirrors how iOS
   *    Camera and Samsung Pano actually work.  Requires
   *    `planeSource` != 'Disabled'; degrades silently to passthrough
   *    otherwise.
   *  - 'flow-based' (V16 A2): same KeyframeGate cap + threshold but
   *    the novelty metric is sparse-Lucas-Kanade optical flow on
   *    full-frame content rather than plane-projected polygon
   *    overlap.  Plane-independent — no `planeSource` requirement;
   *    scale-invariant — works regardless of latched plane size.
   *    Falls back to angular delta when KLT tracking fails. */
  frameSelectionMode: 'time-based' | 'pose-based' | 'flow-based';

  /** V16 — required fraction of NEW content per keyframe (pose-based
   *  AND flow-based modes share this knob).  Range 0.10 – 0.80.
   *  Default 0.40.  Lower = more keyframes per capture + more
   *  redundancy + better feature matching but higher memory.
   *  Higher = fewer keyframes + less margin for blurry frames. */
  keyframeOverlapThreshold: number;

  /** V16 — hard cap on keyframes per capture (pose-based + flow-
   *  based modes).  Range 3 – 10.  Default 6 (matches Samsung's
   *  typical behaviour).  Once reached, all subsequent frames are
   *  rejected and the host should auto-finalize. */
  keyframeMaxCount: number;

  /** V16 A2 — flow-based mode: max Shi-Tomasi corners detected per
   *  accepted keyframe.  Range 50 – 300, default 150.  Higher =
   *  more robust median pan-axis displacement; slower detect. */
  flowMaxCorners: number;

  /** V16 A2 — flow-based mode: Shi-Tomasi quality level (0, 1].
   *  Range 0.005 – 0.05, default 0.01.  Lower = more (weaker)
   *  corners detected. */
  flowQualityLevel: number;

  /** V16 A2 — flow-based mode: minimum pixel distance between
   *  detected corners at WORKING resolution (gate downscales the
   *  frame to 720 px longest side internally).  Range 5 – 20,
   *  default 10. */
  flowMinDistance: number;

  /** V16 — flow-based mode: translation budget in CENTIMETRES.  When
   *  > 0, the gate force-accepts a frame if the camera has moved
   *  more than this distance (3D Euclidean) since the last accepted
   *  keyframe — even when novelty < keyframeOverlapThreshold.
   *  Bounds the parallax between adjacent keyframes so the
   *  downstream stitcher's matcher (AffineBestOf2NearestMatcher
   *  post-V16) sees inputs it can fit a homography to.
   *
   *  Range 0 – 100 cm, default 0 = disabled.  Recommended starting
   *  value once enabled: 8 cm.  Set higher for fast pans, lower for
   *  precise multi-pass scans. */
  flowMaxTranslationCm: number;

  /** V16 — flow-based mode: percentile used to aggregate tracked-
   *  feature absolute displacements into the novelty estimate.
   *  Pre-V16 used median (0.50); 0.85 picks up the LEADING EDGE
   *  motion sooner — better matches user perception of "new
   *  content visible".  Range 0.50 – 0.99, default 0.85.  Set
   *  closer to 1.0 for more sensitive (catches even small leading-
   *  edge motion), closer to 0.5 for more conservative (needs
   *  half the features to have moved). */
  flowNoveltyPercentile: number;

  /** V16 — flow-based mode: eval-throttle.  Gate evaluation runs
   *  every Nth consumeFrame from the AR delegate instead of every
   *  frame.  Pure CPU/battery savings — doesn't change WHICH frames
   *  are accepted, just samples less frequently.  Trade-off: up to
   *  N-1 frames of latency between "user moved enough" and "frame
   *  accepted".  Range 1 – 10, default 1 (every frame).
   *
   *  Recommended for long captures on devices that overheat: set 3
   *  for ~3× CPU reduction on the per-frame gate path.  Eval cost
   *  is ~3-5 ms per call at 60 fps, so 3-5 ms / 16 ms ≈ 20-30 %
   *  AR-delegate budget freed when N=3. */
  flowEvalEveryNFrames: number;

  // cv::Stitcher pipeline knobs (batch-keyframe engine, V16 Phase 1.fix3)

  /** V16 Phase 1.fix3 — `cv::Stitcher`'s warper choice for the
   *  batch-keyframe finalize.
   *
   *  - 'plane': flat output, best when camera angles stay near
   *    perpendicular to scene.  Unbounded bbox for tilt-heavy pans
   *    (umatrix.cpp:710 crash).
   *  - 'cylindrical': wraps onto a cylinder with FIXED vertical axis.
   *    Good for horizontal pans; unrolls vertical pans along the wrong
   *    axis (output looks rotated 90°).
   *  - 'spherical' (recommended for batch-keyframe): rotationally
   *    symmetric, handles any pan direction.  Mild uniform curvature.
   *
   *  Native default is "spherical" specifically for batch-keyframe
   *  (overrides this prop's value in `IncrementalStitcher.start`
   *  unless explicitly provided).  Same field is also consumed by the
   *  legacy non-AR batch path (`BatchStitcher.stitchVideo`) where
   *  the historical default is "plane". */
  warperType: 'plane' | 'cylindrical' | 'spherical';

  /** V16 Phase 1.fix3 — `cv::Stitcher`'s blender choice for the
   *  batch-keyframe finalize.
   *  - 'multiband' (default): Laplacian-pyramid blending; best seam
   *    quality, higher peak memory.
   *  - 'feather': single-band alpha; faster, no halo artifacts when
   *    exposure varies. */
  blenderType: 'multiband' | 'feather';

  /** V16 Phase 1.fix3 — `cv::Stitcher`'s seam-finder choice.
   *  - 'graphcut' (default): cv::detail::GraphCutSeamFinder; optimal
   *    seams, pairs with multi-band, holds all warped frames in memory.
   *  - 'skip': stream warp+feed, lower peak memory, fine with feather. */
  seamFinderType: 'graphcut' | 'skip';

  /** V16 Phase 1b.fix5c — toggle the max-inscribed-rectangle crop in
   *  the batch-keyframe finalize pipeline.  When false (default), the
   *  output is cropped to `cv::boundingRect(mask)` only — preserves
   *  all stitched content at the cost of possible black corners
   *  where cv::Stitcher's projection didn't fill.  When true, the
   *  pipeline additionally runs `MaxInscribedRectFromMask` +
   *  morphological-close + column-projection second pass for a
   *  clean-cornered rectangle (but can over-aggressively shrink the
   *  output on lopsided masks).  Surfaced as a settings toggle so
   *  the operator can A/B the two crop strategies on real scenes. */
  enableMaxInscribedRectCrop: boolean;

  /** 2026-05-14 — `cv::Stitcher` pipeline mode for the batch-keyframe
   *  finalize step.
   *
   *   'auto' (default) — Engine picks PANORAMA or SCANS at finalize
   *                       time based on accumulated translation vs
   *                       rotation magnitudes between first and last
   *                       accepted keyframe poses (AR mode) or the
   *                       windowed IMU integration (non-AR mode).
   *   'panorama'        — Force cv::Stitcher::PANORAMA (rotation-only
   *                       pipeline; ORB + HomographyBasedEstimator +
   *                       BundleAdjusterRay + SphericalWarper).
   *                       Best for rotate-in-place panoramas.
   *                       WARNING: on translation-heavy input the
   *                       rotation-only model diverges and the
   *                       compositing canvas can grow to multi-GB
   *                       (Android lmkd kill observed 2026-05-14).
   *   'scans'           — Force cv::Stitcher::SCANS (affine pipeline;
   *                       AffineBestOf2NearestMatcher +
   *                       BundleAdjusterAffine + PlaneWarper).
   *                       Best for walk-past-shelf captures.  Canvas
   *                       size bounded by sum of frame areas.
   *
   * iOS note: as of 2026-05-14 iOS uses a hand-rolled PANORAMA-style
   * pipeline regardless of this setting.  Setting is passed through
   * to iOS but currently ignored; Android honours it via
   * `image_stitcher_jni.cpp` + `IncrementalStitcher.kt`. */
  stitchMode: 'auto' | 'panorama' | 'scans';

  /** 2026-05-14 (revised) — capture source axis.
   *
   *   'ar'      — ARKit / ARCore session feeds the engine.
   *   'non-ar'  — vision-camera feeds the engine via the gyro-driven
   *               Android snapshot loop (or iOS equivalent — see
   *               realtime-batch-fusion design doc Out-of-Scope).
   *               Lens choice (0.5× / 1×) is handled by the on-screen
   *               chip after mount, not by this setting.
   *
   * Native side uses this to:
   * 1. Decide whether the KeyframeGate should DISABLE its angular-
   *    delta fallback path.  Non-AR has no usable pose data → the
   *    angular calc would produce nonsense → set `disableAngularFallback`
   *    true on the gate.
   * 2. Decide whether to expect pose updates through the AR delegate
   *    path (only meaningful when source='ar').
   *
   * Earlier draft (replaced 2026-05-14) had 4 values:
   * 'ar' | 'wide' | 'ultrawide' | 'auto'.  Pre-mount physical-lens
   * selection via vision-camera's `physicalDevices` filter crashed
   * Galaxy A35's CameraCaptureSession with a Parcel exception
   * (physical_camera_id=null in AidlCamera3-Device configureStreams).
   * Switched to post-mount chip-driven lens swap. */
  captureSource: 'ar' | 'non-ar';
}


export interface IncrementalFinalizeResult {
  /** Path to the final panorama JPEG written to `outputPath`. */
  panoramaPath: string;
  width: number;
  height: number;
  acceptedCount: number;
  /** Frames the engine queue dropped due to backpressure (diagnostic). */
  droppedBackpressure: number;
  /** 2026-05-15 (D) — batch-keyframe stitcher telemetry.  Populated
   * by the cv::Stitcher PANORAMA / SCANS path.  Surfaces
   * `leaveBiggestComponent` drops so the host UI can warn the
   * operator when boundary frames were excluded due to weak feature-
   * matching confidence.
   *
   * Undefined on the realtime (hybrid / firstwins) engines — those
   * don't run leaveBiggestComponent.
   *
   *   framesRequested:        number of keyframes handed to the
   *                            stitcher (== acceptedCount for batch).
   *   framesIncluded:         number of keyframes retained after
   *                            leaveBiggestComponent pruning.
   *   framesDropped:          framesRequested − framesIncluded.
   *                            > 0 means the stitcher silently
   *                            dropped boundary frames; surface a
   *                            "Stitched N of M frames" toast.
   *   finalConfidenceThresh:  panoConfidenceThresh value used on
   *                            the successful attempt (1.0 / 0.5 /
   *                            0.3 — see image_stitcher_jni.cpp
   *                            retry loop).  Useful for debugging
   *                            scenes that consistently need a
   *                            lower threshold. */
  framesRequested?: number;
  framesIncluded?: number;
  framesDropped?: number;
  finalConfidenceThresh?: number;
}


/**
 * 2026-05-16 — input to `refinePanorama`.  Mirrors the subset of
 * `StitcherConfig` that affects the batch refinement step
 * (`cv::Stitcher` pipeline knobs).  All fields optional — when
 * omitted the native side picks production-tested defaults that
 * match the existing batch-keyframe finalize path:
 *
 *   warperType         = "spherical" (handles any pan direction)
 *   blenderType        = "multiband"
 *   seamFinderType     = "graphcut"
 *   captureOrientation = "portrait"
 *   useInscribedRectCrop = false
 *   stitchMode         = "auto" (Android only; iOS hand-rolled
 *                                pipeline is PANORAMA regardless).
 *                                NOTE: on the explicit `refinePanorama`
 *                                path, Android collapses "auto" to
 *                                "scans" — affine, not rotational —
 *                                because refinement is the slow-path
 *                                quality bake where SCANS' translation
 *                                tolerance pays off. The "auto" name is
 *                                kept for API symmetry with the live
 *                                pipeline, but it is NOT cv::Stitcher's
 *                                PANORAMA mode on this path.
 *   jpegQuality        = 90
 *
 * Resolution budgets (`*ResolMP`) keep cv::Stitcher's staged-pipeline
 * memory bounded — see image_stitcher_jni.cpp on Android and the
 * shared C++ `StitchConfig` for the full rationale.  Passing a
 * negative value or omitting the field keeps the per-platform safe
 * default (Android compose-MP cap of 1.0, iOS manual-pipeline cap of
 * 0.6).
 *
 * See: docs/site-content/design/2026-05-14-realtime-batch-fusion.md
 */
export interface IncrementalRefineOptions {
  /** "plane" | "cylindrical" | "spherical".  Default "spherical". */
  warperType?: 'plane' | 'cylindrical' | 'spherical';
  /** "multiband" | "feather".  Default "multiband". */
  blenderType?: 'multiband' | 'feather';
  /** "graphcut" | "skip".  Default "graphcut". */
  seamFinderType?: 'graphcut' | 'skip';
  /** Drives the OUTPUT bake-rotation.  Default "portrait". */
  captureOrientation?:
    | 'portrait'
    | 'portrait-upside-down'
    | 'landscape-left'
    | 'landscape-right';
  /** Crop to max-inscribed rectangle.  Default false (bbox crop only). */
  useInscribedRectCrop?: boolean;
  /**
   * Android: `cv::Stitcher` pipeline mode.  Default "auto".
   *
   * On the explicit `refinePanorama` path, "auto" silently collapses
   * to "scans" (affine).  This is intentional: refinement is the
   * slow-path quality bake where SCANS' translation tolerance gives
   * a noticeably better stitch than PANORAMA's rotation-only model.
   * Pass "panorama" explicitly if you need rotational behaviour.
   *
   * iOS ignores this field — the hand-rolled `cv::detail::*` pipeline
   * in `cpp/stitcher.cpp` is functionally equivalent to PANORAMA
   * regardless of what you pass here.
   */
  stitchMode?: 'auto' | 'panorama' | 'scans';
  /** JPEG quality 1..100, default 90. */
  jpegQuality?: number;
}


/**
 * 2026-05-16 — result of an explicit `refinePanorama` call.  Mirrors
 * `IncrementalFinalizeResult` so host code can treat refined results
 * the same way it treats batch-keyframe finalize results.
 */
export interface IncrementalRefineResult {
  /** Path to the refined panorama JPEG written to `outputPath`. */
  panoramaPath: string;
  width: number;
  height: number;
  /** Frames the stitcher saw (== framePaths.length). */
  framesRequested: number;
  /** Frames retained after `leaveBiggestComponent` (≤ framesRequested). */
  framesIncluded: number;
  /** framesRequested − framesIncluded.  > 0 = some frames dropped. */
  framesDropped: number;
  /** The confidence threshold that succeeded.  -1 when not applicable. */
  finalConfidenceThresh: number;
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
   *
   * `outputPath` (optional) — when empty/omitted the native side
   * creates a path under the app's tmp directory and returns it
   * inside the `panoramaPath` field of the result.  Host apps that
   * want the stitched panorama to be USER-VISIBLE (e.g., browsable
   * via iOS Files.app) should pass a path under the app's
   * Documents directory, e.g.
   * `${RNFS.DocumentDirectoryPath}/captures/${auditId}.jpg`
   * (or the platform-equivalent on Android).  Two host-side
   * requirements for Files.app exposure on iOS:
   *
   *   1. Info.plist must set `UIFileSharingEnabled = true` so the
   *      app's Documents directory is exposed via the Files
   *      browser at all.
   *   2. Info.plist must set `LSSupportsOpeningDocumentsInPlace
   *      = true` so users can open the files in-place rather than
   *      requiring a copy.
   *
   * Frames (intermediate keyframe JPEGs) are saved by the engine
   * to its own private directory and are NOT auto-cleaned — see
   * `cleanupKeyframes` for the GC hook host apps should call on
   * launch or via a lifecycle event.
   */
  finalize(options: {
    outputPath?: string;
    quality?: number;
    /**
     * 2026-05-18 (iOS cross-orientation fix) — JS-supplied current
     * device orientation at finalize time.  When provided, the
     * engine uses this for the bake-rotation pass in place of the
     * orientation captured at start().  Closes the cross-orientation
     * hole where the user starts in one orientation and pans/
     * captures in another — the start-time snapshot would otherwise
     * bake to the wrong direction.  Valid values match
     * IncrementalStartOptions.captureOrientation; omit/empty to keep
     * legacy start-time behaviour.
     */
    captureOrientation?: string;
  }): Promise<IncrementalFinalizeResult>;
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
  /** V16 Phase 1b.fix2 — poll the process phys_footprint in MB.
   *  Backs the on-screen memory debug overlay.  Same metric iOS
   *  jetsam evaluates against, so the displayed value is the
   *  one-true-number for "how close are we to OOM?".  Returns -1
   *  on task_info failure (very rare).  Resolves immediately. */
  getMemoryFootprintMB(): Promise<number>;
  /**
   * 2026-05-16 — realtime+batch fusion API foundation.  Run the
   * shared C++ `cv::Stitcher` pipeline over a caller-supplied list
   * of keyframe JPEG paths and write a refined panorama to
   * `outputPath`.
   *
   * Pre-conditions:
   *   - `framePaths.length >= 2`
   *   - Each path must exist on disk (the native side will read it
   *     via cv::imread); rejected otherwise.
   *
   * Per-platform routing:
   *   - iOS:     `OpenCVStitcher.stitchFramePaths(...)`
   *              (manual cv::detail::* pipeline, useManualPipeline=true).
   *   - Android: `BatchStitcher.stitchSync(...)` →
   *              `image_stitcher_jni.cpp` (high-level
   *              cv::Stitcher::create() pipeline).
   *
   * Reuses the same C++ stitcher both platforms use for the
   * batch-keyframe `finalize()` path — so refinement quality on
   * arbitrary keyframe sets matches what the batch-keyframe engine
   * has been producing in production.
   *
   * The auto-trigger inside the hybrid engine's `finalize()` is a
   * separate code path that internally calls `refinePanorama` when
   * keyframes are on disk; host code may also call it explicitly to
   * re-refine after editing the keyframe set.
   */
  refinePanorama(options: {
    framePaths: string[];
    outputPath: string;
    config?: IncrementalRefineOptions;
  }): Promise<IncrementalRefineResult>;
  /** PiP investigation only — write a JS-side message into the
   *  Swift-side rlis-debug.log so we get a single timeline. */
  appendDebugLog?(message: string): Promise<{ ok: true }>;
  /**
   * 2026-05-18 (Iss 3) — delete keyframe JPEGs older than the cutoff
   * from the SDK's intermediate-keyframe storage directory.
   *
   * Background: the batch-keyframe capture mode saves accepted
   * frames as JPEGs in a per-session directory (iOS:
   * `Library/Application Support/Captures/{uuid}/`, Android: app's
   * private files dir under `captures/{uuid}/`).  These are kept
   * across runs so post-hoc re-stitching is possible from the
   * debug menu — but they accumulate over time and bloat user
   * storage.  Host apps should call this on launch or on a
   * lifecycle hook to garbage-collect old sessions.
   *
   * `olderThanMs` is the staleness cutoff in milliseconds.  Sessions
   * whose newest file mtime is older than `Date.now() - olderThanMs`
   * are deleted in full.  Default if omitted: 24 hours.  Pass 0 to
   * delete every keyframe session unconditionally (use with care).
   *
   * Resolves with the count of deleted sessions + total bytes freed,
   * so the host can surface a "freed 42 MB of old captures"
   * confirmation if desired.  Rejects on filesystem errors (e.g.,
   * the captures dir does not exist — which is also fine; pass 0
   * sessions back) — implementations should swallow ENOENT-style
   * errors and resolve with zero counts.
   */
  cleanupKeyframes?(options?: {
    olderThanMs?: number;
  }): Promise<{ sessionsDeleted: number; bytesFreed: number }>;
  /**
   * 2026-05-18 (Iss 3) — return the absolute filesystem path of the
   * directory where keyframe JPEGs for the CURRENT (running)
   * capture are being saved.  Returns an empty string when no
   * capture is in flight or when the engine isn't using a per-
   * session keyframe directory (e.g., hybrid mode without the
   * batch-keyframe collector).
   *
   * Mainly useful for debugging — e.g., the host can dump the
   * directory's contents to the on-screen log, or copy it to
   * /Documents for post-hoc inspection.
   */
  getKeyframeDir?(): Promise<{ path: string }>;
}


/**
 * Lazy-resolve the native module.  Returns null on platforms that
 * don't have it registered yet (e.g. older builds without the new
 * native code).  Callers fall back to the batch stitcher in that
 * case.
 */
export function getIncrementalNativeModule(): NativeIncrementalModule | null {
  const m = (NativeModules as Record<string, unknown>)['IncrementalStitcher'];
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
 * 2026-05-18 (Iss 3) — host-callable helper to clean up old
 * keyframe sessions.  Wraps the native `cleanupKeyframes` with a
 * sensible default (24 hours) and a noop fallback when the native
 * method isn't implemented (older SDK builds).
 *
 * Typical use: call this in App.tsx's mount effect or from a
 * background-task hook so storage stays bounded between captures.
 *
 * Resolves with the count of sessions deleted + bytes freed so the
 * host can log / surface a "cleaned up X MB" message.  Never
 * rejects — filesystem failures (including ENOENT on the captures
 * dir) resolve as `{ sessionsDeleted: 0, bytesFreed: 0 }`.
 */
export async function cleanupOldKeyframes(
  options?: { olderThanMs?: number },
): Promise<{ sessionsDeleted: number; bytesFreed: number }> {
  const native = getIncrementalNativeModule();
  if (!native?.cleanupKeyframes) {
    return { sessionsDeleted: 0, bytesFreed: 0 };
  }
  try {
    const olderThanMs = options?.olderThanMs ?? 24 * 3600 * 1000;
    return await native.cleanupKeyframes({ olderThanMs });
  } catch {
    return { sessionsDeleted: 0, bytesFreed: 0 };
  }
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
    NativeModules.IncrementalStitcher as unknown as NativeModule,
  );
  return emitter.addListener('IncrementalStateUpdate', listener);
}
