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
import type {
  Camera as VisionCamera,
  DrawableFrameProcessor,
  ReadonlyFrameProcessor,
} from 'react-native-vision-camera';

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
import { type PanoramaSettings } from './PanoramaSettings';
import { panoramaSettingsToNativeConfig } from './PanoramaSettingsBridge';
import { PanoramaSettingsModal } from './PanoramaSettingsModal';
import {
  buildPanoramaInitialSettings,
  type PanoramaPropOverrides,
} from './buildPanoramaInitialSettings';
import { isLowMemDevice } from './lowMemDevice';
import { useCapture } from './useCapture';
import { useDeviceOrientation } from './useDeviceOrientation';
import {
  getIncrementalNativeModule,
  incrementalStitcherIsAvailable,
  subscribeIncrementalState,
  type IncrementalState,
} from '../stitching/incremental';
import { useIncrementalJSDriver } from '../stitching/useIncrementalJSDriver';
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

  /**
   * Optional vision-camera frame processor.  Only attached to the
   * non-AR preview (AR mode uses ARCameraView, which doesn't expose
   * a worklet seam).  Build the worklet on the host side with
   * `useFrameProcessor` from `react-native-vision-camera`.
   *
   * Introduced for F8 (FrameProcessor port) — see
   * `docs/f8-frame-processor-plan.md`.
   *
   * As of v0.5 (F8.3) this prop is **deprecated for the standard
   * non-AR capture flow**: the SDK now installs its own frame
   * processor via `useFrameProcessorDriver` that pipes pixel
   * buffers into the incremental stitcher with synthesised pose.
   * Setting this prop in the default mode will be IGNORED with a
   * one-time console.warn — supplying your own worklet would race
   * with the SDK's pixel-buffer feed.
   *
   * Three coexistence rules:
   *   * Default (modern non-AR): SDK owns the worklet, this prop
   *     is ignored.
   *   * `legacyDriver={true}`: SDK uses the old `useIncrementalJSDriver`
   *     (takeSnapshot path).  Honoured for diagnostics or as an
   *     escape hatch.
   *   * AR mode: vision-camera Camera isn't mounted, this prop is
   *     irrelevant.
   */
  frameProcessor?: ReadonlyFrameProcessor | DrawableFrameProcessor;

  /**
   * Opt back into the legacy `useIncrementalJSDriver` for non-AR
   * captures (the v0.4 path: `takeSnapshot` → JPEG → cache file →
   * `IncrementalStitcher.processFrameAtPath`).
   *
   * Default `false` (use the new `useFrameProcessorDriver`, which
   * runs the gate on the camera producer thread at native frame
   * rate via a vision-camera Frame Processor plugin).  The legacy
   * path will be removed in v0.6 — set this only if you hit a
   * specific issue with the new driver and need to ship a fix.
   */
  legacyDriver?: boolean;
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
    frameProcessor: hostFrameProcessor,
    legacyDriver = false,
  } = props;

  const insets = useSafeAreaInsets();

  // ── State ───────────────────────────────────────────────────────
  const [arPreference, setArPreference] = useState(
    defaultCaptureSource === 'ar',
  );
  const [lens, setLens] = useState<CameraLens>(defaultLens);
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
  // F8.3 — vision-camera Frame Processor variant.  Always
  // instantiated so we don't have conditional hook calls; only one
  // of the two drivers actually .start()s per capture.  Stop() on
  // an idle driver is a no-op.
  const fpDriver = useFrameProcessorDriver();
  // Safety: ensure both drivers are stopped if the component unmounts
  // mid-recording.  Empty deps so this only fires on unmount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => { jsDriver.stop(); fpDriver.stop(); }, []);

  // F8.3 — one-shot deprecation warning when the host supplies their
  // own `frameProcessor` while running in the default (Frame
  // Processor driver) mode.  Two worklets racing on the same
  // producer thread would corrupt the engine's workQueue ordering;
  // the SDK's own worklet wins and the host's is ignored.  Hosts
  // that *need* a custom worklet must opt into `legacyDriver={true}`
  // (which switches off the SDK's worklet entirely).
  const hostFrameProcessorIgnoredWarnedRef = useRef(false);
  if (
    hostFrameProcessor != null
    && !legacyDriver
    && !hostFrameProcessorIgnoredWarnedRef.current
  ) {
    hostFrameProcessorIgnoredWarnedRef.current = true;
    // eslint-disable-next-line no-console
    console.warn(
      '[react-native-image-stitcher] The `frameProcessor` prop on '
      + '<Camera> is ignored when the default driver is active '
      + '(legacyDriver=false).  Either remove the prop or set '
      + 'legacyDriver={true} to opt into the legacy path.',
    );
  }
  // The Frame Processor worklet actually bound to vision-camera's
  // Camera.  Resolution order:
  //   1. Legacy mode: honor the host's prop (or null).
  //   2. Modern mode: SDK driver's worklet, regardless of host's prop.
  const effectiveFrameProcessor = legacyDriver
    ? (hostFrameProcessor ?? null)
    : fpDriver.frameProcessor;

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
      // F8.3 review-of-review (M3 revert): originally gated this to
      // `legacyDriver` because the Frame Processor driver doesn't
      // consult `imuGate` for its own pose synthesis.  That ignored a
      // load-bearing side effect: `imuGate.resetAnchor()` bounds the
      // IIR-integrator drift window per-accept, and
      // `imuGate.getTotalAbsMetres()` is read at finalize time
      // (Camera.tsx:1097) as `imuTranslationMetres` into the native
      // stitchMode auto-resolver (PANORAMA vs SCANS).  Without the
      // per-accept reset, long FP-driver captures let IIR drift
      // compound → inflated metres → biased toward SCANS.  Keep the
      // reset firing for ALL non-AR modes.
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
        // F8.3 — non-AR captures pick between the new Frame Processor
        // driver (default) and the legacy JS-snapshot driver (opt-in
        // via `legacyDriver={true}`).  AR captures always use the
        // ARSession-driven path.
        frameSourceMode: isNonAR
          ? (legacyDriver ? 'jsDriver' : 'frameProcessor')
          : 'arSession',
        composeWidth: 1920,
        composeHeight: 1080,
        canvasWidth: 5000,
        canvasHeight: 5000,
        engine: 'batch-keyframe',
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
      // Start the non-AR frame source.  AR mode feeds natively from
      // ARSession so both drivers stay idle in that path.
      //   * Default: Frame Processor driver — worklet runs on the
      //     producer thread, plugin calls `consumeFrameFromPlugin`
      //     directly.  No camera ref needed (vision-camera owns it).
      //   * Legacy: JS driver — `takeSnapshot` + `processFrameAtPath`
      //     via the cameraRef.
      // Imperative-pattern rationale: see the useIncrementalJSDriver
      // comment above re. why this isn't a useEffect.
      if (isNonAR) {
        if (legacyDriver) {
          jsDriver.start(visionCameraRef);
        } else {
          fpDriver.start();
        }
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
    effectiveCaptureSource,
    imuGate,
    jsDriver,
    fpDriver,
    legacyDriver,
    onError,
  ]);

  const handleHoldEnd = useCallback(async () => {
    if (statusPhase !== 'recording') return;
    setStatusPhase('stitching');
    // Stop pumping new frames before finalizing so the engine isn't
    // racing the final cv::Stitcher pass against late-arriving
    // keyframes.  Both stop() calls are no-ops when the
    // corresponding driver wasn't started (AR mode, or the inactive
    // driver in non-AR mode).
    jsDriver.stop();
    fpDriver.stop();
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
