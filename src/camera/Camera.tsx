// SPDX-License-Identifier: Apache-2.0
/**
 * Camera — the public, props-based camera component for the
 * `react-native-image-stitcher` library (publication target per the
 * 2026-05-15 design doc).
 *
 * One component, both modes:
 *   - **Tap shutter** → single photo via vision-camera's takePhoto
 *     (non-AR) or ARFrame.capturedImage (AR).
 *   - **Hold shutter** → panorama capture; pan-and-release produces
 *     a stitched panorama JPEG via the incremental stitcher.
 *
 * One component, both capture sources:
 *   - **AR mode** (ARKit / ARCore) — used for pose-aware stitching
 *     when the device supports it.
 *   - **Non-AR mode** (vision-camera + IMU) — fallback path,
 *     forced when the 0.5× ultra-wide lens is selected (AR sessions
 *     are tied to a single physical lens; can't switch mid-session).
 *
 * The Camera component owns its runtime state (arPreference, lens,
 * settings).  Parent props are read as INITIAL VALUES at mount; the
 * parent listens for state changes via the callback props.  This
 * "uncontrolled" model matches React's `<input>` convention and
 * matches the design doc's intent (NF — component owns runtime state,
 * parent persists via callbacks if desired).
 *
 * Scope note (step 2 of the SDK extract plan):
 *   - Props-driven API for both photo + panorama modes — DONE here.
 *   - Lens chip + AR toggle UI (U1) — DONE here.
 *   - `showSettingsButton` gates the existing PanoramaSettingsModal — DONE.
 *   - Imperative ref methods (`takePhoto()`, `startPanorama()`,
 *     `stopPanorama()`) — deferred; the built-in shutter button is the
 *     primary affordance for v0.1.0.
 *   - Forward-looking props (`defaultCompositingResolMP`,
 *     `defaultRegistrationResolMP`, `defaultSeamEstimationResolMP`)
 *     are accepted but currently no-ops — those fields don't exist on
 *     PanoramaSettings yet.  They're declared so the public API is
 *     stable before they wire through; the wiring is a follow-up.
 *
 * See: docs/site-content/design/2026-05-15-react-native-image-stitcher-publication.md
 */

import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AppState,
  NativeModules,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFrameProcessor } from 'react-native-vision-camera';
import type {
  Camera as VisionCamera,
  DrawableFrameProcessor,
  ReadonlyFrameProcessor,
} from 'react-native-vision-camera';

import { useARSession } from '../ar/useARSession';
import type { CameraFrameProcessor } from '../stitching/CameraFrame';
import type { ARFrameMeta, ARPluginResult } from '../stitching/ARFrameMeta';
import type { AROverlay } from '../stitching/AROverlay';
import type { AROverlayMethods } from './arOverlayController';
import { ARCameraView, type ARCameraViewHandle } from './ARCameraView';
// ⚠ A STATIC IMPORT, NOT A LAZY ONE. `engine="sweep"` must be able to fail at
// COMPILE time when the sweep surface is absent, not at the first hold. The
// cost is that every consumer of <Camera> pulls the sweep tree into its
// bundle; that is the same trade `default_subspecs` makes on the native side,
// and for the same reason — a silently-missing engine is worse than a larger
// bundle.
import {
  PanoPlusCaptureSurface,
  panoLensChipBottomPt,
  type PanoPlusCaptureSurfaceProps,
} from '../sweep/PanoPlusCaptureSurface';
import type {
  PanoPlusCaptureResult,
  PanoPlusFailure,
  SweepSurfaceHandle,
} from '../sweep/panoPlusTypes';
import { SWEEP_ENGINE_DEFAULTS } from '../sweep/sweepDefaults';
import { loadVideoFileSystem } from '../sweep/fileSystem';
import {
  PANO_PLUS_VERDICT_FILE,
  fileUri,
  panoPlusVerdictSidecar,
  panoPlusCaptureWarnings,
} from '../sweep/panoPlusModel';

/**
 * Everything `engine="sweep"` accepts, which is everything the sweep surface
 * accepts EXCEPT what `<Camera>` owns.
 *
 * Two groups come out, for two different reasons.
 *
 * THE RESULT CHANNEL. Completion and failure arrive through
 * `onCapture`/`onError` like every other engine's, so a host does not learn a
 * second result channel to use one engine.
 *
 * ⚠ WHO OWNS THE CAMERA — AND THIS IS A FIX, NOT TIDINESS. These three used
 * to be in the bag, and the bag is spread over the props `<Camera>` computes,
 * so a host's copy won. That made a state the design calls impossible
 * perfectly expressible, and reachable by a plausible host belief: passing
 * `sweep={{ frameSource: 'host' }}` because the host does own a camera
 * elsewhere left `hostOwnsSweepCamera` false — so `<Camera>` mounted NO
 * preview — while the surface, told the host owns it, suppressed its own
 * viewfinder, suppressed its idle feed AND suppressed the explainer that
 * exists to say why a screen is dark. A black screen with the one component
 * that would have described it deliberately silenced. Measured on the real
 * tree, not argued: a render probe flipped all of `frameSource`,
 * `vcPluginArm`, `vcCameraId`, `poseSource` and `lens` from the bag.
 *
 * They are `<Camera>`'s ANSWER to "who holds the back camera", derived from
 * one predicate together with the preview mount. An answer is not a knob.
 * A host that wants the other arm turns AR on, or picks a different engine.
 *
 * `poseSource` and `lens` STAY, because those really are the operator's — but
 * `<Camera>` now merges them BEFORE computing ownership rather than after, so
 * the predicate sees what the surface will see. See `hostOwnsSweepCamera`.
 */
export type SweepOptions = Omit<
  PanoPlusCaptureSurfaceProps,
  'onComplete' | 'onCancel' | 'onFailure'
  | 'frameSource' | 'hostPreviewLive' | 'vcPluginArm' | 'vcCameraId'
  // ⚠ AND THE TWO PILL WRITERS. `<Camera>` draws the AR pill and the lens
  // chip now, and the surface gates its own clones on these being non-null
  // — so a bag carrying either one RE-CREATES the clone that produced two
  // of the four field defects. Measured before this line existed: with
  // `sweep={{onLensChange, onPoseSourceChange}}` the tree came back with
  // TWO AR pills and TWO lens chips, and the whole suite stayed green.
  //
  // Omitted here so it cannot be written at all, and still assigned after
  // the spread below — the same belt-and-braces the four above get.
  | 'onPoseSourceChange' | 'onLensChange'
>;
import { CameraShutter } from './CameraShutter';
import { CameraView, type CameraViewProps } from './CameraView';
import { CaptureHeader, type CaptureHeaderProps } from './CaptureHeader';
import { CapturePreview, type CapturePreviewAction } from './CapturePreview';
import {
  CaptureThumbnailStrip,
  type CaptureThumbnailItem,
} from './CaptureThumbnailStrip';
import { CaptureStatusOverlay, type CaptureStatusPhase } from './CaptureStatusOverlay';
import { classifyStitchError } from './classifyStitchError';
import { CaptureDebugOverlay } from './CaptureDebugOverlay';
import { CaptureMemoryPill } from './CaptureMemoryPill';
import { CaptureKeyframePill } from './CaptureKeyframePill';
import { CaptureOrientationPill } from './CaptureOrientationPill';
import { CaptureStitchStatsToast, useStitchStatsToast } from './CaptureStitchStatsToast';
import { PanoramaBandOverlay } from './PanoramaBandOverlay';
import { type PanoramaSettings, DEFAULT_FLOW_GATE_SETTINGS } from './PanoramaSettings';
import { panoramaSettingsToNativeConfig } from './PanoramaSettingsBridge';
import { PanoramaSettingsModal } from './PanoramaSettingsModal';
import {
  buildPanoramaInitialSettings,
  type PanoramaPropOverrides,
} from './buildPanoramaInitialSettings';
import { isLowMemDevice } from './lowMemDevice';
import { useCapture } from './useCapture';
import type { CaptureDeviceMode } from './selectCaptureDevice';
import { shouldOfferNativeUltraWide } from './nativeUltraWide';
import { useDeviceOrientation, type DeviceOrientation } from './useDeviceOrientation';
import {
  contentRotationDeg,
  HostJsLandscapeContext,
  type ContentRotationStyle,
} from './useContentRotation';
import { useOrientationDrift } from './useOrientationDrift';
import { OrientationDriftModal } from './OrientationDriftModal';
// ── Panorama GUIDANCE building blocks (feature/pano-ux-guidance) ─────
// Pure decision helpers + sensor hook + presentational surfaces for the
// first-time-user pan-capture guidance (items 1–7).  All read directly
// from the new <Camera> props below, NOT threaded through PanoramaSettings.
import {
  shouldGateForPanMode,
  gateTargetOrientation,
  type PanMode,
} from './panModeGate';
import { countdownSecondsFrom } from './captureCountdown';
import { usePanMotion } from './usePanMotion';
import type { Quad } from './cropGeometry';
import {
  mergeGuidanceCopy,
  captureWarningCopyFrom,
  type GuidanceCopy,
} from './cameraGuidanceCopy';
import { RotateToLandscapePrompt } from './RotateToLandscapePrompt';
import { PanHowToOverlay } from './PanHowToOverlay';
import { CaptureCountdownOverlay } from './CaptureCountdownOverlay';
import { CaptureFrameCounterOverlay } from './CaptureFrameCounterOverlay';
import { LateralMotionModal } from './LateralMotionModal';
import { RectCropPreview, type ImageRect } from './RectCropPreview';
import { buildStitchDebugInfo } from './stitchDebugInfo';
import { cropQuad } from '../stitching/cropQuad';
import { computeInscribedRect } from '../stitching/computeInscribedRect';
import {
  buildCaptureWarnings,
  type CaptureWarning,
} from './captureWarnings';
import {
  getIncrementalNativeModule,
  incrementalMissingMethods,
  incrementalStitcherIsAvailable,
} from '../stitching/incremental';
import { useFrameProcessorDriver } from '../stitching/useFrameProcessorDriver';
import { useSweepWorklet } from '../sweep/useSweepWorklet';
import { useIncrementalStitcher } from '../stitching/useIncrementalStitcher';
import { useIMUTranslationGate } from '../sensors/useIMUTranslationGate';
import { toBareFilePath, toFileUri } from '../utils/paths';
import { normaliseOrientation } from '../quality/normaliseOrientation';
import {
  defaultPanoramaFilename,
  defaultPhotoFilename,
  getDefaultCaptureDir,
  moveFile,
} from '../utils/files';


// ─── Types ──────────────────────────────────────────────────────────

export type CaptureSource = 'ar' | 'non-ar';
/**
 * v0.13.2 — which capture sources the host ALLOWS.  A constraint on top
 * of `defaultCaptureSource` (which picks the initial source within this
 * constraint):
 *   'both'   — AR and non-AR both available; AR toggle is shown.
 *   'ar'     — AR only; AR toggle hidden (nothing to switch to), and the
 *              0.5× lens chooser is hidden (ARKit/ARCore don't expose the
 *              ultra-wide).
 *   'non-ar' — non-AR only; AR toggle hidden.
 */
export type CaptureSourcesMode = 'ar' | 'non-ar' | 'both';
export type CameraLens = '1x' | '0.5x';
export type StitchMode = 'auto' | 'panorama' | 'scans';
export type Blender = 'multiband' | 'feather';
export type SeamFinder = 'graphcut' | 'skip';
export type Warper = 'plane' | 'cylindrical' | 'spherical';


/**
 * Result emitted via `onCapture`.  Discriminated union keyed FIRST on
 * `ok` (success vs. failure) and then on `type` (photo vs. panorama), so a
 * host handles EVERY capture outcome — success, degraded success, and
 * failure — through this one callback.
 *
 * ## v0.16 — unified success/failure + warnings (BREAKING)
 *
 * Previously `onCapture` fired only on success and carried no `ok` field;
 * failures went *solely* to `onError`.  Hosts therefore had no single place
 * to learn whether a capture succeeded, and no programmatic signal that a
 * stitch was *degraded* (e.g. most frames dropped).  Now:
 *
 *   - `onCapture` ALWAYS fires once per capture attempt, with `ok:true`
 *     (output present) or `ok:false` (carrying the `CameraError`).
 *   - both success and failure carry `warnings: CaptureWarning[]` — non-fatal
 *     quality signals (e.g. `LOW_FRAME_UTILIZATION` when <70 % of captured
 *     frames survived, `LATERAL_DRIFT_FINALIZE` when item-6 stopped early).
 *   - `onError` STILL fires on failure too (an unchanged mirror), so existing
 *     error handling keeps working.
 *
 * Migration: gate on `ok` before reading `uri`/`width`/`height` —
 * `if (!result.ok) { handle(result.error); return; }`.
 *
 * Identifier `CameraCaptureResult` (vs. the SDK's existing `CaptureResult`
 * from `../types`) is intentional — the existing CaptureResult shape has
 * SDK-specific fields that don't belong in the public RN library's surface.
 */
export type CameraCaptureResult =
  | {
      ok: true;
      type: 'photo';
      uri: string;
      width: number;
      height: number;
      /**
       * iOS `captureDepthData` (NON-AR captures only) — path of the
       * `<photo>.depth.bin` depth sidecar saved next to the photo
       * (float32 metres row-major + JSON header with dims/intrinsics;
       * format spec in `website/docs/photo-depth.md`).  Absent on
       * Android, in AR capture, on depth-less devices/formats, and
       * whenever the opt-in is off.
       */
      depthPath?: string;
      /**
       * WHY `depthPath` is absent although `captureDepthData` was
       * requested (iOS non-AR): the extractor's reason slug
       * (`no-depth-aux` = no auxiliary depth in the capture — typically
       * a non-depth-capable mounted device; `native-module-missing` =
       * JS newer than the installed binary).  Diagnostic only.
       */
      depthUnavailableReason?: string;
      /** Non-fatal quality signals (empty when none). */
      warnings: CaptureWarning[];
    }
  | {
      ok: true;
      type: 'panorama';
      uri: string;
      width: number;
      height: number;
      framesRequested: number;
      framesIncluded: number;
      framesDropped: number;
      finalConfidenceThresh: number;
      durationMs: number;
      /**
       * 2026-05-22 (audit F2g) — which cv::Stitcher pipeline the
       * batch finalize ran (after auto-resolution if applicable).
       * Useful for displaying a "Stitched as: scans" pill on the
       * output preview.  Undefined when the engine wasn't
       * batch-keyframe (hybrid / slit-scan don't go through
       * cv::Stitcher at finalize).
       */
      stitchModeResolved?: 'panorama' | 'scans';
      /**
       * 2026-06-15 (DEV) — gyro rotation magnitude of the capture, in radians.
       * Shown on the dev preview so the panorama-vs-SCANS rotation threshold can
       * be tuned. `0` = no pose-derived rotation signal (non-AR with no poses).
       */
      rRadians?: number;
      /**
       * 2026-06-16 (DEV) — translation magnitude (m) + auto decision ratio
       * (`>=0.55` → SCANS) that drove panorama-vs-SCANS. Shown on the dev
       * readout alongside `rRadians` to tune the threshold from real captures.
       */
      tMeters?: number;
      decisionRatio?: number;
      /**
       * 2026-06-14 (DEV overlay) — semicolon-separated `key=value` trace of the
       * stitcher's runtime choices (pipe/warp/route/seam/blend) for this
       * output.  Shown on the preview in __DEV__.  iOS only for now.
       */
      debugSummary?: string;
      /**
       * 2026-06-15 (iOS) — keyframe JPEG paths used for this stitch, so the
       * preview can re-stitch them on demand via `refinePanorama` (the
       * high-level tab).  iOS only; undefined elsewhere.
       */
      keyframePaths?: string[];
      /**
       * 2026-06-15 (iOS) — orientation this stitch baked in.  The on-demand
       * high-level re-stitch passes it back so it matches the manual output's
       * rotation (not the raw sensor landscape).  iOS only.
       */
      captureOrientation?: string;
      /** Non-fatal quality signals (empty when none). */
      warnings: CaptureWarning[];
    }
  /**
   * A finished SWEEP (`engine="sweep"`).
   *
   * ⚠ A THIRD SHAPE, NOT A WIDENED PANORAMA. A sweep is not a keyframe
   * panorama with different settings: it produces a pack directory, per-strip
   * integrity counters and a residual verdict, and it has no `warnings`
   * because nothing in its path emits one. Folding it into the `'panorama'`
   * member would give every existing consumer a set of fields that are
   * absent on every capture they have ever seen. `type: 'panoplus'` keeps the
   * discriminant honest and leaves existing narrowing untouched.
   */
  | (PanoPlusCaptureResult & { ok: true })
  | {
      ok: false;
      /** Which capture path failed. */
      type: 'photo' | 'panorama' | 'panoplus';
      /** The classified failure (same object handed to `onError`). */
      error: CameraError;
      /** Any warnings gathered before the failure (usually empty). */
      warnings: CaptureWarning[];
    };


/**
 * The success-panorama variant of {@link CameraCaptureResult} — the exact
 * shape stashed for the crop editor and re-emitted (with adjusted dims) once
 * the user crops.  Narrowed so the crop-confirm spread keeps `uri`/`width`/
 * `height`/`ok` without a cast.
 */
export type PanoramaCaptureResult = Extract<
  CameraCaptureResult,
  { ok: true; type: 'panorama' }
>;


/**
 * Errors surfaced via `onError`.  Classified codes so consumers can
 * branch on the kind of failure (toast vs retry vs report).
 */
export type CameraErrorCode =
  | 'CAMERA_PERMISSION_DENIED'
  | 'CAMERA_DEVICE_UNAVAILABLE'
  | 'PHOTO_CAPTURE_FAILED'
  | 'PANORAMA_START_FAILED'
  /**
   * The `engine` prop named something this binary will not run, and native
   * REFUSED rather than quietly substituting one. Two native codes arrive
   * under this one: `engine-unavailable` (a known engine with no provider in
   * this build) and `engine-unknown` (not an engine name at all). The exact one
   * is on the cause, because they are different bugs on the caller's side.
   *
   * Also raised when native resolves a start WITHOUT saying which engine it
   * resolved — see the `engineResolved` check at the start call site. That
   * means an OLD binary that predates the refusal, and an old binary cannot be
   * trusted with a non-default engine: it would paint a keyframe panorama and
   * report success.
   *
   * Not user-recoverable — this is a host configuration error, so
   * `userFacingStitchError` returns null for it.
   */
  | 'ENGINE_UNAVAILABLE'
  | 'PANORAMA_FINALIZE_FAILED'
  | 'STITCH_NEED_MORE_IMGS'
  | 'STITCH_HOMOGRAPHY_FAIL'
  | 'STITCH_CAMERA_PARAMS_FAIL'
  /**
   * v0.16 — the native post-stitch validator rejected the output: the
   * panorama came out disjoint / fragmented / wildly mis-proportioned
   * (frames didn't connect into one coherent image).  Recoverable by
   * re-capturing, so it carries "try again" copy.
   */
  | 'STITCH_LOW_QUALITY'
  | 'STITCH_OOM'
  | 'OUTPUT_WRITE_FAILED'
  /**
   * Vision-camera surfaced a runtime error that isn't a known
   * transient lifecycle event (those are swallowed inside the SDK's
   * `<CameraView>`).  Examples that DO reach the host as this code:
   * `format/invalid-format`, `capture/recording-canceled`,
   * `device/microphone-permission-denied`, ...  The full error
   * object is on `.cause` for inspection.
   */
  | 'VISION_CAMERA_RUNTIME'
  | 'UNKNOWN';


export class CameraError extends Error {
  public readonly code: CameraErrorCode;
  public readonly cause?: unknown;
  constructor(code: CameraErrorCode, message: string, cause?: unknown) {
    super(message);
    this.code = code;
    this.cause = cause;
    this.name = 'CameraError';
  }
}


/**
 * Frames-dropped info delivered via `onFramesDropped`.  Fires once
 * per panorama capture if the C+D progressive-confidence retry loop
 * inside cv::Stitcher dropped one or more input frames.
 */
export interface FramesDroppedInfo {
  requested: number;
  included: number;
}


/**
 * Camera component props.  See the design doc's "Component API"
 * section for the full rationale per field.
 */
export interface CameraProps {
  // ── Initial values (uncontrolled — read once at mount) ────────────
  defaultCaptureSource?: CaptureSource;
  defaultLens?: CameraLens;
  defaultStitchMode?: StitchMode;
  defaultBlender?: Blender;
  defaultWarper?: Warper;
  defaultFlowNoveltyPercentile?: number;
  defaultFlowEvalEveryNFrames?: number;
  defaultFlowMaxTranslationCm?: number;
  defaultKeyframeMaxCount?: number;
  defaultKeyframeOverlapThreshold?: number;
  /** Time-budget force-accept (ms) for the keyframe gate — accept a
   *  keyframe at least this often during a pan even if novelty is low,
   *  so slow / static pans don't leave temporal gaps.  `0` disables it.
   *  Default 2000 (2 s).  Applies to both AR and non-AR captures. */
  defaultMaxKeyframeIntervalMs?: number;
  /** Forward-looking — wires through to cv::Stitcher's compositingResol
   *  once PanoramaSettings exposes the field (currently a no-op). */
  defaultCompositingResolMP?: number;
  /** Forward-looking — see above. */
  defaultRegistrationResolMP?: number;
  /** Forward-looking — see above. */
  defaultSeamEstimationResolMP?: number;
  /**
   * v0.16 — the stitch RECIPE as a JSON object (`stitchMode` / `warperType` /
   * `blenderType` / `enableMaxInscribedRectCrop` / `debugPack`).  Partial; wins
   * over the flat `default*` props.  v0.24 — the speed levers moved to {@link
   * perf}. */
  stitcher?: PanoramaPropOverrides['stitcher'];
  /**
   * v0.16 — the keyframe GATE as a JSON object (`mode` / `maxKeyframes` /
   * `overlapThreshold` / `maxKeyframeIntervalMs` / `flow`).  Partial; `flow` is
   * deep-merged.  v0.24 — the anti-blur controls moved to {@link blur}. */
  frameSelection?: PanoramaPropOverrides['frameSelection'];
  /**
   * v0.24 — **anti-blur** controls in one group: `sharpnessWindow` (pick-
   * sharpest-of-K) + exposure cap + motion gate + sharpness floor + hi-fps
   * format.  Deep-merged over the SDK defaults (all ON).  Set a knob to 0 /
   * false (or `sharpnessWindow: 1`) to disable it. */
  blur?: PanoramaPropOverrides['blur'];
  /**
   * v0.24 — **perf** (stitch-speed) levers in one group: `seamFinderType`
   * (default 'voronoi'), `rangeMatcherWidth` (3), `numThreads` (0 = multi),
   * `adaptiveStitchMode` ('measured') + its `adaptiveMinOutputMP` /
   * `adaptiveSlowStitchMsPerFrame`.  Wins over `stitcher`. */
  perf?: PanoramaPropOverrides['perf'];

  // ── Inscribed-rect crop (v0.15) ───────────────────────────────────
  /**
   * Crop strategy for the stitched panorama. `false` (default) keeps the
   * bounding-rect of non-black pixels, which preserves all stitched
   * content but may leave black corners. `true` crops to the maximum
   * axis-aligned rectangle inscribed in the coverage mask — clean edges,
   * no black corners (slightly more CPU at finalize) — but it can shrink
   * the output substantially on lopsided / ultra-wide masks, which is why
   * it's opt-in.
   *
   * Implemented as a start-time stitcher config (like the other
   * stitcher settings), so this value is read once at mount to seed the
   * initial setting; the in-app settings modal can override it at
   * runtime. It changes image geometry (the crop), not encoding.
   *
   * Since the default is `false`, only pass this prop to opt in:
   * @example
   * // Crop to a clean inscribed rectangle (no black corners):
   * <Camera maxInscribedRectCrop={true} />
   */
  maxInscribedRectCrop?: boolean;

  // ── UI knobs ──────────────────────────────────────────────────────
  /**
   * Default `true`. Set `false` to disable single-TAP photo capture
   * entirely (`handleTap` no-ops, same as `shutterDisabled`) and hide the
   * native-0.5× external-camera fallback (`offerNativeUW`) — that
   * fallback captures ONE still via the OS camera, the same shape of
   * action this flag disables.
   *
   * PANO-ONLY RECIPE: `enablePhotoMode={false}` with `enablePanoramaMode`
   * left at its default `true` is already a pano-only `<Camera>` — tap is
   * disabled, hold-to-pan still fires a capture. No separate flag needed.
   * Lens switching (the 0.5×/1× chip) is unaffected either way — it
   * selects which device the eventual hold-to-pan uses, it does not
   * itself capture.
   */
  enablePhotoMode?: boolean;
  enablePanoramaMode?: boolean;
  /**
   * Hide the built-in shutter + AR-toggle so a HOST can render its own capture
   * controls and drive capture through the imperative handle
   * ({@link CameraHandle.takePhoto} / {@link CameraHandle.startPanorama} /
   * {@link CameraHandle.stopPanorama}). The lens chip is KEPT — it is a lens
   * selector, not a capture control, and the whole point is that the library
   * still owns lens selection. Default `false` (built-in shutter shown, every
   * existing consumer unchanged).
   */
  hideBuiltInShutter?: boolean;
  /**
   * When a device offers only ONE usable lens (no in-app ultra-wide and no
   * native-0.5× fallback on offer), render NOTHING instead of a static "1×"
   * label — there is nothing to switch, so the chip is noise. Default `false`
   * keeps the "1×" label for back-compat.
   */
  hideLensChipWhenSingle?: boolean;
  /**
   * Lift the bottom control cluster (lens chip + built-in shutter, if shown) by
   * this many px, so a host chrome docked below the preview (e.g. a mode
   * switcher) doesn't overlap it. Default `0`. Layout-only; no behaviour change.
   */
  bottomBarOffset?: number;
  showSettingsButton?: boolean;
  /**
   * v0.13.2 — which capture sources the host allows (default `'both'`).
   * Constrains both the runtime AR toggle and `defaultCaptureSource`:
   *   - `'both'`  : AR + non-AR; the AR toggle is shown so the user can
   *     switch at runtime.
   *   - `'ar'`    : AR only.  AR toggle hidden (nothing to toggle); the
   *     0.5× lens chooser is also hidden (ARKit/ARCore can't use the
   *     ultra-wide), so the camera stays on the AR-capable 1× lens.
   *   - `'non-ar'`: non-AR only.  AR toggle hidden.
   * When set to a single source, that source wins regardless of
   * `defaultCaptureSource`.
   */
  captureSources?: CaptureSourcesMode;
  style?: StyleProp<ViewStyle>;

  /**
   * Which stitcher engine the HOLD gesture drives.
   *
   *  - `'keyframe'` (default) — collects accepted keyframe JPEGs during the
   *    hold-pan-release capture and runs the stitch once at finalize.
   *  - `'sweep'` — the slit-scan engine. NOT in this package yet: native
   *    refuses it with `engine-unavailable`, surfaced as `ENGINE_UNAVAILABLE`.
   *    It is a named value rather than an omission so that asking for it gets
   *    you a clear refusal instead of "no such engine".
   *  - `'batch-keyframe'` — DEPRECATED synonym for `'keyframe'`, kept because
   *    it is what shipped. Identical behaviour; prefer `'keyframe'`.
   *
   * ⚠ `'keyframe'` IS SENT ON THE WIRE AS `'batch-keyframe'` (see the single
   * bag-build site in `startCapture`). That is deliberate: every binary ever
   * shipped understands `'batch-keyframe'`, so the default path stays
   * byte-identical against all of them and `'sweep'` is the ONLY new string an
   * older parser can ever see.
   *
   * The archived live engines (hybrid / slit-scan / firstwins — see `archive/`)
   * are not accepted: native answers `engine-unknown`.
   */
  engine?: 'keyframe' | 'sweep' | 'batch-keyframe';

  /**
   * Optional destination directory for captures.  When set, the lib
   * lands tap-photos at `${outputDir}/photo-${ts}.jpg` and panoramas
   * at `${outputDir}/panorama-${ts}.jpg` and the returned uri points
   * at the persisted file (vs. vision-camera's tmp dir, which is
   * what you get when this prop is omitted).
   *
   * The host is solely responsible for:
   *   - Choosing a writable directory (the lib does NOT pick this for
   *     you on either platform — particularly relevant on Android,
   *     where scoped-storage rules differ between app-private storage
   *     and user-visible Documents/Pictures dirs).
   *   - Ensuring the directory exists.  The lib will create it if it
   *     doesn't, but only inside paths the OS lets it write to.
   *   - Making the path user-visible if that matters (`UIFileSharingEnabled`
   *     on iOS for `FileSystem.documentDirectory`; MediaStore /
   *     `Documents/...` on Android — see your platform's docs).
   *
   * On disk failure the capture promise rejects via `onError` with
   * `CameraError('OUTPUT_WRITE_FAILED', ...)`.  No silent fallback to
   * tmp — that hides bugs.
   *
   * Requires `expo-file-system` (declared as an OPTIONAL peer dep;
   * only needed when this prop is set).
   *
   * Format: bare path or `file://` URI.  Both accepted.
   */
  outputDir?: string;

  /**
   * Disable the shutter — taps + holds are ignored and the button paints in
   * its disabled visual.  The host drives this for capture-gating use cases:
   * e.g. a document scanner that only allows capture once the document fills
   * the framing guide, or a fixture flow that has reached its max photo count.
   * Independent of the SDK's own stitching-in-progress disable.  Default
   * `false`.
   */
  shutterDisabled?: boolean;

  // ── Callbacks ─────────────────────────────────────────────────────
  /**
   * Configuration for `engine="sweep"`, ignored by every other engine.
   *
   * ⚠ ONE BAG RATHER THAN ~20 LOOSE PROPS, and the reason is that they are
   * not camera props. `rectify`, `gainMatch`, `attitudeMagFree`,
   * `poseSource`, `jogGuard` and the rest configure a slit-scan ENGINE; they
   * have no meaning for a keyframe panorama or a photo, and putting them on
   * `CameraProps` would grow the component's public surface by a third with
   * fields that are undefined in every other mode.
   */
  sweep?: SweepOptions;

  onCapture?: (result: CameraCaptureResult) => void;
  onCaptureSourceChange?: (source: CaptureSource) => void;
  onLensChange?: (lens: CameraLens) => void;
  onFramesDropped?: (info: FramesDroppedInfo) => void;
  onError?: (err: CameraError) => void;

  /**
   * v0.12.0 — fires when the SDK auto-abandons an in-progress
   * capture without producing output.  `reason` is a string union
   * so future reasons (network loss, low memory, etc.) can be added
   * without breaking the callback signature.
   *
   * Currently the only reason in v0.12 is `'orientation-drift'`:
   * the user rotated the device between Mode A (landscape + vertical
   * pan) and Mode B (portrait + horizontal pan) mid-capture.  The
   * engine docstring at `incremental.ts:373-403` is explicit that
   * cross-mode capture is "best-effort, not supported," so the SDK
   * decisively cancels the capture (`incremental.cancel()`) and
   * surfaces `OrientationDriftModal` to explain what happened.
   *
   * v0.16 adds `'lateral-drift'`: the user moved the phone perpendicular to
   * the pan arrow before enough frames were captured to stitch.  Rather than
   * finalize into a misleading "need more images" error, the SDK abandons the
   * capture and surfaces the `LateralMotionModal` with "follow the arrow"
   * copy.  (A lateral drift AFTER enough frames still finalizes what was
   * captured and fires `onCapture` with a `LATERAL_DRIFT_FINALIZE` warning.)
   *
   * Hosts use this callback to clean up their own state (e.g., reset
   * a wizard step, log telemetry, surface their own retry UX in
   * addition to the SDK's built-in modal).  No `onCapture` will fire
   * for an abandoned capture.
   */
  onCaptureAbandoned?: (reason: 'orientation-drift' | 'lateral-drift') => void;

  /**
   * v0.13.0 — flash (torch) state.  Controlled-or-uncontrolled.
   *
   *   - **Uncontrolled** (omit `flash`): `<Camera>` owns the flash
   *     state internally.  Tapping the built-in flash button toggles
   *     it on/off.  `onFlashChange` (if supplied) fires for telemetry.
   *   - **Controlled** (supply `flash`): the parent owns the state.
   *     The built-in button still renders and fires `onFlashChange`
   *     on press, but it's a no-op unless the parent updates `flash`
   *     in response.
   *
   * Both shapes coexist with the v0.13 "flash button is on by default"
   * built-in (see the bottom-left bar slot in the JSX).  Hosts that
   * want their own flash chrome can opt out via `showFlashButton={false}`
   * and drive the underlying torch by controlling `flash` directly.
   *
   * ## AR-mode behaviour
   *
   * In AR mode (`defaultCaptureSource="ar"` or runtime-toggled),
   * ARKit / ARCore own the `AVCaptureDevice` and don't expose the
   * torch through vision-camera's pipeline.  The built-in flash
   * button renders as visibly disabled (a11y label "Flash unavailable
   * in AR mode") and `flash` is forced to `'off'` regardless of
   * controlled/uncontrolled state.  Hosts that need flash should
   * toggle to non-AR before enabling.
   */
  flash?: 'on' | 'off';

  /**
   * v0.13.0 — fires when the user taps the built-in flash button.
   * In uncontrolled mode, the internal state has already flipped
   * (single render delay).  In controlled mode, the parent must
   * update the `flash` prop in response or the visual toggle is
   * a no-op.  Useful in either mode for telemetry.
   */
  onFlashChange?: (next: 'on' | 'off') => void;

  /**
   * v0.13.0 — show the built-in flash button in the bottom-left
   * slot.  Defaults to `true`.  Hosts that render their own flash
   * chrome (and drive the underlying torch via the controlled
   * `flash` prop) can opt out by setting this to `false`.
   */
  showFlashButton?: boolean;

  /**
   * v0.13.0 — built-in CaptureHeader title.  When set, `<Camera>`
   * renders a top-of-screen header showing this title (centred)
   * with an optional back affordance + guidance subtitle + the
   * existing settings gear absorbed into the header's right side.
   *
   * When `headerTitle` is undefined the header is not rendered
   * (matches pre-v0.13 behaviour: top of preview is bare except
   * for the standalone settings gear gated on `showSettingsButton`).
   *
   * Combine with `onHeaderBack`, `headerBackLabel`, `headerGuidance`,
   * and `headerColors` to customise the rest of the header.  Hosts
   * that need richer header chrome can omit `headerTitle` and
   * compose their own `<CaptureHeader>` above `<Camera>`.
   */
  headerTitle?: string;

  /**
   * v0.13.0 — header back-button callback.  When supplied (and
   * `headerTitle` is set), the header renders a back affordance
   * on the left.  Omitted ⇒ no back button (the title stays
   * centred).
   */
  onHeaderBack?: () => void;

  /**
   * v0.13.0 — header back-button label.  Defaults to "‹ Back".
   * No effect unless `headerTitle` and `onHeaderBack` are both set.
   */
  headerBackLabel?: string;

  /**
   * v0.13.0 — optional second-line subtitle shown below the
   * header title.  E.g. "Photograph the promotional cola end cap."
   * Renders nothing when undefined.  No effect unless `headerTitle`
   * is set.
   */
  headerGuidance?: string;

  /**
   * v0.13.0 — colour overrides for the built-in header.  Defaults
   * are white-on-black to stay legible over the camera preview.
   * No effect unless `headerTitle` is set.
   */
  headerColors?: CaptureHeaderProps['colors'];

  /**
   * v0.13.0 — when provided (even as `[]`), `<Camera>` renders a
   * built-in `CaptureThumbnailStrip` above the bottom controls
   * showing the host's capture history.  Each item is a plain
   * `{ id, uri, width?, height? }` object; the strip handles
   * aspect-ratio rendering, tap-to-preview, and the count line.
   *
   * Omit (`undefined`) to skip the strip entirely.  Hosts using
   * the strip independently (e.g. on a non-camera screen) can keep
   * importing `CaptureThumbnailStrip` directly from the library —
   * the prop here is the convenience wiring for in-`<Camera>` use.
   *
   * Captures emitted by `<Camera>`'s `onCapture` are NOT added to
   * this array automatically — the host owns the canonical list
   * (typically persisted to its own DB) and updates the prop in
   * response.  This matches the SDK's "Camera owns runtime state,
   * host persists" pattern.
   */
  thumbnails?: CaptureThumbnailItem[];

  /**
   * v0.13.0 — minimum-photos hint for the count line.  Renders
   * "n / minPhotos min" with the success colour when reached,
   * warning colour otherwise.
   */
  thumbnailsMin?: number;

  /**
   * v0.13.0 — maximum-photos hint for the count line.  Renders
   * "· maxPhotos max" suffix.  No enforcement — the host decides
   * what to do at the cap.
   */
  thumbnailsMax?: number;

  /**
   * v0.13.0 — tap handler for thumbnails.  When set, replaces the
   * strip's built-in tap-to-preview modal; the host shows its own
   * preview UI (e.g. with delete / recapture buttons gated on
   * sync state).  Omit to use the built-in preview.
   */
  onThumbnailPress?: (item: CaptureThumbnailItem) => void;

  /**
   * v0.13.0 — when set, `<Camera>` renders a built-in `CapturePreview`
   * modal as `visible`.  Use this for post-stitch confirmation:
   * after `onCapture` emits, the host stores the result and sets
   * `capturePreview` to the new image, with `capturePreviewActions`
   * = `[Discard, Save]` (or similar).  Setting `undefined` hides
   * the modal.
   *
   * Hosts using the modal for thumbnail tap-to-preview can leave
   * this undefined and let the built-in strip's preview handle
   * that case.
   */
  capturePreview?: {
    imageUri: string;
    imageWidth?: number;
    imageHeight?: number;
    title?: string;
  };

  /**
   * v0.13.0 — action buttons rendered along the bottom of the
   * `CapturePreview` modal.  Empty array (or undefined) renders
   * no buttons, only the close affordance.
   */
  capturePreviewActions?: CapturePreviewAction[];

  /**
   * v0.13.0 — fires when the user dismisses the `capturePreview`
   * modal (tap close, backdrop tap, hardware back on Android).
   * The host is expected to clear the `capturePreview` prop in
   * response.
   */
  onCapturePreviewClose?: () => void;

  /**
   * Optional host-supplied vision-camera frame processor.
   *
   * ## When to set this prop
   *
   * v0.8.0+ canonical answer: use the lib's own `useFrameProcessor`
   * hook, NOT `react-native-vision-camera`'s.  The lib's hook:
   *
   *   - **AR mode**: auto-registers the worklet in the native
   *     `__stitcherProxy` registry; the AR session's per-frame
   *     dispatch fans out to it alongside the lib's first-party
   *     stitching.  No prop wiring needed — just mount the hook
   *     anywhere in the tree.
   *   - **Non-AR mode**: returns a vc processor object that this
   *     prop accepts.  Wiring it through enables the host's
   *     worklet to fire on vc's Frame Processor runtime.
   *
   * ```tsx
   * import { Camera, useFrameProcessor, type CameraFrame }
   *   from 'react-native-image-stitcher';
   *
   * function MyScreen() {
   *   const fp = useFrameProcessor((frame: CameraFrame) => {
   *     'worklet';
   *     // ...
   *   }, []);
   *   return <Camera frameProcessor={fp} ... />;
   * }
   * ```
   *
   * ## Non-AR mode composition (v0.11.0+)
   *
   * vision-camera's `<Camera>` accepts ONLY ONE frame processor.
   * The lib's internal `useFrameProcessorDriver` produces the
   * processor that drives first-party panorama stitching in non-AR
   * mode.  If you supply your own via this prop, the lib's
   * default processor is REPLACED — but as of v0.11.0 you can
   * COMPOSE first-party stitching back into your worklet body
   * using `useStitcherWorklet`:
   *
   * ```tsx
   * import {
   *   Camera, useFrameProcessor, useStitcherWorklet,
   *   type CameraFrame,
   * } from 'react-native-image-stitcher';
   *
   * function MyScreen() {
   *   const stitcher = useStitcherWorklet();
   *   const fp = useFrameProcessor((frame: CameraFrame) => {
   *     'worklet';
   *     hostPreLogic(frame);
   *     stitcher.call(frame);   // ← first-party stitching
   *     hostPostLogic(frame);
   *   }, [stitcher.call]);
   *   return <Camera frameProcessor={fp} ... />;
   * }
   * ```
   *
   * Hosts that DON'T call `useStitcherWorklet` from their worklet
   * body replace first-party stitching for non-AR captures (a
   * one-shot console.info documents this when the prop is first
   * supplied).  AR mode is unaffected either way — the AR-mode
   * dispatch path (v0.8.0 Phase 4b.i / 4b.iii) natively fans out
   * to both the lib's first-party stitching AND every registered
   * host worklet on every frame, with per-worklet failure
   * isolation.
   *
   * ## AR mode behaviour
   *
   * In AR mode (`defaultCaptureSource="ar"` or runtime-toggled),
   * vc's `<Camera>` isn't mounted; this prop has no effect.
   * Host worklets registered via the lib's `useFrameProcessor`
   * fire automatically through the AR-session dispatch path
   * (iOS Phase 4b.i / Android Phase 4b.iii).
   *
   * ## Backwards compatibility
   *
   * The pre-v0.8.0 behaviour (warn + ignore) is preserved when the
   * supplied processor is recognisably from
   * `react-native-vision-camera`'s `useFrameProcessor` directly
   * (no `__stitcherFrame` marker).  Hosts should migrate to the
   * lib's `useFrameProcessor` to benefit from AR-mode dispatch.
   *
   * (v0.5 had a `legacyDriver` escape hatch that routed back to
   * `useIncrementalJSDriver`.  That hook + prop were removed in
   * v0.6 per the deprecation timeline announced in the v0.5.0
   * CHANGELOG.)
   */
  frameProcessor?: ReadonlyFrameProcessor | DrawableFrameProcessor;

  /**
   * AR-mode host worklet, invoked once per ARKit / ARCore frame
   * ALONGSIDE the lib's first-party stitching (composition, not
   * replacement).  Receives a `CameraFrame` tagged `source: 'ar'`
   * with world-space `pose` + `arTrackingState`.  Only fires in AR
   * capture (`captureSource === 'ar'`); the non-AR equivalent is
   * `frameProcessor` above (the two modes use different runtimes and
   * frame shapes).  Must be a `'worklet'`-prefixed function; if the
   * native install is unavailable it silently never fires.
   */
  arFrameProcessor?: CameraFrameProcessor;

  /**
   * Opt in to per-frame AR depth on the `arFrameProcessor` frame
   * (`CameraFrame.arDepth`).  Default `false` — depth is the costliest
   * field (a per-frame buffer copy), so it's off until you need it.
   */
  enableDepth?: boolean;
  /**
   * Opt in to high-resolution photo capture (iOS 16+, AR capture path).
   * When `true`, the AR session runs on the smallest video format that
   * supports `captureHighResolutionFrame`, so `takePhoto()` returns a true
   * full-res still (for document OCR / detail capture).  Default `false` —
   * the live stream stays as small as possible; the panorama-stitch path is
   * unaffected (its keyframes are downscaled to a fixed budget regardless).
   * No-op on Android.
   */
  highResCapture?: boolean;
  /**
   * PANORAMA-QUALITY keyframes (Android; see `ARCameraView` prop of the
   * same name): larger ARCore CPU-image config (long-edge ≤ 1920) + a
   * lifted keyframe encode budget (640 → 1280) so stitches stop being
   * assembled from 0.3 MP tiles on devices whose sole 4:3 config is tiny
   * (e.g. Galaxy A35).  Costs stitch memory (~4× pixels per keyframe).
   * Default `false`.  No-op on iOS (native-res keyframes already) and on
   * older binaries.
   */
  keyframeQualityCapture?: boolean;
  /**
   * Native-camera 0.5× fallback (Android; default OFF).  A list of device
   * MODEL identifiers (matched case-insensitively as a PREFIX of
   * `Platform.constants.Model`, so `"SM-A346"` covers every A34 SKU) or
   * `"manufacturer:<brand>"` wildcards, on which the ultra-wide is a
   * SYSTEM-ONLY camera unreachable by any third-party app (proven on the
   * Galaxy A34).  On a matching device that ALSO has no in-app 0.5×
   * (`has0_5x=false`), the lens chip renders a "0.5×⤢" pill that fires
   * {@link onRequestNativeUltraWide} instead of a dead 1× label — the host
   * then hands off to the OS camera.  Absent/empty → feature OFF, no change.
   * iOS ignores this (its virtual devices already reach the ultra-wide).
   */
  nativeUltraWideModels?: readonly string[];
  /**
   * Fired when the operator taps the "0.5×⤢" native-ultra-wide fallback pill
   * (see {@link nativeUltraWideModels}).  The host launches the OS camera
   * (e.g. `react-native-image-picker` `launchCamera`) and routes the
   * returned photo into its own capture flow marked as external provenance —
   * the library does NOT launch anything or deliver the external photo.
   */
  onRequestNativeUltraWide?: () => void;
  /**
   * iOS, NON-AR photo path — save each tap photo's AVDepthData as a
   * `<photo>.depth.bin` sidecar (float32 metres row-major + JSON header
   * with dims/intrinsics) and return its path as `depthPath` on the
   * photo {@link CameraCaptureResult}.  Enables vision-camera depth
   * delivery, biases the format pick toward `supportsDepthCapture`
   * formats, and extracts the depth BEFORE the orientation re-encode
   * strips it.  Produces stereo disparity-derived depth on dual-camera
   * iPhones and absolute LiDAR-backed depth on Pro models; requires the
   * mounted device to be depth-capable (the lens-driven multicam
   * selection qualifies — a plain single wide-angle does not).  Silently
   * yields no sidecar on Android, in AR capture, and on depth-less
   * hardware.  Distinct from `enableDepth` above, which is the AR
   * frame-processor's per-frame depth.  Default `false` (depth delivery
   * adds per-shot latency).
   */
  captureDepthData?: boolean;
  /**
   * Opt in to per-frame AR anchors (`CameraFrame.arAnchors` — detected
   * planes / images).  Default `false`.
   */
  enableAnchors?: boolean;
  /**
   * Opt in to scene-reconstruction mesh anchors (`type: 'mesh'` in
   * `arAnchors`, with `meshGeometry`).  Default `false`.  iOS enables
   * ARKit `sceneReconstruction` (LiDAR); Android reconstructs a rough
   * mesh from the depth map.  Expensive — only on when needed.
   */
  enableMesh?: boolean;
  /**
   * Opt in to the SLAM feature-point cloud in AR plugin contexts.  Default
   * `false`.  Available on ALL AR-capable devices — no LiDAR required.
   * Consumed natively by AR plugins only; does not appear in
   * {@link ARFrameMeta} or `CameraFrame`.
   *
   *   - iOS   → ARKit `rawFeaturePoints` in `RNISARFrameContext.featurePoints`
   *             as world-space `[simd_float3]` (bare `x, y, z`).
   *   - Android → ARCore `Frame.acquirePointCloud()` in
   *             `ARFrameContext.featurePoints` as a flat stride-4
   *             `[x, y, z, confidence]` world-space `FloatArray` (the extra
   *             per-point confidence lets native plugins filter ARCore's
   *             sparser cloud).
   */
  enableFeaturePoints?: boolean;
  /**
   * Which plane orientations to surface in `CameraFrame.arAnchors`
   * (requires `enableAnchors`; AR capture only).  Default `'vertical'`
   * — the orientation the plane-projected stitch path has always used.
   * `'horizontal'` surfaces floors / tables; `'both'` surfaces every
   * detected plane.  See `ARCameraView` for the per-platform details.
   */
  planeDetection?: 'vertical' | 'horizontal' | 'both';

  /**
   * v0.18.0 — LIGHT per-frame AR metadata callback, invoked on the JS
   * MAIN thread (NOT a worklet).  Only fires in AR capture
   * (`captureSource === 'ar'`).  Receives an {@link ARFrameMeta} carrying
   * pose, tracking state, intrinsics, and (when the matching `enable*`
   * prop is on) depth dimensions, anchors, and mesh counts.
   *
   * This is the recommended way to read AR metadata: it sidesteps the
   * worklet path entirely (the `arFrameProcessor` worklet can only safely
   * surface a worklets-core shared value, because capturing a host
   * callback crashes the worklet closure-wrap).  Native builds the meta
   * and emits a device event; `<Camera>` threads the handler through to
   * `<ARCameraView>`, which subscribes and invokes it on the main thread.
   */
  onArFrame?: (meta: ARFrameMeta) => void;

  /**
   * v0.18.0 — throttle interval (ms) for {@link onArFrame}.  Default `100`
   * (≈ 10 Hz).  No effect unless `onArFrame` is provided.
   */
  arFrameMetaInterval?: number;

  /**
   * v0.19.0 — ASYNCHRONOUS AR-plugin result callback (the AR plugin
   * framework), invoked on the JS MAIN thread (NOT a worklet).  Only fires in
   * AR capture (`captureSource === 'ar'`).  Host-registered native plugins
   * (see `RNISARPluginRegistry` / `RNSARPluginRegistry`) that offload heavy
   * per-frame work to their own queue push results via
   * `registry.emit(name, result)`; `<Camera>` threads this handler to
   * `<ARCameraView>`, which subscribes to the `RNImageStitcherARPluginResult`
   * device event and invokes it with `{ plugin, result }`.
   *
   * SYNCHRONOUS plugin results (computed inline on the AR thread) instead ride
   * the throttled {@link onArFrame} event on {@link ARFrameMeta.plugins}.
   * Use `onArFrame` for the in-band sync channel and `onArPluginResult` for
   * the out-of-band async channel — a host can wire either or both.
   *
   * The SDK ships ONLY the generic plugin framework; there are no built-in
   * plugins, so this never fires unless the host registers native plugins.
   */
  onArPluginResult?: (e: ARPluginResult) => void;

  /**
   * v0.20.0 — AR OVERLAY / ANNOTATION renderer.  A declarative array of 2D
   * shapes drawn ON TOP of the AR camera preview, each anchored to WORLD
   * positions and REPROJECTED to screen on every AR frame from the current
   * camera pose + intrinsics (smooth display-rate tracking, no 3D engine).
   * Only meaningful in AR capture (`captureSource === 'ar'`); `<Camera>`
   * threads this straight through to the underlying `<ARCameraView>`.
   *
   * State-driven: pass a React-state array and update it as your world points
   * change (e.g. from {@link CameraProps.onArFrame} plane anchors).  The set is
   * diffed against the current overlays BY `id`.  For zero-render-latency
   * mutations use the imperative ref methods on the `<Camera>` handle instead
   * ({@link CameraHandle}: `setOverlays` / `addOverlay` / `updateOverlay` /
   * `removeOverlay` / `clearOverlays`) — both paths funnel through the same
   * native channel.  JS-set overlays merge on the native side with overlays a
   * registered AR plugin placed directly (namespaced so neither clobbers the
   * other).  See {@link AROverlay} for the shape.
   */
  overlays?: AROverlay[];

  // ── Panorama GUIDANCE (feature/pano-ux-guidance) ──────────────────
  /**
   * Which device holds the non-AR panorama capture accepts.
   *
   *   - `'vertical'` (DEFAULT) — LANDSCAPE-only, top→bottom pan.  Starting a
   *     panorama in portrait is BLOCKED behind the rotate-to-landscape
   *     prompt (item 2); the capture starts the instant they rotate to
   *     landscape (either way up).
   *   - `'horizontal'` — PORTRAIT-only, left→right pan.  Starting in
   *     landscape is BLOCKED behind the rotate-to-portrait prompt; capture
   *     starts on rotating to portrait (either way up).
   *   - `'both'` — landscape OR portrait; the rotate gate never fires, the
   *     user captures in whichever hold they're already in.
   *
   * **BREAKING (since the previous release accepted both holds ungated):**
   * the default is now `'vertical'`.  Hosts that want left→right (portrait)
   * panoramas use `panMode='horizontal'` (portrait-only) or `'both'`.  See
   * CHANGELOG.
   */
  panMode?: PanMode;

  /**
   * Master switch for the in-capture pan-guidance surfaces (rotate
   * prompt, pan how-to overlay, too-fast pill, blinking countdown).
   * Default `true`.  Set `false` to suppress all of them (the lateral-
   * drift FINALIZE behaviour and the crop preview are governed by their
   * own props, not this flag).
   */
  panGuidance?: boolean;

  /**
   * Optional hard recording-TIME ceiling for a non-AR panorama, in
   * milliseconds, used as a SAFETY cap alongside the primary keyframe-count
   * auto-stop.  The default capture now finalizes when the configured
   * keyframe count is reached (see the frame counter HUD), so this is `0`
   * (disabled) by default.  Set it to a positive value to ALSO cap the
   * recording by wall-clock time; when > 0 a blinking countdown (item 5)
   * shows the seconds remaining and the capture auto-finalizes at 0.
   *
   * v0.16 — default changed `9000` → `0` (time cap is now opt-in; the
   * keyframe-count stop is the default UX).
   */
  maxPanDurationMs?: number;

  /**
   * Gyro rate (rad/s) above which the pan is flagged "moving too fast"
   * (item 4 — the transient amber pill).  Optional; forwards to
   * `usePanMotion`'s `warnMaxRadPerSec` (default 1.0 rad/s there).
   */
  panTooFastThreshold?: number;

  /**
   * Cross-pan (lateral) drift budget in CENTIMETRES (item 6).  Once the
   * operator's integrated sideways translation exceeds this for the
   * hook's grace window, the capture FINALIZES what was captured and a
   * one-button popup explains why.  Default `5`.  `0` disables the
   * lateral-drift stop entirely.
   */
  lateralBudgetCm?: number;

  /**
   * Show the draggable-quad crop editor after a panorama finalizes, BEFORE
   * emitting it via `onCapture`.  Default `false`.  When `true`, the user
   * drags 4 corners over the stitched result; confirming crops in place
   * (perspective-rectify when the quad isn't axis-aligned), "Use original"
   * emits the un-cropped panorama, "Retake" discards it.  Takes precedence
   * over {@link showPreview}.
   */
  rectCrop?: boolean;

  /**
   * Show a plain review screen after a panorama finalizes — the stitched
   * image with [Retake] / [Confirm] and NO crop box.  Default `false`.
   * Ignored when {@link rectCrop} is on (the crop editor is itself the
   * preview).  With both off, `onCapture` fires immediately with no UI.
   */
  showPreview?: boolean;

  /**
   * Copy overrides for every guidance string (rotate prompt, pan hint,
   * too-fast warning, lateral-stop popup, crop buttons).  Partial —
   * unspecified keys fall back to {@link DEFAULT_GUIDANCE_COPY}.  Hosts
   * localise or re-word the whole guidance surface in one place here.
   */
  guidanceCopy?: Partial<GuidanceCopy>;
}


/**
 * v0.20.0 — imperative handle exposed via the `<Camera>` ref.
 *
 * Currently scoped to the AR-overlay methods ({@link AROverlayMethods}:
 * `setOverlays` / `addOverlay` / `updateOverlay` / `removeOverlay` /
 * `clearOverlays`), which forward to the underlying `<ARCameraView>`'s overlay
 * channel when AR mode is mounted.  They are no-ops while the camera is in
 * non-AR mode (no `<ARCameraView>` is mounted, and overlays only render over
 * the AR preview) — use the declarative {@link CameraProps.overlays} prop for
 * a set that survives AR↔non-AR transitions, since it re-applies automatically
 * whenever `<ARCameraView>` (re)mounts.
 *
 * The shape is identical to {@link ARCameraViewHandle}'s overlay subset so a
 * host can use either component with the same overlay code.  Panorama capture
 * remains driven by the built-in shutter; single-photo capture can also be
 * triggered imperatively via {@link CameraHandle.takePhoto} (added 0.20.5 for
 * hands-free / auto-capture flows like the document scanner).
 */
export interface CameraHandle extends AROverlayMethods {
  /**
   * Imperatively fire a single-photo capture — identical to the user tapping
   * the shutter (same AR / non-AR routing, same `onCapture` callback, same
   * output path rules).  Respects `enablePhotoMode` and `shutterDisabled`: a
   * no-op while photo mode is off or the shutter is gated, so callers can fire
   * it freely and let the gate decide.  Resolves once the capture attempt
   * settles (success or handled error reported through `onCapture`).
   */
  takePhoto(): Promise<void>;
  /**
   * Imperatively START a panorama sweep — identical to the user beginning a
   * hold on the shutter (the incremental stitcher starts ingesting AR frames).
   * A no-op unless `enablePanoramaMode` is on and the shutter is not gated
   * (`shutterDisabled`), and while a capture is already recording/stitching —
   * the same gates `takePhoto` respects. Pair with {@link stopPanorama}.
   * Added for hosts that render their OWN shutter (see `hideBuiltInShutter`)
   * and drive capture through this handle instead of the built-in button.
   */
  startPanorama(): void;
  /**
   * Imperatively STOP an in-flight panorama sweep — identical to releasing the
   * shutter hold: finalize the stitch and emit `onCapture`. Idempotent (a safe
   * no-op when nothing is recording). Resolves once the stop is dispatched.
   */
  stopPanorama(): Promise<void>;
}


// ─── Sub-components ─────────────────────────────────────────────────

/**
 * Lens chip — toggles between 1× and 0.5× physical lenses.
 *
 * Placement: bottom-center of the preview, just above the shutter
 * button.  Standard iOS-camera-app convention so users know where to
 * look.  Two pills side-by-side, the active one filled.
 */
export interface LensChipProps {
  lens: CameraLens;
  onChange: (lens: CameraLens) => void;
  has0_5x: boolean;
  /**
   * v0.13.1 — counter-rotation applied to the label TEXT (not the pill
   * container) so the "0.5×"/"1×" glyphs read upright when the device
   * is held landscape under a portrait-locked host, while the pill
   * itself stays fixed in the layout.  `{}` (no-op) in the upright cases.
   */
  contentRotation?: { transform?: ViewStyle['transform'] };
  /**
   * Native-camera 0.5× fallback (see `nativeUltraWide.ts`): when the device
   * has NO in-app ultra-wide (`has0_5x=false`) but is a known system-only-UW
   * model, render a "0.5× ⤢" pill that hands off to the OS camera instead of
   * the plain "1×".  Only consulted when `!has0_5x`.
   */
  offerNativeUltraWide?: boolean;
  onNativeUltraWide?: () => void;
  /** When the device offers only ONE lens (no 0.5× and no native fallback),
   *  render null instead of the static "1×" label. Default false. */
  hideWhenSingle?: boolean;
  /**
   * The device's REAL ultra-wide factor, for this chip's label only — `0.6`
   * on a Galaxy S24 Ultra, `0.5` on a typical iPhone.  The `CameraLens`
   * identifier stays `'0.5x'` regardless (it is also the stitcher's
   * warper-tree zoom signal).  Null/absent ⇒ keep the historical `0.5×`
   * text rather than invent a number.
   */
  ultraWideFactor?: number | null;
}
export function LensChip({
  lens,
  onChange,
  has0_5x,
  contentRotation,
  offerNativeUltraWide = false,
  onNativeUltraWide,
  hideWhenSingle = false,
  ultraWideFactor,
}: LensChipProps): React.JSX.Element | null {
  // Label only — never the `CameraLens` value. `0.6` → "0.6×"; the fallback
  // keeps every device that reports nothing on the text it has always shown.
  const uwLabel =
    ultraWideFactor != null && Number.isFinite(ultraWideFactor)
      ? `${ultraWideFactor}×`
      : '0.5×';
  if (!has0_5x) {
    if (offerNativeUltraWide && onNativeUltraWide) {
      // The ultra-wide is unreachable in-app on this device — offer a
      // hand-off to the OS camera. The ⤢ glyph signals it leaves the app.
      return (
        <View style={lensChipStyles.container}>
          <Pressable
            onPress={onNativeUltraWide}
            accessibilityRole="button"
            accessibilityLabel="0.5x ultra-wide via phone camera"
            style={[lensChipStyles.pill, lensChipStyles.nativeUwPill]}
          >
            <Text style={[lensChipStyles.label, contentRotation]}>0.5×⤢</Text>
          </Pressable>
        </View>
      );
    }
    // Only one usable lens. Nothing to switch — hide entirely, or keep the
    // legacy static "1×" label.
    if (hideWhenSingle) return null;
    return (
      <View style={[lensChipStyles.container, lensChipStyles.singleLens]}>
        <Text style={[lensChipStyles.label, contentRotation]}>1×</Text>
      </View>
    );
  }
  return (
    <View style={lensChipStyles.container}>
      <Pressable
        onPress={() => onChange('0.5x')}
        accessibilityRole="button"
        accessibilityLabel={`${uwLabel.replace('×', 'x')} ultra-wide lens`}
        accessibilityState={{ selected: lens === '0.5x' }}
        style={[
          lensChipStyles.pill,
          lens === '0.5x' && lensChipStyles.pillActive,
        ]}
      >
        <Text
          style={[
            lensChipStyles.label,
            lens === '0.5x' && lensChipStyles.labelActive,
            contentRotation,
          ]}
        >
          {uwLabel}
        </Text>
      </Pressable>
      <Pressable
        onPress={() => onChange('1x')}
        accessibilityRole="button"
        accessibilityLabel="1x wide-angle lens"
        accessibilityState={{ selected: lens === '1x' }}
        style={[
          lensChipStyles.pill,
          lens === '1x' && lensChipStyles.pillActive,
        ]}
      >
        <Text
          style={[
            lensChipStyles.label,
            lens === '1x' && lensChipStyles.labelActive,
            contentRotation,
          ]}
        >
          1×
        </Text>
      </Pressable>
    </View>
  );
}

const lensChipStyles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderRadius: 18,
    padding: 3,
    alignSelf: 'center',
  },
  singleLens: {
    paddingHorizontal: 12,
  },
  pill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    minWidth: 44,
    alignItems: 'center',
  },
  pillActive: {
    backgroundColor: '#ffd34d',
  },
  nativeUwPill: {
    // Distinct from the normal lens pill — a subtle outline so the ⤢
    // hand-off reads as "opens your phone camera", not a live lens toggle.
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.6)',
  },
  label: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '600',
  },
  labelActive: {
    color: '#1a1a1a',
  },
});


/**
 * AR toggle — switch between AR-backed and non-AR capture.
 * Conditional on `lens === '1x'`; hidden when the user is on 0.5×
 * (which forces non-AR).
 */
export interface ARToggleProps {
  arEnabled: boolean;
  onToggle: () => void;
  /**
   * v0.13.1 — counter-rotation applied to the "AR" label TEXT (not the
   * pill container) so the glyph reads upright when the device is held
   * landscape under a portrait-locked host, while the pill stays fixed.
   * `{}` no-op in the upright cases.
   */
  contentRotation?: { transform?: ViewStyle['transform'] };
}
export function ARToggle({ arEnabled, onToggle, contentRotation }: ARToggleProps): React.JSX.Element {
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="switch"
      accessibilityLabel={`AR mode ${arEnabled ? 'on' : 'off'}`}
      accessibilityState={{ checked: arEnabled }}
      style={[arToggleStyles.container, arEnabled && arToggleStyles.containerOn]}
    >
      <Text
        style={[
          arToggleStyles.label,
          arEnabled && arToggleStyles.labelOn,
          contentRotation,
        ]}
      >
        AR
      </Text>
    </Pressable>
  );
}

const arToggleStyles = StyleSheet.create({
  container: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: 'rgba(0,0,0,0.45)',
    minWidth: 56,
    alignItems: 'center',
  },
  containerOn: {
    backgroundColor: '#ffd34d',
  },
  label: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 1,
  },
  labelOn: {
    color: '#1a1a1a',
  },
});


/**
 * Settings button — opens the internal PanoramaSettingsModal.  Gated
 * on the `showSettingsButton` prop (default false) so public
 * consumers don't see it.
 */
interface SettingsButtonProps {
  onPress: () => void;
  topInset: number;
}
function SettingsButton({ onPress, topInset }: SettingsButtonProps): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Open camera settings"
      style={[settingsButtonStyles.container, { top: topInset + 8 }]}
    >
      <Text style={settingsButtonStyles.glyph}>⚙</Text>
    </Pressable>
  );
}

const settingsButtonStyles = StyleSheet.create({
  container: {
    position: 'absolute',
    right: 14,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyph: {
    color: '#ffffff',
    fontSize: 22,
    lineHeight: 24,
  },
});


// ─── Main component ─────────────────────────────────────────────────

/**
 * Effective capture source derived from arPreference + lens + the
 * device's AR support.  On a device without ARKit / ARCore, AR mode
 * is unavailable regardless of the user's preference, and the AR
 * toggle is hidden in the UI (see the bottom-bar JSX).  Selecting
 * the 0.5x lens also forces non-AR because ARKit / ARCore sessions
 * don't expose the ultra-wide camera.
 */
function deriveEffectiveCaptureSource(
  arPreference: boolean,
  lens: CameraLens,
  isARSupportedOnDevice: boolean,
): CaptureSource {
  if (!isARSupportedOnDevice) return 'non-ar';
  if (lens === '0.5x') return 'non-ar';
  return arPreference ? 'ar' : 'non-ar';
}


/**
 * Pluck the props that influence the initial PanoramaSettings tree.
 * Kept inline (vs. a wide structural type) so future Camera prop
 * additions don't accidentally widen the settings-translation
 * surface — the pure builder in `./buildPanoramaInitialSettings.ts`
 * has the canonical interface; this just forwards the relevant
 * fields.
 *
 * The `default*ResolMP` props on `CameraProps` are documented as
 * forward-looking no-ops; the new PanoramaSettings tree has no home
 * for them yet (the v0.3 audit found cv::Stitcher's resol knobs
 * aren't reached by either platform's bridge).  They're accepted on
 * the prop interface for API stability and ignored here.
 */
function extractPanoramaOverrides(props: CameraProps): PanoramaPropOverrides {
  return {
    defaultCaptureSource: props.defaultCaptureSource,
    defaultStitchMode: props.defaultStitchMode,
    defaultBlender: props.defaultBlender,
    defaultWarper: props.defaultWarper,
    defaultFlowNoveltyPercentile: props.defaultFlowNoveltyPercentile,
    defaultFlowEvalEveryNFrames: props.defaultFlowEvalEveryNFrames,
    defaultFlowMaxTranslationCm: props.defaultFlowMaxTranslationCm,
    defaultKeyframeMaxCount: props.defaultKeyframeMaxCount,
    defaultKeyframeOverlapThreshold: props.defaultKeyframeOverlapThreshold,
    defaultMaxKeyframeIntervalMs: props.defaultMaxKeyframeIntervalMs,
    // v0.16 — JSON-object form (wins over the flat default* props above).
    stitcher: props.stitcher,
    frameSelection: props.frameSelection,
    // v0.24 — the grouped blur / perf props.
    blur: props.blur,
    perf: props.perf,
    // Item 2 — the interactive crop editor OWNS cropping, so when it's on we
    // force the native auto-crop OFF: the editor needs the full un-cropped
    // panorama (black borders included) so the user can drag the inscribed-
    // rect seed outward to keep more content.  Letting the native auto-crop
    // pre-trim would leave nothing to adjust.
    maxInscribedRectCrop: props.rectCrop
      ? false
      : props.maxInscribedRectCrop,
  };
}


// `toFileUri` (used to be an inline `toFileUri` here) lives in
// `../utils/paths.ts` so every call-site in this lib funnels through
// one canonical implementation.  Native bridges return paths in
// mixed shapes — useCapture.compressedUri already has `file://`,
// while ARCameraView.takePhoto + IncrementalStitcher.finalize +
// `batchKeyframeThumbnailPath` events all return bare paths — and we
// normalise to the URI form on the way out to JS consumers (Android
// `<Image>` requires the scheme; iOS is lenient).


/**
 * The public `<Camera>` component.
 *
 * v0.20.0 — now a `forwardRef`.  The ref exposes {@link CameraHandle} (the AR
 * overlay methods); existing callers that don't pass a ref are unaffected
 * (`forwardRef` makes the ref optional).
 */
export const Camera = forwardRef<CameraHandle, CameraProps>(function Camera(
  props: CameraProps,
  ref,
): React.JSX.Element {
  const {
    defaultCaptureSource = 'non-ar',
    defaultLens = '1x',
    captureSources = 'both',
    enablePhotoMode = true,
    enablePanoramaMode = true,
    hideBuiltInShutter = false,
    hideLensChipWhenSingle = false,
    bottomBarOffset = 0,
    showSettingsButton = false,
    style,
    outputDir,
    shutterDisabled = false,
    onCapture,
    onCaptureSourceChange,
    onLensChange,
    onFramesDropped,
    onError,
    onCaptureAbandoned,
    flash: controlledFlash,
    onFlashChange,
    showFlashButton = true,
    headerTitle,
    onHeaderBack,
    headerBackLabel,
    headerGuidance,
    headerColors,
    thumbnails,
    thumbnailsMin,
    thumbnailsMax,
    onThumbnailPress,
    capturePreview,
    capturePreviewActions,
    onCapturePreviewClose,
    frameProcessor: hostFrameProcessor,
    arFrameProcessor,
    enableDepth,
    highResCapture,
    keyframeQualityCapture,
    nativeUltraWideModels,
    onRequestNativeUltraWide,
    captureDepthData,
    enableAnchors,
    enableMesh,
    enableFeaturePoints,
    planeDetection,
    onArFrame,
    arFrameMetaInterval,
    onArPluginResult,
    overlays,
    engine = 'keyframe',
    sweep,
    // ── Panorama GUIDANCE (feature/pano-ux-guidance) ──────────────
    panMode = 'vertical',
    panGuidance = true,
    maxPanDurationMs = 0,
    panTooFastThreshold,
    lateralBudgetCm = 4,
    rectCrop = false,
    showPreview = false,
    guidanceCopy,
  } = props;

  // Derived guidance state.  The landscape-only gate decision itself is
  // computed inline at the call sites via `shouldGateForPanMode(panMode,
  // deviceOrientation)` (the rotate gate + resume effect), so there's no
  // standalone `modeAOnly` flag to keep in sync.  `guidanceCopyResolved`
  // merges the host override onto the defaults once per `guidanceCopy`
  // identity.
  const guidanceCopyResolved = useMemo(
    () => mergeGuidanceCopy(guidanceCopy),
    [guidanceCopy],
  );

  // v0.13.2 — capture-source constraint (default 'both').  Derives which
  // sources are permitted; `captureSources` overrides any conflicting
  // `defaultCaptureSource`.  Used to constrain the initial AR preference
  // and to hide the AR toggle / lens chooser below.
  const arAllowed = captureSources !== 'non-ar';
  const nonArAllowed = captureSources !== 'ar';
  const arOnly = captureSources === 'ar';

  const insets = useSafeAreaInsets();
  // v0.12.0 — JS-layout orientation independent of device-physical.
  // `useWindowDimensions().width > height` tells us if the OS
  // rotated the framebuffer (only happens for non-locked hosts in
  // device-landscape).  Combined with `useDeviceOrientation()` to
  // pick the JS edge corresponding to the home-indicator side of
  // the device — see `homeIndicatorEdge` below.
  const jsWindow = useWindowDimensions();
  // Measured size of our own root view.  `useWindowDimensions` freezes
  // at its open-time value inside an iOS RN `Modal` (the modal rotates
  // but no dimension-change event fires), so modal hosts would pin the
  // controls to the wrong edge after rotation.  `onLayout` on our root
  // view is reliable in every container; the window dims are only the
  // pre-first-layout fallback.
  const [measuredRoot, setMeasuredRoot] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const jsLandscape = measuredRoot
    ? measuredRoot.width > measuredRoot.height
    : jsWindow.width > jsWindow.height;

  // ── State ───────────────────────────────────────────────────────
  // v0.13.2 — initial AR preference honours `defaultCaptureSource` but
  // is clamped to the `captureSources` constraint: 'ar' forces on,
  // 'non-ar' forces off, 'both' uses the default.
  // ── THE SWEEP'S RESULT SCREEN ───────────────────────────────────
  //
  // ⚠ THE SURFACE DOES NOT SHOW ITS OWN RESULT, AND THAT IS ITS CONTRACT.
  // `onComplete` fires and the HOST puts the review up. That much is
  // unchanged, and it is why a finished sweep once went straight back to a
  // live viewfinder ("after sweep capture, image is not shown in preview").
  //
  // ⚠ WHAT CHANGED: the review is no longer a SWEEP-ONLY screen. This file
  // used to argue that the sweep should review in its own surface "because
  // the thing to review is a pack, not a single JPEG" — and the operator's
  // verdict on that was "the preview modal is not the same as the one for
  // photo and pano; why the fuck would you diverge?". They were right: a
  // pack is reviewed by looking at its canvas, which is an image, and the
  // parts that genuinely needed a pack view were evidence that belongs in
  // the pack. The sweep now defers into `cropPending` and is reviewed by
  // the same `<RectCropPreview>` a panorama uses.
  // ⚠ `sweepReview` IS GONE. The sweep used to review in its own screen,
  // which is what made its result UI diverge from photo and pano. It now
  // defers into `cropPending` like a panorama and is reviewed by the same
  // `<RectCropPreview>`, so there is one review and one result channel.

  // ── THE SWEEP → VISION-CAMERA HANDOFF ───────────────────────────
  //
  // ⚠ TWO CAMERA STACKS, ONE BACK CAMERA, AND THE RELEASE IS ASYNC.
  // The sweep does not ingest vision-camera frames: its recorder OWNS a
  // Camera2 session (it forces the size and fps and asserts the AE/AWB lock)
  // or rides an ARCore shared session. So switching engines is a handoff
  // between two owners of one device, not a change of stitcher.
  //
  // The release does not complete on unmount. Measured on a Galaxy A35, the
  // recorder's own retry says so out loud: "the idle viewfinder opened on
  // attempt 2 after 479ms — the previous camera owner was still letting go."
  // vision-camera does NOT retry: it opens once and reports
  // `system/max-cameras-in-use`, which is exactly what an operator saw after
  // switching sweep → keyframe.
  //
  // So the gate below holds BOTH cameras unmounted for a settle window after
  // the sweep goes away — the same placeholder the AR/non-AR swap already
  // uses for the same Camera2-in-use reason. The other direction needs
  // nothing: the recorder already retries into a camera vision-camera is
  // still releasing.
  const [sweepHandoffPending, setSweepHandoffPending] = useState(false);
  // ── OWNERSHIP IS LATCHED FOR THE LIFE OF A SWEEP ────────────────────
  // `hostOwnsSweepCamera` is computed from live state — the plugin handle
  // can still resolve, AR support can still settle. Recomputing it under a
  // RUNNING sweep would change who owns the camera mid-capture: native
  // latches the arm from the options bag at `start` and never re-reads it,
  // so a flip to `true` mounts `<CameraView>` against a device the
  // recorder's own Camera2 client is already holding, and a flip to `false`
  // unmounts the feed the engine is being fed from. Neither is recoverable
  // mid-sweep. Null while idle; the value taken at start while sweeping.
  const [sweepOwnershipLatch, setSweepOwnershipLatch] =
    useState<boolean | null>(null);
  const prevEngineRef = useRef(engine);
  useEffect(() => {
    const was = prevEngineRef.current;
    prevEngineRef.current = engine;
    if (was !== 'sweep' || engine === 'sweep') return undefined;
    setSweepHandoffPending(true);
    const t = setTimeout(
      () => { setSweepHandoffPending(false); },
      SWEEP_CAMERA_RELEASE_SETTLE_MS,
    );
    return () => { clearTimeout(t); };
  }, [engine]);

  const [arPreference, setArPreference] = useState(
    !arAllowed ? false : !nonArAllowed ? true : defaultCaptureSource === 'ar',
  );
  // v0.13.2 — `arOnly` forces the 1× lens (the ultra-wide isn't usable
  // in AR), and the lens chooser is hidden in that mode.
  const [lens, setLens] = useState<CameraLens>(arOnly ? '1x' : defaultLens);
  // v0.13.0 — flash state.  Controlled by `controlledFlash` when the
  // host supplies the `flash` prop; otherwise owned internally and
  // toggled by the built-in flash button.  `effectiveFlash` below
  // also forces 'off' in AR mode (ARKit / ARCore own the device's
  // torch and don't surface it through vision-camera's pipeline).
  const [internalFlash, setInternalFlash] = useState<'on' | 'off'>('off');
  const [settings, setSettings] = useState<PanoramaSettings>(() =>
    buildPanoramaInitialSettings(
      extractPanoramaOverrides(props),
      isLowMemDevice(),
    ),
  );
  const [settingsModalVisible, setSettingsModalVisible] = useState(false);
  const [statusPhase, setStatusPhase] = useState<CaptureStatusPhase>('idle');
  /**
   * A SWEEP IS IN FLIGHT — both pills are inert while it is.
   *
   * ⚠ THE SURFACE'S OWN HANDLERS HAD THIS GUARD AND IT DID NOT TRAVEL WITH
   * THE PILLS. `onLensPill` and `onArToggle` both open
   * `if (phaseRef.current !== 'idle') return;` under the note "Both taps are
   * inert off-idle: the arm is latched for the sweep and the lens cannot
   * change under one." `<Camera>`'s replacements were a bare `setLens` and a
   * bare `setArPreference`.
   *
   * The reachable case is ordinary: the operator is mid-hold, panning with
   * one hand, and his other thumb lands on the top-right pill. The arm is
   * latched for the running sweep (`runningArm`), so the capture is not
   * corrupted — but the chrome repaints to a state the sweep is not in, and
   * a lens write mid-sweep is a request the recorder cannot honour.
   */
  const [sweepRunning, setSweepRunning] = useState(false);
  /**
   * A CAPTURE IS IN FLIGHT ON **EITHER** ENGINE.
   *
   * ⚠ `statusPhase` NEVER REACHES 'recording' ON A SWEEP, and that single
   * fact switched off Pano's whole guard-rail suite. `startPanorama` routes
   * to `sweepRef.current?.holdStart?.()` and RETURNS before
   * `handleHoldStartRef` (:2144) — correctly, because the keyframe hold must
   * not run against a surface that is not mounted — so every guard gated on
   * `statusPhase === 'recording'` is dead on the sweep: the orientation-drift
   * detector, the REC banner, the wall-clock countdown, the auto-finalize and
   * `onCaptureAbandoned`.
   *
   * Those are not individually missing features. They are one early return.
   *
   * ⚠ AND THIS IS DELIBERATELY *NOT* `setStatusPhase('recording')` ON A
   * SWEEP. Ten sites read that value and they are two different kinds:
   * GUARD RAILS, which belong on both engines, and KEYFRAME MACHINERY —
   * `incremental.start()`'s re-entry guard (:2830), the keyframe-count
   * auto-finalize (:3222), the k/n counter — which would then run against an
   * engine that has no keyframes. Widening the phase would start the
   * keyframe engine's internals during a sweep. So the phase stays honest
   * and the GUARDS get their own predicate.
   */
  /**
   * THE SWEEP IS PAST THE OPERATOR'S CONTROL — `finish()` owns it now.
   *
   * ⚠ `sweepRunning` IS `phase !== 'idle'`, WHICH INCLUDES 'finishing'. That
   * phase spans the native `stop()` and the pack write, seconds on a device,
   * and the operator has already released the shutter and is looking at the
   * result. A guard still armed there fires on a capture that is COMPLETE:
   * turning the phone back to portrait after a landscape sweep abandoned a
   * finished panorama, and because `onCaptureAbandoned` fires a line after
   * the handle call, the host was told the capture was abandoned AND then
   * handed that same capture.
   *
   * The keyframe predicate this replaced never had the problem —
   * `statusPhase` goes 'recording' → 'stitching', and the guards only read
   * 'recording'.
   *
   * ⚠ REPORTED SEPARATELY RATHER THAN NARROWING `onSweepingChange`. That
   * boolean is deliberately every non-idle phase, and three other things
   * read it: the ownership latch, the frame-processor worklet gate, and the
   * HOST's own mode-switch guard, whose whole point is that a mode switch
   * during the finalize window unmounts the surface mid-call. Narrowing it
   * would re-open exactly that. `onControlsState.busy` is already
   * `phase === 'finishing'`, so the guards get their own signal and the
   * emitted value is untouched.
   */
  const [sweepFinalizing, setSweepFinalizing] = useState(false);

  const captureRecording =
    statusPhase === 'recording' || (sweepRunning && !sweepFinalizing);


  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(
    null,
  );
  // perf-3a change 4: `incrementalState` useState + its subscription were
  // removed — Camera renders from `incremental.state` (coalesced by the
  // useIncrementalStitcher hook). See the thumbnail effect below.
  // ── Panorama GUIDANCE state (feature/pano-ux-guidance) ──────────
  // Item 1/2 — a hold that was BLOCKED on the rotate-to-landscape gate.
  // Latches when the user holds the shutter in portrait under Mode A;
  // an effect below resumes the capture the instant they rotate.
  const [pendingPanStart, setPendingPanStart] = useState(false);
  // Item 6 — the latched lateral-drift popup (capture already finalized
  // by the time it shows).
  const [lateralStopVisible, setLateralStopVisible] = useState(false);
  // Item 6 — true when the lateral stop happened with too few frames to
  // stitch (the user veered off almost immediately): the popup then shows
  // the "follow the arrow" copy and the capture is abandoned, not finalized.
  const [lateralWrongDirection, setLateralWrongDirection] = useState(false);
  // Item 3 — the brief pan how-to overlay shown at the start of a
  // recording, auto-dismissed after a timeout.
  const [howToVisible, setHowToVisible] = useState(false);
  // Item 5 — a ~250 ms ticking clock that drives the displayed countdown
  // seconds while recording (the authoritative auto-stop is a setTimeout,
  // not this tick).
  const [nowTick, setNowTick] = useState(() => Date.now());
  // Item 7 — a finalized panorama awaiting the user's crop decision.
  // Non-null mounts the RectCropPreview; `captureResultObj` is the exact
  // CameraCaptureResult we'd otherwise have emitted, stashed so cancel /
  // crop-confirm can emit it (possibly with cropped dims) afterwards.
  const [cropPending, setCropPending] = useState<{
    uri: string;
    width: number;
    height: number;
    /**
     * ⚠ WIDENED FROM `PanoramaCaptureResult` so the SWEEP can use this same
     * review. `onCapture` already carries the sweep as a third member
     * (`type: 'panoplus'`), so no new result channel was needed — only this
     * type and the emit order. `buildStitchDebugInfo` takes a structural,
     * all-optional shape, so the `__DEV__` debug line still compiles and
     * simply prints fewer fields for a sweep.
     */
    captureResultObj: Extract<CameraCaptureResult, { ok: true }>;
    /**
     * Item 2 — max-inscribed-rect seed for the crop quad (image-pixel
     * coords).  Undefined → RectCropPreview falls back to its 8 %-inset
     * default seed (native module absent / inscribed-rect call failed).
     */
    initialRect?: ImageRect;
    /** Warnings to surface as a banner on the crop editor. */
    warnings: CaptureWarning[];
  } | null>(null);

  // 2026-05-22 (audit F9 + F3) — debug stitch-stats toast.  Hook
  // exposes an imperative API; we fire `showResult(finalizeResult)`
  // on every successful finalize when settings.debug is on (gated
  // a few hundred lines below in handleHoldEnd's onCapture branch).
  const stitchToast = useStitchStatsToast();
  // perf-3a change 4 — keyframe thumbnails are owned by the hook now
  // (incremental.keyframeThumbnails); see keyframeThumbnailUris below.
  const [cameraTransitioning, setCameraTransitioning] = useState(false);

  // ARKit / ARCore device-support probe.  `isAvailable` is `false`
  // initially and becomes `true` after the native isSupported() check
  // resolves (~50-200 ms after mount).  Devices without ARKit / ARCore
  // (older iPhones, ARCore-less Androids, simulators) stay `false`
  // forever, which forces non-AR capture everywhere and hides the
  // AR toggle in the bottom bar (see JSX below).
  const { isAvailable: isARSupportedOnDevice, supportProbed: isARSupportProbed } =
    useARSession();

  const effectiveCaptureSource = deriveEffectiveCaptureSource(
    arPreference,
    lens,
    isARSupportedOnDevice,
  );
  const isAR = effectiveCaptureSource === 'ar';
  const isNonAR = !isAR;

  // v0.14.2 — camera-handoff race guard.  While AR is the preferred
  // source but the one-shot `isSupported()` probe hasn't resolved yet,
  // `deriveEffectiveCaptureSource` returns 'non-ar' (because
  // `isARSupportedOnDevice` is still false), which would mount
  // <CameraView> and let vision-camera's AVCaptureSession grab the
  // camera.  The switch to AR ~200-500ms later then fails with ARKit
  // "Required sensor failed" (ARKit and AVCaptureSession can't share the
  // camera), leaving a blank AR preview — intermittent and timing-
  // dependent.  Defer the initial mount until the probe settles: while
  // pending we render the "Switching camera…" placeholder instead of any
  // camera, so vision-camera never contends for the device when AR is the
  // intent.  Conditions mirror deriveEffectiveCaptureSource's own
  // non-support gates (arPreference, lens) so this is true in exactly the
  // cases that resolve to AR once support is confirmed.
  const arSupportPending =
    arPreference && lens !== '0.5x' && !isARSupportProbed;
  const deviceOrientation = useDeviceOrientation();

  // ── Panorama GUIDANCE — shared motion signals (item 3/4/6) ──────
  // One gyro + one accelerometer subscription, live only while a non-AR
  // capture is recording.  Feeds the too-fast pill (`panSpeedBucket`)
  // and the lateral-drift FINALIZE (`lateralExceeded`).  `panTooFast-
  // Threshold` (if set) tunes the 'warn'→'bad' boundary; `lateralBudget-
  // Cm` tunes the drift latch (0 disables the latch in the hook).
  const panMotion = usePanMotion({
    // ⚠ EITHER ENGINE. This hook IS the sideways-drift measurement — it
    // integrates cross-pan translation and latches `lateralExceeded` past
    // `lateralBudgetCm`. On the sweep it was never active, so the operator's
    // first named guard ("I want the sideways drift to be measured and
    // stopped") had nothing measuring it at all.
    //
    // ⚠ AND ON EVERY ARM. `isNonAR` was here from the hook's first commit
    // (edd443d), carried over from its sibling `useIMUTranslationGate` one
    // screen up — where the term is CORRECT, because in AR the native side
    // really does use pose-derived translation and really does ignore the
    // JS integrator. This hook has no such substitute: nothing in this
    // library consumes ARKit translation for a lateral budget, no ARKit pose
    // stream reaches JS at all, and so on the AR arm the sideways-drift
    // guard was not "owned by the session" — it was absent.
    //
    // That is the operator's own configuration. The iOS sweep runs ARKit
    // (`poseSource` defaults to 'ar'), and the production host mounts
    // `defaultCaptureSource="ar"`, so the guard he named first — "I want the
    // sideways drift to be measured and stopped" — measured nothing at all
    // on the platform he tests on, on EITHER engine.
    //
    // Nothing in this hook depends on the camera: it is one gyroscope and
    // one accelerometer, and both run whether or not ARKit holds the
    // session. Widening it also arms the too-fast cue on the AR arm, which
    // is the same cue pano draws on its non-AR arm from the same gyro —
    // this was off in AR for the same reason, and by the same accident.
    active: captureRecording,
    warnMaxRadPerSec: panTooFastThreshold,
    lateralBudgetCm,
  });

  // v0.13.1 — counter-rotation for control CONTENT (AR toggle, lens
  // pill, flash icon, thumbnails) so their labels read upright relative
  // to gravity when the device is held landscape under a PORTRAIT-LOCKED
  // host (the recommended config — the JS framebuffer stays portrait, so
  // without this the labels render at 90°).  Returns `{}` (no-op) in the
  // common upright cases, including non-locked hosts where the OS already
  // rotated the framebuffer.  See `useContentRotation` truth table.
  // Computed from `contentRotationDeg` directly (not the hook) so it
  // uses the measured `jsLandscape` above — the hook's own context
  // fallback only reaches descendants of the provider below.
  const contentRotationDegree = contentRotationDeg(jsLandscape, deviceOrientation);
  const contentRotation: ContentRotationStyle =
    contentRotationDegree === 0
      ? {}
      : { transform: [{ rotate: `${contentRotationDegree}deg` }] };

  // ── Camera handoff gate ─────────────────────────────────────────
  //
  // The placeholder rendered while the underlying camera identity
  // changes (AR toggle, lens swap).  Without this gap, Android
  // vision-camera v4 races the new session's open against the old
  // session's teardown → "Session has been closed"
  // IllegalStateException OR "Maximum cameras in use"
  // CameraAccessException.
  //
  // CRITICAL: A naive useState + useEffect approach DOESN'T WORK.
  // useEffect runs AFTER the commit phase — so on the render where
  // isAR/lens flips, the effect hasn't yet set the gate flag, the
  // render branch already evaluated `flag ? placeholder : camera`
  // against the STALE flag=false → the new camera mounts in that
  // commit → race → crash.
  //
  // Fix (mirrors AuditCaptureScreen.tsx ~L695-766): track the
  // "last fully settled" identity in refs and compare them
  // SYNCHRONOUSLY during render.  The gate closes on the FIRST
  // render where isAR/lens differs from the settled refs.  The
  // useEffect below does the async work (explicit AR session stop +
  // 250 ms grace) and then updates the refs + clears the flag
  // together to drop the gate.
  const settledIsARRef = useRef(isAR);
  const settledLensRef = useRef(lens);
  const inFlightTransition =
    settledIsARRef.current !== isAR
    || settledLensRef.current !== lens
    || cameraTransitioning;


  // ── v0.13.1 — Android portrait lock ─────────────────────────────
  //
  // Android lets a mounted view force its host Activity's orientation,
  // so `<Camera>` guarantees a portrait capture surface regardless of
  // the host app's manifest (even a landscape/unlocked host gets a
  // portrait camera while `<Camera>` is mounted).  The lock lives on
  // the Activity via the native `RNSARSession` module, so it covers
  // BOTH the AR (ARCore) and non-AR (vision-camera) capture paths.
  //
  // iOS is intentionally NOT locked here: iOS supported orientations
  // are a static Info.plist declaration the host owns, and we want iOS
  // hosts to be able to support landscape/unlocked capture.  Hosts that
  // want a portrait-only iOS app set UISupportedInterfaceOrientations
  // themselves.
  //
  // Empty dep array — lock on mount, restore the host's PRIOR
  // orientation on unmount (the native side captures it).
  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    const arModule = (NativeModules as Record<string, unknown>)
      .RNSARSession as
      | { lockPortrait?: () => void; unlockOrientation?: () => void }
      | undefined;
    arModule?.lockPortrait?.();
    return () => {
      arModule?.unlockOrientation?.();
    };
  }, []);

  // keyframeQualityCapture also drives the ANDROID keyframe ENCODE budget
  // (RNSARSession's holder refcount → YuvImageConverter): in NON-AR mode
  // no ARCameraView is mounted to hold it, yet the non-AR keyframe writes
  // read the same global budget.  Acquire per Camera mount / release on
  // unmount or prop-off — the native refcount makes the double-hold
  // (this + a mounted ARCameraView's own effect) safe, and overlapping
  // Camera swaps can't downgrade a live pan.  iOS / old binaries: no-op.
  useEffect(() => {
    if (keyframeQualityCapture !== true) return undefined;
    const arModule = (NativeModules as Record<string, unknown>)
      .RNSARSession as
      | { setKeyframeQualityCaptureEnabled?: (on: boolean) => void }
      | undefined;
    arModule?.setKeyframeQualityCaptureEnabled?.(true);
    return () => {
      arModule?.setKeyframeQualityCaptureEnabled?.(false);
    };
  }, [keyframeQualityCapture]);

  // ── Notify parent of capture-source changes ─────────────────────
  const lastEmittedSourceRef = useRef<CaptureSource | null>(null);
  useEffect(() => {
    if (lastEmittedSourceRef.current !== effectiveCaptureSource) {
      lastEmittedSourceRef.current = effectiveCaptureSource;
      onCaptureSourceChange?.(effectiveCaptureSource);
    }
  }, [effectiveCaptureSource, onCaptureSourceChange]);

  // ── Capture hooks ───────────────────────────────────────────────
  // v0.13.2 — pass the active `lens` so useCapture uses capability-aware
  // selection (multi-cam zoom-switch where available, standalone-ultra-
  // wide swap otherwise).  Replaces the old per-lens
  // `preferredPhysicalDevice` request that mis-selected on some phones.
  const capture = useCapture({
    cameraPosition: 'back',
    enableQualityChecks: false,
    lens,
    // iOS depth sidecar for non-AR tap photos; the matching <CameraView
    // captureDepthData> below turns on depth delivery + the format bias.
    captureDepthData,
  });

  // ── Lens chip availability ──────────────────────────────────────
  // v0.13.2 — real device capability from `useCapture` (which uses
  // `selectCaptureDevice`).  True only when the device actually exposes
  // an ultra-wide reachable via a multi-cam zoom OR a standalone
  // ultra-wide device; false on wide-only hardware (chip hides).
  const has0_5x = capture.has0_5x;
  // Native-camera 0.5× fallback: only when the host opted in (a non-empty
  // model list) AND this Android device has no in-app 0.5× AND its model
  // matches. `Platform.constants` carries Model/Manufacturer on Android.
  const offerNativeUW = useMemo(() => {
    // Photo-only: the fallback captures ONE external still, so it must not
    // sit where a 0.5× PANORAMA would be expected. A pano-only <Camera>
    // never shows it.
    if (!enablePhotoMode) return false;
    const c = (
      Platform as unknown as {
        constants?: { Model?: string; Manufacturer?: string };
      }
    ).constants;
    return shouldOfferNativeUltraWide({
      hasInAppUltraWide: has0_5x,
      models: nativeUltraWideModels,
      platformOS: Platform.OS,
      deviceModel: c?.Model,
      deviceManufacturer: c?.Manufacturer,
    });
  }, [has0_5x, nativeUltraWideModels, enablePhotoMode]);
  // App foreground state drives the non-AR preview's `isActive` — but ONLY
  // when the native-0.5× fallback is being offered (see `isActive=` below);
  // otherwise `isActive` stays the constant `true` it always was (the shipped
  // capture flow is byte-identical). vision-camera 4.x does NOT observe the
  // host activity lifecycle — its session is driven only by `isActive` — so
  // when the OS camera launched by the fallback comes to the foreground we
  // must proactively release the device and re-acquire on return; relying on
  // CameraX's opportunistic reopen is unreliable on the Samsung OEM devices
  // that are the native-UW target class (a swallowed
  // `camera-has-been-disconnected` → silent black preview).
  //
  // Release ONLY on a true `'background'` — NOT on iOS's transient
  // `'inactive'` (Control Center, the notification shade, a permission/Face-ID
  // prompt, the app-switcher peek): those must NOT cycle the session, or the
  // preview black-flashes mid-capture. The OS-camera hand-off backgrounds our
  // activity, which is exactly `'background'`.
  const [appActive, setAppActive] = useState(
    AppState.currentState !== 'background',
  );
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) =>
      setAppActive(s !== 'background'),
    );
    return () => sub.remove();
  }, []);
  const incremental = useIncrementalStitcher();
  const visionCameraRef = useRef<VisionCamera | null>(null);
  const arViewRef = useRef<ARCameraViewHandle | null>(null);
  // Latest `handleTap` (the shutter handler), kept in a ref so the imperative
  // `takePhoto()` always calls the current closure.  `handleTap` is declared
  // far below (after the refs/state it closes over), so the imperative handle
  // can't reference it directly without a TDZ error — the ref bridges that.
  const handleTapRef = useRef<(() => Promise<void>) | null>(null);
  // Latest hold-start callback, kept in a ref so the imperative `startPanorama`
  // can reach it (handleHoldStart is defined below the handle). Mirrors
  // handleTapRef; handleHoldEndRef (the stop side) already exists further down.
  const handleHoldStartRef = useRef<(() => void) | null>(null);
  /** The sweep surface's shutter handle, when `engine="sweep"`. */
  const sweepRef = useRef<SweepSurfaceHandle | null>(null);
  /** `engine` read from inside the imperative handle, whose deps are `[]` so
   *  it is built once and must not close over a stale prop. */
  const engineRef = useRef(engine);
  engineRef.current = engine;

  // v0.20.0 — AR overlay imperative handle.  `<Camera>` itself renders no
  // overlay layer; the overlay methods forward to the mounted
  // `<ARCameraView>`'s handle (which owns the controller + native dispatch).
  // No-op when AR mode isn't mounted (`arViewRef.current === null`), matching
  // the CameraHandle docstring — the declarative `overlays` prop is the path
  // that survives AR↔non-AR transitions.  The `overlays` prop is also threaded
  // straight to `<ARCameraView>` below, so a host can use either API.
  useImperativeHandle(ref, (): CameraHandle => ({
    setOverlays: (o) => arViewRef.current?.setOverlays(o),
    addOverlay: (o) => arViewRef.current?.addOverlay(o),
    updateOverlay: (id, patch) => arViewRef.current?.updateOverlay(id, patch),
    removeOverlay: (id) => arViewRef.current?.removeOverlay(id),
    clearOverlays: () => arViewRef.current?.clearOverlays(),
    raycast: () => arViewRef.current?.raycast() ?? Promise.resolve(null),
    takePhoto: () => handleTapRef.current?.() ?? Promise.resolve(),
    // ⚠ THE HANDLE IS ENGINE-AWARE. A host that hides the built-in shutter
    // and drives capture itself must reach the SWEEP when that engine is
    // selected; routing to `handleHoldStartRef` would start the keyframe
    // engine's hold against a surface that is not mounted, and nothing would
    // report it — `handleHoldStartRef.current` is simply null in sweep mode,
    // so the press would be silently inert.
    startPanorama: () => {
      if (engineRef.current === 'sweep') { sweepRef.current?.holdStart?.(); return; }
      handleHoldStartRef.current?.();
    },
    stopPanorama: () => {
      if (engineRef.current === 'sweep') {
        sweepRef.current?.holdEnd?.();
        return Promise.resolve();
      }
      handleHoldEndRef.current?.();
      return Promise.resolve();
    },
  }), []);

  // Effect that does the async transition work whenever the settled
  // refs disagree with the current isAR/lens.  Order matters:
  //   1. Set the cameraTransitioning state so the gate stays closed
  //      after the synchronous compare flips back to "settled" once
  //      we update the refs.
  //   2. Explicitly stop the AR session if we were in AR mode — this
  //      releases ARCore's grip on Camera2 BEFORE vision-camera tries
  //      to open it.  Without this on Android the next openCamera()
  //      call hits "Maximum cameras in use".  The promise is ignored
  //      if RNSARSession.stop fails or isn't available.
  //   3. Wait 250 ms (Camera2's HAL onClosed is async; this gives it
  //      time to fully release the handle).
  //   4. Update settled refs + clear cameraTransitioning together so
  //      the gate opens on the same commit.
  useEffect(() => {
    if (settledIsARRef.current === isAR && settledLensRef.current === lens) {
      return undefined;
    }
    setCameraTransitioning(true);
    let cancelled = false;
    const finishTransition = () => {
      if (cancelled) return;
      settledIsARRef.current = isAR;
      settledLensRef.current = lens;
      setCameraTransitioning(false);
    };
    const wasAR = settledIsARRef.current;
    const arModule = (NativeModules as Record<string, unknown>).RNSARSession as
      | { stop?: () => Promise<void> }
      | undefined;
    const stopPromise: Promise<unknown> =
      wasAR && arModule?.stop ? arModule.stop() : Promise.resolve();
    stopPromise
      .catch(() => undefined)
      .then(() => {
        setTimeout(finishTransition, 250);
      });
    return () => { cancelled = true; };
  }, [isAR, lens]);

  // IMU translation gate — only engaged in non-AR mode.  Fires when
  // the operator's lateral hand motion exceeds the budget, telling
  // the C++ engine to force-accept the next frame.  This is what
  // keeps non-AR captures producing keyframes at all (the flow-
  // novelty algorithm alone is too strict in practice).
  //
  // 2026-05-22 (audit F2f) — IMU translation gate.  The gate's own
  // `totalAbsMetres` accumulator (banks each segment's |displacement|
  // at every anchor reset) is the right input for the finalize-time
  // auto-resolver in non-AR mode (where pose-derived translation is
  // 0).  Pre-F2f this was reconstructed from `fires × budget +
  // |residual|` — which undercounted any time a non-IMU accept
  // (flow novelty, force-last) reset the integrator before the
  // budget threshold was reached.
  // The translation budget lives at `frameSelection.flow.maxTranslationCm`
  // in the new hierarchical settings shape.  When `flow` is undefined
  // (the consumer opted out of the flow strategy entirely), the gate
  // stays disabled — same observable behaviour as v0.3's `0` default.
  const flowMaxTranslationCm =
    settings.frameSelection.flow?.maxTranslationCm ?? 0;
  const imuGate = useIMUTranslationGate({
    enabled:
      isNonAR
      && statusPhase === 'recording'
      && flowMaxTranslationCm > 0,
    budgetMeters: Math.max(0.001, flowMaxTranslationCm / 100.0),
    onBudgetExceeded: () => {
      const mod = getIncrementalNativeModule();
      mod?.markNextFrameAsLastKeyframe?.().catch(() => undefined);
    },
  });

  // Frame Processor driver for non-AR captures (iOS + Android).
  // In AR mode the engine consumes frames from the ARSession stream
  // natively, so this hook stays idle.
  //
  // IMPORTANT: start()/stop() are called imperatively from the hold
  // handlers below — NOT from a useEffect driven by statusPhase.  The
  // hook returns a fresh object identity on every render, and during
  // a recording the engine emits IncrementalStateUpdate events that
  // cause re-renders multiple times per second.  An effect with the
  // driver in its deps would teardown + restart on every event,
  // resetting the gyro accumulator (yaw/pitch) to zero each cycle.
  // User-visible symptom: "only the first keyframe is accepted, every
  // subsequent ingest sees pose=(0,0) and is rejected as a duplicate".
  // The imperative pattern (start on hold-start, stop on hold-end)
  // avoids the re-render churn entirely.
  // perf-3a change 2 — pass the eval cadence so the WORKLET decimates
  // (before packNV21), paired with the bridge forcing native cadence to 1
  // for frameProcessor mode (see the incremental.start config below). The
  // effective product cadence is unchanged from today's native-only throttle.
  // S7 — the sweep's own worklet, gated by `setActive` so an idle screen
  // pays no per-frame JNI hop.
  //
  // ⚠ AND GATED ON THE ENGINE, because the hook is called from every mode.
  // It used to acquire unconditionally, and its retry loop had no bound: on
  // any build where `panoplus_sweep_ingest` is not registered — which is
  // every iOS build until that arm exists — photo, scan, doc and keyframe
  // pano each carried a permanent ~62 Hz JS timer polling for a plugin they
  // would never call.
  const sweepDriver = useSweepWorklet(engine === 'sweep');
  const fpDriver = useFrameProcessorDriver({
    evalEveryNFrames:
      settings.frameSelection.flow?.evalEveryNFrames ??
      DEFAULT_FLOW_GATE_SETTINGS.evalEveryNFrames,
  });
  // Safety: stop the driver AND clear the pan-duration auto-finalize
  // timer if the component unmounts mid-recording (item 5 exit path #4).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => { fpDriver.stop(); clearPanTimer(); }, []);

  // ── Panorama GUIDANCE — auto-finalize timer + ref bridges ───────
  // The 9 s pan-duration ceiling (item 5) is an authoritative
  // `setTimeout` (not derived from the cosmetic countdown tick).  Stored
  // in a ref so the start logic can schedule it and ALL four capture-exit
  // paths (manual release, drift cancel, lateral stop, unmount) clear it.
  const panDurationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const clearPanTimer = useCallback(() => {
    if (panDurationTimerRef.current) {
      clearTimeout(panDurationTimerRef.current);
      panDurationTimerRef.current = null;
    }
  }, []);
  // `handleHoldEnd` / `startCapture` are defined further down but are
  // referenced from effects + timers declared above them.  Refs break
  // the declaration-order + circular-useCallback-dep cycle: each is
  // kept current by a commit-phase effect, and callers invoke via the
  // ref (`handleHoldEndRef.current?.()`) — mirroring how the drift
  // effect avoids putting these in its dep array.
  const handleHoldEndRef = useRef<(() => void) | null>(null);
  const startCaptureRef = useRef<(() => void) | null>(null);
  // Synchronous re-entrancy latch for the finalize path: the auto-finalize
  // timer and a manual release can both pass the async statusPhase guard in
  // the same tick before React commits 'stitching'.
  const finalizingRef = useRef(false);
  // Item 6 — set by the lateral-drift effect just before it calls
  // handleHoldEnd, so the finalize knows this stop was a sideways-drift
  // auto-stop and can attach the LATERAL_DRIFT_FINALIZE warning.  Consumed
  // (reset) at the start of handleHoldEnd so it never leaks to the next pan.
  const lateralFinalizeRef = useRef(false);
  // Item 4 — latched true if the pan ever exceeded the recommended pace (the
  // live "too fast" cue fired) during the capture, so the finalize attaches a
  // HIGH_PAN_SPEED warning.  Reset at capture start; consumed at finalize.
  const fastPanRef = useRef(false);

  // ── v0.12.0 — Orientation drift detection + auto-abandon ────────
  //
  // The incremental engine supports both portrait (Mode B, horizontal
  // pan) and landscape (Mode A, vertical pan) capture as first-class,
  // but the docstring at `incremental.ts:373-403` is explicit that
  // mixing them mid-capture is "best-effort, not supported" — the
  // output rotation becomes ambiguous and the stitched panorama is
  // malformed.  v0.12 protects against this by snapshotting the
  // orientation at `start()` and auto-cancelling the capture the
  // instant the user rotates to a different orientation mid-flight.
  //
  // The modal is informational only — by the time it renders, the
  // capture is already stopped.  No Continue/Resume affordance per
  // the engine spec.

  const drift = useOrientationDrift(captureRecording);
  const [driftModalDismissed, setDriftModalDismissed] = useState(false);
  // Reset the modal flags when a new capture STARTS (statusPhase →
  // 'recording'), NOT when one stops.  v0.16 fix: the old "any non-recording
  // state" condition cleared `lateralStopVisible` the instant a lateral stop
  // moved statusPhase out of 'recording' — so the popup was hidden before it
  // could ever show (the user only saw the downstream error).  Clearing on
  // capture START instead lets the lateral / drift popups persist after the
  // stop until the user dismisses them, while still giving the next capture
  // a clean slate.
  useEffect(() => {
    if (captureRecording) {
      setDriftModalDismissed(false);
      setLateralStopVisible(false);
      setLateralWrongDirection(false);
    }
  }, [captureRecording]);

  useEffect(() => {
    if (!drift.drifted || !captureRecording) return;
    // ⚠ THE SWEEP ABANDONS THROUGH ITS OWN HANDLE. `incremental.cancel()`
    // below is the KEYFRAME engine's; calling it for a sweep would cancel an
    // engine that was never started and leave the sweep running. The sweep's
    // `abandon` discards the in-flight capture and reports it — the same
    // shape as this path, through the other engine.
    if (sweepRunning) {
      sweepRef.current?.abandon?.('orientation-drift');
      onCaptureAbandoned?.('orientation-drift');
      return;
    }
    // Auto-abandon the in-flight capture.  Order matches handleHoldEnd's
    // "stitch" path but skips finalize:
    //   1. Stop pumping frames so no new keyframes arrive mid-cancel.
    //   2. Tell the native engine to drop accumulated state
    //      (`incremental.cancel()`).
    //   3. Reset statusPhase back to idle.
    //   4. Notify the host via `onCaptureAbandoned`.
    //
    // Wrapped in an IIFE because useEffect callbacks can't be async
    // directly.  Errors from `incremental.cancel()` are caught + sent
    // through `onError` — abandonment must succeed even if the engine
    // is in a weird state.
    void (async () => {
      // item 5 exit path #2 — kill the pan-duration auto-finalize timer
      // so it can't fire into an already-cancelled capture.
      clearPanTimer();
      fpDriver.stop();
      try {
        await incremental.cancel();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        onError?.(new CameraError(
          'PANORAMA_FINALIZE_FAILED',
          `cancel after orientation drift failed: ${message}`,
          err,
        ));
      } finally {
        setStatusPhase('idle');
        setRecordingStartedAt(null);
        onCaptureAbandoned?.('orientation-drift');
      }
    })();
    // Deps: re-run whenever drift latches OR recording state changes.
    // Other deps are stable refs / setters.
    //
    // ⚠ `captureRecording`, NOT `statusPhase` — this effect GATES on the
    // former and a sweep never moves the latter, so naming `statusPhase`
    // here declared a dependency on a value that is constant for half the
    // cases the effect covers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drift.drifted, captureRecording]);

  // v0.8.0 Phase 5 / v0.11.0 — frameProcessor prop semantics:
  //
  //   - Host supplied? → use host's processor.  The host's worklet
  //     body controls whether first-party stitching also fires:
  //     call `stitcher.call(frame)` (from `useStitcherWorklet`)
  //     inside the body to compose; omit to replace.  One-shot
  //     console.info documents the choice so the host can spot a
  //     missing `useStitcherWorklet` call before they go hunting
  //     for "why is non-AR panorama capture not producing output".
  //     AR-mode capture is unaffected either way — the AR-session
  //     dispatch path fans out to BOTH first-party stitching AND
  //     every host worklet independently.
  //
  //   - No host processor? → use `fpDriver.frameProcessor` which is
  //     the lib's internal worklet driving first-party stitching
  //     via `useFrameProcessorDriver`.  Default behaviour for the
  //     common "I just want panorama capture" case.
  const hostFrameProcessorAcceptedWarnedRef = useRef(false);
  if (
    hostFrameProcessor != null
    && !hostFrameProcessorAcceptedWarnedRef.current
  ) {
    hostFrameProcessorAcceptedWarnedRef.current = true;
    // eslint-disable-next-line no-console
    console.info(
      '[react-native-image-stitcher] Host frameProcessor supplied — '
      + 'non-AR mode will run YOUR composed worklet.  If you want '
      + 'first-party panorama stitching alongside your own logic, '
      + 'call `useStitcherWorklet()` and invoke `stitcher.call(frame)` '
      + 'from your worklet body (see `<Camera>` `frameProcessor` '
      + 'JSDoc for the composition pattern).  AR-mode capture is '
      + 'unaffected (AR-session dispatch fans out to both '
      + 'first-party and host worklets independently).  '
      + '\u26a0 AND WITH engine="sweep" IT TURNS THE VISION-CAMERA ARM OFF '
      + 'ENTIRELY: the sweep is fed by the first-party worklet, and a host '
      + 'processor replaces it, so `<Camera>` declines host camera ownership '
      + 'and the sweep falls back to opening its own camera session. Your '
      + 'worklet then does not run on the sweep screen at all. \u26a0 AND '
      + 'COMPOSITION DOES NOT HELP HERE: the term is PRESENCE, not whether '
      + 'you call us, so `useSweepWorklet()` inside your own worklet still '
      + 'turns the arm off. A host frameProcessor and engine="sweep" are '
      + 'mutually exclusive today; use one or the other on that screen.',
    );
  }
  // The Frame Processor worklet bound to vision-camera's Camera.
  // Host's wins if supplied; lib's internal driver otherwise.
  // S7 — a THREE-way, and the sweep is not the keyframe driver. Its worklet
  // passes nothing but the frame: attitude and intrinsics are resolved
  // natively, and a second pose synthesised here would silently disagree
  // with the one the engine actually uses.
  const sweepCall = sweepDriver.call;
  const sweepFrameProcessor = useFrameProcessor((frame) => {
    'worklet';
    (sweepCall as unknown as (f: unknown) => void)(frame);
  }, [sweepCall]);
  const effectiveFrameProcessor = hostFrameProcessor
    ?? (engine === 'sweep' ? sweepFrameProcessor : fpDriver.frameProcessor);

  // ── Keyframe thumbnails ──────────────────────────────────────────────
  // perf-3a change 4: Camera.tsx no longer keeps its OWN
  // `subscribeIncrementalState` + `incrementalState` useState (the SECOND
  // per-event re-render of this large tree). It renders from the hook's
  // coalesced `incremental.state`, and the keyframe thumbnails are now
  // OWNED BY THE HOOK too (`incremental.keyframeThumbnails`) — accumulated
  // per RAW accept event with a functional updater so two accepts in one
  // React batch both survive (the earlier draft accumulated off the
  // coalesced state and dropped one — 3a review finding). Normalise to
  // `file://` here for the Android <Image> band overlay.
  const keyframeThumbnailUris = useMemo(
    () => incremental.keyframeThumbnails.map(toFileUri),
    [incremental.keyframeThumbnails],
  );
  // 2026-05-23 (race fix) — Previously this useEffect cleared
  // `batchKeyframeThumbnails` + `incrementalState` when statusPhase
  // transitioned to 'recording'.  But handleHoldStart is async
  // (`await incremental.start(...)`), and on Android the ARSession
  // was already alive on the GL thread — it could emit an ACCEPT
  // event during the await window, BEFORE the effect ran.  Order
  // observed in logcat:
  //   1. setStatusPhase('recording') queued
  //   2. await incremental.start() yields
  //   3. ARCore frame → ingest → JS [state] emit
  //   4. setBatchKeyframeThumbnails((prev=[]) => [keyframe-0.jpg])
  //   5. React commits statusPhase change → THIS effect ran
  //   6. setBatchKeyframeThumbnails([])  ← WIPED frame 0!
  //   7. Frame 1 arrives → updater sees prev=[] → adds only frame 1
  //   ⇒ final array missing keyframe-0.jpg
  // The reset is now done synchronously at the top of
  // handleHoldStart, before any await, so the GL thread can't race
  // ahead.  This effect is intentionally removed.

  // 2026-05-22 (audit F2f) — every accepted keyframe is a fresh
  // anchor for the IMU translation gate, regardless of which
  // mechanism qualified the frame (flow novelty, plane-overlap,
  // angular fallback, IMU-budget force-accept, force-last).  Reset
  // the gate's per-segment integrator on every acceptedCount
  // increment so the operator sees `imuΔ` reset to 0 in the debug
  // overlay after every accept — consistent UX regardless of WHY
  // the gate took the frame.  Pre-F2f only the IMU-budget path
  // reset the integrator; flow accepts left `posX` ticking up
  // forever, which surprised the user.
  //
  // The gate's `totalAbsMetres` cumulative accumulator banks the
  // |segment displacement| before zeroing, so finalize-time
  // translation magnitude is preserved across non-IMU accepts.
  const lastAcceptedCountRef = useRef(0);
  useEffect(() => {
    const accepted = incremental.state?.acceptedCount ?? 0;
    if (accepted > lastAcceptedCountRef.current) {
      lastAcceptedCountRef.current = accepted;
      // F8.3 review-of-review (M3 revert): an earlier draft gated
      // this on the pre-v0.6 `legacyDriver` prop because the Frame
      // Processor driver doesn't consult `imuGate` for its own pose
      // synthesis.  That ignored a load-bearing side effect:
      // `imuGate.resetAnchor()` bounds the IIR-integrator drift
      // window per-accept, and `imuGate.getTotalAbsMetres()` is read
      // at finalize time as `imuTranslationMetres` into the native
      // stitchMode auto-resolver (PANORAMA vs SCANS).  Without the
      // per-accept reset, long FP-driver captures let IIR drift
      // compound → inflated metres → biased toward SCANS.  Now fires
      // for ALL non-AR captures (the only non-AR driver post-v0.6).
      if (isNonAR) {
        imuGate.resetAnchor();
      }
    } else if (accepted === 0) {
      // New capture (state cleared) — reset our edge-detect ref.
      lastAcceptedCountRef.current = 0;
    }
  }, [incremental.state?.acceptedCount, isNonAR, imuGate]);

  // ── Shutter handlers ────────────────────────────────────────────

  const handleTap = useCallback(async () => {
    if (!enablePhotoMode || shutterDisabled) return;
    try {
      let uri: string;
      let width: number;
      let height: number;
      // iOS captureDepthData — set by the NON-AR branch only (the AR
      // path never produces a depth sidecar).
      let depthPath: string | undefined;
      let depthUnavailableReason: string | undefined;
      // Compose the destination path BEFORE the capture so both the
      // AR and non-AR branches land at the same predictable location.
      // If `outputDir` is set, the lib lands the file at a host-
      // controlled path; otherwise, in the lib's canonical capture
      // dir (`<cache>/react-native-image-stitcher/photo-<ms>.jpg`).
      const photoOutputPath = outputDir
        ? `${toBareFilePath(outputDir).replace(/\/$/, '')}/${defaultPhotoFilename()}`
        : `${await getDefaultCaptureDir()}/${defaultPhotoFilename()}`;
      if (isAR && arViewRef.current) {
        // ARCameraView writes to its own tmp location; relocate to
        // photoOutputPath via the native FileBridge so both branches
        // return paths under the same dir.
        // v0.12.0 — pass deviceOrientation so the AR takePhoto's
        // native CIImage rotation matches the user's view.  Pre-
        // v0.12 the native side hardcoded portrait, so landscape
        // photos came out sideways.
        //
        // 0.20.5 — for HIGH-RES document capture, force 'portrait' instead of
        // the live gyro.  Scanning holds the phone FLAT over the doc, so the
        // accelerometer (deviceOrientation) is ambiguous and the FIRST shot
        // after entering AR came out sideways (gyro hadn't settled).  The
        // doc-scan UI is portrait, so a fixed 'portrait' is the stable,
        // WYSIWYG choice — the AR analogue of the non-AR `'preview'` path.
        const photo = await arViewRef.current.takePhoto({
          quality: 90,
          orientation: highResCapture ? 'portrait' : deviceOrientation,
        });
        try {
          await moveFile(photo.path, photoOutputPath);
        } catch (moveErr) {
          throw new CameraError(
            'OUTPUT_WRITE_FAILED',
            `Failed to move AR photo to ${photoOutputPath}.  The destination `
            + 'directory must be writable.',
            moveErr,
          );
        }
        // Bake EXIF orientation into pixels (parity with the non-AR path,
        // which does this inside useCapture.takePhoto).  Android's AR
        // takePhoto can return a file with an EXIF orientation tag over
        // un-rotated pixels; RN's <Image> honours the tag but OpenCV
        // (detectDocument / cropQuad) does NOT — so a downstream crop preview
        // would be squished and the detected quad rotated 90°.
        // normaliseOrientation re-encodes upright with no tag and returns the
        // true post-rotation dims.  No-op on already-upright files.
        const arNorm = await normaliseOrientation(photoOutputPath, {
          width: photo.width,
          height: photo.height,
        });
        // Android <Image> needs the `file://` scheme to render the
        // returned uri; iOS is OK either way.  Normalise once here.
        uri = toFileUri(photoOutputPath);
        width = arNorm.width;
        height = arNorm.height;
      } else {
        if (!visionCameraRef.current) {
          throw new CameraError(
            'CAMERA_DEVICE_UNAVAILABLE',
            'vision-camera ref is not attached',
          );
        }
        // useCapture.takePhoto wraps the cameraRef internally;
        // attach via assignment so the hook's ref points at our
        // local ref.  This works because RefObject is just { current }.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (capture.cameraRef as any).current = visionCameraRef.current;
        // useCapture handles the move internally; the returned
        // `compressedUri` already points at `photoOutputPath`.
        const result = await capture.takePhoto({ outputPath: photoOutputPath });
        uri = result.compressedUri;
        width = result.width;
        height = result.height;
        depthPath = result.depthPath;
        depthUnavailableReason = result.depthUnavailableReason;
      }

      onCapture?.({
        ok: true,
        type: 'photo',
        uri,
        width,
        height,
        ...(depthPath ? { depthPath } : {}),
        ...(depthUnavailableReason ? { depthUnavailableReason } : {}),
        warnings: [],
      });
    } catch (err) {
      const e = err instanceof CameraError
        ? err
        : new CameraError(
          'PHOTO_CAPTURE_FAILED',
          err instanceof Error ? err.message : String(err),
          err,
        );
      // v0.16 — failures now reach `onCapture` too (ok:false), with
      // `onError` kept as a mirror so existing handlers keep working.
      onError?.(e);
      onCapture?.({ ok: false, type: 'photo', error: e, warnings: [] });
    }
  }, [enablePhotoMode, shutterDisabled, isAR, capture, outputDir, onCapture, onError]);

  // ── startCapture — the "actually start recording" logic ─────────
  // Extracted from `handleHoldStart` so the rotate-to-landscape gate
  // (item 1/2) can DEFER it: a portrait Mode-A hold latches
  // `pendingPanStart` and an effect calls this once the user rotates.
  // Identical behaviour to the inline body it replaced — the only new
  // line is the item-5 auto-finalize timer scheduled right after
  // `setRecordingStartedAt`.
  const startCapture = useCallback(async () => {
    try {
      // perf-3a change 4 — thumbnails + engine state are cleared inside the
      // hook's start() (resetCoalescer + setState(null)) BEFORE its native
      // start await, preserving the 2026-05-23 race fix: a frame the GL/FP
      // thread ingests during the await window accumulates from the just-
      // cleared array (functional updater) instead of being wiped by a
      // post-await reset. So no synchronous clear is needed here.
      // Item 4 — fresh capture: clear the latched too-fast flag.
      fastPanRef.current = false;
      setStatusPhase('recording');
      setRecordingStartedAt(Date.now());
      // Item 5 — schedule the hard-ceiling auto-finalize.  Fires
      // `handleHoldEnd` (via ref to dodge the circular useCallback dep),
      // which finalizes what's captured — the FINALIZE-on-zero product
      // decision.  Cleared on every other capture-exit path.  Skipped
      // when the feature is disabled (`maxPanDurationMs <= 0`).
      clearPanTimer();
      if (maxPanDurationMs > 0) {
        panDurationTimerRef.current = setTimeout(() => {
          handleHoldEndRef.current?.();
        }, maxPanDurationMs);
      }
      const orientationRotation: 0 | 90 | 180 | 270 =
        deviceOrientation === 'portrait' ? 90
          : deviceOrientation === 'portrait-upside-down' ? 270
            : 0;
      // v0.4 — the inline-flat config dict that v0.3 maintained here
      // moved into `panoramaSettingsToNativeConfig` (see
      // PanoramaSettingsBridge.ts).  That adapter is the single source
      // of truth for the JS→native wire format; both this call site
      // AND the modal's reset-to-defaults preview agree on the same
      // mapping.  Audit fixes F1 / F4 / F6 from v0.3 are now properties
      // of the bridge (verified by the unit tests in
      // src/camera/__tests__/PanoramaSettingsBridge.test.ts).
      //
      // 2026-05-23 — override `captureSource` with the runtime-derived
      // `effectiveCaptureSource` (from `arPreference + lens +
      // AR-device-support`).  Pre-this change the camera-screen AR
      // toggle wrote ONLY to local `arPreference` state while the
      // bridge read `settings.captureSource` — so native could think
      // the capture was AR while the operator had toggled it off (or
      // vice-versa).  Single source of truth now: whatever camera the
      // operator can see is what native is told it is.  The settings
      // modal's `captureSource` control has been removed for the same
      // reason — see PanoramaSettingsModal.tsx for the rationale.
      //
      // perf-3a change 1 (open early) — start the FP driver (non-AR) BEFORE
      // the native start await, so its ingest gate opens and its cadence
      // counter is anchored (via reset()) at the hold-start moment rather
      // than one bridge round-trip later. Interval-containment guarantees
      // pixel neutrality: the gate-open window strictly contains native's
      // ingest-enabled window (native flips its AtomicBoolean INSIDE
      // incremental.start), so no frame native would accept is gated;
      // pre-enable strays are dropped by that AtomicBoolean anyway. On any
      // start failure the catch below closes the gate. See docs/perf-3a §4.1.
      if (isNonAR) {
        fpDriver.start();
      }
      // THE SINGLE PLACE `engine` BECOMES A WIRE VALUE. `'keyframe'` is sent as
      // `'batch-keyframe'` so every binary ever shipped sees exactly the string
      // it already understands, which keeps the default path byte-identical
      // against all of them; `'sweep'` is therefore the only NEW string an
      // older parser can encounter, and an older parser is precisely the thing
      // that cannot refuse it.
      const engineWire = engine === 'keyframe' ? 'batch-keyframe' : engine;
      const startResult = await incremental.start({
        snapshotJpegQuality: 75,
        snapshotEveryNAccepts: 1,
        frameRotationDegrees: orientationRotation,
        captureOrientation: deviceOrientation,
        // Non-AR captures use the Frame Processor driver
        // (vision-camera producer-thread worklet → cv_flow_gate
        // plugin → IncrementalStitcher.consumeFrame).  AR captures
        // use the ARSession-driven path.
        frameSourceMode: isNonAR ? 'frameProcessor' : 'arSession',
        composeWidth: 1920,
        composeHeight: 1080,
        canvasWidth: 5000,
        canvasHeight: 5000,
        engine: engineWire,
        // perf-3a change 2 — pass the frame-source mode so the bridge emits
        // flowEvalEveryNFrames=1 for the frameProcessor path: the worklet now
        // does the decimation (before the ~3-4 MB packNV21 copy) and native's
        // cadence is 1, so the effective product cadence is unchanged. AR mode
        // keeps native-side decimation (AR frames never pass the worklet).
        config: panoramaSettingsToNativeConfig(
          { ...settings, captureSource: effectiveCaptureSource },
          { frameSourceMode: isNonAR ? 'frameProcessor' : 'arSession' },
        ),
      });
      // ⚠ FAIL CLOSED WHEN NATIVE DID NOT SAY WHAT IT RESOLVED.
      //
      // Absence is the only thing an OLD binary can express: one that predates
      // the three-way resolve accepts ANY engine string, logs a deprecation and
      // paints a keyframe panorama, then resolves ok:true. So a missing
      // `engineResolved` means "this binary cannot refuse", and on such a
      // binary a non-default engine would silently produce the wrong output and
      // report success — the exact failure this step exists to prevent.
      //
      // ⚠ AND IT IS SCOPED TO THE NON-DEFAULT CASE ON PURPOSE. For the keyframe
      // path an old binary does precisely what it has always done, so refusing
      // there would break every existing host to guard against nothing.
      if (engineWire !== 'batch-keyframe' && startResult?.engineResolved == null) {
        throw new Error(
          `native did not report engineResolved for engine '${engine}'. This ` +
            'binary predates engine refusal and cannot be trusted with a ' +
            'non-default engine — it would paint a keyframe panorama and ' +
            'report success. Rebuild the native side.',
        );
      }
      // F8.3 review-of-review (M3 revert): `imuGate.resetAnchor()`
      // is load-bearing for the stitchMode auto-resolver (see the
      // matching comment on the per-accept reset useEffect above).
      // Keep firing it on every capture start, not just legacy mode.
      imuGate.resetAnchor();
      // perf-3a change 2 (review fix) — re-anchor the worklet decimation
      // grid NOW that native has enabled ingestion. The gate was opened
      // before this await (open-early, so no keyframe is lost), which let
      // await-window frames advance the counter; re-zeroing it here anchors
      // the {0,N,2N,…} grid at native-ingest-enable, matching native's old
      // post-enable anchor → frame-identical decimation (not a phase offset).
      if (isNonAR) {
        fpDriver.resetCadence();
      }
    } catch (err) {
      // perf-3a change 1 — native start failed: close the ingest gate we
      // opened before the await (below), so a failed start doesn't leave the
      // worklet feeding a not-started engine.
      if (isNonAR) {
        fpDriver.stop();
      }
      setStatusPhase('idle');
      clearPanTimer();
      // An engine refusal is a HOST CONFIGURATION error, not a capture failure,
      // and conflating the two costs the host the one thing it needs: which of
      // its own props was wrong. Native's reject code is carried on the error
      // (`engine-unavailable` — known engine, no provider in this build; or
      // `engine-unknown` — not an engine name), and the fail-closed throw above
      // is the third case. All three surface as ENGINE_UNAVAILABLE with the
      // precise cause attached.
      // ⚠ LOG THE STACK. A start failure reaches the host as a CODE and a
      // MESSAGE, and for a JS-side throw the message alone is useless — a
      // bare "undefined is not a function" names neither the call nor the
      // file, and the host has no way to get at it. The stack is the one
      // thing that turns that into a fix, and it is free in a dev build.
      if (__DEV__) {
        // eslint-disable-next-line no-console
        console.error(
          '[Camera] startCapture threw',
          { engine, isNonAR, engineWire: engine === 'keyframe' ? 'batch-keyframe' : engine },
          err instanceof Error ? (err.stack ?? err.message) : String(err),
        );
      }
      const nativeCode = (err as { code?: unknown } | null)?.code;
      const isEngineRefusal =
        nativeCode === 'engine-unavailable' ||
        nativeCode === 'engine-unknown' ||
        (err instanceof Error && err.message.includes('engineResolved'));
      onError?.(
        new CameraError(
          isEngineRefusal ? 'ENGINE_UNAVAILABLE' : 'PANORAMA_START_FAILED',
          err instanceof Error ? err.message : String(err),
          err,
        ),
      );
    }
  }, [
    incremental,
    isNonAR,
    deviceOrientation,
    settings,
    effectiveCaptureSource,
    imuGate,
    fpDriver,
    engine,
    onError,
    maxPanDurationMs,
    clearPanTimer,
  ]);

  // Bridge the latest `handleTap` to the imperative `takePhoto()` (declared
  // above the imperative handle, so it can't be referenced there directly).
  // Assigning a ref during render is the canonical "latest callback" pattern.
  handleTapRef.current = handleTap;

  // Keep the ref current so the auto-finalize timer + the rotate-resume
  // effect can invoke the latest `startCapture` without taking it as a
  // dep (which would re-run them on every recording-driven re-render).
  useEffect(() => {
    startCaptureRef.current = () => { void startCapture(); };
  });

  // ── handleHoldStart — early guards + the rotate-to-landscape gate ─
  // The "actually start" body lives in `startCapture`; this wrapper only
  // decides WHETHER to start now.  Under Mode A in portrait it latches
  // `pendingPanStart` instead (item 1/2) and the resume effect below
  // starts the capture once the user rotates to landscape.
  const handleHoldStart = useCallback(() => {
    // Gate symmetrically with handleTap (shutterDisabled) AND guard
    // re-entrancy: the built-in shutter's phase machine prevents a
    // double-start, but the imperative startPanorama() has no such machine, so
    // a repeat call — or one while a capture is recording/stitching — would
    // re-enter incremental.start() on a live engine.
    if (!enablePanoramaMode || shutterDisabled) return;
    if (statusPhase === 'recording' || statusPhase === 'stitching') return;
    if (!incrementalStitcherIsAvailable()) {
      // Say WHICH of the two it is. "Not available" covered both "the module
      // is not registered at all" (a linking problem) and "it is registered
      // but a method is missing" (a native-export problem), and those send
      // the reader to completely different places. The second one is not
      // hypothetical: a displaced `@ReactMethod` once left `start` off the
      // bridge, and the only symptom was PANORAMA_START_FAILED with no clue.
      const missing = incrementalMissingMethods();
      onError?.(
        new CameraError(
          'PANORAMA_START_FAILED',
          missing === null
            ? 'Native incremental stitcher module is not registered. The '
              + 'native side is not linked into this build.'
            : `Native incremental stitcher is registered but does not export `
              + `${missing.join(', ')}. The native method exists but is not `
              + `bridged — on Android check that @ReactMethod still touches `
              + `the function (scripts/check-reactmethod-binding.sh).`,
        ),
      );
      return;
    }
    if (shouldGateForPanMode(panMode, deviceOrientation)) {
      // Mode-A + portrait — block the start and show the rotate prompt.
      // The resume effect picks this up the instant the device rotates.
      setPendingPanStart(true);
      return;
    }
    void startCapture();
  }, [
    enablePanoramaMode,
    shutterDisabled,
    statusPhase,
    onError,
    panMode,
    deviceOrientation,
    startCapture,
  ]);

  // ── Rotate-to-landscape resume (item 1/2) ───────────────────────
  // When a hold was gated (`pendingPanStart`) and the user has since
  // rotated so the gate no longer fires, start the deferred capture.
  // Invoked through `startCaptureRef` (kept current above) so this
  // effect's deps don't churn on every recording re-render.
  useEffect(() => {
    if (pendingPanStart && !shouldGateForPanMode(panMode, deviceOrientation)) {
      setPendingPanStart(false);
      startCaptureRef.current?.();
    }
  }, [pendingPanStart, deviceOrientation, panMode]);

  const handleHoldEnd = useCallback(async () => {
    // Item 5 exit path #1 — always kill the auto-finalize timer on
    // release, even on the early-return below (it's idempotent).
    clearPanTimer();
    // Item 1/2 — if the shutter is released while a rotate-gated hold is
    // pending (user let go before rotating to landscape), abandon the
    // deferred start rather than starting on the next rotation.
    if (pendingPanStart) setPendingPanStart(false);
    if (statusPhase !== 'recording') return;
    // Re-entrancy latch — close the timer-vs-release double-finalize window
    // synchronously so incremental.finalize()/onCapture fire exactly once.
    if (finalizingRef.current) return;
    finalizingRef.current = true;
    // Consume the lateral-drift flag once, here, so it's cleared on BOTH the
    // success and failure paths and never leaks into the next capture.
    const wasLateralFinalize = lateralFinalizeRef.current;
    lateralFinalizeRef.current = false;
    const wasFastPan = fastPanRef.current;
    fastPanRef.current = false;
    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.log(
        `[capture] finalize: wasFastPan=${wasFastPan} `
        + `wasLateralFinalize=${wasLateralFinalize}`,
      );
    }
    setStatusPhase('stitching');
    // perf-3a change 1 — `fpDriver.stop()` moved from HERE to the finally
    // below (close-late), so the ingest gate stays open through the 50 ms
    // yield + finalize bridge hop (the window native still ingests). The
    // <CameraView> unmount driven by statusPhase==='stitching' (just set)
    // stops frame delivery within a frame or two regardless, so no frames
    // race the stitch — the engine still isn't fed late keyframes.
    // V12.14.8 restore (regressed in the SDK camera extraction): the
    // render below unmounts <CameraView>/<ARCameraView> while
    // statusPhase==='stitching'.  Yield a macrotask so React commits that
    // unmount and vision-camera tears down the AVCaptureSession + preview
    // buffers (~150-250 MB) BEFORE the memory-heavy stitch runs.  Without
    // it the live-camera footprint and the stitch peak coexist and
    // jetsam (iOS) / lmkd (Android) OOM-kill the app — the exact
    // WatchdogTermination crash V12.14.8 originally fixed.
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      // Compose the panorama output path: host-controlled if
      // `outputDir` is set, else the lib's canonical capture dir
      // (`<cache>/react-native-image-stitcher/panorama-<ms>.jpg`).
      // `incremental.finalize` writes the stitched JPEG straight to
      // this path natively (no JS-side move needed for panoramas).
      const panoOutputPath = outputDir
        ? `${toBareFilePath(outputDir).replace(/\/$/, '')}/${defaultPanoramaFilename()}`
        : `${await getDefaultCaptureDir()}/${defaultPanoramaFilename()}`;
      // 2026-05-22 (audit F2f) — total IMU translation directly from
      // the gate's cumulative accumulator (banks |segment displacement|
      // at every anchor reset, including non-IMU-driven resets like
      // flow-novelty accepts).  No more fires × budget + residual
      // reconstruction.  Only meaningful in non-AR mode (in AR the
      // native side uses pose-derived translation and ignores this).
      const imuTotalTranslationM =
        isNonAR ? imuGate.getTotalAbsMetres() : 0;
      const result = await incremental.finalize(
        panoOutputPath,
        90, // default JPEG quality
        deviceOrientation,
        imuTotalTranslationM,
        lens, // 2026-06-16 — explicit '1x'|'0.5x' for the high-level warper tree
      );
      if (
        typeof result.framesRequested === 'number'
        && typeof result.framesIncluded === 'number'
        && result.framesIncluded < result.framesRequested
      ) {
        onFramesDropped?.({
          requested: result.framesRequested,
          included: result.framesIncluded,
        });
      }

      // v0.16 — non-fatal quality signals attached to the result + (when
      // the crop editor shows) the crop banner.  LOW_FRAME_UTILIZATION when
      // <70 % of captured frames survived; LATERAL_DRIFT_FINALIZE when item-6
      // stopped this capture early.
      const warnings = buildCaptureWarnings({
        framesRequested: result.framesRequested,
        framesIncluded: result.framesIncluded,
        lateralFinalize: wasLateralFinalize,
        highPanSpeed: wasFastPan,
        copy: captureWarningCopyFrom(guidanceCopyResolved),
      });

      const captureResultObj: PanoramaCaptureResult = {
        ok: true,
        type: 'panorama',
        // Native finalize() returns a bare `/data/.../foo.jpg` path;
        // normalise to `file://` for Android <Image>.
        uri: toFileUri(result.panoramaPath),
        width: result.width,
        height: result.height,
        framesRequested: result.framesRequested ?? -1,
        framesIncluded: result.framesIncluded ?? -1,
        framesDropped:
          (result.framesRequested ?? 0) - (result.framesIncluded ?? 0),
        finalConfidenceThresh: result.finalConfidenceThresh ?? -1,
        durationMs: Date.now() - (recordingStartedAt ?? Date.now()),
        stitchModeResolved: result.stitchModeResolved,
        rRadians: result.rRadians,
        tMeters: result.tMeters,
        decisionRatio: result.decisionRatio,
        debugSummary: result.debugSummary,
        keyframePaths: result.batchKeyframePaths,
        captureOrientation: result.captureOrientation,
        warnings,
      };
      // When the crop editor OR a plain preview is enabled AND the panorama
      // has valid intrinsic dims, defer `onCapture`: stash the result and
      // mount RectCropPreview (crop mode when `rectCrop`, preview-only when
      // just `showPreview`).  The modal's confirm / use-original / retake
      // decision emits the final result.  Otherwise emit immediately.
      if (
        (rectCrop || showPreview)
        && result.width > 0
        && result.height > 0
      ) {
        // Crop mode only — seed the quad from the max-inscribed rectangle of
        // the (un-cropped) panorama so the editor opens on the tightest clean
        // rectangle, not a blind 8 % inset.  Best-effort: an absent native
        // module / decode failure falls back to the default seed.  Skipped in
        // preview-only mode (no quad to seed).
        let initialRect: ImageRect | undefined;
        if (rectCrop) {
          try {
            const inscribed = await computeInscribedRect(captureResultObj.uri);
            if (inscribed && inscribed.width > 0 && inscribed.height > 0) {
              initialRect = {
                x: inscribed.x,
                y: inscribed.y,
                width: inscribed.width,
                height: inscribed.height,
              };
            }
          } catch {
            // No seed — RectCropPreview uses its default inset.
          }
        }
        setCropPending({
          uri: captureResultObj.uri,
          width: result.width,
          height: result.height,
          captureResultObj,
          initialRect,
          warnings,
        });
      } else {
        onCapture?.(captureResultObj);
      }
      // 2026-05-22 (audit F9) — fire the debug stitch-stats toast on
      // every successful finalize when settings.debug is on.  Shows
      // the leaveBiggestComponent retry telemetry + resolved mode so
      // the operator can see what choice the auto-resolver made.
      if (settings.debug) {
        stitchToast.showResult(result);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Classify the raw native failure string → typed code.  The chain
      // lives in classifyStitchError() (the load-bearing C++↔JS contract,
      // unit-tested against the actual native strings) so a future reword
      // of a cpp throw can't silently drop the "pan more slowly" path.
      const code = classifyStitchError(message);
      const error = new CameraError(code, message, err);
      // v0.16 — surface the failure on BOTH callbacks: `onError` (unchanged
      // mirror) and `onCapture` (ok:false) so a host has one place to learn
      // the outcome.  A lateral-drift stop that then failed to stitch still
      // reports that cause via the warning.
      onError?.(error);
      onCapture?.({
        ok: false,
        type: 'panorama',
        error,
        warnings: buildCaptureWarnings({
          lateralFinalize: wasLateralFinalize,
          highPanSpeed: wasFastPan,
          copy: captureWarningCopyFrom(guidanceCopyResolved),
        }),
      });
    } finally {
      // perf-3a change 1 (close late) — stop the FP driver (→ close the
      // ingest gate) AFTER finalize settles, not before the 50 ms yield.
      // The gate-open interval must strictly CONTAIN native's ingest-enabled
      // interval (native cuts ingest synchronously at the top of finalize):
      // closing earlier would gate the 1-3 tail frames that native still
      // ingests during the yield + finalize bridge hop and that feed the
      // sharpness window / trailing keyframe → keyframe loss. No stitch-phase
      // waste: <CameraView> unmounts at statusPhase==='stitching' (set above)
      // so no frames reach the still-open gate during the multi-second stitch.
      fpDriver.stop();
      finalizingRef.current = false;
      setStatusPhase('idle');
      setRecordingStartedAt(null);
    }
  }, [
    statusPhase,
    incremental,
    deviceOrientation,
    onCapture,
    onFramesDropped,
    onError,
    recordingStartedAt,
    fpDriver,
    // F10 Phase 2 review N1 — these four were missing pre-fix.  The
    // callback reads `settings.debug` (to gate the stitchToast),
    // `isNonAR` (to decide whether to read IMU totalAbs translation),
    // `imuGate` (the read itself), and `stitchToast` (the toast hook
    // object).  If any of those identities change between the user
    // pressing-and-holding the shutter and the release, the stale-
    // closure read could disagree with the actual current state.
    // Pre-existing v0.3 bug; v0.4 was the natural time to address it.
    settings,
    isNonAR,
    imuGate,
    stitchToast,
    // 2026-06-16 — the finalize passes `lens` (the high-level warper tree's zoom
    // signal); without it here the closure would send a STALE lens if the user
    // switched 1x↔0.5x after this callback was last memoized.
    lens,
    // feature/pano-ux-guidance — the release also tears down the
    // pan-duration timer + a pending rotate-gate, and decides whether to
    // route the result through the crop editor.
    clearPanTimer,
    pendingPanStart,
    rectCrop,
    showPreview,
  ]);

  // Keep `handleHoldEndRef` current so the auto-finalize timer + the
  // lateral-drift effect invoke the latest `handleHoldEnd` without
  // adding it as a dep (it changes identity on every recording tick).
  useEffect(() => {
    handleHoldEndRef.current = () => { void handleHoldEnd(); };
    // Assigned here (not with handleTapRef) because handleHoldStart is declared
    // below that point — this site is after both hold handlers exist.
    handleHoldStartRef.current = handleHoldStart;
  });

  // ── Item 6 — lateral drift → FINALIZE + popup ───────────────────
  // Mirrors the orientation-drift effect, but FINALIZES the capture
  // (keeps what was stitched) rather than cancelling it: clear the
  // pan-duration timer, latch the popup, then call handleHoldEnd via
  // its ref.  Gated off when the budget is disabled (`<= 0`).
  useEffect(() => {
    if (
      !panMotion.lateralExceeded
      || !captureRecording
      || lateralBudgetCm <= 0
    ) {
      return;
    }
    clearPanTimer();

    // ⚠ THE SWEEP STOPS THROUGH ITS OWN SHUTTER. Everything below is the
    // keyframe engine's: `acceptedKeyframeCount`, `incremental.cancel()`,
    // `handleHoldEndRef`. A sweep has no keyframes to count and no
    // `incremental` session to cancel.
    //
    // Release always FINALIZES on the sweep, which is pano's ">= 2
    // keyframes" arm — keep what was captured and say why. The unusable
    // case needs no branch here: the sweep's own `onComplete` already emits
    // rather than reviewing when the canvas came back empty.
    if (sweepRunning) {
      setLateralWrongDirection(false);
      setLateralStopVisible(true);
      sweepRef.current?.holdEnd?.();
      return;
    }

    // #3 — if the user veered off before enough frames were captured to
    // stitch, finalizing would fail with a misleading "need more images"
    // error.  Instead ABANDON the capture (no stitch → no error) and show
    // the "follow the arrow" popup.  Otherwise FINALIZE what was captured
    // (a usable partial pano) and show the "keep it straight" popup.
    const MIN_STITCHABLE_KEYFRAMES = 2;
    if (acceptedKeyframeCount < MIN_STITCHABLE_KEYFRAMES) {
      setLateralWrongDirection(true);
      setLateralStopVisible(true);
      void (async () => {
        fpDriver.stop();
        try {
          await incremental.cancel();
        } catch {
          // best-effort — abandonment must succeed even in a weird state.
        } finally {
          setStatusPhase('idle');
          setRecordingStartedAt(null);
          onCaptureAbandoned?.('lateral-drift');
        }
      })();
      return;
    }

    setLateralWrongDirection(false);
    setLateralStopVisible(true);
    // Mark this finalize as lateral-drift-triggered so handleHoldEnd attaches
    // the LATERAL_DRIFT_FINALIZE warning to the result.
    lateralFinalizeRef.current = true;
    handleHoldEndRef.current?.();
    // Deps mirror the drift effect: re-run when the latch trips or the
    // recording state changes.  Other reads are stable setters / refs.
    // `captureRecording` for the reason stated there.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panMotion.lateralExceeded, captureRecording, lateralBudgetCm]);

  // ── Item 7 — auto-finalize when the configured keyframe count is hit ─
  // The engine caps accepted keyframes at `keyframeMaxCount`; once it
  // reports that many, no more frames will be accepted, so stop + stitch
  // (same finalize path as releasing the shutter).  `handleHoldEnd`'s
  // re-entrancy latch makes this idempotent vs. a manual release in the
  // same tick.  This is the PRIMARY auto-stop (the time cap is opt-in).
  const keyframeMaxCount = settings.frameSelection.maxKeyframes;
  const acceptedKeyframeCount = incremental.state?.acceptedCount ?? 0;
  // Item 4 — speed cue routed into the REC banner/border colour (green→red).
  // Gated on panGuidance so opting out keeps the banner calm/green.
  const recordingTooFast =
    panGuidance && panMotion.panSpeedBucket !== 'good';
  // Latch the too-fast flag for the HIGH_PAN_SPEED warning (shown on the crop
  // editor + returned in onCapture.warnings).  Latches when the live cue is
  // active OR — per the user's request — when a KEYFRAME the stitch will use
  // is accepted while the pan is too fast (so a captured frame was actually
  // taken at speed).  Depending on panSpeedBucket + acceptedKeyframeCount
  // directly (not just the derived `recordingTooFast`) makes the effect run
  // on every bucket / keyframe change, so a brief red window can't be missed.
  // Reset at capture start.
  const prevAcceptedForSpeedRef = useRef(0);
  useEffect(() => {
    if (statusPhase !== 'recording') {
      prevAcceptedForSpeedRef.current = acceptedKeyframeCount;
      return;
    }
    const newKeyframe = acceptedKeyframeCount > prevAcceptedForSpeedRef.current;
    prevAcceptedForSpeedRef.current = acceptedKeyframeCount;
    if (recordingTooFast) {
      if (__DEV__ && !fastPanRef.current) {
        // eslint-disable-next-line no-console
        console.log(
          `[panMotion] HIGH_PAN_SPEED latched (bucket=`
          + `${panMotion.panSpeedBucket} acceptedCount=${acceptedKeyframeCount}`
          + `${newKeyframe ? ' on a keyframe' : ''})`,
        );
      }
      fastPanRef.current = true;
    }
  }, [
    statusPhase,
    recordingTooFast,
    acceptedKeyframeCount,
    panMotion.panSpeedBucket,
  ]);
  useEffect(() => {
    if (
      statusPhase === 'recording'
      && keyframeMaxCount > 0
      && acceptedKeyframeCount >= keyframeMaxCount
    ) {
      handleHoldEndRef.current?.();
    }
  }, [statusPhase, keyframeMaxCount, acceptedKeyframeCount]);

  // ── Item 3 — brief pan how-to overlay at recording start ────────
  // Show the how-to GIF + direction arrow for a short window when a
  // recording begins, then auto-fade.  The component never self-times;
  // this effect owns the lifecycle.
  useEffect(() => {
    if (statusPhase !== 'recording') {
      setHowToVisible(false);
      return;
    }
    setHowToVisible(true);
    const t = setTimeout(() => setHowToVisible(false), 2500);
    return () => clearTimeout(t);
  }, [statusPhase]);

  // ── Item 5 — cosmetic countdown tick ────────────────────────────
  // While recording, bump `nowTick` ~4×/s so `countdownSecondsFrom`
  // recomputes the displayed whole-seconds.  The authoritative auto-stop
  // is the `panDurationTimerRef` setTimeout, NOT this interval.  Skipped
  // when the countdown feature is disabled (`maxPanDurationMs <= 0`).
  useEffect(() => {
    if (!captureRecording || maxPanDurationMs <= 0) return;
    const id = setInterval(() => setNowTick(Date.now()), 250);
    return () => clearInterval(id);
  }, [captureRecording, maxPanDurationMs]);

  // Whole seconds remaining for the countdown overlay (item 5).  Pure
  // helper; clamps to [0, round(maxPanDurationMs/1000)].
  /**
   * THE SWEEP'S RECORDING CLOCK AND ITS WALL-CLOCK CAP.
   *
   * ⚠ BOTH LIVED INSIDE THE KEYFRAME `startCapture`, so a sweep had neither.
   * `recordingStartedAt` is what the REC banner counts up from and what the
   * countdown counts down against, and the cap is Pano's promise that a hold
   * cannot run forever. A pano+ hold could run until the operator let go, or
   * until the canvas filled — which is a different promise and a much later
   * one.
   *
   * The cap FINALIZES rather than abandoning: reaching a time limit is not a
   * fault, and the panorama painted so far is the deliverable. That is what
   * the keyframe engine's own `maxPanDurationMs` path does.
   */
  //
  // ⚠ TWO EFFECTS, NOT ONE, AND THE SPLIT IS THE POINT. Stamping the clock
  // and arming the timer in one effect keyed on `[sweepRunning,
  // maxPanDurationMs]` meant that ANY change to the cap mid-hold — a host
  // re-rendering `maxPanDurationMs={settings.maxPanMs}` after a settings
  // refetch, an inline object, a parent re-render that recomputes the prop —
  // re-ran the whole body: the elapsed time was thrown away, the REC banner
  // jumped back to 0:00, and a FULL-LENGTH timer was armed again. A host
  // that re-rendered on a timer could hold the cap off forever, which is
  // precisely the promise the cap exists to make.
  //
  // So the clock is stamped on the RISING EDGE of the hold and nothing else,
  // and the timer is armed for whatever is LEFT of the cap measured from
  // that stamp. A cap shortened mid-hold to a value already elapsed fires at
  // once, which is the honest reading of "this hold may not exceed N".
  const sweepClockRef = useRef<number | null>(null);
  useEffect(() => {
    if (!sweepRunning) {
      sweepClockRef.current = null;
      return undefined;
    }
    const startedAt = Date.now();
    sweepClockRef.current = startedAt;
    setRecordingStartedAt(startedAt);
    return undefined;
  }, [sweepRunning]);
  useEffect(() => {
    if (!sweepRunning || maxPanDurationMs <= 0) return undefined;
    // Declared after the clock effect, so on the rising edge React has
    // already run that one in this same commit and the ref is this hold's.
    // The `?? Date.now()` is the defensive reading for a future reorder, not
    // a reachable state today.
    const startedAt = sweepClockRef.current ?? Date.now();
    const remainingMs = Math.max(0, startedAt + maxPanDurationMs - Date.now());
    const id = setTimeout(() => {
      sweepRef.current?.holdEnd?.();
    }, remainingMs);
    return () => { clearTimeout(id); };
  }, [sweepRunning, maxPanDurationMs]);

  const countdownSeconds = countdownSecondsFrom(
    recordingStartedAt,
    nowTick,
    maxPanDurationMs,
  );

  // ── Lens / AR-toggle handlers ───────────────────────────────────

  const handleLensChange = useCallback((next: CameraLens) => {
    if (sweepRunning) return;
    setLens(next);
    onLensChange?.(next);
  }, [onLensChange, sweepRunning]);

  const handleARToggle = useCallback(() => {
    if (sweepRunning) return;
    // ⚠ WHEN THE PILL IS THE ESCAPE HATCH IT MUST ALSO COMMIT THE LENS, or
    // showing it there just moves the dead control from the chip to the
    // pill. On a body with no enumerable ultra-wide the chip has no handler
    // at all, so the pill is the only live thing on screen — and at raw
    // 0.5× `deriveEffectiveCaptureSource` answers 'non-ar' from the RAW
    // lens, so toggling `arPreference` alone moves nothing.
    //
    // Committing 1× here is the same move the surface's own `onArToggle`
    // makes when it leaves AR: "the value already under the operator's
    // finger being made real" — the chip is already painting `1×` in this
    // state, because `sweepEffectiveLens` masked it.
    if (lens !== '1x' && !has0_5x) {
      setLens('1x');
      onLensChange?.('1x');
    }
    setArPreference((prev) => !prev);
  }, [sweepRunning, lens, has0_5x, onLensChange]);

  // ── v0.13.0 — Flash control ─────────────────────────────────────
  //
  // `flashRequested` is what the host / built-in button asks for.
  // `effectiveFlash` is what we drive into vision-camera (non-AR).  AR
  // mode forces 'off' (flash is hidden in AR; ARKit/ARCore own the
  // device) so vision-camera — which isn't the active camera in AR —
  // doesn't fight for it.
  //
  // v0.13.1 — the ACTIVE device's torch capability is the source of
  // truth.  The ultra-wide (0.5×) lens has no flash/torch unit on most
  // phones, so vision-camera throws `flash-not-available` if we pass
  // flash="on" while it's selected.  `capture.device.hasTorch` (from
  // vision-camera's device list) tells us definitively; we hide the
  // flash control and force 'off' when the device can't flash.
  // v0.13.2 — `capture.deviceHasTorch` reflects the MOUNTED device.  In
  // multi-cam mode this is the multi-cam device (has a torch → flash
  // works on both 1× and 0.5× via zoom).  In standalone-uw mode on 0.5×
  // the mounted device is the torchless ultra-wide → flash hides.
  const deviceHasTorch = capture.deviceHasTorch;
  const flashRequested: 'on' | 'off' = controlledFlash ?? internalFlash;
  const effectiveFlash: 'on' | 'off' =
    isAR || !deviceHasTorch ? 'off' : flashRequested;
  const toggleFlash = useCallback(() => {
    const next: 'on' | 'off' = flashRequested === 'on' ? 'off' : 'on';
    if (controlledFlash == null) setInternalFlash(next);
    onFlashChange?.(next);
  }, [flashRequested, controlledFlash, onFlashChange]);

  // v0.13.1 — top-right control pills (flash + AR) stack vertically
  // UNDER the settings affordance.  Anchor depends on what's above:
  //   - headerTitle set  → pills clear the CaptureHeader bar
  //     (title row ≈ topInset + ~36; guidance pill adds ~28 when present)
  //   - standalone gear  → pills clear the 40px gear at topInset + 8
  //   - neither          → pills start where the gear would be
  const pillStackTop =
    headerTitle != null
      ? insets.top + (headerGuidance != null ? 72 : 40)
      : showSettingsButton
        ? insets.top + 8 + 44
        : insets.top + 8;

  // ── JSX ─────────────────────────────────────────────────────────

  // ══════════════════════════════════════════════════════════════════
  //  engine="sweep" — the sweep surface OWNS the screen
  // ══════════════════════════════════════════════════════════════════
  //
  // ⚠ A DELEGATION, NOT A BRANCH INSIDE THE NORMAL RENDER, AND THE REASON IS
  // THE AR SESSION. `<Camera>` mounts an `<ARCameraView>` and so does the
  // sweep surface; two mounts mean two `RNSARSession.shared.start()` calls
  // against one camera, which produces no compile error, no link error, and
  // a black preview or a frozen session on a phone. Returning early is the
  // only shape in which exactly one of them is alive.
  //
  // ⚠ AND THE SWEEP DOES NOT GO THROUGH `incremental.start()` AT ALL. It is
  // not a mode of the keyframe engine: it is its own native module family
  // (`RNSSweepSession` and siblings) with its own start/stop/cancel
  // lifecycle. Both natives still answer `engine-unavailable` for the string
  // 'sweep' — deliberately, because nothing should reach them with it. The
  // engine selector is resolved HERE, in JS, before any bridge call.
  //
  // What the host sees is unchanged: completion arrives on `onCapture` and
  // failure on `onError`, exactly as for a photo or a panorama.
  // ── ONE DEFINITION OF THE HOST PREVIEW ──────────────────────────
  //
  // `<CameraView>` is vision-camera's session and it is the viewfinder for
  // BOTH the keyframe engine and the non-AR sweep — the whole point of S7
  // is that the sweep stops opening a second camera beside it. Defined once
  // here so the two call sites cannot drift: ~25 props, several of them
  // load-bearing lifecycle (`isActive`, the background-release contract),
  // and a copy would be a second place to fix the next Samsung reclaim bug.
  // ⚠ A FUNCTION, NOT A VALUE, AND THE PARAMETER IS THE WHOLE POINT.
  //
  // This element is rendered from TWO places — the sweep cell and the main
  // keyframe tree — and it used to carry the sweep's `onPreviewStarted`
  // handler in both. That handler writes a `<Camera>`-scoped flag meaning
  // "the SWEEP's host preview is drawing", so the KEYFRAME preview set it
  // too, and on sweep → keyframe → sweep the flag arrived already true for
  // a brand-new, session-less element: transparent root, explainer
  // suppressed, black underneath. Five rounds of this rung's history is
  // that flag being written by something that does not own it.
  //
  // Now the lifecycle callbacks are passed IN by the call site that owns
  // them, so the keyframe cell structurally cannot write the sweep's flag.
  // One definition still, for the ~25 props and the background-release
  // contract that must not drift between the two.
  // ── THE CHROME THAT BELONGS TO `<Camera>`, NOT TO AN ENGINE ─────────
  //
  // ⚠ THIS EXISTS BECAUSE `engine` WAS CHANGING THE WHOLE SCREEN. The
  // `engine === 'sweep'` branch below returns a different tree, and every
  // control lived AFTER it — so on a sweep the operator got the sweep
  // surface's own CLONES of these pills instead (`src/sweep/chrome.tsx`),
  // fed from the pano+ arm/calibration ladder rather than from the camera.
  // Four field defects came out of that one substitution:
  //
  //   * the AR pill could not be deselected — the clone paints
  //     `armNotice.effectivePoseSource` (what will RUN) rather than the
  //     operator's setting, and on an uncalibrated phone the IMU arm falls
  //     back to ARKit, so it was pinned ON and its handler wrote a value
  //     the state already held;
  //   * the lens chip showed only 1× — the clone's `has0_5x` is
  //     `ultraWideOfferable`, which that same fallback forces false, so it
  //     collapsed to a static `<Text>` with no `Pressable`;
  //   * and the result screen diverged, because the review surfaces live
  //     after the branch too.
  //
  // A switch must show the SETTING. What will actually run is the arm
  // notice's job, and the surface still prints it. Conflating the two is
  // what produced the stuck pill.
  //
  // So these render ONCE, from `<Camera>`'s own state, on every engine.
  // ── THE LENS THE RUNNING ARM WILL ACTUALLY OPEN ─────────────────────────
  //
  // ⚠ THE PILL SHOWS THE SETTING; THE CHIP SHOWS WHAT IS LIVE. They are not
  // the same rule, and collapsing them to one is how this control has now
  // failed in BOTH directions:
  //
  //   * the sweep surface's own clone painted `effectivePoseSource` on the AR
  //     PILL — what will RUN — so on an uncalibrated phone the pill was pinned
  //     ON and could not be deselected. Fixed by painting the preference,
  //     because AR *is* a preference the operator owns and the arm notice is
  //     what says which arm will really run.
  //
  //   * unifying the chrome then pointed the LENS CHIP at `<Camera>`'s raw
  //     `lens`, which reintroduced the mirror defect the surface had already
  //     solved (`PanoPlusCaptureSurface`'s `effectiveLens`, and its stated
  //     property: "no reachable state where the chip claims a lens the running
  //     arm cannot deliver"). A lens is NOT a deferred preference — it is the
  //     glass the operator is looking through. On the AR arm that glass is
  //     structurally the wide camera (ARKit publishes no ultra-wide format —
  //     0 of 22 on iPhone17,1; ARCore forces camera 0 on the A35), and `start`
  //     DELETES the `lens` key there. Painting `0.5×` over an ARKit viewfinder
  //     tells the operator he is on a camera he is not on.
  //
  // Reported UP from the surface, because the fallback is decided down there
  // from the calibration plan `<Camera>` does not have. `onEffectiveArmChange`
  // already existed on the surface and nothing consumed it.
  //
  // ⚠ THE REQUEST STAYS RAW. `effectiveCaptureSource` — which moves the arm —
  // must keep reading `lens`, or a 0.5× tap would never leave AR, the fallback
  // would never be evaluated, and this mask would have nothing to report.
  // Request with the setting, paint with what came back.
  const [sweepEffectiveArm, setSweepEffectiveArm] =
    useState<{
      poseSource: 'ar' | 'imu';
      resolving: boolean;
      fallbackToAr: boolean;
      chromeSuppressed: boolean;
    } | null>(null);
  const handleSweepEffectiveArm = useCallback((arm: {
    poseSource: 'ar' | 'imu';
    resolving: boolean;
    fallbackToAr: boolean;
    chromeSuppressed: boolean;
  }) => {
    // Bails on an equal answer: this is called from an effect in the child
    // whose deps include this callback, so an unconditional `setState` would
    // re-render on every one of the surface's own renders.
    setSweepEffectiveArm((prev) => (
      prev != null
        && prev.poseSource === arm.poseSource
        && prev.resolving === arm.resolving
        && prev.fallbackToAr === arm.fallbackToAr
        && prev.chromeSuppressed === arm.chromeSuppressed
        ? prev
        : {
            poseSource: arm.poseSource,
            resolving: arm.resolving,
            fallbackToAr: arm.fallbackToAr,
            chromeSuppressed: arm.chromeSuppressed,
          }
    ));
  }, []);
  // ⚠ CLEARED WHEN THE SWEEP LEAVES, OR THE LAST SWEEP'S ARM PAINTS THE FIRST
  // FRAME OF THE NEXT ONE. The read below is per-render
  // (`engine === 'sweep' ? … : null`), which makes the mask inert on the
  // keyframe engine — but the STATE survives, so sweep → keyframe → tap 0.5×
  // → sweep re-applied a stale `'ar'` and masked a lens the operator had
  // legitimately chosen, for the commit before the surface re-reported.
  useEffect(() => {
    if (engine !== 'sweep') setSweepEffectiveArm(null);
  }, [engine]);
  // ⚠ AND THE HOLD FLAG WITH IT, OR BOTH PILLS FREEZE ON THE OTHER ENGINE.
  // `sweepRunning` gates `handleARToggle` and `handleLensChange`, and those
  // are the SHARED handlers — the keyframe tree renders the same pills. Its
  // only release on this path is the surface's own unmount cleanup, so a
  // host flipping `engine` mid-hold (or a surface that unmounts without
  // reporting) would leave the keyframe engine's AR pill and lens chip
  // permanently inert, with nothing on screen to say why.
  useEffect(() => {
    if (engine !== 'sweep') setSweepRunning(false);
  }, [engine]);
  // Derived, never stored per engine: a keyframe capture has no sweep arm, so
  // reading the state directly would let a stale answer from the last sweep
  // mask the chip after the engine flipped back.
  const effectiveLens = sweepEffectiveLens(
    lens,
    engine === 'sweep' ? sweepEffectiveArm : null,
  );

  /** The AR pill, or null. The CONTAINER belongs to each tree — the
   *  keyframe tree stacks the flash pill under it, the sweep cell does not. */
  const renderSharedArPill = (): React.JSX.Element | null => (
    // ⚠ THE RAW LENS BELOW, NOT `effectiveLens` — AND THE ROUND THAT USED
    // `effectiveLens` HERE BUILT A DEAD CONTROL, which is the defect this
    // whole rung exists to remove.
    //
    // `effectiveLens` is strictly weaker: it equals '1x' on every arm when
    // the raw lens is '1x', so the ONLY state it newly admits is raw 0.5×
    // with the arm declined to ARKit — the shipped state on an uncalibrated
    // iPhone. There the pill RENDERS and pressing it moves nothing:
    // `deriveEffectiveCaptureSource` answers 'non-ar' from the RAW lens
    // whatever `arPreference` says, so the arm cannot leave ARKit while 0.5×
    // is still being asked for. A pill that lights up and changes nothing is
    // field defect #1, rebuilt one layer up.
    //
    // So Pano's rule is restored verbatim. The CHIP still paints
    // `effectiveLens`, because a chip names the GLASS and must not claim a
    // camera nothing opened; the PILL names a SETTING and must only be on
    // screen where that setting can actually move. Different questions —
    // which is the whole point of keeping the two rules apart.
    // ⚠ `hideBuiltInShutter` HIDES THE SHUTTER, NOT THE ARM CONTROL — and on
    // a sweep it is not even our shutter being hidden. The surface draws its
    // own, and pano+'s documented host config is exactly
    // `bottomBarOffset: 150, hideBuiltInShutter` (panoPlusModel.ts:2149), so
    // this term deleted the AR pill outright on the one host configuration
    // the sweep actually ships under — defect #1 rebuilt, one layer up.
    (!hideBuiltInShutter || engine === 'sweep')
      && arAllowed && nonArAllowed
      // ⚠ …OR THE CHIP CANNOT MOVE THE LENS, which is the surface's own
      // fourth term (`arPillVisible`: `effectiveLens === '1x' ||
      // !chipCanMoveLens`) and did not travel with the pill either.
      //
      // `LensChip` renders a Pressable only when `has0_5x`; without it the
      // chip collapses to a static `1×` (or the native-UW hand-off pill).
      // So on a body whose ultra-wide `<Camera>` cannot enumerate — which is
      // also the value during the async device resolve — a host starting at
      // `defaultLens="0.5x"` got NO AR pill (gated on the raw lens) and a
      // chip with no handler: zero live controls on the whole sweep screen,
      // and no way back. One control is always left on screen.
      && (lens === '1x' || !has0_5x)
      && isARSupportedOnDevice
      ? (
        <ARToggle
          arEnabled={arPreference}
          onToggle={handleARToggle}
          contentRotation={contentRotation}
        />
      )
      : null
  );

  const renderSharedLensChip = (): React.JSX.Element | null => (
    !arOnly ? (
      <LensChip
        lens={effectiveLens}
        onChange={handleLensChange}
        has0_5x={has0_5x}
        contentRotation={contentRotation}
        offerNativeUltraWide={offerNativeUW}
        onNativeUltraWide={onRequestNativeUltraWide}
        hideWhenSingle={hideLensChipWhenSingle}
        ultraWideFactor={capture.ultraWideFactor}
      />
    ) : null
  );

  /**
   * Write the sweep's verdict sidecar next to its pack.
   *
   * ⚠ THIS USED TO BE A MOUNT EFFECT ON `PanoPlusResultView`. That screen no
   * longer mounts, and the evidence it wrote is not optional — deleting the
   * screen without moving this would have silently stopped writing
   * `host_verdict.json` for every sweep. Called before the review is
   * stashed, so it happens even if the operator retakes.
   */
  const writeSweepVerdictSidecar = (result: PanoPlusCaptureResult): void => {
    if (result.sessionDir === '') return;
    const fs = loadVideoFileSystem();
    if (fs == null) return;
    const uri = `${fileUri(result.sessionDir).replace(/\/$/, '')}`
      + `/${PANO_PLUS_VERDICT_FILE}`;
    void fs
      .writeAsStringAsync(uri, panoPlusVerdictSidecar(result))
      .catch((e: unknown) => {
        // eslint-disable-next-line no-console
        console.warn('[pano+] verdict sidecar not written —', e);
      });
  };

  /**
   * The post-capture review surfaces, rendered by EVERY engine.
   *
   * ⚠ THESE USED TO LIVE ONLY IN THE KEYFRAME TREE, after the
   * `engine === 'sweep'` early return — so on a sweep neither was in the
   * tree and five public props did nothing at all: `capturePreview`,
   * `capturePreviewActions`, `onCapturePreviewClose`, `rectCrop` and
   * `showPreview`. The sweep showed its own screen instead, with one
   * hairline "Close" and no host actions, and the operator reported the
   * divergence.
   *
   * One helper, called from both trees, so they cannot drift again.
   */
  const renderReviewSurfaces = (): React.JSX.Element => (
    <>
    {/* v0.13.0 — built-in post-stitch / tap-to-preview modal.
        Visible when the host supplies `capturePreview`.  When
        undefined the modal stays hidden (visible=false) so it
        doesn't intercept touches.  Host is expected to clear
        `capturePreview` via `onCapturePreviewClose` on dismiss. */}
    <CapturePreview
      visible={capturePreview != null}
      imageUri={capturePreview?.imageUri ?? ''}
      imageWidth={capturePreview?.imageWidth}
      imageHeight={capturePreview?.imageHeight}
      title={capturePreview?.title}
      actions={capturePreviewActions}
      onClose={onCapturePreviewClose ?? noop}
    />

    {/* Post-capture review surface, shown after a panorama finalizes when
        `rectCrop` OR `showPreview` is on (handleHoldEnd stashed the pending
        result instead of emitting it).  `showCropControls={rectCrop}`:
          - crop mode (rectCrop) → draggable quad seeded on the max-inscribed
            rectangle; any capture warnings banner on top.
              - Use original → emit the original, un-cropped panorama.
              - Crop         → cropQuad (perspective-rectify when the quad
                isn't axis-aligned) overwrites the file in place; emit with
                the rectified dims + a cache-busting query so <Image> reloads
                it.  On any crop failure, fall back to the original.
          - preview-only mode (showPreview, no rectCrop) → bare image with
            [Retake]/[Confirm]; Confirm routes through onUseOriginal. */}
    <RectCropPreview
      // Remount per capture so the dragged-quad + layout state re-seed to
      // the new image (RectCropPreview seeds its quad once via useState).
      key={cropPending?.uri ?? 'crop'}
      visible={cropPending != null}
      imageUri={cropPending?.uri ?? ''}
      imageWidth={cropPending?.width ?? 0}
      imageHeight={cropPending?.height ?? 0}
      initialRect={cropPending?.initialRect}
      warnings={cropPending?.warnings.map((w) => w.message) ?? []}
      // ⚠ NEVER CROP A SWEEP. `cropQuad` rewrites the file IN PLACE
      // (see onUseOriginal below), and a pano+ canvas is referenced
      // by the pack in its `sessionDir` — cropping it desyncs the
      // two, and every offline harness then reads a pack whose
      // image is not the image that was measured. A sweep gets
      // preview-only: the bare image with [Retake] / [Confirm],
      // which is exactly what pano shows when `rectCrop` is off.
      showCropControls={
        rectCrop && cropPending?.captureResultObj.type !== 'panoplus'
      }
      topInset={insets.top}
      bottomInset={insets.bottom}
      copy={guidanceCopyResolved}
      // Carry the live memory pill onto the preview too (same settings.debug
      // gate as the camera), so the operator can watch the RSS spike when the
      // on-demand high-level re-stitch fires.
      showMemoryPill={settings.debug}
      // DEV overlay — show the stitcher's runtime choices (pipeline / warper /
      // route / seam / blend) + score / frames / size for this output, so the
      // operator can see HOW it was built.  __DEV__ only.
      debugInfo={
        __DEV__ && cropPending
          ? buildStitchDebugInfo(cropPending.captureResultObj)
          : undefined
      }
      onUseOriginal={(altUri) => {
        if (cropPending) {
          // altUri set → the user picked the alt (manual) pipeline's output
          // in the A/B toggle; emit THAT image (cache-bust for <Image>).
          onCapture?.(emitUri(
            altUri
              ? {
                  ...cropPending.captureResultObj,
                  uri: `${altUri}?t=${Date.now()}`,
                }
              : cropPending.captureResultObj,
          ));
        }
        setCropPending(null);
      }}
      onRetake={() => {
        // Discard this capture entirely — no onCapture — and return to
        // the live camera (statusPhase is already 'idle' post-finalize).
        setCropPending(null);
      }}
      onConfirm={async ({ quad, perspective }) => {
        if (!cropPending) return;
        const pending = cropPending;
        // perspective=true → rectify the dragged quad to an upright
        // rectangle (cropToQuad).  perspective=false (the user dragged a
        // ~rectangular quad) → crop to the quad's axis-aligned bounding box
        // — a plain crop, no warp.
        const xs = quad.map((p) => p.x);
        const ys = quad.map((p) => p.y);
        const cropPoints: Quad = perspective
          ? quad
          : [
              { x: Math.min(...xs), y: Math.min(...ys) },
              { x: Math.max(...xs), y: Math.min(...ys) },
              { x: Math.max(...xs), y: Math.max(...ys) },
              { x: Math.min(...xs), y: Math.max(...ys) },
            ];
        try {
          // cropQuad takes a BARE path; the stashed uri is a file://
          // URI.  Overwrites in place (pass the same path).
          const cropped = await cropQuad(
            toBareFilePath(pending.uri),
            cropPoints,
            undefined,
            { quality: 90 },
          );
          onCapture?.({
            ...pending.captureResultObj,
            // Cache-bust so <Image> reloads the overwritten file.
            uri: `${toFileUri(cropped.outputPath)}?t=${Date.now()}`,
            width: cropped.width,
            height: cropped.height,
          });
        } catch (err) {
          onError?.(
            new CameraError(
              'OUTPUT_WRITE_FAILED',
              err instanceof Error ? err.message : String(err),
              err,
            ),
          );
          // Fall back to the un-cropped panorama so the capture isn't
          // lost on a crop failure.
          onCapture?.(pending.captureResultObj);
        } finally {
          setCropPending(null);
        }
      }}
    />
    </>
  );

  /**
   * The two guard-rail explainers, rendered by EVERY engine.
   *
   * ⚠ BOTH USED TO LIVE ONLY IN THE KEYFRAME TREE, after the
   * `engine === 'sweep'` early return — the same miss that stranded the
   * review surfaces, one screen later. The guards themselves were wired to
   * the sweep in c935a6c and 358d434, so a sweep DID stop on a rotation and
   * DID stop on sideways drift; it just did it into an empty screen. The
   * operator saw the viewfinder return to idle with no panorama and no
   * reason given, which is worse than not guarding at all.
   *
   * One helper, called from both trees, so they cannot drift again — the
   * same shape as `renderReviewSurfaces` above.
   */
  const renderGuardModals = (): React.JSX.Element => (
    <>
    {/* v0.12.0 — Orientation drift modal.  Shows AFTER the SDK has
        auto-abandoned the capture (the useEffect above stops the
        engine + transitions to idle + fires onCaptureAbandoned).
        Modal exists purely to explain WHY the capture was
        cancelled.  Single OK button (no Continue) per the engine
        spec on cross-mode capture being best-effort, not supported. */}
    <OrientationDriftModal
      visible={drift.drifted && !driftModalDismissed}
      captureOrientation={drift.captureOrientation}
      currentOrientation={drift.currentOrientation}
      onAcknowledge={() => setDriftModalDismissed(true)}
    />

    {/* Item 6 — lateral-drift popup.  Latched true by the lateral
        effect AFTER it finalizes the capture; informational only,
        dismiss just clears the latch so the next capture starts
        fresh. */}
    <LateralMotionModal
      visible={lateralStopVisible}
      title={
        lateralWrongDirection
          ? guidanceCopyResolved.lateralWrongDirectionTitle
          : guidanceCopyResolved.lateralStopTitle
      }
      body={
        lateralWrongDirection
          ? guidanceCopyResolved.lateralWrongDirectionBody
          : guidanceCopyResolved.lateralStopBody
      }
      dismissLabel={guidanceCopyResolved.lateralStopDismiss}
      onDismiss={() => {
        setLateralStopVisible(false);
        setLateralWrongDirection(false);
      }}
    />
    </>
  );

  const renderHostPreview = (
    /** vision-camera lifecycle callbacks, owned by the calling cell. */
    lifecycle?: NonNullable<CameraViewProps['cameraProps']>,
    /** EVERY vision-camera error, including the swallowed lifecycle codes. */
    onAnyError?: (error: unknown) => void,
  ): React.JSX.Element => (
    <CameraView
        onAnyError={onAnyError}
        ref={visionCameraRef}
        device={capture.device}
        // Release the camera whenever the app is genuinely BACKGROUNDED, and
        // rebind on return — the standard vision-camera lifecycle contract
        // (v4 does not observe the host activity itself; the session follows
        // `isActive` alone). Holding a camera we cannot draw is wrong on its
        // own terms: it blocks other apps, burns battery, and Android may
        // revoke it anyway, surfacing as the swallowed
        // `camera-has-been-disconnected` → silent black preview.
        //
        // DEVICE EVIDENCE (Galaxy A35, 2026-07-24): this was previously gated
        // on the native-0.5× affordance being OFFERED, which meant a device
        // with a reachable ultra-wide kept its camera + AR session fully open
        // while the OEM camera launched over it. Samsung's `lmkd` runs a
        // camera-open "kill boost" (`camkillboostmode`, targeting the pid
        // that opened the camera) and KILLED the app mid-hand-off — with
        // 2.2 GB still free, so it is Samsung's camera-specific reclaim, not
        // generic pressure. The in-flight capture died with the process.
        // Staying small exactly when that reclaim runs is the whole point, so
        // the release must NOT be conditional on why we backgrounded.
        //
        // Only a true `'background'` releases — never iOS's transient
        // `'inactive'` (Control Centre, the notification shade, a
        // permission/Face-ID prompt, the app-switcher peek), which would
        // black-flash the preview mid-capture. See the `appActive` note.
        isActive={appActive}
        // iOS depth sidecar for tap photos (non-AR only): turns on
        // vision-camera depth delivery + the depth-capable format bias;
        // useCapture (threaded above) extracts the sidecar before the
        // orientation re-encode.
        captureDepthData={captureDepthData}
        // High-res still capture (document scanning): raises the photo cap so
        // the non-AR tap photo uses the device's largest 4:3 still (e.g.
        // 12.5 MP), while the 4:3 video/preview the frame-processor runs on is
        // unchanged.  Stitching/keyframes unaffected (they downscale
        // regardless); only the tap photo benefits.
        highResCapture={highResCapture}
        // Non-AR pano keyframe quality: floors the VIDEO stream at 1280
        // long edge (the FP stream IS the keyframe source here).
        keyframeQualityCapture={keyframeQualityCapture}
        // v0.23 anti-blur EXPOSURE CAP (non-AR): translated to an fps floor
        // on this vision-camera instance (see CameraView). 0/absent = off.
        maxExposureMs={settings.frameSelection.antiBlur?.maxExposureMs ?? 0}
        // `video={true}` is REQUIRED for takeSnapshot to work on iOS.
        // vision-camera v4's iOS implementation of takeSnapshot waits
        // for a frame on the video pipeline; with video disabled, the
        // promise never resolves and the JS frame-driver stalls after
        // the very first buffered preview frame.  Android takeSnapshot
        // works either way.  Pattern matches AuditCaptureScreen.tsx
        // which has run on `video` (true) for months without issue.
        video
        flash={effectiveFlash}
        // v0.13.2 — in multi-cam mode the lens is switched via zoom
        // on a single mounted device (0.5× → ultra-wide end, 1× →
        // wide baseline).  undefined in standalone/wide-only modes
        // (lens = device identity, no zoom).
        zoom={capture.deviceZoom}
        style={StyleSheet.absoluteFill}
        // F8 (FrameProcessor port) — host-supplied worklet runs on
        // the camera producer thread for every frame.  Only wired
        // in non-AR mode; AR mode uses ARCameraView which doesn't
        // expose a frame-processor seam.  See
        // docs/f8-frame-processor-plan.md.
        // ⚠ THE LIFECYCLE CALLBACKS LAST, so a call site that owns them
        // wins over anything above; a site that does not pass them gets a
        // preview that reports to nobody, which is correct for the
        // keyframe tree.
        cameraProps={{
          ...(effectiveFrameProcessor != null
            ? { frameProcessor: effectiveFrameProcessor }
            : {}),
          ...lifecycle,
        }}
        onError={(err) => {
          // CameraView already filters known transient lifecycle
          // errors (screen-lock, etc.) before invoking this.  What
          // reaches here is a real vision-camera runtime issue:
          // pull `code`/`message` defensively (the type is
          // `unknown` from CameraView's perspective) and wrap in
          // a SDK-typed `CameraError` so hosts get a stable shape.
          const e = err as { code?: string; message?: string };
          const codeStr = e?.code ?? 'unknown';
          const msg = e?.message ?? String(err);
          onError?.(new CameraError(
            'VISION_CAMERA_RUNTIME',
            `${codeStr}: ${msg}`,
            err,
          ));
        }}
      />
  );

  // ⚠ MOUNTED IS NOT DRAWING. `mountHostPreview` is a render decision; the
  // session behind it takes real time to open (this file's own constant
  // measures the RELEASE at ~479 ms, and the open is no faster). Telling the
  // surface "the host's preview is live" the instant we render the element
  // reopens the black-screen-with-no-explainer window for exactly that
  // latency — at first mount of the host arm, and again after every settle.
  // vision-camera answers this itself with `onPreviewStarted` — the
  // FIRST-FRAME event, passed in by the sweep cell alone (`onStarted` is
  // the session event and is deliberately not used; see the call site).
  const [hostPreviewStarted, setHostPreviewStarted] = useState(false);
  /** vision-camera's own reason the host preview is not up, or `''`. Shown
   *  by the sweep surface instead of the transient handoff caption, which
   *  would otherwise sit over a permanent failure for ever. */
  const [hostPreviewError, setHostPreviewError] = useState('');

  // ── AN OWNERSHIP FLIP IS A CAMERA HANDOFF, AND NEEDS A SETTLE ────────
  // Two idle affordances move the answer with the surface still mounted (the
  // AR pill, the lens pill). Without a window, `<CameraView>` unmounts and
  // the surface's idle effect opens its own AVF client in the SAME frame,
  // while Camera2 is still releasing the first — ERROR_CAMERA_IN_USE on a
  // phone where nothing is wrong but the ordering. So the loser releases
  // first and the winner waits; see `sweepCameraHandoff`.
  const [ownershipSettling, setOwnershipSettling] = useState(false);

  // Who owns the camera on the sweep arm — ONE boolean, so the preview and
  // the native start options cannot disagree.
  //
  // ⚠ THE ASSEMBLY IS ITS OWN PURE FUNCTION, not an object literal here, and
  // that is a fix rather than tidiness. Three review rounds running, the
  // PREDICATE was covered by a truth table while the argument list feeding
  // it was not — so a term could be re-pointed at the wrong source with
  // `tsc` clean and every case green. Both defects that actually shipped
  // were in the wiring: `sweepPoseSource` read `<Camera>`'s own state
  // instead of the merged value, and the multicam term read the merged lens
  // instead of the one that selected the device.
  // ⚠ THE **EFFECTIVE** SOURCE, NOT THE RAW PREFERENCE.
  //
  // Pano's rule is that 0.5× implies the non-AR arm —
  // `deriveEffectiveCaptureSource` returns 'non-ar' at 0.5× without
  // mutating `arPreference`. Now that `<Camera>`'s lens chip drives the
  // sweep too, reading the raw preference here would let the chip move the
  // lens to 0.5× while the sweep still asked ARKit to open the ultra-wide.
  // Reading the effective source reproduces the sweep's whole "0.5× ⇒
  // decoupled arm" policy as a CONSEQUENCE of Pano's rule rather than as a
  // second copy of it.
  const sweepPoseSource = sweepMergedPoseSource(
    sweep?.poseSource,
    effectiveCaptureSource === 'ar',
  );
  const sweepLens = sweepMergedLens(sweep?.lens, lens);
  const hostOwnsSweepCameraLive = sweepHostOwnsCamera(sweepOwnershipInput({
    isAR,
    platformOS: Platform.OS,
    cameraUnmounting: cameraShouldUnmount(
      inFlightTransition,
      arSupportPending,
      statusPhase,
      sweepHandoffPending,
    ),
    bagPoseSource: sweep?.poseSource,
    arPreference,
    pluginReady: sweepDriver.isReady,
    deviceId: capture.device?.id ?? '',
    captureMode: capture.captureMode,
    lens,
    hostFrameProcessorPresent: hostFrameProcessor != null,
  }));

  const prevOwnsRef = useRef(hostOwnsSweepCameraLive);
  useEffect(() => {
    // ⚠ NEVER WHILE A SWEEP IS RUNNING, AND THE EARLY RETURN MUST NOT
    // RECORD. `mountHostPreview` ANDs the latch with the window, so a settle
    // begun mid-sweep would unmount the preview the engine is being fed
    // from — the exact thing the latch forbids, arriving through the fix for
    // a different problem. Leaving `prevOwnsRef` untouched keeps the
    // transition PENDING, so the handoff happens when the sweep ends.
    if (!sweepShouldSettle({
      latch: sweepOwnershipLatch,
      previous: prevOwnsRef.current,
      live: hostOwnsSweepCameraLive,
    })) return undefined;
    prevOwnsRef.current = hostOwnsSweepCameraLive;
    setOwnershipSettling(true);
    const timer = setTimeout(
      () => { setOwnershipSettling(false); },
      SWEEP_CAMERA_RELEASE_SETTLE_MS,
    );
    return () => { clearTimeout(timer); };
  }, [hostOwnsSweepCameraLive, sweepOwnershipLatch]);

  const { mountHostPreview, surfaceFrameSource } = sweepCameraHandoff({
    live: hostOwnsSweepCameraLive,
    latch: sweepOwnershipLatch,
    settling: ownershipSettling,
  });

  // ⚠ ONE EXPRESSION FOR "IS THE HOST'S PREVIEW IN THE TREE", used by the
  // mount, by `hostPreviewLive` and by the clearing effect below.
  //
  // It was `mountHostPreview` in all three places while the element's real
  // condition carried `&& the review is closed` — so the ONE unmount that
  // happens on the dominant repeat path (sweep → review → dismiss → sweep)
  // was invisible to the effect. `onPreviewStopped`/`onStopped` do not fire
  // for an unmount either, so the flag stayed true, and the remounted
  // `<CameraView>` — a brand-new instance with no session yet — was reported
  // as LIVE. Transparent root, explainer suppressed, black underneath: the
  // defect this rung is named after, on every capture after the first.
  const hostPreviewMounted =
    engine === 'sweep' && mountHostPreview && cropPending == null;
  // ⚠ NO DEPENDENCY ARRAY, DELIBERATELY — which normally reads as a
  // mistake, so: the edge-triggered form missed the case where the flag is
  // set WHILE `hostPreviewMounted` is already false (the keyframe tree's
  // preview did exactly that), because the key never changed and the effect
  // never re-ran. Clearing on every render while unmounted cannot miss a
  // writer. React bails out of an identical `setState`, so this does not
  // loop and costs nothing once settled.
  //
  // BOTH flags: an error string outlives its session otherwise, and
  // `panoPlusCameraOffNotice` prints it BEFORE the handoff caption — so a
  // resolved fault would caption the next handoff window.
  useEffect(() => {
    if (!hostPreviewMounted) {
      setHostPreviewStarted(false);
      setHostPreviewError('');
    }
  });

  // ⚠ THE EARLY RETURN IS THE **AR** CELL ONLY (S7).
  //
  // On the AR arm the sweep surface mounts its own `<ARCameraView>`, and
  // `<Camera>` mounts one too — two `RNSARSession.shared.start()` calls
  // against one camera, with no compile error and a black preview on a
  // phone. Returning early is still the only shape in which exactly one is
  // alive, so that cell is unchanged.
  //
  // The NON-AR sweep is the opposite problem: there the host's own
  // `<CameraView>` IS the camera, and the sweep is fed from it by the
  // `panoplus_sweep_ingest` frame processor. So it falls through to the
  // main tree, where the viewfinder, the shutter and the chrome already
  // exist — and the surface renders OVER it with `frameSource="host"`, as
  // chrome with no camera of its own.
  if (engine === 'sweep') {
    return (
      <HostJsLandscapeContext.Provider value={jsLandscape}>
        <View style={[styles.container, style]}>
          {/* ── THE NON-AR SWEEP RUNS ON THE HOST'S OWN PREVIEW (S7) ──
              On the AR arm the surface mounts its own `<ARCameraView>` and
              nothing else may; on the non-AR arm `<CameraView>` IS the
              camera and the sweep is fed from it by the
              `panoplus_sweep_ingest` frame processor. Same element the
              keyframe engine uses — one definition, so the two cannot
              drift.

              ⚠ GATED ON THE OWNERSHIP ANSWER, NOT ON `!isAR`. The two are
              not the same question: `!isAR` is "the sweep is not using
              ARKit", and this needs "the sweep's native recorder will open
              NOTHING". On iOS today the second is false however the first
              reads, and mounting this there puts two sessions on one
              camera.

              ⚠ AND THE KEYFRAME CHROME STAYS OUT. Falling through to the
              main tree would bring the settings modal, the thumbnail strip
              and the band overlay with it — keyframe furniture over a
              sweep. The sweep's own HUD is the surface's. */}
          {hostPreviewMounted && renderHostPreview({
            // ⚠ ONLY THE SWEEP CELL PASSES THESE. They write state that
            // means "the SWEEP's host preview is drawing", so the keyframe
            // tree's copy of this element must not have them.
            //
            // `onPreviewStarted`, NOT `onStarted`: vision-camera documents
            // the latter as the SESSION event — "outputs can start
            // receiving frames … but might not have received any yet" — so
            // gating on it narrows the transparent-over-black window rather
            // than closing it. `onStopped` is kept as a belt for the
            // `isActive={false}` teardown, which `onPreviewStopped` alone
            // does not cover.
            onPreviewStarted: () => {
              setHostPreviewStarted(true);
              setHostPreviewError('');
            },
            onPreviewStopped: () => { setHostPreviewStarted(false); },
            onStopped: () => { setHostPreviewStarted(false); },
            // EVERY error, including the three transient lifecycle codes
            // `onError` deliberately swallows — which are exactly the ones
            // that leave this preview dark with nothing else to say.
            // Without them the handoff caption sits over a permission
            // denial for ever. Passed as `onAnyError` (the second argument)
            // rather than through `cameraProps.onError`, which would
            // REPLACE `CameraView`'s own filter for the inner camera and
            // change what the host sees.
          }, (err: unknown) => {
            const e = err as { code?: string; message?: string };
            setHostPreviewError(
              `${e?.code ?? 'unknown'}: ${e?.message ?? String(err)}`,
            );
          })}
          {cropPending == null && (
          // ⚠ THE SURFACE UNMOUNTS BEHIND THE REVIEW, and must keep doing
          // so. It owns a camera; leaving it mounted behind the review
          // holds ARKit/Camera2 for as long as the operator reads.
          // `RectCropPreview` is a `<Modal>`, i.e. an overlay rather than a
          // replacement, so this gate is what releases the device — keyed
          // on `cropPending` now that the review is the shared one.
          <PanoPlusCaptureSurface
            ref={sweepRef}
            // ── THE CONTROLS ARE `<Camera>`'S, NOT A SECOND SET ──────────
            //
            // The sweep surface draws its OWN AR and lens pills, and it
            // gates each one on being given somewhere to write:
            // `onPoseSourceChange != null` and `onLensChange != null` are
            // the literal conditions. A host that does not pass them gets NO
            // pill rather than a dead one — which is the right default, and
            // is exactly what happened here: switching to the sweep made
            // both controls vanish, because this delegation passed neither.
            //
            // They are wired to `<Camera>`'s OWN `arPreference` and `lens`,
            // the same state the keyframe path's controls use. So the pills
            // are in the same place before and after an engine switch, they
            // start at the value the operator last chose, and a change made
            // on one engine is still in force on the other. Two surfaces
            // with two independent copies of "AR on" is how an operator ends
            // up reading one and getting the other.
            //
            // ⚠ UNLESS THE HOST PINS ONE THROUGH THE BAG — see the handlers
            // below, which are withheld in that case so the pill is absent
            // rather than dead.
            // ── S5: ASK FOR THE VISION-CAMERA ARM ───────────────────────
            // Same boolean that chose the preview above, deliberately: the
            // declaration "the host owns the camera" and the request "do
            // not open one" have to be the same fact, or the surface draws
            // no viewfinder while native takes the device. See
            // `hostOwnsSweepCamera` for what each of its terms prevents.
            // ── A PILL THE HOST HAS PINNED IS NOT SHOWN AT ALL ──────────
            // The surface gates each pill on its callback being non-null —
            // "a host that does not pass them gets NO pill rather than a
            // dead one", which is its own doctrine and the right default.
            //
            // ⚠ AND A BAG-PINNED VALUE MAKES THE PILL DEAD, which the
            // comment above this block used to deny: it said the pills are
            // wired to `<Camera>`'s own `arPreference` and `lens`. They
            // are — but the VALUE handed back is the merged one, and the
            // bag wins, so with `sweep.poseSource` set the handler runs,
            // the state moves, the prop does not, and the pill snaps back
            // under the operator's finger. A control that visibly refuses
            // its own input is worse than an absent one.
            // ⚠ WITHHELD UNCONDITIONALLY — `<Camera>` DRAWS THESE NOW.
            //
            // The surface gates each of its own pills on the matching
            // callback being non-null: "a host that does not pass them gets
            // NO pill rather than a dead one" is its own doctrine
            // (`arPillVisible`, `lensChipVisible`). Passing null is
            // therefore the supported way to say "the host owns this
            // control", and it deletes the clones that produced two of the
            // four field defects.
            //
            // They are not merely duplicates — they answer a DIFFERENT
            // question. The clone paints `armNotice.effectivePoseSource`
            // (which arm will run) and its `has0_5x` is `ultraWideOfferable`
            // (whether the pano+ ladder will allow 0.5× on that arm). On an
            // uncalibrated phone both collapse: the pill pins ON and cannot
            // be tapped off, and the chip becomes a static `1×` with no
            // `Pressable`. `<Camera>`'s pills show the SETTING and always
            // move; what will actually run stays the arm notice's job, and
            // the surface still prints it.
            // (assigned AFTER `{...sweep}` — see below.)
            // ⚠ DEFAULTS BEFORE THE SPREAD, SO THE HOST ALWAYS WINS.
            // The surface's own prop defaults were never a configuration
            // anyone ran — its one host passed everything off a flag store,
            // so `{...sweep}` with `sweep` undefined fired every bare default
            // at once, on a device, for the first time. On the A35 that chose
            // the ARCore pose arm in a dim room and the sweep painted nothing
            // (see `sweepDefaults.ts` for the measurement).
            {...sweep}
            // ⚠ THESE WERE ABOVE THE SPREAD AND THE COMMENT SAID
            // "WITHHELD UNCONDITIONALLY", which was false: a bag carrying
            // either writer overwrote the `undefined` and the surface drew
            // its clone again. Moved down to the position the four props
            // below already occupy, for the identical reason.
            onPoseSourceChange={undefined}
            onLensChange={undefined}
            // ⚠ `guidanceCopy` IS A MERGE, NOT AN OVERRIDE, and it is after
            // the spread because the merge has to see the bag's value.
            //
            // `<Camera>`'s own `guidanceCopy` is the ONE prop a host already
            // uses to localise capture-time text, and on a sweep it reached
            // everything `<Camera>` draws (the REC banner, both guard-rail
            // modals) and nothing the SURFACE draws — which is the text the
            // operator actually reads during a pano+ hold. `tooFast` is the
            // one sentence with a rung that means the same thing on both
            // engines, so it is carried across by name; the other seventeen
            // rungs have no keyframe counterpart and are addressed by rung
            // through the bag.
            //
            // A bag entry for `'too-fast'` WINS, because it is the more
            // specific statement of the same intent.
            guidanceCopy={
              guidanceCopy?.tooFast != null
                ? {
                    'too-fast': { headline: guidanceCopy.tooFast },
                    ...(sweep?.guidanceCopy ?? {}),
                  }
                : sweep?.guidanceCopy
            }
            // ── AFTER THE SPREAD, AND THE TYPE ALSO FORBIDS THEM ─────────
            // These are `<Camera>`'s ANSWER to "who holds the back camera",
            // not a host knob — `SweepOptions` omits all four, so the bag
            // cannot carry them and this position is the belt to that
            // braces. A host copy winning here made the impossible state
            // reachable: `frameSource: 'host'` with no preview mounted is a
            // black screen with the explainer suppressed.
            //
            // `poseSource` is the MERGED value the predicate ALSO judged,
            // so the arm cannot drift between this line and that one.
            //
            // ⚠ `lens` IS MERGED HERE AND **NOT** IN THE PREDICATE, and that
            // asymmetry is deliberate rather than an oversight. This prop
            // says which lens the SURFACE should show; the predicate's term
            // asks which PHYSICAL DEVICE is mounted, and only `<Camera>`'s
            // own `lens` moves that (`useCapture({ lens })`). Feeding the
            // merged value to the predicate let a bag `lens` disarm the
            // multicam guard while the device stayed where it was. See
            // `sweepOwnershipInput`.
            frameSource={surfaceFrameSource}
            // The handoff's other half: `'host'` says who owns the camera,
            // this says whether it is on screen yet. See
            // `sweepCameraHandoff` — for ~600 ms the answers differ, and
            // the surface must not go transparent over nothing.
            hostPreviewLive={sweepPreviewLive({
              mounted: hostPreviewMounted,
              started: hostPreviewStarted,
            })}
            hostPreviewError={hostPreviewError}
            vcPluginArm={mountHostPreview}
            vcCameraId={mountHostPreview ? (capture.device?.id ?? '') : ''}
            poseSource={sweepPoseSource}
            lens={sweepLens}
            // ⚠ THE ARM THAT WILL REALLY RUN, COMING BACK UP. The fallback is
            // decided inside the surface from a calibration plan `<Camera>`
            // cannot see, and the shared lens chip has to know about it or it
            // paints a lens ARKit cannot deliver. See `sweepEffectiveLens`.
            onEffectiveArmChange={handleSweepEffectiveArm}
            // ⚠ MERGED KEY-BY-KEY, NOT SPREAD. `engineOptions` is an object,
            // so letting the host's copy through the spread above would
            // REPLACE the defaults wholesale — a host that set one option
            // would silently lose the other six, including the trajectory
            // continuation that removes the elbow. Host keys still win.
            engineOptions={{ ...SWEEP_ENGINE_DEFAULTS, ...sweep?.engineOptions }}
            // ⚠ AFTER THE SPREAD, LIKE `engineOptions`, AND FOR THE SAME
            // REASON. This gates the frame-processor worklet: a host copy
            // landing on top would leave the gate shut for the whole sweep
            // and the engine would receive nothing, silently. The host's
            // own handler is still called — it is composed, not replaced.
            onControlsState={(st: { busy: boolean }) => {
              // `busy` is `phase === 'finishing'` — see `sweepFinalizing`.
              setSweepFinalizing(st.busy);
              sweep?.onControlsState?.(st as never);
            }}
            onSweepingChange={(sweeping: boolean) => {
              // Latch ownership at the first edge and release it at the
              // last — see `sweepOwnershipLatch`. Set from the LIVE value,
              // not the latched one, or a latch could never be replaced.
              setSweepOwnershipLatch(sweeping ? hostOwnsSweepCameraLive : null);
              // A SEPARATE boolean from the latch, deliberately: the latch
              // answers "who owns the camera", which is `false` on the AR
              // arm and null when idle — two different falsy meanings. The
              // pills need the PHASE.
              setSweepRunning(sweeping);
              if (!sweeping) setSweepFinalizing(false);
              sweepDriver.setActive(sweeping);
              sweep?.onSweepingChange?.(sweeping);
            }}
            onComplete={(result: PanoPlusCaptureResult) => {
              // ⚠ THE REVIEW IS A GATE, NOT A VIEWER — the panorama's shape,
              // and the reason this changed.
              //
              // It used to fire `onCapture` FIRST and then mount a
              // sweep-only screen, which made Retake structurally
              // impossible (the host already had the result) and gave the
              // operator a different review from photo and pano: a bare
              // absolute `<View>` with one hairline "Close", no host
              // actions, while `capturePreview`, `capturePreviewActions`,
              // `onCapturePreviewClose`, `rectCrop` and `showPreview` were
              // all silently inert on this engine.
              //
              // Now it stashes, exactly as `handleHoldEnd` does for a
              // panorama, and `onCapture` fires from the review's Confirm —
              // so Retake discards the capture and one result UI serves
              // every engine.
              // ⚠ THE WARNINGS RIDE THE RESULT, not just the review banner.
              // `onCapture(result).warnings` is the host-facing channel and
              // every other engine fills it; the sweep emitted a result with
              // no `warnings` key at all, so a host reading it uniformly got
              // `undefined` on one engine and an array on the others.
              const sweepWarnings = panoPlusCaptureWarnings(result.summary);
              const captureResultObj = {
                ...result, ok: true as const, warnings: sweepWarnings,
              };
              // The verdict sidecar used to be written by the review screen's
              // mount effect. That screen no longer mounts, so the write
              // moves here — before the stash, so it happens even if the
              // operator retakes.
              writeSweepVerdictSidecar(result);
              // ⚠ THE SAME GATE THE KEYFRAME ENGINE USES (:3000), and it was
              // the dims ALONE here. `engine` selects which engine the hold
              // runs and changes nothing else — but a host using the
              // DOCUMENTED defaults (`rectCrop` false, `showPreview` false,
              // whose JSDoc says "with both off, `onCapture` fires
              // immediately with no UI") got a full-screen review it never
              // asked for the moment it flipped `engine`, and its
              // auto-advance flow stalled behind a modal with no host-visible
              // way to dismiss it. Both props were observably inert on the
              // sweep's result path.
              if ((rectCrop || showPreview)
                  && result.width > 0 && result.height > 0) {
                setCropPending({
                  // ⚠ SCHEMED HERE, NOT UPSTREAM. `panoPlusResultOf` returns
                  // `summary.canvasPath` VERBATIM — a bare native path
                  // (`/data/user/0/…/canvas.jpg`) — and that is the public
                  // `PanoPlusCaptureResult.uri` contract, deliberately. But
                  // `<Image>` needs a scheme, so the review that replaced
                  // `PanoPlusResultView` has to do what that screen did:
                  // it rendered `source={{ uri: fileUri(result.uri) }}`.
                  //
                  // Dropping this is why defect #4 ("the preview modal is not
                  // the same as the one for photo and pano") was answered with
                  // the right modal showing an EMPTY FRAME — Retake, Confirm,
                  // the warnings and the debug pill all painted; the panorama
                  // did not. The keyframe path has always schemed its own
                  // (`toFileUri(result.panoramaPath)`); only this one did not.
                  uri: toFileUri(result.uri),
                  width: result.width,
                  height: result.height,
                  // NOT re-schemed: the public result keeps the bare path.
                  captureResultObj,
                  // ⚠ THE SWEEP'S OWN VERDICT, not an empty array. This was
                  // `warnings: []` on every sweep while `panoPlusIntegrity`
                  // — 352 lines of hole/seam/banding/clipping analysis —
                  // reached the pack and nothing else. The channel is
                  // shared and was already wired; the sweep fed it nothing,
                  // so one engine warned and the other was silent through
                  // the same `onCapture`.
                  warnings: sweepWarnings,
                });
              } else {
                // No image to review — emit rather than strand the capture.
                onCapture?.(emitUri(captureResultObj));
              }
            }}
            onFailure={(failure: PanoPlusFailure) => {
              // ⚠ A GUARD RAIL IS NOT A FAILURE, AND `onError` IS NOT ITS
              // CHANNEL. `abandon()` emits `panoplus-abandoned` for every
              // caller of the handle, but inside `<Camera>` the only caller
              // is the rotation guard one screen up, and it has ALREADY told
              // the host through `onCaptureAbandoned` — the same single
              // channel, with the same reason, that the keyframe engine uses
              // for the identical event. Letting it through as well gave a
              // host that surfaces `onError` (a toast, a Sentry breadcrumb) a
              // `PANORAMA_START_FAILED` for a capture that started fine, ran,
              // and was deliberately stopped — with a code naming a phase it
              // was nowhere near. On the keyframe engine the same rotation
              // produces no `onError` at all.
              if (failure.code === 'panoplus-abandoned') return;
              onError?.(
                // A sweep refusal is a capture failure, not an engine one:
                // the engine IS available here — this is the engine saying no
                // to this attempt. `ENGINE_UNAVAILABLE` would send a reader
                // to the build, which is the wrong place.
                //
                // The original failure rides on `cause`, so the sweep's own
                // code (`panoplus-busy`, `panoplus-io`, …) and its counters
                // survive the hop instead of being flattened to a string.
                new CameraError(
                  'PANORAMA_START_FAILED',
                  failure.message ?? String(failure.code ?? 'sweep failed'),
                  failure,
                ),
              );
            }}
          />
          )}

          {/* ── `<Camera>`'S OWN CHROME, ON THE SWEEP TOO ──────────────
              The whole point of `engine` being a prop: the operator gets
              the same AR pill and the same lens chip whichever engine the
              hold runs. Same elements as the keyframe tree, from the same
              state, via the same helpers — so they cannot drift.

              Rendered AFTER the surface so they sit above its HUD, and
              `pointerEvents="box-none"` so the surface's own shutter and
              gestures still receive touches through the container.

              ⚠ AND THAT IS EXACTLY WHY `chromeSuppressed` IS IN THIS GATE.
              "After the surface" means ON TOP OF IT, including on top of a
              full-screen overlay the surface puts up. The surface removes
              BOTH of its own pills while the first-run basis-acquisition
              card is showing, and the note beside that term names the
              hazard precisely: "the suppression would summon the more
              damaging of the two controls."

              That term did not travel when the pills moved here. Measured:
              `<Camera engine="sweep" />` with default props on an
              uncalibrated phone rendered the AR pill live on top of the
              calibration card, and ONE tap moved the arm to ARKit, which
              made `armWantsBasis` false and unmounted the overlay — the
              one-time basis measurement cancelled by a control the surface
              had deliberately taken off that screen. `hostChromeTopPt` was
              the same class of miss, found one round earlier. */}
          {cropPending == null
            && !(sweepEffectiveArm?.chromeSuppressed ?? false) && (
            <>
              <View
                // ⚠ CLEARS THE HOST'S OWN TOP CHROME TOO. The surface takes
                // `hostChromeTopPt` and adds it to the top inset for exactly
                // this reason (`withHostChromeTop`) — a host with a docked
                // banner draws over anything placed at the bare inset. The
                // pill moved out of the surface and left that term behind,
                // so on such a host it sits under the banner. `Math.max`
                // rather than `+`: `pillStackTop` already clears `<Camera>`'s
                // OWN header, and the two are alternatives, not a stack.
                style={[styles.pillStack, {
                  top: Math.max(pillStackTop, sweep?.hostChromeTopPt ?? 0),
                }]}
                pointerEvents="box-none"
              >
                {renderSharedArPill()}
              </View>
              {/* ⚠ THE REC BANNER AND THE COUNTDOWN, ON THE SWEEP TOO.
                  Both are `<Camera>`'s and both lived only in the keyframe
                  tree, so a sweep had no "you ARE recording" cue at all and
                  no wall-clock cap — the surface's own note names the gap
                  ("Pano's words on the same screen — its REC banner aside").

                  `phase` is derived rather than read: `statusPhase` stays
                  'idle' on a sweep by design (widening it would start the
                  keyframe engine's internals), so the shared overlay is
                  driven by the same `captureRecording` the guards use. */}
              <CaptureStatusOverlay
                phase={sweepRunning ? 'recording' : statusPhase}
                topInset={insets.top}
                recordingStartedAt={recordingStartedAt ?? undefined}
                tooFast={recordingTooFast}
                recordingMessage={
                  recordingTooFast
                    ? guidanceCopyResolved.tooFast
                    : guidanceCopyResolved.statusRecording
                }
                stitchingMessage={guidanceCopyResolved.statusStitching}
              />
              <CaptureCountdownOverlay
                visible={sweepRunning && maxPanDurationMs > 0}
                secondsRemaining={countdownSeconds}
                orientation={deviceOrientation}
              />
              <View
                // ⚠ DERIVED FROM THE SURFACE'S OWN ARITHMETIC, NOT A LITERAL.
                // This was `bottom: 132` under a comment claiming the two
                // sides agreed "by construction" through `bottomBarOffset`.
                // Nothing connected them: the surface's slot is computed
                // from the insets, `bottomBarOffset` and whether it draws
                // the shutter, and a host setting any of the three slid its
                // bar out from under a chip that did not move. A mutation
                // to `bottom: 0` — the chip fully behind the shutter — left
                // the entire suite green.
                style={[styles.sweepLensChipDock, {
                  // ONE inset source: the surface reads
                  // `SafeAreaInsetsContext` and `<Camera>` reads
                  // `useSafeAreaInsets()`, which is the same provider. (The
                  // review measured the surface's as `undefined` — that is
                  // the render harness having no provider, not a device
                  // fact, and it is why the two agree here without a prop.)
                  bottom: panoLensChipBottomPt(
                    insets.bottom,
                    sweep?.bottomBarOffset ?? 0,
                    sweep?.hideBuiltInControls ?? false,
                  ),
                }]}
                pointerEvents="box-none">
                {renderSharedLensChip()}
              </View>
            </>
          )}

          {/* ── THE SAME REVIEW SURFACES THE OTHER ENGINES USE ─────────
              Rendered from one helper so the sweep cell and the main tree
              cannot drift — which is exactly how they drifted before:
              both of these lived only after the early return, so on a
              sweep neither existed and five public props did nothing. */}
          {renderGuardModals()}
          {renderReviewSurfaces()}
        </View>
      </HostJsLandscapeContext.Provider>
    );
  }

  return (
    <HostJsLandscapeContext.Provider value={jsLandscape}>
    <View
      style={[styles.container, style]}
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        if (width <= 0 || height <= 0) return;
        setMeasuredRoot((prev) =>
          prev && prev.width === width && prev.height === height
            ? prev
            : { width, height },
        );
      }}
    >
      {/* Preview — AR or non-AR (or the brief "switching…" placeholder
          while the previous session tears down).  Conditional mount so
          only ONE camera component is alive at a time; matches the
          monorepo's working pattern and avoids the Camera2-in-use
          conflict that "always mount both" caused on Android. */}
      {cameraShouldUnmount(
        inFlightTransition,
        arSupportPending,
        statusPhase,
        sweepHandoffPending,
      ) ? (
        // statusPhase==='stitching' UNMOUNTS the camera so vision-camera
        // frees the AVCaptureSession + preview buffers during the stitch
        // (V12.14.8 OOM fix).  The CaptureStatusOverlay renders the
        // "Stitching…" state on top, so no placeholder label is needed
        // in that case — only for the camera-switch transition.
        <View style={[StyleSheet.absoluteFill, styles.transitionPlaceholder]}>
          {statusPhase === 'stitching' ? null : (
            <Text style={styles.transitionLabel}>Switching camera…</Text>
          )}
        </View>
      ) : isAR ? (
        <ARCameraView
          ref={arViewRef}
          style={StyleSheet.absoluteFill}
          arFrameProcessor={arFrameProcessor}
          enableDepth={enableDepth}
          highResCapture={highResCapture}
          keyframeQualityCapture={keyframeQualityCapture}
          enableAnchors={enableAnchors}
          enableMesh={enableMesh}
          enableFeaturePoints={enableFeaturePoints}
          planeDetection={planeDetection}
          onArFrame={onArFrame}
          arFrameMetaInterval={arFrameMetaInterval}
          onArPluginResult={onArPluginResult}
          overlays={overlays}
        />
      ) : (
        renderHostPreview()
      )}

      {/* REC banner + record border (during recording / stitching).  v0.16
          — the banner + border are GREEN normally and turn RED (with the
          too-fast copy) when the pan is too fast: the single speed cue that
          replaced the always-red border + separate amber pill. */}
      <CaptureStatusOverlay
        phase={statusPhase}
        topInset={insets.top}
        recordingStartedAt={recordingStartedAt ?? undefined}
        tooFast={recordingTooFast}
        recordingMessage={
          recordingTooFast
            ? guidanceCopyResolved.tooFast
            : guidanceCopyResolved.statusRecording
        }
        stitchingMessage={guidanceCopyResolved.statusStitching}
      />

      {/* v0.13.1 — the built-in pan-guidance overlays
          (IncrementalPanGuide drift marker + PanoramaGuidance speed
          pill) were removed from the public surface.  They remain in
          the tree as internal-only components but <Camera> no longer
          renders them and the `panGuide` / `panoramaGuidance` props
          are gone.  Re-wire here if a host need resurfaces. */}

      {/* feature/pano-ux-guidance — in-capture guidance overlays.
          All gated on `panGuidance`; each renders null when not
          visible so they can mount unconditionally. */}
      {/* Item 6 — live keyframe counter "k / n" (top-centre).  The primary
          capture HUD; the capture auto-finalizes when k reaches n. */}
      <CaptureFrameCounterOverlay
        visible={statusPhase === 'recording' && panGuidance}
        framesCaptured={acceptedKeyframeCount}
        framesMax={keyframeMaxCount}
        orientation={deviceOrientation}
      />
      {/* Item 5 — optional blinking time countdown (top corner), shown only
          when the host opts into a wall-clock cap via maxPanDurationMs. */}
      <CaptureCountdownOverlay
        visible={statusPhase === 'recording' && panGuidance && maxPanDurationMs > 0}
        secondsRemaining={countdownSeconds}
        orientation={deviceOrientation}
      />
      {/* Item 3 — brief pan how-to graphic + direction arrow. */}
      <PanHowToOverlay
        visible={statusPhase === 'recording' && panGuidance && howToVisible}
        orientation={deviceOrientation}
      />
      {/* Item 4 — "moving too fast" feedback is no longer a separate pill.
          v0.16 — it's consolidated into the CaptureStatusOverlay banner +
          border above, which turn from GREEN to RED (with the too-fast copy)
          when `recordingTooFast` — one calm cue instead of an always-red
          border plus a second amber pill. */}

      {/*
        2026-05-22 (audit F9 + F3) — debug UI suite, all gated on
        settings.debug.  Mounts in <Camera> automatically; Layer-2
        hosts can import the individual components from the public
        API and compose their own debug surface.  Layout:
          - top-left:    orientation pill (purple)
          - top-center:  keyframes pill (green/amber)
          - top-right:   memory pill (green/amber/red)
          - top-center:  stitch-stats toast (dark capsule, transient)
          - left-mid:    detailed metrics block (overlap, processing,
                         imuΔ, etc.) — uses CaptureDebugOverlay
       */}
      {settings.debug && (
        <>
          <CaptureOrientationPill
            orientation={deviceOrientation}
            topInset={insets.top}
          />
          <CaptureKeyframePill
            state={incremental.state}
            topInset={insets.top}
          />
          <CaptureMemoryPill topInset={insets.top} />
          <CaptureDebugOverlay
            incrementalState={incremental.state}
            imuTranslationMetres={
              isNonAR ? imuGate.getTranslationMetres() : null
            }
            captureSource={effectiveCaptureSource}
            frameSelectionMode={settings.frameSelection.mode}
            stitchMode={settings.stitcher.stitchMode}
          />
        </>
      )}
      {/* Toast renders regardless of `settings.debug` — toast hook
       *  is only ever fired from the debug-gated path, but mounting
       *  unconditionally lets Layer-2 hosts wire their own showFor()
       *  callers without needing a separate mount. */}
      <CaptureStitchStatsToast
        message={stitchToast.message}
        topInset={insets.top}
      />

      {/* v0.13.0 — built-in CaptureHeader, gated on `headerTitle`.
          When the header is mounted, it absorbs the settings gear
          on its right side (avoids stacking with the standalone
          gear).  Hosts that DON'T set `headerTitle` get the legacy
          standalone gear, still gated on `showSettingsButton`. */}
      {headerTitle != null ? (
        <View style={styles.headerWrap} pointerEvents="box-none">
          <CaptureHeader
            title={headerTitle}
            onBack={onHeaderBack}
            backLabel={headerBackLabel}
            guidance={headerGuidance}
            colors={headerColors}
            topInset={insets.top}
            onSettingsPress={
              showSettingsButton
                ? () => setSettingsModalVisible(true)
                : undefined
            }
          />
        </View>
      ) : (
        showSettingsButton && (
          <SettingsButton
            topInset={insets.top}
            onPress={() => setSettingsModalVisible(true)}
          />
        )
      )}

      {/*
        v0.12.0 — Orientation-aware bottom controls anchored to the
        physical home-indicator edge.  The shutter follows the home-
        indicator regardless of host portrait-lock state:
          - locked + any device              → JS-bottom (locked
            framebuffer maps device-bottom to JS-bottom always)
          - non-locked + device-portrait     → JS-bottom
          - non-locked + device-landscape-L  → JS-right
          - non-locked + device-landscape-R  → JS-left
        Computed in `homeIndicatorEdge` which combines `jsLandscape`
        (from window dims) with `deviceOrientation` (sensor).
      */}
      <View
        pointerEvents="box-none"
        style={bottomAreaStyleForEdge(
          homeIndicatorEdge(jsLandscape, deviceOrientation),
          insets.bottom + 12,
          insets.top + 12,
        )}
      >
        {/* Live-frame band — only visible while recording.  `vertical`
            is true when the home-indicator anchor is on a side edge
            (left or right), in which case the band is a vertical
            column.  Otherwise it's a horizontal strip. */}
        {statusPhase === 'recording' && (
          <PanoramaBandOverlay
            state={incremental.state}
            frameUris={keyframeThumbnailUris}
            captureOrientation={deviceOrientation}
            vertical={isSideEdge(homeIndicatorEdge(jsLandscape, deviceOrientation))}
          />
        )}

        {/* v0.13.0 — built-in capture-history thumbnail strip.  Lives
            INSIDE the orientation-aware bottomArea container so it
            rides along to the home-indicator edge in landscape rather
            than sitting at a hard-coded `bottom: 160` mid-screen.
            Hidden during recording so the PanoramaBandOverlay above
            it has room without overlap.  Strip is intrinsically
            horizontal; v0.13.1 will add orientation-aware rotation
            for the thumbnails + tablet "user-bottom" placement. */}
        {thumbnails != null && statusPhase !== 'recording' && (
          <CaptureThumbnailStrip
            items={thumbnails}
            minPhotos={thumbnailsMin}
            maxPhotos={thumbnailsMax}
            onItemPress={onThumbnailPress}
            // v0.13.1 — stack the idle strip vertically when the
            // home-indicator anchor is on a side edge (non-locked host
            // in landscape), matching PanoramaBandOverlay's `vertical`
            // so the strip rides the home-indicator edge instead of
            // running horizontally across the rotated screen.
            vertical={isSideEdge(homeIndicatorEdge(jsLandscape, deviceOrientation))}
            // v0.13.1 — counter-rotate the thumbnail images so the
            // captured scene reads upright in portrait-locked landscape.
            contentRotation={contentRotation}
          />
        )}

        {/* Shutter row.  Horizontal row when home-indicator is on
            top/bottom (lens left / shutter center / AR right);
            vertical column when on left/right (slots stack along
            the narrow strip).  Touch targets stay axis-aligned. */}
        <View
          style={[
            bottomBarStyleForEdge(homeIndicatorEdge(jsLandscape, deviceOrientation)),
            // Host chrome docked below? Lift the whole cluster clear of it.
            bottomBarOffset > 0 && { transform: [{ translateY: -bottomBarOffset }] },
          ]}
        >
        {/* v0.13.1 — flash + AR moved to the top-right pill stack (see
            below).  Left/right slots stay as flex spacers so the shutter
            + lens chip remain centred. */}
        <View style={styles.bottomBarLeft} />
        <View style={styles.bottomBarCenter}>
          {/* v0.13.2 — lens chooser hidden in AR-only mode (ARKit/ARCore
              can't use the ultra-wide, so there's nothing to choose). */}
          {renderSharedLensChip()}
          {!hideBuiltInShutter && (
            <View style={styles.shutterWrap}>
              <CameraShutter
                onTap={handleTap}
                onHoldStart={enablePanoramaMode ? handleHoldStart : noop}
                onHoldComplete={enablePanoramaMode ? handleHoldEnd : noop}
                // Tap-only when panorama is off — no dead "recording" ring on a
                // hold that does nothing (the split-Photo-mode case).
                holdEnabled={enablePanoramaMode}
                isProcessing={statusPhase === 'stitching'}
                disabled={statusPhase === 'stitching' || shutterDisabled}
              />
            </View>
          )}
        </View>
        <View style={styles.bottomBarRight} />
        </View>
      </View>

      {/* v0.13.1 — top-right control pill stack, anchored UNDER the
          settings affordance.  Vertical column; pills match the AR
          toggle's shape.  ORDER MATTERS: AR pill is FIRST (top) so it
          stays anchored when the flash pill below it shows/hides
          (flash is hidden in AR mode, and when the active device has no
          torch — e.g. the ultra-wide 0.5× lens).  AR toggle shows only
          when the lens is 1× (ARKit/ARCore don't expose the ultra-wide)
          and the device supports AR. */}
      <View
        style={[styles.pillStack, { top: pillStackTop }]}
        pointerEvents="box-none"
      >
        {/* v0.13.2 — AR toggle only when BOTH sources are allowed
            (captureSources='both'); a single-source constraint has
            nothing to toggle.  Still gated on 1× + device AR support.
            ⚠ The AR pill itself now comes from `renderSharedPills`, which
            the SWEEP cell renders too — one pill, one state, both engines.
            Only the flash pill below is keyframe-tree-specific. */}
        {renderSharedArPill()}
        {showFlashButton && !isAR && deviceHasTorch && (
          <Pressable
            onPress={toggleFlash}
            accessibilityRole="button"
            accessibilityLabel={`Flash ${flashRequested === 'on' ? 'on' : 'off'}`}
            accessibilityState={{ selected: flashRequested === 'on' }}
            hitSlop={8}
            style={[
              pillStyles.pill,
              flashRequested === 'on' && pillStyles.pillActive,
            ]}
          >
            <Text
              style={[
                pillStyles.flashGlyph,
                flashRequested === 'on' && pillStyles.glyphActive,
                contentRotation,
              ]}
            >
              ⚡
            </Text>
          </Pressable>
        )}
      </View>

      {/* Settings modal (rendered always, visible-gated). */}
      <PanoramaSettingsModal
        visible={settingsModalVisible}
        settings={settings}
        onChange={setSettings}
        onClose={() => setSettingsModalVisible(false)}
      />

      {/* Item 1/2 — rotate prompt.  Shown while a gated hold is blocked on
          the user rotating to the target orientation (landscape for
          panMode='vertical', portrait for 'horizontal').  The resume effect
          starts the deferred capture the instant they do. */}
      {/* The rotate prompt is the ONLY feedback for the mode gate, so it is
          NOT gated on `panGuidance` — otherwise panGuidance={false} +
          a gated panMode would block the hold with a dead, silent shutter.
          `panGuidance` governs only the cosmetic in-capture overlays. */}
      <RotateToLandscapePrompt
        visible={pendingPanStart}
        target={gateTargetOrientation(panMode) ?? 'landscape'}
        copy={
          gateTargetOrientation(panMode) === 'portrait'
            ? guidanceCopyResolved.rotateToPortrait
            : guidanceCopyResolved.rotateToLandscape
        }
      />

      {renderGuardModals()}

      {renderReviewSurfaces()}
    </View>
    </HostJsLandscapeContext.Provider>
  );
});


function noop(): void {
  /* no-op handler used when panorama mode is disabled */
}


/**
 * v0.12.0 — JS edge corresponding to the physical home-indicator
 * side of the device.  This is where the shutter + controls anchor
 * to so they're always within thumb reach of the user's grip
 * (matching iOS Camera's behaviour).
 *
 * Combines two signals:
 *   - `jsLandscape`: whether the OS rotated the framebuffer.  True
 *     only for non-locked hosts in device-landscape.
 *   - `deviceOrient`: physical device orientation from the sensor.
 *
 * Truth table:
 *   | jsLandscape | deviceOrient        | edge   |
 *   |---           |---                  |---     |
 *   | false        | any                 | bottom | (portrait JS coords —
 *   |              |                     |        |  device-bottom = JS-bottom
 *   |              |                     |        |  in both locked and
 *   |              |                     |        |  non-locked-portrait)
 *   | true         | landscape-left      | right  | (screen rotated, home
 *   |              |                     |        |  indicator on user-right)
 *   | true         | landscape-right     | left   | (mirror)
 *
 * Caveats:
 *   - Non-locked + upside-down doesn't surface JS-top here because
 *     upside-down doesn't change window dimensions; we can't
 *     distinguish locked-portrait-with-device-flipped from
 *     non-locked-portrait-with-screen-flipped-180°.  Defaults to
 *     JS-bottom which matches the more common locked case.  Add
 *     handling here when a host needs upside-down support.
 *   - jsLandscape=true with non-landscape device shouldn't happen
 *     in steady state — only during a transition mid-rotation.
 *     Falls through to 'right' as a defensive default.
 */
type HomeIndicatorEdge = 'bottom' | 'top' | 'left' | 'right';

function homeIndicatorEdge(
  jsLandscape: boolean,
  deviceOrient: DeviceOrientation,
): HomeIndicatorEdge {
  if (!jsLandscape) return 'bottom';
  if (deviceOrient === 'landscape-left') return 'right';
  if (deviceOrient === 'landscape-right') return 'left';
  return 'right';
}


/**
 * v0.12.0 — true when the anchor edge is on a side (left/right), so
 * the band + shutter row need to be vertical strips.  Top/bottom
 * anchors yield horizontal strips.
 */
function isSideEdge(edge: HomeIndicatorEdge): boolean {
  return edge === 'left' || edge === 'right';
}

// v0.13.1 — test-only exports of the pure orientation-decision
// functions.  `homeIndicatorEdge` + `isSideEdge` together produce the
// `vertical` flag that drives PanoramaBandOverlay and
// CaptureThumbnailStrip layout, so they carry the orientation contract.
// Unit-tested via these handles (the lib's jest config is pure-TS and
// can't mount <Camera>; see jest.config.js).
/** @internal test-only — see `homeIndicatorEdge`. */
export const _homeIndicatorEdgeForTests = homeIndicatorEdge;
/** @internal test-only — see `isSideEdge`. */
export const _isSideEdgeForTests = isSideEdge;


/**
 * cameraShouldUnmount — whether the live camera (<CameraView> /
 * <ARCameraView>) should be UNMOUNTED (replaced by the placeholder) this
 * render rather than mounted.
 *
 * True while a camera-switch transition or AR-support probe is in flight,
 * OR during the stitch (statusPhase==='stitching').  The stitching case is
 * the V12.14.8 OOM fix: unmounting frees vision-camera's AVCaptureSession +
 * preview buffers (~150-250 MB) BEFORE the memory-heavy stitch, so the
 * live-camera footprint and the stitch peak never coexist and jetsam (iOS)
 * / lmkd (Android) don't OOM-kill the app.
 *
 * Pure + exported for test — the lib's jest config can't mount <Camera>,
 * so this boolean is the unit-testable core of the OOM render gate.
 */
function cameraShouldUnmount(
  inFlightTransition: boolean,
  arSupportPending: boolean,
  statusPhase: CaptureStatusPhase,
  sweepHandoffPending: boolean,
): boolean {
  return (
    inFlightTransition
    || arSupportPending
    || statusPhase === 'stitching'
    || sweepHandoffPending
  );
}

/** @internal test-only — see `cameraShouldUnmount`. */
export const _cameraShouldUnmountForTests = cameraShouldUnmount;

/**
 * sweepHostOwnsCamera — on `engine="sweep"`, will the embedding `<Camera>`'s
 * own `<CameraView>` be the camera, with the sweep fed from it by the
 * `panoplus_sweep_ingest` frame processor?
 *
 * ── WHY THIS IS ONE FUNCTION AND NOT FOUR CONDITIONS ────────────────────
 *
 * S7 asked this question in three places with three different answers:
 * `!isAR` chose whether to render the preview, `!isAR && pluginReady` chose
 * whether to ask native for the arm, and the main tree's handoff guard
 * applied to neither. An adversarial review found three reachable states in
 * which they disagree, and every disagreement lands the same way — vision-
 * camera holds the back camera while the native recorder opens its own
 * session against it. Two stacks, one camera, on a phone.
 *
 * So it is one boolean now. A disagreement is no longer expressible.
 *
 * Each term below is a defect that was reachable, not a precaution:
 *
 *  * **`platformOS === 'android'` — a REGRESSION S7 INTRODUCED, and the
 *    reason this function exists.** `vcPluginArm` / `vcCameraId` are read by
 *    `PanoPlusAndroidRecorder` and by nothing whatsoever under `ios/`: the
 *    iOS bridge knows two producers, `"ar"` and `"imu"`, and `"imu"`
 *    unconditionally starts `RNISPanoAvfSource`, which opens its OWN
 *    `AVCaptureSession` on a physical back device. Before S7 that was the
 *    only session on the sweep screen. S7 mounted `<CameraView>` beside it.
 *    ⚠ And it does NOT fail loudly: `canAddInput` tests configuration
 *    compatibility, not runtime exclusivity, so the second open usually
 *    SUCCEEDS and one of the two sessions is interrupted afterwards — a dead
 *    preview, not an error code. iOS stays on the arm that works until
 *    `PanoPlusBridge` grows the fourth start mode Android has.
 *
 *  * **`sweepPoseSource === 'imu'` — NOT implied by `!isAR`, and the gap is
 *    reachable.** `deriveEffectiveCaptureSource` returns `'non-ar'` when AR
 *    is merely UNSUPPORTED or the lens is 0.5×, so `isAR` is false on plenty
 *    of sweeps the operator has AR switched on for. Meanwhile the surface
 *    forwards `vcPluginArm` only on the IMU arm — because the recorder's own
 *    gate is `cfg.vcPluginArm && cfg.livePoseSource == "imu"`. So with AR
 *    preferred but unavailable, the old predicate declared "the host owns the
 *    camera", `<CameraView>` mounted, the surface drew no viewfinder, the arm
 *    flag was dropped on the way out — and the recorder opened its own camera
 *    anyway. Every 0.5× sweep with the AR pill on took that path.
 *
 *    ⚠ IT IS THE MERGED VALUE, not `arPreference`. `poseSource` is a host-
 *    settable key in the `sweep` bag and the bag is spread over these props,
 *    so reading `<Camera>`'s own state here would answer a question about a
 *    value the surface is not going to receive — which is the same
 *    two-places-one-fact defect one level up.
 *
 *  * **`!cameraUnmounting`** — the v0.14.2 camera-handoff race, reintroduced.
 *    `isAR` is false until the async `isSupported()` probe settles, so with
 *    AR preferred the sweep cell mounted `<CameraView>` for the width of the
 *    probe. That is precisely the window in which vision-camera's session
 *    grabs the camera and the switch to AR 200-500 ms later fails with ARKit
 *    "Required sensor failed". The main tree has guarded this for a year;
 *    the sweep cell was not using the guard.
 *
 *  * **`pluginReady` and a non-empty `deviceId`** — the arm cannot be served
 *    without a plugin handle and an id to read intrinsics from, and when it
 *    is not served the recorder opens its own camera anyway. Declaring the
 *    host owns it in that state tells the surface to draw no viewfinder
 *    while native takes the device: a black screen over a live sweep.
 *
 *  * **not multicam away from the wide baseline** — S6 refuses a frame on
 *    iOS precisely because a VIRTUAL multi-camera container switches its
 *    active constituent under zoom with no notification. In `'multicam'`
 *    mode `capture.device.id` IS that logical container, and the recorder
 *    derives intrinsics from its `CameraCharacteristics` assuming the default
 *    crop. Refusing the hazard on one platform and handing it to the other
 *    would be the same bug twice.
 *
 * Pure + exported for test, for the same reason `cameraShouldUnmount` is:
 * the lib's jest config cannot drive `<Camera>`'s vision-camera mocks, so a
 * render test cannot reach most of these states. A truth table can reach all
 * of them.
 */
export interface SweepHostOwnsCameraInput {
  /** The sweep resolved to the ARKit/ARCore arm, which feeds itself. */
  isAR: boolean;
  /**
   * The pose arm the surface will ACTUALLY be given — `<Camera>`'s
   * `arPreference`, already merged with any host override from the `sweep`
   * bag. ⚠ NOT the same question as `isAR`, and the gap between them is a
   * reachable collision; see the term's note below.
   */
  sweepPoseSource: 'ar' | 'imu';
  /** `Platform.OS`. */
  platformOS: string;
  /** `cameraShouldUnmount(...)` — a switch, probe or stitch is in flight. */
  cameraUnmounting: boolean;
  /** The `panoplus_sweep_ingest` plugin handle has been acquired. */
  pluginReady: boolean;
  /** `capture.device?.id ?? ''`. */
  deviceId: string;
  /** How lenses are switched for the mounted device. */
  captureMode: CaptureDeviceMode;
  /** The lens the operator chose. */
  lens: '1x' | '0.5x';
  /**
   * The host supplied its own `frameProcessor` prop.
   *
   * ⚠ IT SILENTLY REPLACES OURS. `effectiveFrameProcessor` is
   * `hostFrameProcessor ?? (engine === 'sweep' ? sweepFrameProcessor : …)`,
   * so a host that sets both `frameProcessor` and `engine="sweep"` gets its
   * own worklet bound to `<CameraView>` and the sweep's ingest worklet
   * bound to nothing. Without this term the predicate still said "the host
   * owns the camera", so the recorder was told to open NOTHING and wait to
   * be fed — by a plugin no frame will ever reach. That is the
   * armed-with-no-feeder failure the AR arm already shipped once, and it
   * presents as `vcFramesOffered == 0`, i.e. as a plugin that never mounted.
   */
  hostFrameProcessorPresent: boolean;
}

/**
 * The same keys at RUNTIME, because a TypeScript parameter type is erased
 * and a table test cannot enumerate it.
 *
 * ⚠ AND EXHAUSTIVENESS IS ENFORCED BY `tsc`, NOT BY EYE — see the check
 * below. The truth table reads this list, so a term added to the interface
 * without a falsifying value fails the build and then the table, rather
 * than sitting in the predicate unexercised. An earlier version of that
 * table compared two literals in the same test file and claimed to be
 * derived from the predicate; it was not, and could not have been.
 */
export const SWEEP_HOST_OWNS_INPUT_KEYS = [
  'isAR',
  'sweepPoseSource',
  'platformOS',
  'cameraUnmounting',
  'pluginReady',
  'deviceId',
  'captureMode',
  'lens',
  'hostFrameProcessorPresent',
] as const;

// A key missing from the list above makes this line a type error.
type _SweepOwnsKeysAreExhaustive =
  Exclude<keyof SweepHostOwnsCameraInput,
          typeof SWEEP_HOST_OWNS_INPUT_KEYS[number]> extends never
    ? true : ['missing keys in SWEEP_HOST_OWNS_INPUT_KEYS'];
const _sweepOwnsKeysAreExhaustive: _SweepOwnsKeysAreExhaustive = true;
void _sweepOwnsKeysAreExhaustive;

/**
 * sweepOwnershipInput — build `sweepHostOwnsCamera`'s argument list from what
 * `<Camera>` actually has.
 *
 * ⚠ THE WIRING IS WHERE THE BUGS WERE, WHICH IS WHY IT IS A FUNCTION. The
 * predicate has had a truth table for three review rounds; both defects that
 * reached a commit were in the argument list, invisible to it:
 *
 *   * `sweepPoseSource` was `<Camera>`'s own `arPreference` rather than the
 *     MERGED value — and the `sweep` bag is spread over the surface's props,
 *     so the host's key wins. The predicate judged one arm while the surface
 *     ran another, dropped the vc flag on the way out, and the recorder
 *     opened its own camera against the one vision-camera held.
 *   * The multicam term was the MERGED lens — but the physical device and
 *     its zoom come from `useCapture({ lens })`, which reads `<Camera>`'s
 *     own state. So `sweep={{ lens: 'wide' }}` disarmed the virtual-
 *     constituent guard while the device stayed at 0.5×.
 *
 * Stated as one rule: a term takes the value of whatever it is a question
 * ABOUT. "Which arm will run" is the surface's, so it is merged. "Which
 * physical device is mounted" is `<Camera>`'s, so it is not.
 */
export function sweepOwnershipInput(src: {
  isAR: boolean;
  platformOS: string;
  cameraUnmounting: boolean;
  /** `sweep?.poseSource` — the host's override, or undefined. */
  bagPoseSource: 'ar' | 'imu' | undefined;
  /** `<Camera>`'s own AR toggle. */
  arPreference: boolean;
  pluginReady: boolean;
  deviceId: string;
  captureMode: CaptureDeviceMode;
  /** ⚠ `<Camera>`'s OWN lens — the one that chose the device. */
  lens: CameraLens;
  hostFrameProcessorPresent: boolean;
}): SweepHostOwnsCameraInput {
  return {
    isAR: src.isAR,
    // MERGED: this asks which arm the SURFACE will run.
    sweepPoseSource: sweepMergedPoseSource(src.bagPoseSource, src.arPreference),
    platformOS: src.platformOS,
    cameraUnmounting: src.cameraUnmounting,
    pluginReady: src.pluginReady,
    deviceId: src.deviceId,
    captureMode: src.captureMode,
    // NOT merged: this asks which physical device is mounted, and only
    // `<Camera>`'s own lens moves that.
    lens: src.lens === '0.5x' ? '0.5x' : '1x',
    hostFrameProcessorPresent: src.hostFrameProcessorPresent,
  };
}

function sweepHostOwnsCamera(input: SweepHostOwnsCameraInput): boolean {
  return (
    !input.isAR
    && input.sweepPoseSource === 'imu'
    && input.platformOS === 'android'
    && !input.cameraUnmounting
    && input.pluginReady
    && input.deviceId !== ''
    && !(input.captureMode === 'multicam' && input.lens !== '1x')
    && !input.hostFrameProcessorPresent
  );
}

/**
 * What the surface will actually be given for `poseSource` / `lens`, host
 * override included.
 *
 * ⚠ PURE AND EXPORTED BECAUSE THE RENDER HARNESS CANNOT SEE THE FIX. The
 * merge exists so `sweepHostOwnsCamera` judges the value the SURFACE
 * receives rather than `<Camera>`'s own state — but the harness pins three
 * of that predicate's other terms false, so reverting the merge leaves
 * every mounted assertion green. Measured: the whole suite passed with it
 * reverted. A two-line derivation with no falsifiable test is how the first
 * version of this collapse shipped a claim it could not support.
 */
export function sweepMergedPoseSource(
  bagPoseSource: 'ar' | 'imu' | undefined,
  arPreference: boolean,
): 'ar' | 'imu' {
  return bagPoseSource ?? (arPreference ? 'ar' : 'imu');
}

/**
 * The lens the RUNNING arm will actually open — the value the chip paints.
 *
 * ── WHY A MASK AND NOT JUST THE STATE ───────────────────────────────────
 *
 * `lens` is the operator's REQUEST and must stay raw everywhere that acts on
 * it: it is what moves the sweep off the AR arm in the first place (Pano's
 * rule, `deriveEffectiveCaptureSource`). But the arm is allowed to REFUSE —
 * on iOS the IMU arm falls back to ARKit whenever τ/basis are missing for
 * `model | lens | W×H | fps` (`panoPlusArmNotice`) — and ARKit is
 * structurally wide-only. The request survives; the glass does not change.
 *
 * Field report that named this, 2026-09-19: *"0.5x lens does not go to that
 * camera — shows the same view as 1x."* Everything downstream was correct;
 * the chip simply went on claiming a lens the arm had already declined.
 *
 *   arm                      │ lens='0.5x' │ lens='1x'
 *   ─────────────────────────┼─────────────┼──────────
 *   null (keyframe / no      │    0.5x     │    1x     ← untouched
 *     answer yet)            │             │
 *   resolving (read in       │    0.5x     │    1x     ← follows the REQUEST
 *     flight)                │             │
 *   imu  (decoupled arm)     │    0.5x     │    1x     ← honoured
 *   ar   (ARKit / ARCore)    │     1x      │    1x     ← MASKED
 *
 * The `resolving` row is the same courtesy the surface's start button and AR
 * pill already give: a label that may be taken back one frame later is not
 * offered. It follows the request until the arm answers.
 */
export function sweepEffectiveLens(
  lens: CameraLens,
  arm: { poseSource: 'ar' | 'imu'; resolving: boolean } | null,
): CameraLens {
  if (arm == null || arm.resolving) return lens;
  return arm.poseSource === 'ar' ? '1x' : lens;
}

/**
 * ONE `uri` CONVENTION AT THE EMIT BOUNDARY.
 *
 * ⚠ `<Camera>` HANDS THREE EMIT SITES TO ONE `onCapture`, AND THEY DISAGREED.
 * A photo and a panorama emit a SCHEMED `file:///…`; a sweep emitted the bare
 * `/data/user/0/…/canvas.jpg` that `panoPlusResultOf` returns verbatim. Same
 * callback, two conventions — and a host cannot branch on the engine, because
 * the whole point of `engine` is that it does not change anything else.
 *
 * The difference is not cosmetic: every `fs`-style API a host reaches for
 * (`cv::imwrite`, `NSFileManager`, `BitmapFactory.decodeFile`) treats
 * `file:///x.jpg` as a literal filename, and every RN `<Image>` needs the
 * scheme. One of the two always breaks, silently, depending on which engine
 * ran.
 *
 * Applied HERE and not in `panoPlusResultOf`, deliberately: the pack's own
 * `canvasPath` and the `sessionDir` that references it must stay bare, and
 * `PanoPlusCaptureResult` is a documented public shape. This schemes only
 * what crosses `onCapture`. `toFileUri` is idempotent, so a site that already
 * schemed is unchanged.
 */
function emitUri<T>(result: T): T {
  const r = result as { uri?: unknown };
  if (typeof r.uri !== 'string' || r.uri === '') return result;
  return { ...result, uri: toFileUri(r.uri) };
}

/** Twin of `sweepMergedPoseSource` for the lens. */
export function sweepMergedLens(
  bagLens: 'wide' | 'ultraWide' | undefined,
  lens: CameraLens,
): 'wide' | 'ultraWide' {
  return bagLens ?? (lens === '0.5x' ? 'ultraWide' : 'wide');
}

/** @internal test-only — see `sweepHostOwnsCamera`. */
export const _sweepHostOwnsCameraForTests = sweepHostOwnsCamera;

/**
 * sweepCameraHandoff — resolve the live ownership answer, the in-flight sweep
 * latch and the settle window into the two things that actually act on them:
 * whether `<Camera>` may MOUNT its preview, and what the surface is TOLD.
 *
 * ── WHY THEY ARE NOT THE SAME BOOLEAN ───────────────────────────────────
 *
 * An ownership flip is a camera HANDOFF, and a handoff has a loser and a
 * winner. Done in one commit, `<CameraView>` unmounts and the surface's idle
 * effect opens its own AVF client in the same frame — while Camera2 is still
 * releasing the first, a release this file measures at ~479 ms. That is
 * ERROR_CAMERA_IN_USE on a phone where nothing is wrong but the ordering.
 *
 * So for the width of the window the surface is told `'host'` (whoever held
 * a camera lets go, and nobody opens one) while `mountHostPreview` stays
 * false (the winner waits). Neither side has a camera for 600 ms. That is
 * the correct state during a handoff, and the surface's own fail-closed
 * guard refuses a hold taken inside it rather than starting half-armed.
 *
 * ⚠ AND THE LATCH OUTRANKS THE WINDOW. `latch` is non-null exactly while a
 * sweep is running, and `sweepShouldSettle` will not open a window under it —
 * because `mountHostPreview` ANDs the two, so a settle begun mid-sweep would
 * unmount the preview the engine is being fed from. That is strictly worse
 * than the flip the window exists to smooth: it is the failure the latch was
 * added to prevent, arriving through the fix for a different one.
 *
 * Pure and exported because a TABLE reaches rows a mounted test cannot —
 * `{mounted: false, started: true}`, a latch against a contrary live value.
 * ⚠ NOT because "the harness cannot move these inputs": that premise was
 * false and cost five review rounds.
 * `src/sweep/__tests__/cameraSweepHostArm.render.test.tsx` overrides the
 * pinned mocks locally and drives this end to end on the Android host arm.
 */
function sweepCameraHandoff(input: {
  /** What the predicate says right now. */
  live: boolean;
  /** The value latched at the start of a running sweep; null while idle. */
  latch: boolean | null;
  /** A handoff is in flight. */
  settling: boolean;
}): { mountHostPreview: boolean; surfaceFrameSource: 'own' | 'host' } {
  const owns = input.latch ?? input.live;
  return {
    mountHostPreview: owns && !input.settling,
    surfaceFrameSource: (owns || input.settling) ? 'host' : 'own',
  };
}

/** Should a handoff window open this render? See `sweepCameraHandoff`. */
function sweepShouldSettle(input: {
  latch: boolean | null;
  previous: boolean;
  live: boolean;
}): boolean {
  // Never under a running sweep, and the caller must NOT record `live` when
  // this returns false — the transition stays pending so the handoff happens
  // when the sweep ends, which is when it is safe.
  if (input.latch !== null) return false;
  return input.previous !== input.live;
}

/**
 * sweepPreviewLive — is the host's preview actually DRAWING?
 *
 * Two facts, and the history of this rung is a history of confusing them:
 *
 *   * `mounted` — the element is in the tree. This is a render decision and
 *     says nothing about pixels; a session takes real time to open.
 *   * `started` — vision-camera has delivered a first preview frame
 *     (`onPreviewStarted`), cleared on stop AND on unmount, because neither
 *     `onPreviewStopped` nor `onStopped` fires for an unmount.
 *
 * Only both together mean there is something behind the sweep surface. Get
 * it wrong in either direction and the surface goes transparent over black
 * with its explainer suppressed — which is the defect this whole rung is
 * named after, and which two successive "fixes" recreated.
 *
 * ⚠ THE COMMENT HERE USED TO SAY "only a table can assert the mapping".
 * That was false in the same commit that wrote it:
 * `cameraSweepHostArm.render.test.tsx` fires `onPreviewStarted` on the real
 * mounted element and asserts all of it. The extraction is kept because the
 * expression is the one place three separate defects landed and a named
 * function is where its history can be written down — not because the
 * mounted suite cannot reach it.
 */
function sweepPreviewLive(input: {
  mounted: boolean;
  started: boolean;
}): boolean {
  return input.mounted && input.started;
}

/** @internal test-only — see `sweepPreviewLive`. */
export const _sweepPreviewLiveForTests = sweepPreviewLive;

/** @internal test-only — see `sweepCameraHandoff`. */
export const _sweepCameraHandoffForTests = sweepCameraHandoff;
/** @internal test-only — see `sweepShouldSettle`. */
export const _sweepShouldSettleForTests = sweepShouldSettle;


/**
 * How long to keep BOTH cameras unmounted after the sweep surface goes away,
 * before vision-camera is allowed to open.
 *
 * 600 ms, from the measurement rather than a guess: the recorder's own
 * retry reported reclaiming the camera on "attempt 2 after 479ms" on a
 * Galaxy A35. This is the other side of that same release. Too short and
 * vision-camera reports `system/max-cameras-in-use`; too long and the
 * operator watches a placeholder for no reason.
 */
const SWEEP_CAMERA_RELEASE_SETTLE_MS = 600;


/**
 * v0.12.0 — bottom-controls outer container positioning.  Anchors
 * to the home-indicator JS edge with the appropriate flex direction
 * so the band sits on the viewport side of the shutter (toward the
 * camera preview centre).
 */
function bottomAreaStyleForEdge(
  edge: HomeIndicatorEdge,
  bottomInsetPx: number,
  topInsetPx: number,
): ViewStyle {
  switch (edge) {
    case 'bottom':
      // Band above shutter row, both at JS-bottom.  JSX order
      // [band, shutter] + flexDirection 'column' = band at top of
      // stack (closer to screen centre), shutter at JS-bottom.
      return {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        flexDirection: 'column',
        alignItems: 'stretch',
        paddingBottom: bottomInsetPx,
      };
    case 'top':
      // Mirror of bottom.  column-reverse so JSX [band, shutter]
      // renders [shutter, band] in JS, shutter at JS-top, band
      // below it (toward screen centre).
      return {
        position: 'absolute',
        left: 0,
        right: 0,
        top: 0,
        flexDirection: 'column-reverse',
        alignItems: 'stretch',
        paddingTop: topInsetPx,
      };
    case 'right':
      // Band to the left of shutter column, both at JS-right.
      // flexDirection 'row' + JSX [band, shutter] = band at JS-left
      // of container (screen centre side), shutter at JS-right.
      return {
        position: 'absolute',
        top: 0,
        bottom: 0,
        right: 0,
        flexDirection: 'row',
        alignItems: 'stretch',
        paddingRight: 12,
      };
    case 'left':
      // Mirror of right.  row-reverse so JSX [band, shutter] gives
      // band at JS-right (screen centre side), shutter at JS-left.
      return {
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: 0,
        flexDirection: 'row-reverse',
        alignItems: 'stretch',
        paddingLeft: 12,
      };
  }
}


/**
 * v0.12.0 — inner shutter-row flex direction.  Horizontal row for
 * top/bottom anchors; vertical column for left/right anchors so
 * the three slots (lens / shutter / AR) stack along the narrow
 * side strip.  Buttons don't rotate — touch targets and text
 * orient correctly via either (a) un-rotated framebuffer under
 * portrait-lock or (b) OS-rotated framebuffer under non-locked.
 */
function bottomBarStyleForEdge(edge: HomeIndicatorEdge): ViewStyle {
  const vertical = isSideEdge(edge);
  return {
    flexDirection: vertical ? 'column' : 'row',
    paddingHorizontal: vertical ? 0 : 18,
    paddingVertical: vertical ? 18 : 0,
    alignItems: 'center',
  };
}


const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  transitionPlaceholder: {
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  transitionLabel: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 13,
  },
  bottomArea: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'column',
    alignItems: 'stretch',
  },
  bottomBar: {
    flexDirection: 'row',
    paddingHorizontal: 18,
    alignItems: 'flex-end',
  },
  bottomBarLeft: {
    flex: 1,
    alignItems: 'flex-start',
    justifyContent: 'flex-end',
  },
  bottomBarCenter: {
    flex: 1,
    alignItems: 'center',
  },
  bottomBarRight: {
    flex: 1,
    alignItems: 'flex-end',
    justifyContent: 'flex-end',
  },
  shutterWrap: {
    marginTop: 12,
  },
  headerWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
  // v0.13.1 — `thumbnailStripWrap` removed.  The strip now renders
  // inside the orientation-aware bottomArea container (alongside
  // PanoramaBandOverlay and the bottom bar) rather than as a
  // position-absolute overlay at hard-coded `bottom: 160`.
  //
  // v0.13.1 — top-right control pill stack (flash + AR).  Absolute,
  // pinned to the right edge under the settings affordance; `top` is
  // set inline from `pillStackTop`.  Column so the pills stack
  // vertically; gap keeps them from touching.
  pillStack: {
    position: 'absolute',
    right: 14,
    alignItems: 'flex-end',
    gap: 10,
  },
  /**
   * Where `<Camera>`'s lens chip sits on the SWEEP cell.
   *
   * The keyframe tree centres it in `bottomBarCenter`, above the shutter.
   * The sweep surface draws its own shutter row, so the chip is docked
   * just above that row instead of being laid out inside it — same
   * control, same state, placed against the chrome that is actually on
   * screen. `bottomBarOffset` (passed to the surface) is what reserves
   * the room, so the two agree by construction.
   */
  sweepLensChipDock: {
    position: 'absolute',
    left: 0,
    right: 0,
    // `bottom` is supplied at the call site from `panoLensChipBottomPt` —
    // deliberately absent here so a literal cannot creep back in.
    alignItems: 'center',
  },
});


// v0.13.1 — shared pill style for the top-right control stack.  The
// flash pill matches the AR toggle's shape (same padding / radius /
// background) so the two read as a set.
const pillStyles = StyleSheet.create({
  pill: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: 'rgba(0,0,0,0.45)',
    minWidth: 56,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillActive: {
    backgroundColor: '#ffd34d',
  },
  flashGlyph: {
    color: '#ffffff',
    fontSize: 18,
  },
  glyphActive: {
    color: '#1a1a1a',
  },
});
