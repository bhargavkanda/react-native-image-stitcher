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
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
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
import type {
  Camera as VisionCamera,
  DrawableFrameProcessor,
  ReadonlyFrameProcessor,
} from 'react-native-vision-camera';

import { useARSession } from '../ar/useARSession';
import { ARCameraView, type ARCameraViewHandle } from './ARCameraView';
import { CameraShutter } from './CameraShutter';
import { CameraView } from './CameraView';
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
import { type PanoramaSettings } from './PanoramaSettings';
import { panoramaSettingsToNativeConfig } from './PanoramaSettingsBridge';
import { PanoramaSettingsModal } from './PanoramaSettingsModal';
import {
  buildPanoramaInitialSettings,
  type PanoramaPropOverrides,
} from './buildPanoramaInitialSettings';
import { isLowMemDevice } from './lowMemDevice';
import { useCapture } from './useCapture';
import { useDeviceOrientation, type DeviceOrientation } from './useDeviceOrientation';
import { useContentRotation } from './useContentRotation';
import { useOrientationDrift } from './useOrientationDrift';
import { OrientationDriftModal } from './OrientationDriftModal';
// ── Panorama GUIDANCE building blocks (feature/pano-ux-guidance) ─────
// Pure decision helpers + sensor hook + presentational surfaces for the
// first-time-user pan-capture guidance (items 1–7).  All read directly
// from the new <Camera> props below, NOT threaded through PanoramaSettings.
import { shouldGateForPanMode, type PanMode } from './panModeGate';
import { countdownSecondsFrom } from './captureCountdown';
import { usePanMotion } from './usePanMotion';
import type { Quad } from './cropGeometry';
import {
  mergeGuidanceCopy,
  type GuidanceCopy,
} from './cameraGuidanceCopy';
import { GUIDANCE_PILL, GUIDANCE_TOKENS } from './guidanceTokens';
import { RotateToLandscapePrompt } from './RotateToLandscapePrompt';
import { PanHowToOverlay } from './PanHowToOverlay';
import { CaptureCountdownOverlay } from './CaptureCountdownOverlay';
import { LateralMotionModal } from './LateralMotionModal';
import { RectCropPreview } from './RectCropPreview';
import { cropQuad } from '../stitching/cropQuad';
import {
  getIncrementalNativeModule,
  incrementalStitcherIsAvailable,
  subscribeIncrementalState,
  type IncrementalState,
} from '../stitching/incremental';
import { useFrameProcessorDriver } from '../stitching/useFrameProcessorDriver';
import { useIncrementalStitcher } from '../stitching/useIncrementalStitcher';
import { useIMUTranslationGate } from '../sensors/useIMUTranslationGate';
import { toBareFilePath, toFileUri } from '../utils/paths';
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
 * Result emitted via `onCapture`.  Discriminated union keyed on
 * `type` so consumers handle both photo and panorama outputs through
 * one callback path.
 *
 * Identifier `CameraCaptureResult` (vs. the SDK's existing
 * `CaptureResult` from `../types`) is intentional — the existing
 * CaptureResult shape has SDK-specific fields (deviceMetadata,
 * qualityReport, deviceUuid) that don't belong in the public RN
 * library's surface.  Step 3 (symbol rename) will retire the
 * historical SDK-specific names; for now we keep both types
 * side-by-side so the existing host code continues to work.
 */
export type CameraCaptureResult =
  | {
      type: 'photo';
      uri: string;
      width: number;
      height: number;
    }
  | {
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
    };


/**
 * Errors surfaced via `onError`.  Classified codes so consumers can
 * branch on the kind of failure (toast vs retry vs report).
 */
export type CameraErrorCode =
  | 'CAMERA_PERMISSION_DENIED'
  | 'CAMERA_DEVICE_UNAVAILABLE'
  | 'PHOTO_CAPTURE_FAILED'
  | 'PANORAMA_START_FAILED'
  | 'PANORAMA_FINALIZE_FAILED'
  | 'STITCH_NEED_MORE_IMGS'
  | 'STITCH_HOMOGRAPHY_FAIL'
  | 'STITCH_CAMERA_PARAMS_FAIL'
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
  defaultSeamFinder?: SeamFinder;
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
  enablePhotoMode?: boolean;
  enablePanoramaMode?: boolean;
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
   * Which stitcher engine to drive.  Only `'batch-keyframe'` is
   * supported (and the default): it collects accepted keyframe JPEGs
   * during the hold-pan-release capture and runs the stitch once at
   * finalize.  The live engines (hybrid / slit-scan / firstwins) were
   * archived in the batch-keyframe cleanup — see `archive/`.
   */
  engine?: 'batch-keyframe';

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

  // ── Callbacks ─────────────────────────────────────────────────────
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
   * Hosts use this callback to clean up their own state (e.g., reset
   * a wizard step, log telemetry, surface their own retry UX in
   * addition to the SDK's built-in modal).  No `onCapture` will fire
   * for an abandoned capture.
   */
  onCaptureAbandoned?: (reason: 'orientation-drift') => void;

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
   * import { Camera, useFrameProcessor, type StitcherFrame }
   *   from 'react-native-image-stitcher';
   *
   * function MyScreen() {
   *   const fp = useFrameProcessor((frame: StitcherFrame) => {
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
   *   type StitcherFrame,
   * } from 'react-native-image-stitcher';
   *
   * function MyScreen() {
   *   const stitcher = useStitcherWorklet();
   *   const fp = useFrameProcessor((frame: StitcherFrame) => {
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

  // ── Panorama GUIDANCE (feature/pano-ux-guidance) ──────────────────
  /**
   * Which device holds the non-AR panorama capture accepts.
   *
   *   - `'mode-a'` (DEFAULT) — LANDSCAPE-only.  Holding the phone in
   *     portrait when the user starts a panorama is BLOCKED behind the
   *     rotate-to-landscape prompt (item 2); the capture starts the
   *     instant they rotate to landscape (either way up).
   *   - `'both'` — landscape OR portrait; the rotate gate never fires,
   *     the user captures in whichever hold they're already in.
   *
   * **BREAKING (since the previous release defaulted to both modes):**
   * the default is now `'mode-a'`.  Hosts that relied on portrait
   * (Mode B, left→right) panoramas must opt back in with
   * `panMode='both'`.  See CHANGELOG.
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
   * Hard recording ceiling for a non-AR panorama, in milliseconds.  A
   * blinking countdown (item 5) shows the whole seconds remaining and,
   * on reaching 0, the capture auto-finalizes (stops + stitches what was
   * captured — same code path as the user releasing the shutter).
   * Default `9000` (9 s).  `0` disables both the countdown UI and the
   * auto-finalize (recording is then unbounded).
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
   * Show the draggable-quad crop editor (item 7) after a panorama
   * finalizes, BEFORE emitting it via `onCapture`.  Default `false`.
   * When `true`, the user drags 4 corners over the stitched result;
   * confirming crops in place (native perspective rectify when the quad
   * isn't axis-aligned), cancelling emits the un-cropped panorama.
   */
  rectCropPreview?: boolean;

  /**
   * Whether the crop editor (item 7) may perspective-rectify a
   * non-rectangular quad (`cv::warpPerspective`).  Default `true`.
   * `false` restricts the crop to the axis-aligned bounding rect even
   * when the user drags a skewed quad.  No effect unless
   * `rectCropPreview` is on.
   */
  perspectiveCorrectCrop?: boolean;

  /**
   * Copy overrides for every guidance string (rotate prompt, pan hint,
   * too-fast warning, lateral-stop popup, crop buttons).  Partial —
   * unspecified keys fall back to {@link DEFAULT_GUIDANCE_COPY}.  Hosts
   * localise or re-word the whole guidance surface in one place here.
   */
  guidanceCopy?: Partial<GuidanceCopy>;
}


// ─── Sub-components ─────────────────────────────────────────────────

/**
 * Lens chip — toggles between 1× and 0.5× physical lenses.
 *
 * Placement: bottom-center of the preview, just above the shutter
 * button.  Standard iOS-camera-app convention so users know where to
 * look.  Two pills side-by-side, the active one filled.
 */
interface LensChipProps {
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
}
function LensChip({ lens, onChange, has0_5x, contentRotation }: LensChipProps): React.JSX.Element {
  if (!has0_5x) {
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
        accessibilityLabel="0.5x ultra-wide lens"
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
          0.5×
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
interface ARToggleProps {
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
function ARToggle({ arEnabled, onToggle, contentRotation }: ARToggleProps): React.JSX.Element {
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
    defaultSeamFinder: props.defaultSeamFinder,
    defaultWarper: props.defaultWarper,
    defaultFlowNoveltyPercentile: props.defaultFlowNoveltyPercentile,
    defaultFlowEvalEveryNFrames: props.defaultFlowEvalEveryNFrames,
    defaultFlowMaxTranslationCm: props.defaultFlowMaxTranslationCm,
    defaultKeyframeMaxCount: props.defaultKeyframeMaxCount,
    defaultKeyframeOverlapThreshold: props.defaultKeyframeOverlapThreshold,
    defaultMaxKeyframeIntervalMs: props.defaultMaxKeyframeIntervalMs,
    maxInscribedRectCrop: props.maxInscribedRectCrop,
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
 */
export function Camera(props: CameraProps): React.JSX.Element {
  const {
    defaultCaptureSource = 'non-ar',
    defaultLens = '1x',
    captureSources = 'both',
    enablePhotoMode = true,
    enablePanoramaMode = true,
    showSettingsButton = false,
    style,
    outputDir,
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
    engine = 'batch-keyframe',
    // ── Panorama GUIDANCE (feature/pano-ux-guidance) ──────────────
    panMode = 'mode-a',
    panGuidance = true,
    maxPanDurationMs = 9000,
    panTooFastThreshold,
    lateralBudgetCm = 5,
    rectCropPreview = false,
    perspectiveCorrectCrop = true,
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
  const jsLandscape = jsWindow.width > jsWindow.height;

  // ── State ───────────────────────────────────────────────────────
  // v0.13.2 — initial AR preference honours `defaultCaptureSource` but
  // is clamped to the `captureSources` constraint: 'ar' forces on,
  // 'non-ar' forces off, 'both' uses the default.
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
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(
    null,
  );
  const [incrementalState, setIncrementalState] = useState<IncrementalState | null>(null);
  // ── Panorama GUIDANCE state (feature/pano-ux-guidance) ──────────
  // Item 1/2 — a hold that was BLOCKED on the rotate-to-landscape gate.
  // Latches when the user holds the shutter in portrait under Mode A;
  // an effect below resumes the capture the instant they rotate.
  const [pendingPanStart, setPendingPanStart] = useState(false);
  // Item 6 — the latched lateral-drift popup (capture already finalized
  // by the time it shows).
  const [lateralStopVisible, setLateralStopVisible] = useState(false);
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
    captureResultObj: CameraCaptureResult;
  } | null>(null);
  // 2026-05-22 (audit F9 + F3) — debug stitch-stats toast.  Hook
  // exposes an imperative API; we fire `showResult(finalizeResult)`
  // on every successful finalize when settings.debug is on (gated
  // a few hundred lines below in handleHoldEnd's onCapture branch).
  const stitchToast = useStitchStatsToast();
  const [batchKeyframeThumbnails, setBatchKeyframeThumbnails] = useState<
    string[]
  >([]);
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
    active: statusPhase === 'recording' && isNonAR,
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
  const contentRotation = useContentRotation();

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
  });

  // ── Lens chip availability ──────────────────────────────────────
  // v0.13.2 — real device capability from `useCapture` (which uses
  // `selectCaptureDevice`).  True only when the device actually exposes
  // an ultra-wide reachable via a multi-cam zoom OR a standalone
  // ultra-wide device; false on wide-only hardware (chip hides).
  const has0_5x = capture.has0_5x;
  const incremental = useIncrementalStitcher();
  const visionCameraRef = useRef<VisionCamera | null>(null);
  const arViewRef = useRef<ARCameraViewHandle | null>(null);

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
  const fpDriver = useFrameProcessorDriver();
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
  const drift = useOrientationDrift(statusPhase === 'recording');
  const [driftModalDismissed, setDriftModalDismissed] = useState(false);
  // Reset the dismissed flag when a new capture starts (or any non-
  // recording state) so the next drift event surfaces a fresh modal.
  // Item 6 — clear the latched lateral-stop popup on the same edge so a
  // fresh capture doesn't inherit the previous one's drift state.
  useEffect(() => {
    if (statusPhase !== 'recording') {
      setDriftModalDismissed(false);
      setLateralStopVisible(false);
    }
  }, [statusPhase]);

  useEffect(() => {
    if (!drift.drifted || statusPhase !== 'recording') return;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drift.drifted, statusPhase]);

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
      + 'first-party and host worklets independently).',
    );
  }
  // The Frame Processor worklet bound to vision-camera's Camera.
  // Host's wins if supplied; lib's internal driver otherwise.
  const effectiveFrameProcessor = hostFrameProcessor ?? fpDriver.frameProcessor;

  // ── Subscribe to engine state for live keyframe thumbs ──────────
  useEffect(() => {
    const sub = subscribeIncrementalState((state) => {
      setIncrementalState(state);
      if (state?.batchKeyframeThumbnailPath) {
        setBatchKeyframeThumbnails((prev) => {
          // De-dupe — same path may emit on subsequent ticks.
          // Normalise to `file://...` so Android <Image> in the band
          // overlay can actually render the thumbnail.
          const path = toFileUri(state.batchKeyframeThumbnailPath!);
          if (prev.includes(path)) return prev;
          return [...prev, path];
        });
      }
    });
    return () => { sub?.remove?.(); };
  }, []);
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
    const accepted = incrementalState?.acceptedCount ?? 0;
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
  }, [incrementalState?.acceptedCount, isNonAR, imuGate]);

  // ── Shutter handlers ────────────────────────────────────────────

  const handleTap = useCallback(async () => {
    if (!enablePhotoMode) return;
    try {
      let uri: string;
      let width: number;
      let height: number;
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
        const photo = await arViewRef.current.takePhoto({
          quality: 90,
          orientation: deviceOrientation,
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
        // Android <Image> needs the `file://` scheme to render the
        // returned uri; iOS is OK either way.  Normalise once here.
        uri = toFileUri(photoOutputPath);
        width = photo.width;
        height = photo.height;
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
      }

      onCapture?.({ type: 'photo', uri, width, height });
    } catch (err) {
      const e = err instanceof CameraError
        ? err
        : new CameraError(
          'PHOTO_CAPTURE_FAILED',
          err instanceof Error ? err.message : String(err),
          err,
        );
      onError?.(e);
    }
  }, [enablePhotoMode, isAR, capture, outputDir, onCapture, onError]);

  // ── startCapture — the "actually start recording" logic ─────────
  // Extracted from `handleHoldStart` so the rotate-to-landscape gate
  // (item 1/2) can DEFER it: a portrait Mode-A hold latches
  // `pendingPanStart` and an effect calls this once the user rotates.
  // Identical behaviour to the inline body it replaced — the only new
  // line is the item-5 auto-finalize timer scheduled right after
  // `setRecordingStartedAt`.
  const startCapture = useCallback(async () => {
    try {
      // 2026-05-23 (race fix) — synchronously clear thumbnails +
      // engine state at the top of startCapture, BEFORE awaiting
      // incremental.start().  In the previous effect-based design
      // the GL thread could ingest an AR frame during the await
      // window and add to thumbnails BEFORE React's
      // statusPhase-effect ran and wiped them.  See the removed
      // useEffect a few hundred lines above for the full log trace.
      // Synchronous reset here means any racing frame ingest sees
      // an empty array and accumulates from there.
      setBatchKeyframeThumbnails([]);
      setIncrementalState(null);
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
      await incremental.start({
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
        engine,
        config: panoramaSettingsToNativeConfig({
          ...settings,
          captureSource: effectiveCaptureSource,
        }),
      });
      // F8.3 review-of-review (M3 revert): `imuGate.resetAnchor()`
      // is load-bearing for the stitchMode auto-resolver (see the
      // matching comment on the per-accept reset useEffect above).
      // Keep firing it on every capture start, not just legacy mode.
      imuGate.resetAnchor();
      // Start the Frame Processor driver for non-AR captures.  AR
      // mode feeds natively from ARSession so the driver stays idle.
      // Imperative pattern (vs useEffect) because the driver's start
      // resets pose accumulators that should only fire at the
      // hold-start moment, not on every re-render.
      if (isNonAR) {
        fpDriver.start();
      }
    } catch (err) {
      setStatusPhase('idle');
      clearPanTimer();
      onError?.(
        new CameraError(
          'PANORAMA_START_FAILED',
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
    if (!enablePanoramaMode) return;
    if (!incrementalStitcherIsAvailable()) {
      onError?.(
        new CameraError(
          'PANORAMA_START_FAILED',
          'Native incremental stitcher module not available',
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
    setStatusPhase('stitching');
    // Stop pumping new frames before finalizing so the engine isn't
    // racing the final cv::Stitcher pass against late-arriving
    // keyframes.  No-op in AR mode (the driver was never started).
    fpDriver.stop();
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

      const captureResultObj: CameraCaptureResult = {
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
      };
      // Item 7 — when the crop editor is enabled AND the panorama has
      // valid intrinsic dims, defer `onCapture`: stash the result and
      // mount RectCropPreview.  The user's crop / cancel decision (the
      // modal's onConfirm / onCancel below) emits the final result.
      // Otherwise emit immediately, as before.
      if (
        rectCropPreview
        && result.width > 0
        && result.height > 0
      ) {
        setCropPending({
          uri: captureResultObj.uri,
          width: result.width,
          height: result.height,
          captureResultObj,
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
      onError?.(new CameraError(code, message, err));
    } finally {
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
    // feature/pano-ux-guidance — the release also tears down the
    // pan-duration timer + a pending rotate-gate, and decides whether to
    // route the result through the crop editor.
    clearPanTimer,
    pendingPanStart,
    rectCropPreview,
  ]);

  // Keep `handleHoldEndRef` current so the auto-finalize timer + the
  // lateral-drift effect invoke the latest `handleHoldEnd` without
  // adding it as a dep (it changes identity on every recording tick).
  useEffect(() => {
    handleHoldEndRef.current = () => { void handleHoldEnd(); };
  });

  // ── Item 6 — lateral drift → FINALIZE + popup ───────────────────
  // Mirrors the orientation-drift effect, but FINALIZES the capture
  // (keeps what was stitched) rather than cancelling it: clear the
  // pan-duration timer, latch the popup, then call handleHoldEnd via
  // its ref.  Gated off when the budget is disabled (`<= 0`).
  useEffect(() => {
    if (
      !panMotion.lateralExceeded
      || statusPhase !== 'recording'
      || lateralBudgetCm <= 0
    ) {
      return;
    }
    clearPanTimer();
    setLateralStopVisible(true);
    handleHoldEndRef.current?.();
    // Deps mirror the drift effect: re-run when the latch trips or the
    // recording state changes.  Other reads are stable setters / refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panMotion.lateralExceeded, statusPhase, lateralBudgetCm]);

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
    if (statusPhase !== 'recording' || maxPanDurationMs <= 0) return;
    const id = setInterval(() => setNowTick(Date.now()), 250);
    return () => clearInterval(id);
  }, [statusPhase, maxPanDurationMs]);

  // Whole seconds remaining for the countdown overlay (item 5).  Pure
  // helper; clamps to [0, round(maxPanDurationMs/1000)].
  const countdownSeconds = countdownSecondsFrom(
    recordingStartedAt,
    nowTick,
    maxPanDurationMs,
  );

  // ── Lens / AR-toggle handlers ───────────────────────────────────
  const handleLensChange = useCallback((next: CameraLens) => {
    setLens(next);
    onLensChange?.(next);
  }, [onLensChange]);

  const handleARToggle = useCallback(() => {
    setArPreference((prev) => !prev);
  }, []);

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

  return (
    <View style={[styles.container, style]}>
      {/* Preview — AR or non-AR (or the brief "switching…" placeholder
          while the previous session tears down).  Conditional mount so
          only ONE camera component is alive at a time; matches the
          monorepo's working pattern and avoids the Camera2-in-use
          conflict that "always mount both" caused on Android. */}
      {cameraShouldUnmount(inFlightTransition, arSupportPending, statusPhase) ? (
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
        />
      ) : (
        <CameraView
          ref={visionCameraRef}
          device={capture.device}
          isActive
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
          cameraProps={effectiveFrameProcessor != null
            ? { frameProcessor: effectiveFrameProcessor }
            : undefined}
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
      )}

      {/* REC banner + record border (during recording / stitching). */}
      <CaptureStatusOverlay
        phase={statusPhase}
        topInset={insets.top}
        recordingStartedAt={recordingStartedAt ?? undefined}
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
      {/* Item 5 — blinking 9 s countdown (top corner). */}
      <CaptureCountdownOverlay
        visible={statusPhase === 'recording' && panGuidance && maxPanDurationMs > 0}
        secondsRemaining={countdownSeconds}
        orientation={deviceOrientation}
      />
      {/* Item 3 — brief pan how-to GIF + direction arrow. */}
      <PanHowToOverlay
        visible={statusPhase === 'recording' && panGuidance && howToVisible}
        orientation={deviceOrientation}
      />
      {/* Item 4 — transient "moving too fast" pill, centred near the
          top (below the countdown).  Minimal inline pill in the shared
          guidance visual language (amber text on scrim, hairline
          border); shown only while the gyro bucket is 'bad'. */}
      {statusPhase === 'recording'
        && panGuidance
        && panMotion.panSpeedBucket === 'bad' && (
        <View style={guidanceStyles.tooFastWrap} pointerEvents="none">
          <View style={guidanceStyles.tooFastPill}>
            <Text style={guidanceStyles.tooFastText}>
              {guidanceCopyResolved.tooFast}
            </Text>
          </View>
        </View>
      )}

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
            state={incrementalState}
            topInset={insets.top}
          />
          <CaptureMemoryPill topInset={insets.top} />
          <CaptureDebugOverlay
            incrementalState={incrementalState}
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
            state={incrementalState}
            frameUris={batchKeyframeThumbnails}
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
        <View style={bottomBarStyleForEdge(homeIndicatorEdge(jsLandscape, deviceOrientation))}>
        {/* v0.13.1 — flash + AR moved to the top-right pill stack (see
            below).  Left/right slots stay as flex spacers so the shutter
            + lens chip remain centred. */}
        <View style={styles.bottomBarLeft} />
        <View style={styles.bottomBarCenter}>
          {/* v0.13.2 — lens chooser hidden in AR-only mode (ARKit/ARCore
              can't use the ultra-wide, so there's nothing to choose). */}
          {!arOnly && (
            <LensChip
              lens={lens}
              onChange={handleLensChange}
              has0_5x={has0_5x}
              contentRotation={contentRotation}
            />
          )}
          <View style={styles.shutterWrap}>
            <CameraShutter
              onTap={handleTap}
              onHoldStart={enablePanoramaMode ? handleHoldStart : noop}
              onHoldComplete={enablePanoramaMode ? handleHoldEnd : noop}
              isProcessing={statusPhase === 'stitching'}
              disabled={statusPhase === 'stitching'}
            />
          </View>
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
            nothing to toggle.  Still gated on 1× + device AR support. */}
        {arAllowed && nonArAllowed && lens === '1x' && isARSupportedOnDevice && (
          <ARToggle arEnabled={arPreference} onToggle={handleARToggle} contentRotation={contentRotation} />
        )}
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

      {/* Item 1/2 — rotate-to-landscape prompt.  Shown while a Mode-A
          hold is blocked on the user rotating to landscape.  The resume
          effect starts the deferred capture the instant they do. */}
      {/* The rotate prompt is the ONLY feedback for the Mode-A gate, so it
          is NOT gated on `panGuidance` — otherwise panGuidance={false} +
          panMode='mode-a' would block a portrait hold with a dead, silent
          shutter.  `panGuidance` governs only the cosmetic in-capture
          overlays. */}
      <RotateToLandscapePrompt
        visible={pendingPanStart}
        copy={guidanceCopyResolved.rotateToLandscape}
      />

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
        title={guidanceCopyResolved.lateralStopTitle}
        body={guidanceCopyResolved.lateralStopBody}
        dismissLabel={guidanceCopyResolved.lateralStopDismiss}
        onDismiss={() => setLateralStopVisible(false)}
      />

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

      {/* Item 7 — draggable-quad crop editor, shown after a panorama
          finalizes when `rectCropPreview` is on (handleHoldEnd stashed
          the pending result instead of emitting it).
            - Cancel → emit the original, un-cropped panorama.
            - Crop   → cropQuad (perspective-rectify when the quad isn't
                       axis-aligned) overwrites the file in place; emit
                       with the rectified dims + a cache-busting query so
                       <Image> reloads the overwritten file.  On any
                       crop failure, fall back to the original. */}
      <RectCropPreview
        // Remount per capture so the dragged-quad + layout state re-seed to
        // the new image (RectCropPreview seeds its quad once via useState).
        key={cropPending?.uri ?? 'crop'}
        visible={cropPending != null}
        imageUri={cropPending?.uri ?? ''}
        imageWidth={cropPending?.width ?? 0}
        imageHeight={cropPending?.height ?? 0}
        perspectiveCorrect={perspectiveCorrectCrop}
        copy={guidanceCopyResolved}
        onCancel={() => {
          if (cropPending) onCapture?.(cropPending.captureResultObj);
          setCropPending(null);
        }}
        onConfirm={async ({ quad, perspective }) => {
          if (!cropPending) return;
          const pending = cropPending;
          // perspective=true → rectify the dragged quad to an upright
          // rectangle (cropToQuad).  perspective=false (axis-aligned drag,
          // OR perspectiveCorrectCrop disabled) → crop to the quad's axis-
          // aligned bounding box — a plain crop, no warp — so the
          // perspectiveCorrectCrop={false} contract is honoured.
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
    </View>
  );
}


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
): boolean {
  return inFlightTransition || arSupportPending || statusPhase === 'stitching';
}

/** @internal test-only — see `cameraShouldUnmount`. */
export const _cameraShouldUnmountForTests = cameraShouldUnmount;


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


// feature/pano-ux-guidance — item 4 "moving too fast" pill.  Self-
// contained, in the shared guidance visual language (GUIDANCE_TOKENS /
// GUIDANCE_PILL): amber text on the scrim background with a hairline
// border, centred near the top, below the countdown.  Non-interactive
// (the wrapper sets pointerEvents="none" so it never eats touches).
const guidanceStyles = StyleSheet.create({
  tooFastWrap: {
    position: 'absolute',
    top: 96,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  tooFastPill: {
    paddingVertical: GUIDANCE_PILL.paddingVertical,
    paddingHorizontal: GUIDANCE_PILL.paddingHorizontal,
    borderRadius: GUIDANCE_PILL.borderRadius,
    backgroundColor: GUIDANCE_TOKENS.scrim,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: GUIDANCE_TOKENS.amber,
  },
  tooFastText: {
    color: GUIDANCE_TOKENS.amber,
    fontSize: GUIDANCE_PILL.fontSize,
    fontWeight: GUIDANCE_PILL.fontWeight,
  },
});
