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
 *   - Video recording lives in useVideoCapture (TODO).
 *
 * The public API is designed to be minimal and replaceable: host apps
 * that prefer the raw vision-camera API can opt out of this hook and
 * still use the SDK's quality + stitching modules.
 */

import { useCallback, useRef, useState } from 'react';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  type PhotoFile,
  type TakePhotoOptions,
} from 'react-native-vision-camera';

import { runQualityCheck } from '../quality/runQualityCheck';
import { normaliseOrientation } from '../quality/normaliseOrientation';
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
   */
  takePhoto: () => Promise<CaptureResult>;
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
  } = options;

  const cameraRef = useRef<Camera | null>(null);
  const device = useCameraDevice(cameraPosition);
  const { hasPermission, requestPermission } = useCameraPermission();
  const [flash, setFlash] = useState<'off' | 'on'>('off');
  const [isCapturing, setIsCapturing] = useState(false);
  // Holds the in-flight takePhoto promise so we don't kick off a second
  // call while the first is still settling.  Cleared in the finally.
  const inFlightRef = useRef<Promise<CaptureResult> | null>(null);

  const toggleFlash = useCallback(() => {
    setFlash((prev) => (prev === 'off' ? 'on' : 'off'));
  }, []);

  const takePhoto = useCallback(async (): Promise<CaptureResult> => {
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
        const orientedPhoto: PhotoFile = {
          ...photo,
          width: normalised.width || photo.width,
          height: normalised.height || photo.height,
        };

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
  };
}
