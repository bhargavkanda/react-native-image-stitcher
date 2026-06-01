// SPDX-License-Identifier: Apache-2.0
/**
 * useCapture — React hook that encapsulates the camera capture state
 * machine so host apps get a drop-in replacement for the ad-hoc
 * vision-camera wiring they used to have inline on each screen.
 *
 * Responsibilities:
 *   - Holds the Camera ref for ``takePhoto``.
 *   - Tracks the device permission state and exposes a request helper.
 *   - Manages torch / flash state + a toggle helper.
 *   - Wraps takePhoto with a single-flight guard so a double-tap on
 *     the shutter button doesn't spawn two captures in parallel.
 *   - Runs an optional JS-side quality check on the captured image
 *     before resolving; the host app sees the QualityReport on the
 *     returned CaptureResult.
 *
 * Non-goals:
 *   - This hook does NOT persist captures.  Host apps hand the
 *     returned CaptureResult to their own storage layer (WatermelonDB
 *     insert, Redux dispatch, whatever).
 *   - Video recording lives in useVideoCapture.
 *
 * The public API is designed to be minimal and replaceable: host apps
 * that prefer the raw vision-camera API can opt out of this hook and
 * still use the SDK's quality + stitching modules.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Camera,
  useCameraDevice,
  useCameraDevices,
  useCameraPermission,
  type PhotoFile,
  type PhysicalCameraDeviceType,
  type TakePhotoOptions,
} from 'react-native-vision-camera';

import {
  selectCaptureDevice,
  zoomForLens,
  type CaptureDeviceMode,
  type DeviceLike,
} from './selectCaptureDevice';
import { runQualityCheck } from '../quality/runQualityCheck';
import { normaliseOrientation } from '../quality/normaliseOrientation';
import { toBareFilePath } from '../utils/paths';
import {
  defaultPhotoFilename,
  getDefaultCaptureDir,
  moveFile,
} from '../utils/files';
import type {
  CaptureResult,
  QualityReport,
  QualityThresholds,
} from '../types';


/**
 * Hook input.  Everything optional; sensible defaults are applied
 * so simple call-sites can write ``useCapture()`` and get a usable
 * back-camera pipeline with ``flash=off`` and no quality checking.
 */
export interface UseCaptureOptions {
  /** 'back' | 'front' — defaults to 'back' (shelf photos). */
  cameraPosition?: 'back' | 'front';
  /** Quality check toggle + thresholds. */
  enableQualityChecks?: boolean;
  qualityThresholds?: QualityThresholds;
  /**
   * Extra TakePhotoOptions to pass through to vision-camera.
   * The SDK merges these with its defaults; host-supplied values win.
   */
  takePhotoOptions?: TakePhotoOptions;
  /**
   * 2026-05-14 — preferred physical-lens type for the chosen
   * `cameraPosition`.  Maps to vision-camera's `physicalDevices`
   * filter on `useCameraDevice`.
   *
   *   undefined (default) — use vision-camera's selection algorithm,
   *                         which picks the device that combines
   *                         the most lenses (typically the "main"
   *                         multi-lens virtual camera).  Existing
   *                         behaviour; backwards-compatible.
   *   'wide-angle-camera' — 1× physical lens (the standard rear
   *                         camera most users think of as "the
   *                         camera").
   *   'ultra-wide-angle-camera' — 0.5× ultra-wide lens (only on
   *                         devices with one; Samsung A35 has one;
   *                         iPhone 11 Pro and later have one).
   *   'telephoto-camera'  — 2× / 3× telephoto if the device has
   *                         one.  Rare on field-rep deployments;
   *                         exposed for symmetry.
   *
   * When the preferred type isn't available on the device, the
   * hook falls back to vision-camera's default selection (i.e.,
   * behaves as if `preferredPhysicalDevice` was undefined).  The
   * returned `availablePhysicalDevices` exposes what the device
   * actually offers so the host can render an appropriate switcher.
   *
   * v0.13.2 — superseded by `lens` for `<Camera>`'s own use (see
   * `selectCaptureDevice`).  Still honoured for direct Layer-2 hosts.
   */
  preferredPhysicalDevice?: PhysicalCameraDeviceType;
  /**
   * v0.13.2 — the active UI lens (`1×` / `0.5×`).  When supplied, the
   * hook uses capability-aware selection (`selectCaptureDevice`): it
   * prefers a multi-cam device spanning both FOVs (lens switched via
   * `zoom`, torch available on every lens), and falls back to a
   * standalone ultra-wide device-swap only where no such multi-cam
   * device exists.  Fixes the "0.5× shows wide-angle on some phones"
   * and "flash unavailable on 0.5×" bugs.  When omitted, the legacy
   * `preferredPhysicalDevice` path is used (backwards-compatible).
   */
  lens?: '1x' | '0.5x';
}


/**
 * Per-call options for `takePhoto`.  Separate from `UseCaptureOptions`
 * (the hook-level config) so callers can vary the destination
 * filename per capture without re-creating the hook.
 */
export interface TakePhotoCallOptions {
  /**
   * Move the captured JPEG to this fully-resolved path after EXIF
   * orientation correction.  Requires `expo-file-system` in the
   * host (declared as an OPTIONAL peer — only needed when
   * `outputPath` is set).  Host is responsible for the destination
   * directory's existence and writability; lib rejects loudly on
   * disk failure rather than silently falling back to a tmp path.
   *
   * Format: bare path (e.g. `/data/.../foo.jpg`) or `file://`-prefixed
   * URI — both accepted; lib normalises internally.
   */
  outputPath?: string;
}


/**
 * Hook output.  Intentionally flat so destructuring a subset is
 * cheap and the API doesn't force callers to drill into nested
 * objects for common concerns.
 */
export interface UseCaptureReturn {
  /** Pass to <CameraView ref={ref} /> (or the raw Camera directly). */
  cameraRef: React.RefObject<Camera | null>;
  /** The currently selected device — null while vision-camera hasn't picked one. */
  device: ReturnType<typeof useCameraDevice>;
  /** True once the user has granted camera permission. */
  hasPermission: boolean;
  /** Trigger the system permission sheet.  Resolves to the new state. */
  requestPermission: () => Promise<boolean>;
  /** Current flash mode — controlled from host code. */
  flash: 'off' | 'on';
  toggleFlash: () => void;
  /** True while takePhoto is in flight.  Use to disable the shutter button. */
  isCapturing: boolean;
  /**
   * Take a photo.  Single-flight: parallel calls return the in-flight
   * promise.  Returns a CaptureResult (with an optional QualityReport
   * when ``enableQualityChecks`` is on).
   *
   * `outputPath` (optional): a fully-resolved destination path.  When
   * set, the lib moves the captured JPEG to that path after EXIF
   * orientation correction, and the returned `compressedUri` points
   * at the moved file.  The host is responsible for ensuring the
   * destination directory exists and is writable; on disk failure,
   * the promise rejects with an error referencing `outputPath`.
   *
   * Requires `expo-file-system` to be installed in the host app
   * (declared as an OPTIONAL peer dep — consumers that don't pass
   * `outputPath` aren't required to have it).
   */
  takePhoto: (options?: TakePhotoCallOptions) => Promise<CaptureResult>;
  /**
   * 2026-05-14 — physical lens types available on the chosen
   * `cameraPosition`.  Computed once at the first vision-camera
   * device-list emission; useful for the host to decide whether to
   * render a 0.5×/1× camera switcher chip (only show if both
   * `wide-angle-camera` AND `ultra-wide-angle-camera` are present).
   *
   * Empty array on platforms that haven't enumerated devices yet
   * (very brief — vision-camera resolves the device list at module
   * load).  Always populated by the time the camera is mountable.
   */
  availablePhysicalDevices: PhysicalCameraDeviceType[];
  /**
   * v0.13.2 — how lenses are switched for the mounted device:
   *   'multicam'      — one device spans both FOVs; switch via `deviceZoom`.
   *   'standalone-uw' — separate ultra-wide device; switch by remounting.
   *   'wide-only'     — no ultra-wide; no 0.5× chooser.
   */
  captureMode: CaptureDeviceMode;
  /**
   * v0.13.2 — whether the device can offer a 0.5× ultra-wide lens AT ALL
   * (real capability, replacing the old hardcoded assumption).  Drives
   * whether `<Camera>` renders the lens chooser.
   */
  has0_5x: boolean;
  /**
   * v0.13.2 — whether the currently-MOUNTED device has a torch.  Drives
   * the flash control's availability (the standalone ultra-wide has none).
   */
  deviceHasTorch: boolean;
  /**
   * v0.13.2 — the `zoom` value to apply for the active lens in
   * `multicam` mode (0.5× → ultra-wide end, 1× → wide baseline).
   * `undefined` in standalone/wide-only modes (lens = device identity,
   * no zoom needed).  Pass to `<CameraView zoom>`.
   */
  deviceZoom: number | undefined;
}


function makeCaptureResult(
  photo: PhotoFile,
  qualityReport: QualityReport | undefined,
): CaptureResult {
  const capturedAt = new Date().toISOString();
  return {
    // The device UUID the host wants to identify this capture with is
    // app-specific.  We synthesise a deterministic ish value so the
    // host gets a placeholder; most hosts will swap it out for a uuid
    // library (react-native-uuid or similar) before persisting.
    deviceUuid: `${capturedAt}-${photo.path.split('/').pop() ?? 'photo'}`,
    compressedUri: `file://${photo.path}`,
    // vision-camera reports width/height post-orientation-correction,
    // matching what `<Image>` renders.  Forwarding them lets the
    // SDK's thumbnail strip / preview modal lay out at the correct
    // aspect ratio instead of forcing square crops.
    width: photo.width,
    height: photo.height,
    isStitched: false,
    capturedAt,
    qualityReport,
    deviceMetadata: {
      platform: 'ios',
      osVersion: '',
      deviceModel: '',
      cameraId: '',
      flashEnabled: false,
    },
  };
}


export function useCapture(options: UseCaptureOptions = {}): UseCaptureReturn {
  const {
    cameraPosition = 'back',
    enableQualityChecks = false,
    qualityThresholds,
    takePhotoOptions,
    preferredPhysicalDevice,
    lens,
  } = options;

  const cameraRef = useRef<Camera | null>(null);

  const allDevices = useCameraDevices();

  // v0.13.2 — capability-aware selection (`lens` supplied) vs legacy
  // per-lens physical-device swap (`preferredPhysicalDevice`).
  //
  // Capability-aware: `selectCaptureDevice` prefers a multi-cam device
  // that spans wide + ultra-wide (so 0.5× is reached via `zoom` and the
  // torch works on every lens), falling back to a standalone ultra-wide
  // device-swap only where the platform has no such multi-cam grouping.
  // This fixes (a) 0.5× silently showing the wide-angle FOV on phones
  // where the ultra-wide is only inside a multi-cam device, and (b)
  // flash being unavailable on the torchless standalone ultra-wide.
  const selection = useMemo(
    () => selectCaptureDevice(allDevices as unknown as DeviceLike[]),
    [allDevices],
  );


  // Legacy path (no `lens`): preserve the pre-v0.13.2 per-physical-lens
  // request so direct Layer-2 hosts that pass `preferredPhysicalDevice`
  // are unaffected.
  const legacyDevice = useCameraDevice(cameraPosition, {
    physicalDevices: preferredPhysicalDevice ? [preferredPhysicalDevice] : undefined,
  });
  const legacyFallback = useCameraDevice(cameraPosition);

  // The mounted device:
  //   - lens supplied + multicam     → the single multi-cam device
  //     (lens switched via `zoom`, computed below).
  //   - lens supplied + standalone-uw→ swap to the ultra-wide device on
  //     0.5×, else the wide primary (matches the legacy swap, but with
  //     correct device identity from `selectCaptureDevice`).
  //   - lens supplied + wide-only    → the wide device (0.5× hidden).
  //   - no lens                      → legacy behaviour.
  let device: ReturnType<typeof useCameraDevice>;
  let activeZoom: number | undefined;
  if (lens != null) {
    if (selection.mode === 'standalone-uw' && lens === '0.5x') {
      device = (selection.ultraWideDevice as typeof legacyDevice) ?? selection.device as typeof legacyDevice ?? legacyFallback;
    } else {
      device = (selection.device as typeof legacyDevice) ?? legacyFallback;
    }
    activeZoom =
      selection.mode === 'multicam' && selection.device
        ? zoomForLens(selection.device, lens)
        : undefined;
  } else {
    device = legacyDevice ?? legacyFallback;
    activeZoom = undefined;
  }

  // Enumerate ALL physical lens types available on the chosen
  // position so the host can decide whether to render a switcher.
  // Vision-camera's `useCameraDevices()` returns CameraDevice[]; each
  // has `physicalDevices: PhysicalCameraDeviceType[]`.  We dedupe the
  // union across all devices at `position` so the host sees the full
  // set the platform exposes (some phones expose ultra-wide only via
  // a separate logical camera, not the main one).  `allDevices` is
  // computed once above (shared with `selectCaptureDevice`).
  const availablePhysicalDevices = useMemo<PhysicalCameraDeviceType[]>(() => {
    const seen = new Set<PhysicalCameraDeviceType>();
    for (const d of allDevices) {
      if (d.position !== cameraPosition) continue;
      for (const pd of d.physicalDevices ?? []) {
        seen.add(pd);
      }
    }
    return Array.from(seen);
  }, [allDevices, cameraPosition]);

  const { hasPermission, requestPermission } = useCameraPermission();
  const [flash, setFlash] = useState<'off' | 'on'>('off');
  const [isCapturing, setIsCapturing] = useState(false);
  // Holds the in-flight takePhoto promise so we don't kick off a second
  // call while the first is still settling.  Cleared in the finally.
  const inFlightRef = useRef<Promise<CaptureResult> | null>(null);

  const toggleFlash = useCallback(() => {
    setFlash((prev) => (prev === 'off' ? 'on' : 'off'));
  }, []);

  const takePhoto = useCallback(async (callOptions?: TakePhotoCallOptions): Promise<CaptureResult> => {
    if (inFlightRef.current) {
      return inFlightRef.current;
    }
    if (!cameraRef.current) {
      throw new Error(
        'useCapture.takePhoto: cameraRef is not yet attached. '
        + 'Render <CameraView ref={cameraRef} /> or the raw Camera with this ref first.',
      );
    }

    const promise = (async () => {
      setIsCapturing(true);
      try {
        const photo = await cameraRef.current!.takePhoto({
          flash,
          ...takePhotoOptions,
        });
        // Bake EXIF rotation into pixels so the file on disk matches
        // what the operator just saw on the preview, regardless of
        // how downstream consumers handle EXIF.  Returns the
        // post-rotation dimensions; we override the photo's
        // width/height before constructing the CaptureResult so
        // the SDK contract reports "what's actually saved".
        const normalised = await normaliseOrientation(photo.path, {
          width: photo.width,
          height: photo.height,
        });
        let orientedPhoto: PhotoFile = {
          ...photo,
          width: normalised.width || photo.width,
          height: normalised.height || photo.height,
        };

        // Move the orientation-corrected file to its final location.
        // If the caller passed `outputPath`, use that.  Otherwise, the
        // lib publishes captures into its canonical default dir so
        // returned paths are predictable across consumers (vs.
        // vision-camera's auto-generated UUID-named tmp file).  The
        // move is performed via the `RNImageStitcherFileUtils` native
        // bridge — no peer-dep on `expo-file-system` etc.
        try {
          const dstPath = callOptions?.outputPath
            ? toBareFilePath(callOptions.outputPath)
            : `${await getDefaultCaptureDir()}/${defaultPhotoFilename()}`;
          await moveFile(orientedPhoto.path, dstPath);
          orientedPhoto = { ...orientedPhoto, path: dstPath };
        } catch (e) {
          throw new Error(
            'useCapture.takePhoto: failed to move captured photo to its '
            + `destination${callOptions?.outputPath ? ` (${callOptions.outputPath})` : ' (default capture dir)'}. `
            + `Underlying: ${e instanceof Error ? e.message : String(e)}`,
          );
        }

        let report: QualityReport | undefined;
        if (enableQualityChecks && qualityThresholds) {
          report = await runQualityCheck(orientedPhoto.path, qualityThresholds);
        }
        return makeCaptureResult(orientedPhoto, report);
      } finally {
        setIsCapturing(false);
        inFlightRef.current = null;
      }
    })();
    inFlightRef.current = promise;
    return promise;
  }, [flash, enableQualityChecks, qualityThresholds, takePhotoOptions]);

  return {
    cameraRef,
    device,
    hasPermission,
    requestPermission,
    flash,
    toggleFlash,
    isCapturing,
    takePhoto,
    availablePhysicalDevices,
    captureMode: selection.mode,
    has0_5x: selection.has0_5x,
    deviceHasTorch: device?.hasTorch ?? false,
    deviceZoom: activeZoom,
  };
}
