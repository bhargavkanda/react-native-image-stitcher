/**
 * PanoramaSettingsModal — runtime A/B testing surface for the
 * stitcher pipeline.  Operators in the field can toggle warper,
 * blender, and tuning constants between captures to see what
 * looks best on real shelf scenes.
 *
 * The modal is presentational: the host owns the settings state
 * (typically `useState<PanoramaSettings>`) and renders the modal
 * with `visible` toggled by a gear-icon press in the capture
 * header.  Settings flow OUT via `onChange` for each tweak.
 *
 * Why expose this as an SDK component instead of leaving it to
 * each host?  The set of tunable knobs IS the SDK's contract —
 * if a new setting is added (e.g. registration MP) the SDK ships
 * the UI for it in lockstep with the param itself, instead of
 * forcing every host app to update its settings screen.
 */

import React, { useState } from 'react';
import {
  Modal,
  NativeModules,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';


export interface PanoramaSettings {
  warperType: 'plane' | 'cylindrical' | 'spherical';
  blenderType: 'multiband' | 'feather';
  /**
   * Seam finder strategy.  "graphcut" finds optimal seams before
   * blending (cleaner output, pairs with multiband, more memory).
   * "skip" streams warp+feed (lower peak memory, fine with feather).
   */
  seamFinderType: 'graphcut' | 'skip';
  /**
   * V16 Phase 1b.fix5c (Ram's call 2026-05-10) — toggle the
   * max-inscribed-rectangle crop on the batch-keyframe output
   * panorama.  When false (default), the output is cropped to the
   * bounding rectangle of non-black pixels only (cv::boundingRect)
   * — preserves all stitched content at the cost of some black
   * corners where cv::Stitcher's projection didn't fill.  When
   * true, the post-stitch pipeline additionally runs
   * `MaxInscribedRectFromMask` to find the largest axis-aligned
   * rectangle entirely inside content, followed by the
   * column-projection second-pass.  Inscribed-rect can be
   * over-aggressive on lopsided masks (field log showed a
   * 1146×1102 bbox shrinking to a 602×1102 strip), so default OFF
   * lets the operator see the full stitched scene; flip ON to
   * A/B against the cleaner-but-smaller output.
   */
  enableMaxInscribedRectCrop: boolean;
  /**
   * Phase 4.4 EXPERIMENTAL: when true, the host swaps the
   * vision-camera-backed CameraView for an ARKit-backed ARCameraView
   * during panorama capture.  Default false (keeps the existing
   * stitcher flow untouched).  Phase 5 will add AR-backed photo /
   * video capture and pose-driven stitching; until then this is
   * preview-only — useful for verifying the AR session renders
   * cleanly on the operator's device before we cut over.
   */
  useARPreview: boolean;
  /**
   * V15 — Incremental engine choice for live realtime stitching.
   *   'hybrid'           — Whole-frame projection + feature matching;
   *                        planar by default (was cylindrical).
   *   'slitscan-rotate'  — V13.0a baseline + 1D NCC for rotation
   *                        wobble correction.
   *   'slitscan-both'    — DEFAULT.  V13.0a + no accept gate +
   *                        feather blend.  Iterate via per-stage
   *                        toggles below.
   *
   * All three are A/B-comparable on the same scene by toggling here
   * without restarting the app.
   */
  incrementalEngine:
    | 'batch-keyframe'
    | 'hybrid'
    | 'slitscan-rotate'
    | 'slitscan-both';

  /**
   * V15 — Slit-scan slit width (fraction of pan-axis retained per
   * frame).  Range 0.10 – 0.70.  Smaller = less within-slit multi-
   * depth disagreement but tighter overlap budget at fast pans.
   * Default 0.30.  Only applied to slitscan-* engines.
   */
  slitWidthFraction: number;

  /**
   * V15 — Per-stage correction toggles for slitscan-both.  Settings
   * UI exposes these so iteration happens via toggles, not rebuilds.
   */
  acceptGate: 0 | 50;
  enableTriangulation: boolean;
  enableTriAccumulator: boolean;
  enable2dNcc: boolean;
  enableRansacHomography: boolean;
  paintMode: 'FirstPaintedWins' | 'FeatherBlend';
  hybridProjection: 'Cylindrical' | 'Planar';
  /** 1D NCC search radius (slitscan-rotate only). */
  nccSearchRadius1d: number;
  /** **DEPRECATED in V15.0d** — see `planeSource`.  Kept on the type
   *  for backward compat with stored settings.  When `planeSource`
   *  is 'Disabled' (default) and this is true, the engine treats it
   *  as 'ARKitDetected'. */
  useDetectedPlane: boolean;
  /** V15.0d — source of the plane used by the V15.0b plane-projected
   *  stitch path.  Slit-scan modes only.
   *
   *  - 'Disabled': no plane projection (plain slit-scan).
   *  - 'ARKitDetected': use ARKit's first vertical plane that aligns
   *    with the camera's view direction.  Falls back to slit-scan
   *    silently when no aligned plane is found.
   *  - 'Virtual': synthesize a plane perpendicular to the camera at
   *    `virtualPlaneDepthMeters` distance.  Always works; loses
   *    "real depth" advantage but immune to ARKit picking the wrong
   *    surface (which is the common failure mode for ARKitDetected). */
  planeSource: 'Disabled' | 'ARKitDetected' | 'Virtual';
  /** V15.0d — depth (m) of the synthetic plane in front of the camera
   *  when `planeSource = 'Virtual'`.  0.3 – 5.0 m.  Default 1.5 m. */
  virtualPlaneDepthMeters: number;
  /** V15.0d — alignment threshold (cosine) for ARKit-detected planes.
   *  Higher = stricter (fewer planes accepted).  0.0 – 1.0.
   *  Default 0.6 (≈53° max angle off-camera). */
  arkitPlaneAlignmentThreshold: number;
  /** V15.0g — plane-projection rendering style.  Trapezoidal is the
   *  V15.0b legacy 3D-correct mapping; Rectified is V15.0g's clean-
   *  rectangle paste that eliminates tilt-induced trapezoidal
   *  distortion.  Default Rectified.  Ignored when planeSource =
   *  Disabled. */
  planeProjectionStyle: 'Trapezoidal' | 'Rectified';
  /** V15.0d — 2D NCC search half-window in pixels.  4 – 30.
   *  Default 12. */
  nccSearchMargin2d: number;
  /** V15.0d — 2D NCC confidence threshold below which corrections
   *  are rejected.  0.30 – 0.99.  Default 0.75. */
  nccConfidenceThreshold2d: number;
  /** V15.0d (1B) — EMA smoothing on 2D NCC corrections to damp
   *  single-frame snaps.  Default false. */
  enableNcc2dEmaSmoothing: boolean;
  /** V15.0d — EMA weight on the CURRENT-frame correction.  0.05 – 0.95.
   *  Default 0.4 (60% prev / 40% current). */
  ncc2dEmaAlpha: number;
  /** V15.0d (1C) — pan-axis-aware 2D NCC: clamp the cross-axis
   *  correction tighter than the pan-axis.  Default false. */
  enableNcc2dPanAxisLock: boolean;
  /** V15.0d — cross-axis clamp (px) when pan-axis lock is on.
   *  0 – 30.  Default 5. */
  ncc2dCrossAxisLockPx: number;

  /** V16 — frame-selection mode for the live engine.
   *
   *  - 'time-based' (default): every ARFrame is forwarded to the
   *    engine; the engine's own gate (kMinAcceptDeltaPx etc.) decides.
   *    Backward-compatible with all prior versions.
   *  - 'pose-based': frames are pre-filtered by a KeyframeGate that
   *    projects each onto the latched ARKit plane and accepts only
   *    when overlap with the previous keyframe is < 1 −
   *    overlapThreshold.  Bounded to keyframeMaxCount frames per
   *    capture (matches iOS Camera / Samsung Pano architecture).
   *    Requires planeSource != 'Disabled' to engage.
   *  - 'flow-based' (V16 A2, DEFAULT): same KeyframeGate cap +
   *    threshold but the novelty metric is sparse-Lucas-Kanade
   *    optical flow on full-frame content instead of plane-projected
   *    polygon overlap.  Plane-independent (scale-invariant — works
   *    regardless of latched plane size); the metric is "median
   *    pan-axis feature displacement / pan-axis frame dim", which is
   *    a direct measure of % new content on the leading edge.  Falls
   *    back to angular delta when feature tracking fails (texture-
   *    poor scene / motion exceeds KLT pyramid window). */
  frameSelectionMode: 'time-based' | 'pose-based' | 'flow-based';
  /** V16 — required NEW-content fraction for a keyframe to be
   *  accepted (pose-based AND flow-based modes share this knob;
   *  both interpret 0.40 as "40 % new content").  Tuneable from
   *  0.20 to 0.60 in the modal. */
  keyframeOverlapThreshold: number;
  /** V16 — hard cap on keyframes per capture (pose-based + flow-
   *  based modes).  Default 6.  Once reached, all further frames are
   *  rejected and the host should auto-finalize. */
  keyframeMaxCount: number;
  /** V16 A2 — flow-based mode: max Shi-Tomasi corners to detect per
   *  accepted keyframe.  More = more robust median pan-axis
   *  displacement but slower detect (~15-25 ms at 150 on iPhone 13
   *  Pro).  Range 50 – 300, default 150. */
  flowMaxCorners: number;
  /** V16 A2 — flow-based mode: Shi-Tomasi quality level (0, 1].
   *  Lower = more (weaker) corners detected; higher = fewer
   *  (stronger) corners.  Default 0.01.  Range 0.005 – 0.05 in the
   *  modal. */
  flowQualityLevel: number;
  /** V16 A2 — flow-based mode: minimum pixel distance between
   *  detected corners at WORKING resolution (the gate internally
   *  downscales the frame to 720 px longest side for KLT).  Higher
   *  = more spatially-spread features.  Default 10. */
  flowMinDistance: number;
  /** V16 — flow-based mode: translation budget in CENTIMETRES.
   *  When > 0, the gate force-accepts a frame if the camera has
   *  translated more than this distance (3D Euclidean) since the
   *  last accepted keyframe — even when novelty < threshold.
   *  Bounds the parallax between adjacent keyframes so the
   *  downstream affine stitcher matcher can fit a homography.
   *  Range 0 – 100 cm in the modal, default 0 = disabled.
   *  Recommended starting value once enabled: 8 cm. */
  flowMaxTranslationCm: number;
  /** V16 — flow-based mode: percentile used to aggregate tracked-
   *  feature absolute displacements into the novelty estimate.
   *  Pre-V16 used median (0.50); 0.85 picks up leading-edge
   *  motion sooner — matches user perception of "new content
   *  visible" better.  Range 0.50 – 0.99, default 0.85. */
  flowNoveltyPercentile: number;
  /** V16 — flow-based mode: eval-throttle.  Gate evaluation runs
   *  every Nth consumeFrame from the AR delegate instead of every
   *  frame.  Pure CPU/battery savings — doesn't change WHICH
   *  frames are accepted, just samples less frequently.  Range
   *  1 – 10, default 1 (every frame). */
  flowEvalEveryNFrames: number;

  /** V15.0c — sliver position within the camera frame.  'Center' is
   *  V13.x default.  'Bottom' takes leading-edge content for top-to-
   *  bottom pan; 'Top' for bottom-to-top pan. */
  sliverPosition: 'Center' | 'Bottom' | 'Top';
  /** V15.0c — paint full first frame, then add slivers as user pans.
   *  Useful with 'Bottom' or 'Top' sliverPosition. */
  firstFrameFullFrame: boolean;
  /** Hard cap on hold duration (ms).  0 disables auto-stop. */
  maxRecordingMs: number;
  /** Frames per second of recording to sample for stitching. */
  framesPerSecond: number;
  /** Floor / ceiling on extracted frame count. */
  minFrames: number;
  maxFrames: number;
  /** JPEG quality (0-100) for output panorama. */
  quality: number;

  // ── 2026-05-14: capture-source + stitch-mode axes ─────────────────
  //
  // These two settings are independent from the existing
  // `incrementalEngine` / `useARPreview` axes; together they decide
  // (a) which camera + tracking the capture screen uses, and (b)
  // which OpenCV pipeline mode the batch stitcher uses at finalize.

  /**
   * 2026-05-14 (revised) — capture-source picker for the panorama
   * camera screen.  Two options after the 2026-05-14 user-reported
   * Galaxy A35 crash + simplification request:
   *
   *   'ar' (DEFAULT) — Use the AR stack (ARKit on iOS, ARCore on
   *                    Android).  Plane detection, pose-aware
   *                    capture, pose-driven gate.  Falls back to
   *                    non-AR silently if the device doesn't
   *                    support AR.
   *   'non-ar'      — Use vision-camera.  Disables all AR-based
   *                    services (planeSource=Disabled, no plane
   *                    polling, no AR session, frameSelectionMode
   *                    flipped to flow-based).  Lens-switcher chip
   *                    on the capture screen lets the operator
   *                    toggle 0.5× / 1× without re-opening Settings.
   *                    The chip is hidden if the device has only
   *                    one physical back lens.
   *
   * Cascade: switching from 'ar' → 'non-ar' triggers a useEffect
   * in `AuditCaptureScreen` that patches dependent settings
   * (planeSource, frameSelectionMode, useARPreview) to a coherent
   * non-AR state.  Operators don't have to know which other
   * settings to flip.
   *
   * Earlier draft (replaced 2026-05-14) had 4 values:
   * 'auto' | 'ar' | 'wide' | 'ultrawide'.  The pre-mount
   * physical-lens selection ('wide' / 'ultrawide') crashed the
   * Galaxy A35 vision-camera CameraCaptureSession with a Parcel
   * exception (physical_camera_id=null in AidlCamera3-Device
   * configureStreams) — Camera2 can't be reliably steered to a
   * specific physical lens via vision-camera's `physicalDevices`
   * filter on this hardware.  The post-mount on-screen chip path
   * works because vision-camera selects the safe multi-lens
   * virtual device first, and the lens swap happens against an
   * already-open camera.
   */
  captureSource: 'ar' | 'non-ar';

  /**
   * 2026-05-14 — `cv::Stitcher` pipeline mode for the batch stitch.
   *
   *   'auto' (DEFAULT)
   *     The capture engine looks at the accumulated translation vs
   *     rotation magnitudes between first and last accepted keyframe
   *     poses (AR-mode) or the windowed IMU integration (non-AR
   *     mode) and picks PANORAMA or SCANS at finalize time.
   *
   *   'panorama'
   *     `cv::Stitcher::PANORAMA` — rotation-only pipeline.  Best for
   *     "rotate phone in place to capture a wide field of view"
   *     captures.  ORB feature matching + global BundleAdjusterRay +
   *     SphericalWarper.  Sharp seams, expensive memory.  WARNING:
   *     on translation-heavy input the rotation-only homography fit
   *     diverges and the canvas can blow up to multi-GB on Android
   *     (2026-05-14 lmkd kill observed).  Pick this only for genuine
   *     rotation panoramas.
   *
   *   'scans'
   *     `cv::Stitcher::SCANS` — translational pipeline.  Best for
   *     "walk past a shelf and pan sideways" captures.  Affine
   *     matcher + AffineBasedEstimator + BundleAdjusterAffine +
   *     PlaneWarper.  Canvas size bounded by sum of frame areas.
   *     Slight quality drop on pure rotations but works for them too.
   *
   * iOS NOTE: as of 2026-05-14 the iOS stitcher uses a hand-rolled
   * PANORAMA-style pipeline (OpenCVStitcher.mm:600+) regardless of
   * this setting.  Setting is passed through to iOS but ignored.
   * Android honours it via retailens_stitcher.cpp.  Bridging iOS is
   * a follow-up.
   */
  stitchMode: 'auto' | 'panorama' | 'scans';
}


// Per-device default selection.  We read the iPhone's physical
// RAM at SDK module load (exposed by `RetaiLensStitcher`'s
// `constantsToExport`) and pick the heaviest blender + seam
// finder combo that fits.  Threshold (2 GB) is conservative —
// iPhone 6s through iPhone X have 2 GB exactly; below that
// (iPhone 6 / 5s) is unsupported by RN 0.84 anyway.  The user
// can still flip ANY of these in the settings modal at runtime;
// this only chooses the INITIAL default.
const _physicalMemoryBytes: number = (() => {
  const m = (NativeModules as Record<string, unknown>).RetaiLensStitcher;
  const bytes =
    m && typeof m === 'object'
      ? (m as { physicalMemoryBytes?: number }).physicalMemoryBytes
      : undefined;
  return typeof bytes === 'number' ? bytes : 0;
})();

const _isLowMem = _physicalMemoryBytes > 0
  && _physicalMemoryBytes < 2 * 1024 * 1024 * 1024;

// One-line diagnostic so the host's Metro console shows what the
// SDK saw at module load.  If `physicalMemoryBytes=0` here, the
// native bridge's `constantsToExport` isn't being picked up by
// React Native and we should investigate the @objc registration.
// The defaults always pick the SAFE fallback (multiband+graphcut)
// when the value is 0 — this log is the only signal we have.
// eslint-disable-next-line no-console
console.log(
  '[capture-sdk] PanoramaSettings defaults: '
  + `physicalMemoryBytes=${_physicalMemoryBytes} `
  + `isLowMem=${_isLowMem} `
  + `→ blender=${_isLowMem ? 'feather' : 'multiband'} `
  + `seam=${_isLowMem ? 'skip' : 'graphcut'}`,
);


export const DEFAULT_PANORAMA_SETTINGS: PanoramaSettings = {
  warperType: 'plane',
  // High-quality defaults on devices with ≥2 GB RAM (iPhone X+):
  // MultiBandBlender + GraphCutSeamFinder, the same combo
  // cv::Stitcher::PANORAMA uses internally and what produced the
  // sharpest output during iteration.
  // Low-memory devices (<2 GB) fall back to FeatherBlender + skip
  // seam (streams warp+feed) so peak memory stays under the
  // tighter jetsam threshold.  Either way, the user can switch
  // both in the settings modal.
  blenderType: _isLowMem ? 'feather' : 'multiband',
  seamFinderType: _isLowMem ? 'skip' : 'graphcut',
  // V16 Phase 1b.fix5c — default OFF.  See PanoramaSettings.enableMaxInscribedRectCrop.
  enableMaxInscribedRectCrop: false,
  // AR-backed capture is the default — vision-camera path is kept as
  // a fallback while we shake out edge cases.
  useARPreview: true,
  // V16 Phase 1 — batch-keyframe is the new default-recommended
  // engine: KeyframeGate caps input at ≤ keyframeMaxCount frames,
  // OpenCVStitcher's BA + GraphCut + ExposureCompensator +
  // MultiBandBlender runs once on shutter release.  Existing
  // slitscan-* engines remain available for wide-pan fallback.
  incrementalEngine: 'batch-keyframe',
  slitWidthFraction: 0.30,
  acceptGate: 0,
  enableTriangulation: false,
  enableTriAccumulator: false,
  enable2dNcc: false,
  enableRansacHomography: false,
  // V15.0c — Ram observation: FirstPaintedWins is consistently the best
  // output across all combinations.  Default switched from FeatherBlend.
  paintMode: 'FirstPaintedWins',
  hybridProjection: 'Planar',
  nccSearchRadius1d: 15,
  useDetectedPlane: false,
  // V16 Phase 1 — Virtual plane is the default since batch-keyframe
  // is the recommended engine and the gate needs a plane to compute
  // polygon overlap.  Virtual works without ARKit-detected planes (a
  // synthesized plane perpendicular to the first-frame camera at
  // virtualPlaneDepthMeters); operators can flip to ARKitDetected
  // when in a controlled scene with a clearly-visible wall.  Disabled
  // is still selectable for the older slit-scan paths that don't
  // need a plane.
  // V16 Phase 1b.fix5c (Ram's call 2026-05-10): switched default
  // from 'Virtual' to 'ARKitDetected'.  ARKit's real plane gives
  // better intrinsics-to-pixel alignment than a synthesised plane
  // at a fixed depth, when ARKit can find a vertical plane.  Falls
  // back to slit-scan when no plane latches.
  planeSource: 'ARKitDetected',
  virtualPlaneDepthMeters: 1.5,
  arkitPlaneAlignmentThreshold: 0.6,
  // V15.0g — Rectified is the default (Trapezoidal had the tilt-
  // induced bottom-wider-than-top distortion that was the field
  // blocker on V15.0e/f).  Trapezoidal stays available for
  // operator A/B comparison.
  planeProjectionStyle: 'Rectified',
  // V15.0d — NCC 2D defaults match V15.0c.4's hardcoded values, now
  // tunable via the settings UI.  EMA smoothing and pan-axis lock are
  // off by default so the V15.0c.4 baseline behaviour is preserved
  // until the operator explicitly opts in.
  nccSearchMargin2d: 12,
  // V15.0i.1 — default raised to 0.99 per Ram (only apply on near-
  // perfect overlap matches; reject ambiguous matches that snap to
  // wrong patterns on repetitive textures like shelf rails).
  nccConfidenceThreshold2d: 0.99,
  enableNcc2dEmaSmoothing: false,
  ncc2dEmaAlpha: 0.4,
  enableNcc2dPanAxisLock: false,
  ncc2dCrossAxisLockPx: 5,
  // V16 A2 (2026-05-13) — flow-based is now the default.  Ram report
  // 2026-05-13 13:05 showed that pose-based on a small latched plane
  // produces "bursts" of accepts on small physical motion: a 0.64 m²
  // plane at 2.7 m perpDist gave 6 accepts in 1 s over 12 cm of
  // translation because the plane-projected polygon covers only a
  // sliver of the frame, hyperinflating newContent.  Flow-based
  // measures novelty from real image content (sparse KLT), is
  // plane-independent, and is invariant to plane size.  Operators
  // can still flip back to 'pose-based' or 'time-based' in the modal
  // for A/B testing or low-texture scenes.  Same defaults shared
  // between pose-based and flow-based (40 % new content per
  // keyframe, ≤ 6 keyframes per capture).
  frameSelectionMode: 'flow-based',
  // 2026-05-15 (U4) — flow-based default novelty 0.40 → 0.20.
  // Accept frames with 20 % new content (was 40 %).  More inclusive
  // selection for shelf-pan captures where panning slowly produces
  // gradual content reveal.  Operator can still bump via Settings.
  keyframeOverlapThreshold: 0.20,
  keyframeMaxCount: 6,
  // V16 A2 — flow-based mode tuning.  Defaults are the values that
  // tested cleanly on iPhone 13 Pro / 14 Pro: 150 corners give a
  // stable median across the frame; quality=0.01 + minDistance=10
  // give spatially-spread, repeatable detection.  All three are
  // tunable in the modal under "Flow tuning".
  flowMaxCorners: 150,
  flowQualityLevel: 0.01,
  flowMinDistance: 10,
  // V16 — translation-budget force-accept (Flow strategy only).
  // 0 = disabled (default — back-compat).  Operator opts-in via the
  // "Flow tuning — translation budget" segmented control below.
  flowMaxTranslationCm: 0,
  // V16 — novelty aggregation percentile.  0.85 picks up leading-
  // edge motion sooner than the pre-V16 median (0.50).  Operator
  // can dial down toward 0.5 for more-conservative captures or up
  // toward 0.99 for more-aggressive.
  flowNoveltyPercentile: 0.85,
  // V16 — every-Nth-frame eval throttle.  2026-05-15 (U4): default
  // 1 → 5 to reduce per-frame KeyframeGate CPU cost (Shi-Tomasi +
  // calcOpticalFlowPyrLK is ~3-5 ms per ARFrame on Galaxy A35; at
  // 30 fps that's ~15 % CPU on flow alone).  Evaluating every 5th
  // frame yields novelty samples at ~6 Hz which is still well above
  // the 1-2 Hz keyframe-accept cadence.
  // matches pre-V16 behaviour).  Set higher to cut CPU on long
  // captures at the cost of acceptance latency.
  flowEvalEveryNFrames: 5,
  // V15.0c — sliver tweaks: leading-edge sliver from BOTTOM for typical
  // top-to-bottom pan + full first-frame anchor produced the best
  // outputs in early iteration.
  sliverPosition: 'Bottom',
  firstFrameFullFrame: true,
  maxRecordingMs: 8000,
  framesPerSecond: 3,
  minFrames: 6,
  maxFrames: 16,
  quality: 85,

  // 2026-05-14 (revised) — capture source defaults to 'ar' (AR-backed
  // is the recommended path; non-AR is the explicit opt-out).  Stitch
  // mode stays 'auto' — the auto-resolution heuristic between PANORAMA
  // and SCANS is per-capture, not per-mode, so it's safe to leave on.
  captureSource: 'ar',
  stitchMode: 'auto',
};


export interface PanoramaSettingsModalProps {
  visible: boolean;
  settings: PanoramaSettings;
  onChange: (next: PanoramaSettings) => void;
  onClose: () => void;
}


export function PanoramaSettingsModal({
  visible,
  settings,
  onChange,
  onClose,
}: PanoramaSettingsModalProps): React.JSX.Element {
  const update = (patch: Partial<PanoramaSettings>) =>
    onChange({ ...settings, ...patch });

  // V16 Phase 1b — derive the 2-axis (timing × algorithm) UI state
  // from the underlying single `incrementalEngine` field.  Storage
  // shape is unchanged; the modal just presents it in two segmented
  // controls so the user's mental model matches the system's actual
  // primary axis (batch vs realtime).
  //
  // Mapping:
  //   incrementalEngine === 'batch-keyframe'  → timing='batch'
  //   incrementalEngine === 'hybrid'          → timing='realtime', algo='hybrid'
  //   incrementalEngine === 'slitscan-rotate' → timing='realtime', algo='slitscan-rotate'
  //   incrementalEngine === 'slitscan-both'   → timing='realtime', algo='slitscan-both'
  const timing: 'batch' | 'realtime' =
    settings.incrementalEngine === 'batch-keyframe' ? 'batch' : 'realtime';
  // When in batch mode, remember 'hybrid' as the realtime algorithm
  // the user would land on if they flipped timing back.  When already
  // in realtime, the engine field IS the algorithm.
  const realtimeAlgorithm:
    'hybrid' | 'slitscan-rotate' | 'slitscan-both' =
      settings.incrementalEngine === 'batch-keyframe'
        ? 'hybrid'
        : settings.incrementalEngine;
  const setTiming = (t: 'batch' | 'realtime') => {
    if (t === 'batch') {
      update({ incrementalEngine: 'batch-keyframe' });
    } else {
      update({ incrementalEngine: realtimeAlgorithm });
    }
  };

  // Frame Selection only makes sense for batch and hybrid engines —
  // slit-scan needs dense input and the gate would starve it.
  const showFrameSelection =
    timing === 'batch' || realtimeAlgorithm === 'hybrid';

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>Panorama settings</Text>
            <Pressable
              onPress={onClose}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Close settings"
              style={styles.closeBtn}
            >
              <Text style={styles.closeText}>×</Text>
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.body}>
            <Text style={styles.debugLine}>
              {`device: physicalMemoryBytes=${_physicalMemoryBytes} `
                + `(${(_physicalMemoryBytes / (1024 ** 3)).toFixed(2)} GB) · `
                + `isLowMem=${_isLowMem ? 'yes' : 'no'} · `
                + `default blender=${_isLowMem ? 'feather' : 'multiband'}`}
            </Text>

            {/* ──────────────────────────────────────────────
             *  2026-05-14 (revised) — CAPTURE SOURCE picker.
             *  Two options after the Galaxy A35 vision-camera
             *  CameraCaptureSession crash on pre-mount physical-
             *  lens selection: 'ar' (AR-backed, default) and
             *  'non-ar' (vision-camera + lens-switcher chip on
             *  the capture screen).  Switching to 'non-ar'
             *  cascades to disable plane detection, flip frame-
             *  selection to flow-based, and turn off useARPreview
             *  (see useEffect in AuditCaptureScreen.tsx).
             * ────────────────────────────────────────────── */}
            <SectionHeader title="Capture source" />
            <SegmentedControl
              options={['ar', 'non-ar']}
              value={settings.captureSource}
              onChange={(v) => update({ captureSource: v as PanoramaSettings['captureSource'] })}
              caption="ar (default): ARKit / ARCore — plane detection, pose-aware capture, full AR stack.  non-ar: vision-camera only — disables AR plane detection, flips frame-selection to flow-based, runs IMU translation gate.  In non-ar mode, the on-screen lens-switcher chip lets you toggle 0.5× / 1× lens during capture (only shown when the device has both lenses)."
            />

            {/* 2026-05-14 — Stitch-mode picker.  THE 2026-05-14 OOM
             *  root cause: cv::Stitcher PANORAMA mode breaks down
             *  on translation-heavy input.  'auto' (DEFAULT) routes
             *  between PANORAMA and SCANS based on accumulated
             *  translation vs rotation magnitudes at finalize time.
             *  Lifted to the top of the modal alongside captureSource
             *  for the same reason: it's a top-level pipeline
             *  decision, not a per-engine tuning. */}
            <SectionHeader title="Stitch mode" />
            <SegmentedControl
              options={['auto', 'panorama', 'scans']}
              value={settings.stitchMode}
              onChange={(v) => update({ stitchMode: v as PanoramaSettings['stitchMode'] })}
              caption="auto (default): pick PANORAMA or SCANS based on translation/rotation totals at finalize. panorama: cv::Stitcher::PANORAMA — rotation-only (spherical warper, BA-ray); best for rotate-in-place captures, BAD on translation. scans: cv::Stitcher::SCANS — affine pipeline (plane warper, BA-affine); best for shelf-pan captures."
            />

            {/* ──────────────────────────────────────────────
             *  STITCH TIMING — top-level decision.  Maps to the
             *  `incrementalEngine` storage field via setTiming().
             * ────────────────────────────────────────────── */}
            <SectionHeader title="Stitch timing" />
            <SegmentedControl
              options={['batch', 'realtime']}
              value={timing}
              onChange={(v) => setTiming(v as 'batch' | 'realtime')}
              caption="batch (recommended): full cv::Stitcher pipeline at shutter release. Highest quality. ~1–2 s post-release. realtime: incremental during pan; lower latency, fewer quality stages."
            />

            {/* ──────────────────────────────────────────────
             *  FRAME SELECTION (V16) — only for batch + hybrid.
             *  Slit-scan needs dense input; gate would starve it.
             * ────────────────────────────────────────────── */}
            {showFrameSelection && (
              <>
                <SectionHeader title="Frame selection (V16)" />
                <SegmentedControl
                  options={['time-based', 'pose-based', 'flow-based']}
                  value={settings.frameSelectionMode}
                  onChange={(v) => update({ frameSelectionMode: v as PanoramaSettings['frameSelectionMode'] })}
                  caption="flow-based (V16 A2, default): KeyframeGate uses sparse-Lucas-Kanade optical flow on full frame — plane-independent, invariant to plane size. pose-based: plane-polygon overlap (oversensitive on small latched planes). time-based: every ARFrame goes to the engine."
                />
                {(settings.frameSelectionMode === 'pose-based' ||
                  settings.frameSelectionMode === 'flow-based') && (
                  <>
                    <SectionHeader title="Overlap threshold (new content per keyframe)" />
                    <SegmentedControl
                      options={['20%', '30%', '40%', '50%', '60%']}
                      value={`${Math.round(settings.keyframeOverlapThreshold * 100)}%`}
                      onChange={(v) => update({ keyframeOverlapThreshold: parseInt(v, 10) / 100 })}
                      caption="Required NEW content per keyframe. 40% (default) ≈ 4–5 keyframes for a 90° pan. Same threshold semantics for both pose-based and flow-based."
                    />
                    <SectionHeader title="Max keyframes per capture" />
                    <SegmentedControl
                      options={['3', '4', '5', '6', '8', '10']}
                      value={String(settings.keyframeMaxCount)}
                      onChange={(v) => update({ keyframeMaxCount: parseInt(v, 10) })}
                      caption="Hard cap. 6 (default) matches Samsung's behaviour. Once reached, host auto-finalizes."
                    />
                  </>
                )}
                {settings.frameSelectionMode === 'flow-based' && (
                  <>
                    <SectionHeader title="Flow tuning — max corners" />
                    <SegmentedControl
                      options={['50', '100', '150', '200', '300']}
                      value={String(settings.flowMaxCorners)}
                      onChange={(v) => update({ flowMaxCorners: parseInt(v, 10) })}
                      caption="Max Shi-Tomasi corners detected per accepted keyframe. More = more robust median, slower detect. 150 = default."
                    />
                    <SectionHeader title="Flow tuning — quality level" />
                    <SegmentedControl
                      options={['0.005', '0.01', '0.02', '0.03', '0.05']}
                      value={String(settings.flowQualityLevel)}
                      onChange={(v) => update({ flowQualityLevel: parseFloat(v) })}
                      caption="Shi-Tomasi corner quality threshold. Lower = more (weaker) corners; higher = fewer (stronger) corners. 0.01 = default."
                    />
                    <SectionHeader title="Flow tuning — min distance" />
                    <SegmentedControl
                      options={['5', '8', '10', '15', '20']}
                      value={String(settings.flowMinDistance)}
                      onChange={(v) => update({ flowMinDistance: parseInt(v, 10) })}
                      caption="Min pixel distance between detected corners (working resolution = 720 px longest side). Higher = more spatially-spread features. 10 = default."
                    />
                    <SectionHeader title="Flow tuning — translation budget (cm)" />
                    <SegmentedControl
                      options={['0', '5', '8', '12', '20', '50']}
                      value={String(settings.flowMaxTranslationCm)}
                      onChange={(v) => update({ flowMaxTranslationCm: parseInt(v, 10) })}
                      caption="Force-accept when camera has moved this many cm since last keyframe, even if novelty < overlap threshold. Bounds parallax so the stitcher can match. 0 = disabled (default). 8 = recommended starting value."
                    />
                    <SectionHeader title="Flow tuning — novelty percentile" />
                    <SegmentedControl
                      options={['0.50', '0.70', '0.85', '0.95', '0.99']}
                      value={settings.flowNoveltyPercentile.toFixed(2)}
                      onChange={(v) => update({ flowNoveltyPercentile: parseFloat(v) })}
                      caption="How tracked-feature displacements are aggregated into novelty. 0.50 = pre-V16 median behaviour (conservative). 0.85 = picks up leading-edge motion sooner (default, matches user perception). 0.99 = near-max, very aggressive."
                    />
                    <SectionHeader title="Flow tuning — eval every N frames" />
                    <SegmentedControl
                      options={['1', '2', '3', '5', '10']}
                      value={String(settings.flowEvalEveryNFrames)}
                      onChange={(v) => update({ flowEvalEveryNFrames: parseInt(v, 10) })}
                      caption="Throttle gate evaluation to every Nth AR frame. 1 = every frame (default, no throttle). 3-5 = noticeable CPU/battery savings on long captures, up to N-1 frames of acceptance latency."
                    />
                  </>
                )}
              </>
            )}

            {/* ──────────────────────────────────────────────
             *  AR PLANE PROJECTION — used by KeyframeGate's overlap
             *  calculation, slit-scan plane-projection, and (future)
             *  pose-driven batch.  Sub-fields reveal based on source.
             * ────────────────────────────────────────────── */}
            <SectionHeader title="AR plane projection" />
            <SegmentedControl
              options={['Disabled', 'ARKitDetected', 'Virtual']}
              value={settings.planeSource}
              onChange={(v) => update({ planeSource: v as PanoramaSettings['planeSource'] })}
              caption="Disabled: no plane (gate falls back to angular delta). ARKitDetected: latch ARKit's vertical plane (best fidelity, picky). Virtual: synthesise plane perpendicular to camera at a fixed depth (always works)."
            />
            {settings.planeSource === 'ARKitDetected' && (
              <>
                <SectionHeader title="ARKit alignment threshold" />
                <SegmentedControl
                  options={['0.3', '0.5', '0.6', '0.7', '0.85']}
                  value={settings.arkitPlaneAlignmentThreshold.toFixed(2)}
                  onChange={(v) => update({ arkitPlaneAlignmentThreshold: parseFloat(v) })}
                  caption="Min dot product between candidate plane normal and camera facing. 0.6 (default) = ~53° max angle off-camera. Higher = stricter."
                />
              </>
            )}
            {settings.planeSource === 'Virtual' && (
              <>
                <SectionHeader title="Virtual plane depth" />
                <SegmentedControl
                  options={['0.5m', '1.0m', '1.5m', '2.0m', '3.0m']}
                  value={`${settings.virtualPlaneDepthMeters.toFixed(1)}m`}
                  onChange={(v) => update({ virtualPlaneDepthMeters: parseFloat(v) })}
                  caption="Synthetic plane depth at first frame. Set to your typical scan distance."
                />
              </>
            )}
            {settings.planeSource !== 'Disabled' && (
              <>
                <SectionHeader title="Plane projection style" />
                <SegmentedControl
                  options={['Rectified', 'Trapezoidal']}
                  value={settings.planeProjectionStyle}
                  onChange={(v) => update({ planeProjectionStyle: v as PanoramaSettings['planeProjectionStyle'] })}
                  caption="Rectified (default): clean rectangle paste, no tilt distortion. Trapezoidal: V15.0b legacy 3D-correct raycast — geometric purity at the cost of tilt artifacts."
                />
              </>
            )}

            {/* ──────────────────────────────────────────────
             *  ALGORITHM — what runs at stitch time.  In batch mode
             *  there's no choice (cv::Stitcher feature-matched
             *  pipeline).  In realtime, three live engines.
             * ────────────────────────────────────────────── */}
            <SectionHeader title="Algorithm" />
            {timing === 'batch' ? (
              <View style={styles.infoBox}>
                <Text style={styles.infoText}>
                  Full feature-matched pipeline:
                  ORB → BFMatcher → RANSAC → BundleAdjusterRay →
                  waveCorrect → Warper → GraphCutSeamFinder →
                  ExposureCompensator → MultiBandBlender. No engine
                  choice in batch mode.
                </Text>
              </View>
            ) : (
              <SegmentedControl
                options={['hybrid', 'slitscan-rotate', 'slitscan-both']}
                value={realtimeAlgorithm}
                onChange={(v) => update({ incrementalEngine: v as PanoramaSettings['incrementalEngine'] })}
                caption="hybrid: streaming planar projection + feature matching. slitscan-rotate: V13.0a + 1D NCC. slitscan-both: V13.0a + no accept gate + feather blend (iteration playground)."
              />
            )}

            {/* ──────────────────────────────────────────────
             *  ALGORITHM TUNING — engine-specific knobs revealed
             *  by current Algorithm choice.
             * ────────────────────────────────────────────── */}
            {timing === 'batch' && (
              <>
                {/* Capture source + stitch mode were lifted to the
                 * TOP of the modal (above the timing picker) on
                 * 2026-05-14 since they're pipeline-level decisions,
                 * not batch-tuning knobs.  See the top of the
                 * ScrollView for those controls. */}
                <SectionHeader title="Batch tuning — Warper" />
                <SegmentedControl
                  options={['plane', 'cylindrical', 'spherical']}
                  value={settings.warperType}
                  onChange={(v) => update({ warperType: v as PanoramaSettings['warperType'] })}
                  caption="plane (default, recommended for retail shelves): flat rectangular output. cylindrical: rotational mid-arc, gentle curvature. spherical: wide pans (180°+) but always-curved."
                />
                <SectionHeader title="Batch tuning — Blender" />
                <SegmentedControl
                  options={['multiband', 'feather']}
                  value={settings.blenderType}
                  onChange={(v) => update({ blenderType: v as PanoramaSettings['blenderType'] })}
                  caption="multiband (default): Laplacian-pyramid blending; cleanest seams. feather: faster, no halo when exposure varies."
                />
                <SectionHeader title="Batch tuning — Seam finder" />
                <SegmentedControl
                  options={['graphcut', 'skip']}
                  value={settings.seamFinderType}
                  onChange={(v) => update({ seamFinderType: v as PanoramaSettings['seamFinderType'] })}
                  caption="graphcut (default): cv::detail::GraphCutSeamFinder; optimal seams, pairs with multiband, holds all warps in memory. skip: stream warp+feed (lower peak memory)."
                />
                <SectionHeader title="Batch tuning — Inscribed-rect crop" />
                <SegmentedControl
                  options={['off', 'on']}
                  value={settings.enableMaxInscribedRectCrop ? 'on' : 'off'}
                  onChange={(v) => update({ enableMaxInscribedRectCrop: v === 'on' })}
                  caption="off (default): final crop is just cv::boundingRect of non-black pixels — preserves all stitched content; may have black corners. on: additionally run MaxInscribedRectFromMask + column-projection second-pass for a clean-cornered rectangle — can shrink the output if the panorama mask is lopsided. A/B against the bbox crop on real scenes."
                />
              </>
            )}
            {timing === 'realtime' && realtimeAlgorithm === 'hybrid' && (
              <>
                <SectionHeader title="Hybrid tuning — Projection" />
                <SegmentedControl
                  options={['Planar', 'Cylindrical']}
                  value={settings.hybridProjection}
                  onChange={(v) => update({ hybridProjection: v as PanoramaSettings['hybridProjection'] })}
                  caption="Planar (default): cv::detail::PlaneWarper. Cylindrical: V12.x – V14.0a behaviour (legacy)."
                />
              </>
            )}
            {timing === 'realtime' && realtimeAlgorithm.startsWith('slitscan') && (
              <>
                <SectionHeader title="Slit-scan tuning — Slit width" />
                <SegmentedControl
                  options={['0.01', '0.05', '0.10', '0.20', '0.30', '0.50']}
                  value={settings.slitWidthFraction.toFixed(2)}
                  onChange={(v) => update({ slitWidthFraction: parseFloat(v) })}
                  caption="Fraction of pan-axis retained per sliver. 0.30 (V15 default) ≈ 324 px. Smaller = less within-slit depth disagreement."
                />
                <SectionHeader title="Slit-scan tuning — Sliver position" />
                <SegmentedControl
                  options={['Center', 'Bottom', 'Top']}
                  value={settings.sliverPosition}
                  onChange={(v) => update({ sliverPosition: v as PanoramaSettings['sliverPosition'] })}
                  caption="Where on the camera sensor frame the sliver is taken."
                />
                <SectionHeader title="Slit-scan tuning — Full first-frame" />
                <SegmentedControl
                  options={['off', 'on']}
                  value={settings.firstFrameFullFrame ? 'on' : 'off'}
                  onChange={(v) => update({ firstFrameFullFrame: v === 'on' })}
                  caption="ON: first accepted frame paints the full camera frame at the canvas anchor; subsequent frames use sliver clip."
                />
                <SectionHeader title="Slit-scan tuning — Paint mode" />
                <SegmentedControl
                  options={['FirstPaintedWins', 'FeatherBlend']}
                  value={settings.paintMode}
                  onChange={(v) => update({ paintMode: v as PanoramaSettings['paintMode'] })}
                  caption="FirstPaintedWins (default): protect already-painted pixels. FeatherBlend: alpha-blend new content into overlap."
                />
              </>
            )}

            {/* ──────────────────────────────────────────────
             *  ADVANCED — 2D NCC fine-alignment (closed by default).
             *  Used by slit-scan plane mode and any 2D NCC stage.
             * ────────────────────────────────────────────── */}
            <Accordion title="Advanced — 2D NCC fine-alignment" badge="advanced">
              <SectionHeader title="Enable 2D NCC" />
              <SegmentedControl
                options={['off', 'on']}
                value={settings.enable2dNcc ? 'on' : 'off'}
                onChange={(v) => update({ enable2dNcc: v === 'on' })}
                caption="V13.0g 2D NCC fine-alignment after pose-driven projection. Refines (Δx, Δy) translation via cv::matchTemplate."
              />
              {settings.enable2dNcc && (
                <>
                  <SectionHeader title="Confidence threshold" />
                  <SegmentedControl
                    options={['0.50', '0.65', '0.75', '0.85', '0.95', '0.99']}
                    value={settings.nccConfidenceThreshold2d.toFixed(2)}
                    onChange={(v) => update({ nccConfidenceThreshold2d: parseFloat(v) })}
                    caption="Reject NCC corrections below this confidence. 0.99 = only apply on near-perfect overlap."
                  />
                  <SectionHeader title="Search half-window (px)" />
                  <SegmentedControl
                    options={['6', '10', '12', '20', '30']}
                    value={String(settings.nccSearchMargin2d)}
                    onChange={(v) => update({ nccSearchMargin2d: parseInt(v, 10) })}
                    caption="Pixels: 2D NCC searches ±this around the pose-predicted match."
                  />
                  <SectionHeader title="EMA smoothing" />
                  <SegmentedControl
                    options={['off', 'on']}
                    value={settings.enableNcc2dEmaSmoothing ? 'on' : 'off'}
                    onChange={(v) => update({ enableNcc2dEmaSmoothing: v === 'on' })}
                    caption="Damp single-frame snaps to spurious peaks via EMA."
                  />
                  {settings.enableNcc2dEmaSmoothing && (
                    <>
                      <SectionHeader title="EMA alpha (current-frame weight)" />
                      <SegmentedControl
                        options={['0.20', '0.30', '0.40', '0.60', '0.80']}
                        value={settings.ncc2dEmaAlpha.toFixed(2)}
                        onChange={(v) => update({ ncc2dEmaAlpha: parseFloat(v) })}
                      />
                    </>
                  )}
                  <SectionHeader title="Pan-axis lock" />
                  <SegmentedControl
                    options={['off', 'on']}
                    value={settings.enableNcc2dPanAxisLock ? 'on' : 'off'}
                    onChange={(v) => update({ enableNcc2dPanAxisLock: v === 'on' })}
                    caption="Clamp cross-axis correction tighter than pan-axis (pose + 1D NCC handle cross-axis already)."
                  />
                  {settings.enableNcc2dPanAxisLock && (
                    <>
                      <SectionHeader title="Cross-axis clamp (px)" />
                      <SegmentedControl
                        options={['2', '5', '10', '15']}
                        value={String(settings.ncc2dCrossAxisLockPx)}
                        onChange={(v) => update({ ncc2dCrossAxisLockPx: parseInt(v, 10) })}
                      />
                    </>
                  )}
                </>
              )}
            </Accordion>

            {/* ──────────────────────────────────────────────
             *  ADVANCED — Slit-scan experimental.  Only relevant
             *  when slitscan-both is the active engine.
             * ────────────────────────────────────────────── */}
            {timing === 'realtime' && realtimeAlgorithm === 'slitscan-both' && (
              <Accordion title="Advanced — Slit-scan experimental" badge="experimental">
                <SectionHeader title="Triangulation parallax" />
                <SegmentedControl
                  options={['off', 'on']}
                  value={settings.enableTriangulation ? 'on' : 'off'}
                  onChange={(v) => update({ enableTriangulation: v === 'on' })}
                  caption="V13.0e ORB triangulation + median-Z parallax correction. Adds ~10ms/accept."
                />
                <SectionHeader title="RANSAC homography" />
                <SegmentedControl
                  options={['off', 'on']}
                  value={settings.enableRansacHomography ? 'on' : 'off'}
                  onChange={(v) => update({ enableRansacHomography: v === 'on' })}
                  caption="V14.0a RANSAC homography per slit + cv::warpPerspective. Known limitation: can absorb pan as scale, leaving gaps."
                />
                <SectionHeader title="Accept gate (px)" />
                <SegmentedControl
                  options={['0', '50']}
                  value={String(settings.acceptGate)}
                  onChange={(v) => update({ acceptGate: parseInt(v, 10) as PanoramaSettings['acceptGate'] })}
                  caption="0 = accept on every frame (Apple-dense). 50 = V13.0g throttle."
                />
              </Accordion>
            )}

            {/* ──────────────────────────────────────────────
             *  OUTPUT — always visible.
             * ────────────────────────────────────────────── */}
            <SectionHeader title="Recording cap" />
            <SegmentedControl
              options={['4 s', '6 s', '8 s', '10 s']}
              value={`${Math.round(settings.maxRecordingMs / 1000)} s`}
              onChange={(v) => update({ maxRecordingMs: parseInt(v, 10) * 1000 })}
              caption="Auto-stops the hold-recording at this duration."
            />
            <SectionHeader title="JPEG quality" />
            <SegmentedControl
              options={['70', '85', '92']}
              value={String(settings.quality)}
              onChange={(v) => update({ quality: parseInt(v, 10) })}
              caption="Higher = bigger files, sharper detail. 85 is the recommended default."
            />

            {/* ──────────────────────────────────────────────
             *  DIAGNOSTICS / FALLBACKS — closed by default.  AR is
             *  the active path for 99% of use; the vision-camera
             *  fallback path lives here for emergencies.
             * ────────────────────────────────────────────── */}
            <Accordion title="Diagnostics / fallbacks" badge="rarely needed">
              <View style={styles.infoBox}>
                <Text style={styles.infoText}>
                  AR-backed capture is the recommended path. Toggle off
                  ONLY if ARKit fails on a specific device (very rare on
                  modern iPhones). Doing so falls back to vision-camera
                  video recording + post-stitch via cv::Stitcher.
                </Text>
              </View>
              <SectionHeader title="AR-backed capture" />
              <SegmentedControl
                options={['on', 'off']}
                value={settings.useARPreview ? 'on' : 'off'}
                onChange={(v) => update({ useARPreview: v === 'on' })}
                caption="Default ON. OFF only when ARKit is unavailable or for A/B testing."
              />
              {!settings.useARPreview && (
                <>
                  <SectionHeader title="Frame extraction — Frames per second" />
                  <SegmentedControl
                    options={['2', '3', '4']}
                    value={String(settings.framesPerSecond)}
                    onChange={(v) => update({ framesPerSecond: parseInt(v, 10) })}
                    caption="Frames/sec extracted from the recorded video. Lower = faster but riskier overlap."
                  />
                  <SectionHeader title="Frame extraction — Frame count clamp" />
                  <SegmentedControl
                    options={['4-12', '6-16', '8-20']}
                    value={`${settings.minFrames}-${settings.maxFrames}`}
                    onChange={(v) => {
                      const [min, max] = v.split('-').map((n) => parseInt(n, 10));
                      update({ minFrames: min, maxFrames: max });
                    }}
                    caption="Floor/ceiling for extracted frames."
                  />
                </>
              )}
            </Accordion>

            <Pressable
              onPress={() => onChange(DEFAULT_PANORAMA_SETTINGS)}
              style={styles.resetBtn}
              accessibilityRole="button"
              accessibilityLabel="Reset to defaults"
            >
              <Text style={styles.resetText}>Reset to defaults</Text>
            </Pressable>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}


function SectionHeader({ title }: { title: string }) {
  return <Text style={styles.sectionHeader}>{title}</Text>;
}


/**
 * Collapsible section.  Used for closed-by-default groupings
 * ("Advanced", "Diagnostics / fallbacks") so the modal's primary
 * surface stays focused on the controls operators actually touch
 * day-to-day.
 *
 * State is local — each Accordion instance manages its own open
 * flag.  The modal opens fresh-collapsed every mount which is what
 * we want for now; persisting open state across mounts (e.g. via
 * AsyncStorage) is a future enhancement.
 */
function Accordion({
  title,
  initiallyOpen = false,
  badge,
  children,
}: {
  title: string;
  initiallyOpen?: boolean;
  badge?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <View style={styles.accordion}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        style={styles.accordionHeader}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${title}, ${open ? 'expanded' : 'collapsed'}`}
      >
        <Text style={styles.accordionChevron}>{open ? '▼' : '▶'}</Text>
        <Text style={styles.accordionTitle}>{title}</Text>
        {badge ? <Tag label={badge} /> : null}
      </Pressable>
      {open ? <View style={styles.accordionBody}>{children}</View> : null}
    </View>
  );
}


/**
 * Small grey-text badge.  Marks sections / fields as "advanced",
 * "experimental", "legacy", or similar — quick visual signal that
 * the operator can usually ignore them.
 */
function Tag({ label }: { label: string }): React.JSX.Element {
  return (
    <View style={styles.tag}>
      <Text style={styles.tagText}>{label}</Text>
    </View>
  );
}


function SegmentedControl({
  options,
  value,
  onChange,
  caption,
}: {
  options: string[];
  value: string;
  onChange: (next: string) => void;
  caption?: string;
}) {
  return (
    <View>
      <View style={styles.segmentedRow}>
        {options.map((opt) => {
          const selected = opt === value;
          return (
            <Pressable
              key={opt}
              onPress={() => onChange(opt)}
              style={[
                styles.segment,
                selected && styles.segmentSelected,
              ]}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={`${opt}${selected ? ' (selected)' : ''}`}
            >
              <Text
                style={[
                  styles.segmentText,
                  selected && styles.segmentTextSelected,
                ]}
              >
                {opt}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {caption ? <Text style={styles.caption}>{caption}</Text> : null}
    </View>
  );
}


const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#1c1c1e',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingBottom: 32,
    maxHeight: '88%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.15)',
  },
  title: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '600',
  },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeText: {
    color: '#ffffff',
    fontSize: 22,
    fontWeight: '300',
    lineHeight: 24,
  },
  body: {
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  sectionHeader: {
    color: '#ffffff',
    opacity: 0.85,
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 18,
    marginBottom: 8,
  },
  row: {
    marginTop: 4,
  },
  label: {
    color: '#ffffff',
    opacity: 0.85,
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 18,
    marginBottom: 8,
  },
  segmentedRow: {
    flexDirection: 'row',
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 10,
    padding: 4,
    gap: 4,
  },
  segment: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentSelected: {
    backgroundColor: '#ffffff',
  },
  segmentText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '500',
    opacity: 0.85,
  },
  segmentTextSelected: {
    color: '#000000',
    fontWeight: '700',
    opacity: 1,
  },
  caption: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 11,
    marginTop: 6,
    lineHeight: 16,
  },
  debugLine: {
    color: 'rgba(255,200,0,0.85)',
    fontFamily: 'Menlo',
    fontSize: 10,
    paddingVertical: 8,
    paddingHorizontal: 6,
    backgroundColor: 'rgba(255,200,0,0.08)',
    borderRadius: 6,
    marginBottom: 4,
  },
  resetBtn: {
    marginTop: 28,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
    alignItems: 'center',
  },
  resetText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '500',
  },
  // V16 Phase 1b — Accordion + Tag + InfoBox
  accordion: {
    marginTop: 18,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 8,
    overflow: 'hidden',
  },
  accordionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 12,
    gap: 8,
  },
  accordionChevron: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 11,
    width: 14,
  },
  accordionTitle: {
    color: '#ffffff',
    opacity: 0.85,
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    flex: 1,
  },
  accordionBody: {
    paddingHorizontal: 12,
    paddingBottom: 14,
  },
  tag: {
    backgroundColor: 'rgba(255,255,255,0.12)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  tagText: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 9,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  infoBox: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 8,
    padding: 12,
    marginTop: 4,
  },
  infoText: {
    color: 'rgba(255,255,255,0.75)',
    fontSize: 12,
    lineHeight: 17,
  },
});
