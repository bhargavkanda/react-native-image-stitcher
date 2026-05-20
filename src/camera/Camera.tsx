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
  const [batchKeyframeThumbnails, setBatchKeyframeThumbnails] = useState<
    string[]
  >([]);

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

  // IMU translation gate — only in non-AR mode.
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

  // JS-driver for non-AR captures (iOS + Android).  Starts/stops with
  // recording.  In AR mode the engine consumes frames from the
  // ARSession stream natively, so this hook stays idle.
  const jsDriver = useIncrementalJSDriver();
  useEffect(() => {
    if (!isNonAR) return undefined;
    if (statusPhase === 'recording') {
      jsDriver.start(visionCameraRef);
    } else {
      jsDriver.stop();
    }
    return () => {
      jsDriver.stop();
    };
  }, [statusPhase, isNonAR, jsDriver]);

  // ── Subscribe to engine state for live keyframe thumbs ──────────
  useEffect(() => {
    const sub = subscribeIncrementalState((state) => {
      setIncrementalState(state);
      if (state?.batchKeyframeThumbnailPath) {
        setBatchKeyframeThumbnails((prev) => {
          // De-dupe — same path may emit on subsequent ticks.
          const path = state.batchKeyframeThumbnailPath!;
          if (prev.includes(path)) return prev;
          return [...prev, path];
        });
      }
    });
    return () => { sub?.remove?.(); };
  }, []);
  useEffect(() => {
    if (statusPhase === 'recording') {
      setBatchKeyframeThumbnails([]);
      setIncrementalState(null);
    }
  }, [statusPhase]);

  // ── Shutter handlers ────────────────────────────────────────────

  const handleTap = useCallback(async () => {
    if (!enablePhotoMode) return;
    try {
      let uri: string;
      let width: number;
      let height: number;
      if (isAR && arViewRef.current) {
        const photo = await arViewRef.current.takePhoto({ quality: 90 });
        uri = photo.path;
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
        // Effect: capture.takePhoto() resolves with the SDK's
        // CaptureResult (with compressedUri / width / height).
        // We adapt to the public CameraCaptureResult shape.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (capture.cameraRef as any).current = visionCameraRef.current;
        const result = await capture.takePhoto();
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
  }, [enablePhotoMode, isAR, capture, onCapture, onError]);

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
          stitchMode: settings.stitchMode,
          warperType: settings.warperType,
          blenderType: settings.blenderType,
          seamFinderType: settings.seamFinderType,
          flowNoveltyPercentile: settings.flowNoveltyPercentile,
          flowEvalEveryNFrames: settings.flowEvalEveryNFrames,
          flowMaxTranslationCm: settings.flowMaxTranslationCm,
          keyframeMaxCount: settings.keyframeMaxCount,
          keyframeOverlapThreshold: settings.keyframeOverlapThreshold,
          frameSelectionMode: 'flow-based',
        },
      });
      imuGate.resetAnchor();
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
    onError,
  ]);

  const handleHoldEnd = useCallback(async () => {
    if (statusPhase !== 'recording') return;
    setStatusPhase('stitching');
    try {
      const result = await incremental.finalize(
        undefined,
        90,
        deviceOrientation,
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
        uri: result.panoramaPath,
        width: result.width,
        height: result.height,
        framesRequested: result.framesRequested ?? -1,
        framesIncluded: result.framesIncluded ?? -1,
        framesDropped:
          (result.framesRequested ?? 0) - (result.framesIncluded ?? 0),
        finalConfidenceThresh: result.finalConfidenceThresh ?? -1,
        durationMs: Date.now() - (recordingStartedAt ?? Date.now()),
      });
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
      {/* Preview — AR or non-AR.  Conditional mount so only ONE
          camera component is alive at a time; this matches the
          monorepo's working pattern and avoids the Camera2-in-use
          conflict that "always mount both" caused on Android. */}
      {isAR ? (
        <ARCameraView
          ref={arViewRef}
          style={StyleSheet.absoluteFill}
        />
      ) : (
        <CameraView
          ref={visionCameraRef}
          device={capture.device}
          isActive
          video={false}
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
