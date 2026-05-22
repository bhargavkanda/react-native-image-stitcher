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
  useRef,
  useState,
} from 'react';
import {
  NativeModules,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Camera as VisionCamera } from 'react-native-vision-camera';

import { useARSession } from '../ar/useARSession';
import { ARCameraView, type ARCameraViewHandle } from './ARCameraView';
import { CameraShutter } from './CameraShutter';
import { CameraView } from './CameraView';
import { CaptureStatusOverlay, type CaptureStatusPhase } from './CaptureStatusOverlay';
import { CaptureDebugOverlay } from './CaptureDebugOverlay';
import { CaptureMemoryPill } from './CaptureMemoryPill';
import { CaptureKeyframePill } from './CaptureKeyframePill';
import { CaptureOrientationPill } from './CaptureOrientationPill';
import { CaptureStitchStatsToast, useStitchStatsToast } from './CaptureStitchStatsToast';
import { PanoramaBandOverlay } from './PanoramaBandOverlay';
import {
  DEFAULT_PANORAMA_SETTINGS,
  PanoramaSettingsModal,
  type PanoramaSettings,
} from './PanoramaSettingsModal';
import { useCapture } from './useCapture';
import { useDeviceOrientation } from './useDeviceOrientation';
import {
  getIncrementalNativeModule,
  incrementalStitcherIsAvailable,
  subscribeIncrementalState,
  type IncrementalState,
} from '../stitching/incremental';
import { useIncrementalJSDriver } from '../stitching/useIncrementalJSDriver';
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
  /** Forward-looking — wires through to cv::Stitcher's compositingResol
   *  once PanoramaSettings exposes the field (currently a no-op). */
  defaultCompositingResolMP?: number;
  /** Forward-looking — see above. */
  defaultRegistrationResolMP?: number;
  /** Forward-looking — see above. */
  defaultSeamEstimationResolMP?: number;

  // ── UI knobs ──────────────────────────────────────────────────────
  enablePhotoMode?: boolean;
  enablePanoramaMode?: boolean;
  showSettingsButton?: boolean;
  style?: StyleProp<ViewStyle>;

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
}
function LensChip({ lens, onChange, has0_5x }: LensChipProps): React.JSX.Element {
  if (!has0_5x) {
    return (
      <View style={[lensChipStyles.container, lensChipStyles.singleLens]}>
        <Text style={lensChipStyles.label}>1×</Text>
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
}
function ARToggle({ arEnabled, onToggle }: ARToggleProps): React.JSX.Element {
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
 * Apply per-prop defaults to build the initial settings snapshot.
 * The settings live in component state from there; the prop values
 * never re-flow.
 *
 * Note: the `default*ResolMP` props don't have a home on PanoramaSettings
 * yet — they're accepted on the prop interface for forward compatibility
 * but ignored here.  Wiring is a follow-up once PanoramaSettings is
 * extended.
 */
function buildInitialSettings(props: CameraProps): PanoramaSettings {
  return {
    ...DEFAULT_PANORAMA_SETTINGS,
    stitchMode: props.defaultStitchMode ?? DEFAULT_PANORAMA_SETTINGS.stitchMode,
    blenderType:
      props.defaultBlender ?? DEFAULT_PANORAMA_SETTINGS.blenderType,
    seamFinderType:
      props.defaultSeamFinder ?? DEFAULT_PANORAMA_SETTINGS.seamFinderType,
    warperType:
      props.defaultWarper ?? DEFAULT_PANORAMA_SETTINGS.warperType,
    flowNoveltyPercentile:
      props.defaultFlowNoveltyPercentile ??
      DEFAULT_PANORAMA_SETTINGS.flowNoveltyPercentile,
    flowEvalEveryNFrames:
      props.defaultFlowEvalEveryNFrames ??
      DEFAULT_PANORAMA_SETTINGS.flowEvalEveryNFrames,
    flowMaxTranslationCm:
      props.defaultFlowMaxTranslationCm ??
      DEFAULT_PANORAMA_SETTINGS.flowMaxTranslationCm,
    keyframeMaxCount:
      props.defaultKeyframeMaxCount ??
      DEFAULT_PANORAMA_SETTINGS.keyframeMaxCount,
    keyframeOverlapThreshold:
      props.defaultKeyframeOverlapThreshold ??
      DEFAULT_PANORAMA_SETTINGS.keyframeOverlapThreshold,
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
    defaultCaptureSource = 'ar',
    defaultLens = '1x',
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
  } = props;

  const insets = useSafeAreaInsets();

  // ── State ───────────────────────────────────────────────────────
  const [arPreference, setArPreference] = useState(
    defaultCaptureSource === 'ar',
  );
  const [lens, setLens] = useState<CameraLens>(defaultLens);
  const [settings, setSettings] = useState<PanoramaSettings>(() =>
    buildInitialSettings(props),
  );
  const [settingsModalVisible, setSettingsModalVisible] = useState(false);
  const [statusPhase, setStatusPhase] = useState<CaptureStatusPhase>('idle');
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(
    null,
  );
  const [incrementalState, setIncrementalState] = useState<IncrementalState | null>(null);
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
  const { isAvailable: isARSupportedOnDevice } = useARSession();

  const effectiveCaptureSource = deriveEffectiveCaptureSource(
    arPreference,
    lens,
    isARSupportedOnDevice,
  );
  const isAR = effectiveCaptureSource === 'ar';
  const isNonAR = !isAR;
  const deviceOrientation = useDeviceOrientation();

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


  // ── Notify parent of capture-source changes ─────────────────────
  const lastEmittedSourceRef = useRef<CaptureSource | null>(null);
  useEffect(() => {
    if (lastEmittedSourceRef.current !== effectiveCaptureSource) {
      lastEmittedSourceRef.current = effectiveCaptureSource;
      onCaptureSourceChange?.(effectiveCaptureSource);
    }
  }, [effectiveCaptureSource, onCaptureSourceChange]);

  // ── Lens chip availability ──────────────────────────────────────
  // TODO follow-up: probe the device's available physical lenses via
  // vision-camera's `useCameraDevices` and surface in
  // `useCapture().availablePhysicalDevices`.  For now we assume the
  // 0.5x ultra-wide exists on modern devices.  When it doesn't, the
  // lens chip degenerates to a static 1× indicator (see LensChip).
  const has0_5x = true;

  // ── Capture hooks ───────────────────────────────────────────────
  const capture = useCapture({
    cameraPosition: 'back',
    enableQualityChecks: false,
    preferredPhysicalDevice:
      lens === '0.5x' ? 'ultra-wide-angle-camera' : 'wide-angle-camera',
  });
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
  const imuGate = useIMUTranslationGate({
    enabled:
      isNonAR
      && statusPhase === 'recording'
      && settings.flowMaxTranslationCm > 0,
    budgetMeters: Math.max(0.001, settings.flowMaxTranslationCm / 100.0),
    onBudgetExceeded: () => {
      const mod = getIncrementalNativeModule();
      mod?.markNextFrameAsLastKeyframe?.().catch(() => undefined);
    },
  });

  // JS-driver for non-AR captures (iOS + Android).  In AR mode the
  // engine consumes frames from the ARSession stream natively, so this
  // hook stays idle.
  //
  // IMPORTANT: start()/stop() are called imperatively from the hold
  // handlers below — NOT from a useEffect driven by statusPhase.  The
  // hook returns a fresh object identity on every render, and during
  // a recording the engine emits IncrementalStateUpdate events that
  // cause re-renders multiple times per second.  An effect with
  // `jsDriver` in its deps would teardown + restart the driver on
  // every event, resetting the gyro accumulator (yaw/pitch) to zero
  // each cycle and nulling the cameraRef during the brief gap.  The
  // user-visible symptom was "only the first keyframe is accepted,
  // every subsequent snapshot sees pose=(0,0) and is rejected as a
  // duplicate of the first".  Matching AuditCaptureScreen's proven
  // imperative pattern (start on hold-start, stop on hold-end) avoids
  // the re-render churn entirely.
  const jsDriver = useIncrementalJSDriver();
  // Safety: ensure the driver is stopped if the component unmounts
  // mid-recording.  Empty deps so this only fires on unmount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => { jsDriver.stop(); }, []);

  // ── Subscribe to engine state for live keyframe thumbs ──────────
  useEffect(() => {
    const sub = subscribeIncrementalState((state) => {
      // 2026-05-23 (debug) — log every emit so we can correlate
      // native-side accepts with JS-side thumbnail-strip state.
      // Logs gated on debug to keep production noise-free.
      // eslint-disable-next-line no-console
      if (state) {
        console.log(
          `[incremental.state] outcome=${state.outcome} acceptedCount=${state.acceptedCount}`
          + ` kfMax=${state.keyframeMax} overlap=${state.overlapPercent?.toFixed?.(1) ?? '?'}`
          + ` thumbPath=${state.batchKeyframeThumbnailPath ?? '(none)'}`
          + ` thumbIdx=${state.batchKeyframeIndex ?? '(none)'}`,
        );
      }
      setIncrementalState(state);
      if (state?.batchKeyframeThumbnailPath) {
        setBatchKeyframeThumbnails((prev) => {
          // De-dupe — same path may emit on subsequent ticks.
          // Normalise to `file://...` so Android <Image> in the band
          // overlay can actually render the thumbnail.
          const path = toFileUri(state.batchKeyframeThumbnailPath!);
          if (prev.includes(path)) return prev;
          const next = [...prev, path];
          // eslint-disable-next-line no-console
          console.log(`[incremental.thumbs] adding ${path} → [${next.join(', ')}]`);
          return next;
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
        const photo = await arViewRef.current.takePhoto({ quality: 90 });
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

  const handleHoldStart = useCallback(async () => {
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
    try {
      // 2026-05-23 (race fix) — synchronously clear thumbnails +
      // engine state at the top of handleHoldStart, BEFORE awaiting
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
      const orientationRotation: 0 | 90 | 180 | 270 =
        deviceOrientation === 'portrait' ? 90
          : deviceOrientation === 'portrait-upside-down' ? 270
            : 0;
      await incremental.start({
        snapshotJpegQuality: 75,
        snapshotEveryNAccepts: 1,
        frameRotationDegrees: orientationRotation,
        captureOrientation: deviceOrientation,
        frameSourceMode: isNonAR ? 'jsDriver' : 'arSession',
        composeWidth: 1920,
        composeHeight: 1080,
        canvasWidth: 5000,
        canvasHeight: 5000,
        engine: 'batch-keyframe',
        config: {
          // ── cv::Stitcher (batch finalize) ─────────────────────────
          stitchMode: settings.stitchMode,
          warperType: settings.warperType,
          blenderType: settings.blenderType,
          seamFinderType: settings.seamFinderType,
          enableMaxInscribedRectCrop: settings.enableMaxInscribedRectCrop,
          // ── KeyframeGate (per-frame selection) ────────────────────
          // F6 audit fix: pass settings.frameSelectionMode through
          // instead of hardcoding 'flow-based' (which silently made the
          // time-based / pose-based modal options no-ops).
          frameSelectionMode: settings.frameSelectionMode,
          keyframeMaxCount: settings.keyframeMaxCount,
          keyframeOverlapThreshold: settings.keyframeOverlapThreshold,
          // ── Flow-strategy tunables ────────────────────────────────
          // F4 audit fix: previously omitted, which made the modal
          // sliders for these three a complete no-op (only iOS native
          // even read them, and only when JS sent them).
          flowNoveltyPercentile: settings.flowNoveltyPercentile,
          flowEvalEveryNFrames: settings.flowEvalEveryNFrames,
          flowMaxTranslationCm: settings.flowMaxTranslationCm,
          flowMaxCorners: settings.flowMaxCorners,
          flowQualityLevel: settings.flowQualityLevel,
          flowMinDistance: settings.flowMinDistance,
          // ── Engine-routing flags consumed by native ───────────────
          // F1 audit fix: Android keyframe gate's disableAngularFallback
          // opt-out reads this to decide whether to skip the angular
          // fallback (gyro pose is too noisy for the FoV-overlap calc
          // in non-AR mode, causing degenerate cv::Stitcher params).
          captureSource: settings.captureSource,
        },
      });
      imuGate.resetAnchor();
      // Start pumping vision-camera snapshots into the engine for
      // non-AR captures.  AR mode feeds frames natively from the
      // ARSession, so the JS driver stays idle in that path.  This
      // mirrors AuditCaptureScreen.handleHoldStart's `androidDriver.start`
      // imperative call — see the comment near `useIncrementalJSDriver`
      // for why this is NOT done via useEffect.
      if (isNonAR) {
        jsDriver.start(visionCameraRef);
      }
    } catch (err) {
      setStatusPhase('idle');
      onError?.(
        new CameraError(
          'PANORAMA_START_FAILED',
          err instanceof Error ? err.message : String(err),
          err,
        ),
      );
    }
  }, [
    enablePanoramaMode,
    incremental,
    isNonAR,
    deviceOrientation,
    settings,
    imuGate,
    jsDriver,
    onError,
  ]);

  const handleHoldEnd = useCallback(async () => {
    if (statusPhase !== 'recording') return;
    setStatusPhase('stitching');
    // Stop pumping new snapshots before finalizing so the engine isn't
    // racing the final cv::Stitcher pass against late-arriving keyframes.
    // No-op in AR mode where jsDriver was never started.
    jsDriver.stop();
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
        90,
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
      onCapture?.({
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
      });
      // 2026-05-22 (audit F9) — fire the debug stitch-stats toast on
      // every successful finalize when settings.debug is on.  Shows
      // the leaveBiggestComponent retry telemetry + resolved mode so
      // the operator can see what choice the auto-resolver made.
      if (settings.debug) {
        stitchToast.showResult(result);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code: CameraErrorCode =
        /need more images/i.test(message) ? 'STITCH_NEED_MORE_IMGS'
        : /homography/i.test(message) ? 'STITCH_HOMOGRAPHY_FAIL'
        : /camera params/i.test(message) ? 'STITCH_CAMERA_PARAMS_FAIL'
        : /out of memory|oom/i.test(message) ? 'STITCH_OOM'
        : 'PANORAMA_FINALIZE_FAILED';
      onError?.(new CameraError(code, message, err));
    } finally {
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
    jsDriver,
  ]);

  // ── Lens / AR-toggle handlers ───────────────────────────────────
  const handleLensChange = useCallback((next: CameraLens) => {
    setLens(next);
    onLensChange?.(next);
  }, [onLensChange]);

  const handleARToggle = useCallback(() => {
    setArPreference((prev) => !prev);
  }, []);

  // ── JSX ─────────────────────────────────────────────────────────

  return (
    <View style={[styles.container, style]}>
      {/* Preview — AR or non-AR (or the brief "switching…" placeholder
          while the previous session tears down).  Conditional mount so
          only ONE camera component is alive at a time; matches the
          monorepo's working pattern and avoids the Camera2-in-use
          conflict that "always mount both" caused on Android. */}
      {inFlightTransition ? (
        <View style={[StyleSheet.absoluteFill, styles.transitionPlaceholder]}>
          <Text style={styles.transitionLabel}>Switching camera…</Text>
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
          flash="off"
          style={StyleSheet.absoluteFill}
        />
      )}

      {/* REC banner + record border (during recording / stitching). */}
      <CaptureStatusOverlay
        phase={statusPhase}
        topInset={insets.top}
        recordingStartedAt={recordingStartedAt ?? undefined}
      />

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
            frameSelectionMode={settings.frameSelectionMode}
            stitchMode={settings.stitchMode}
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

      {/* Settings gear (top-right), gated on showSettingsButton. */}
      {showSettingsButton && (
        <SettingsButton
          topInset={insets.top}
          onPress={() => setSettingsModalVisible(true)}
        />
      )}

      {/*
        Bottom area: stacks the live-frame band ABOVE the shutter row
        so the band is tethered to the shutter on the viewport side
        (the operator's eye is drawn from the camera preview, down
        the band, into the shutter — a single continuous reading
        path).  With the SDK's orientation lock holding the UI in
        portrait, this stack works the same regardless of how the
        device is physically held.
      */}
      <View
        pointerEvents="box-none"
        style={[styles.bottomArea, { paddingBottom: insets.bottom + 12 }]}
      >
        {/* Live-frame band — only visible while recording. */}
        {statusPhase === 'recording' && (
          <PanoramaBandOverlay
            state={incrementalState}
            frameUris={batchKeyframeThumbnails}
            captureOrientation={deviceOrientation}
          />
        )}

        {/* Shutter row: lens chip (left), shutter (centre), AR toggle (right). */}
        <View style={styles.bottomBar}>
        <View style={styles.bottomBarLeft} />
        <View style={styles.bottomBarCenter}>
          <LensChip
            lens={lens}
            onChange={handleLensChange}
            has0_5x={has0_5x}
          />
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
        <View style={styles.bottomBarRight}>
          {lens === '1x' && isARSupportedOnDevice && (
            <ARToggle arEnabled={arPreference} onToggle={handleARToggle} />
          )}
        </View>
        </View>
      </View>

      {/* Settings modal (rendered always, visible-gated). */}
      <PanoramaSettingsModal
        visible={settingsModalVisible}
        settings={settings}
        onChange={setSettings}
        onClose={() => setSettingsModalVisible(false)}
      />
    </View>
  );
}


function noop(): void {
  /* no-op handler used when panorama mode is disabled */
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
});
