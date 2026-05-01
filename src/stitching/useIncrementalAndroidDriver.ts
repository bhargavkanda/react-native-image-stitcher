/**
 * useIncrementalAndroidDriver — Android-only frame driver for the
 * incremental panorama engine.
 *
 * Why this exists
 *   On iOS, `RetaiLensIncrementalStitcher` wires itself into the
 *   ARSession's per-frame stream natively (60 Hz pose + image
 *   delivery, zero JS involvement once started).  On Android, ARCore
 *   demands exclusive camera access — the same constraint as ARKit on
 *   iOS — but the Android side of the SDK doesn't yet have an
 *   ARCore-backed CameraView.  Until that lands (Phase 0 follow-up),
 *   Android drives the engine from JS:
 *
 *     - vision-camera keeps the camera viewport (no AR conflict)
 *     - `takeSnapshot()` runs at ~250 ms intervals during press-hold
 *     - `react-native-sensors` gyroscope is integrated to estimate
 *       cumulative yaw/pitch (drives the FoV-overlap gate, same as
 *       ARKit pose on iOS)
 *     - Each snapshot path + integrated pose is fed to
 *       `RetaiLensIncrementalStitcher.processFrameAtPath()`
 *
 * Trade-off vs Path 1 (proper ARCore integration)
 *   Gyro integration drifts ~1–2° per minute.  Acceptable for the
 *   typical 5–15 s shelf pan; not great for ambitious 360° captures.
 *   Snapshot rate is ~4 Hz (vs 60 Hz on iOS).  Pose drives
 *   frame-selection only — the actual image alignment is feature-
 *   matched + RANSAC-fit, so quality of the panorama itself isn't
 *   bounded by gyro accuracy.
 *
 * Lifecycle
 *   `start({ cameraRef })` enables the loop; `stop()` tears down.
 *   Both should be called by the host's hold-start / hold-complete
 *   handlers.  The hook is a no-op on iOS so callers can use it
 *   unconditionally.
 */

import { useCallback, useRef } from 'react';
import { NativeModules, Platform } from 'react-native';
import {
  gyroscope,
  setUpdateIntervalForType,
  SensorTypes,
} from 'react-native-sensors';
import type { Subscription } from 'rxjs';
import type { Camera } from 'react-native-vision-camera';


export interface UseIncrementalAndroidDriverOptions {
  /**
   * Snapshot interval in ms.  Default 250 (≈ 4 Hz).  Lower = more
   * candidate frames + more disk I/O.  Don't go below 200 — vision-
   * camera's snapshot pipeline can't keep up reliably below that.
   */
  snapshotIntervalMs?: number;
  /**
   * Gyro sample rate in ms (~30 Hz default matches the existing
   * `PanoramaGuidance` cadence).  Used for pose integration only —
   * not the snapshot rate.
   */
  gyroIntervalMs?: number;
  /**
   * Approximate horizontal FoV of the device camera.  Drives the
   * overlap-percent calculation in the native engine.  Default 65°
   * is a reasonable mid-tier smartphone average; if you have access
   * to the device's actual intrinsics, pass them through for more
   * accurate gating.
   */
  fovHorizDegrees?: number;
}


export interface IncrementalAndroidDriverHandle {
  start: (cameraRef: React.RefObject<Camera | null>) => void;
  stop: () => void;
  isRunning: boolean;
}


interface NativeProcessFrame {
  processFrameAtPath(options: {
    path: string;
    yaw: number;
    pitch: number;
    fovHorizDegrees: number;
    trackingPoor: boolean;
  }): Promise<unknown>;
}


function getNativeIncremental(): NativeProcessFrame | null {
  const m = (NativeModules as Record<string, unknown>)['RetaiLensIncrementalStitcher'];
  if (!m || typeof m !== 'object') return null;
  return m as NativeProcessFrame;
}


export function useIncrementalAndroidDriver(
  options: UseIncrementalAndroidDriverOptions = {},
): IncrementalAndroidDriverHandle {
  const {
    snapshotIntervalMs = 250,
    gyroIntervalMs = 33,
    fovHorizDegrees = 65,
  } = options;

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const gyroSubRef = useRef<Subscription | null>(null);
  const cameraRef = useRef<React.RefObject<Camera | null> | null>(null);
  // Integrated pose accumulators, in radians.  Reset on each
  // start() call.  Y-axis = horizontal pan (yaw), X-axis = vertical
  // pan (pitch).  Sign convention matches ARKit: counter-clockwise
  // from above is positive yaw.
  const yawRef = useRef(0);
  const pitchRef = useRef(0);
  const lastGyroAtRef = useRef<number | null>(null);
  // Single in-flight guard so we don't pile up overlapping snapshot
  // promises on slow devices — if last snapshot hasn't finished
  // when the next interval fires, skip.
  const snapshotInFlightRef = useRef(false);
  // Module-level "is the driver active right now" — exposed to the
  // host because the hook itself doesn't trigger re-renders.
  const isRunningRef = useRef(false);

  const stop = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (gyroSubRef.current) {
      gyroSubRef.current.unsubscribe();
      gyroSubRef.current = null;
    }
    cameraRef.current = null;
    isRunningRef.current = false;
  }, []);

  const start = useCallback(
    (cameraRefArg: React.RefObject<Camera | null>) => {
      if (Platform.OS !== 'android') return;
      if (isRunningRef.current) return;
      const native = getNativeIncremental();
      if (!native) return;

      cameraRef.current = cameraRefArg;
      yawRef.current = 0;
      pitchRef.current = 0;
      lastGyroAtRef.current = null;
      snapshotInFlightRef.current = false;
      isRunningRef.current = true;

      // Gyro integration.  Each sample carries angular velocity in
      // rad/s; multiply by elapsed time to accumulate angular
      // displacement.  Note: the gyro axes are device-local; we use
      // y for yaw and x for pitch on a device held in portrait.
      // Landscape would swap, but the FoV-overlap gate is dominant-
      // axis based on the .mm side, so the convention matters less
      // than consistency.
      setUpdateIntervalForType(SensorTypes.gyroscope, gyroIntervalMs);
      gyroSubRef.current = gyroscope.subscribe({
        next: ({ x, y }) => {
          const now = Date.now();
          if (lastGyroAtRef.current === null) {
            lastGyroAtRef.current = now;
            return;
          }
          const dt = (now - lastGyroAtRef.current) / 1000.0;
          lastGyroAtRef.current = now;
          yawRef.current += y * dt;
          pitchRef.current += x * dt;
        },
        error: (err) => {
          // eslint-disable-next-line no-console
          console.warn('[useIncrementalAndroidDriver] gyro error', err);
        },
      });

      // Snapshot loop.
      const tick = async () => {
        if (snapshotInFlightRef.current) return;
        const cam = cameraRef.current?.current;
        if (!cam) return;
        snapshotInFlightRef.current = true;
        try {
          const snap = await cam.takeSnapshot({ quality: 70 });
          if (!snap?.path) return;
          await native.processFrameAtPath({
            path: snap.path,
            yaw: yawRef.current,
            pitch: pitchRef.current,
            fovHorizDegrees,
            trackingPoor: false,
          });
        } catch (err) {
          // Swallow per-frame errors so the loop keeps running.
          // eslint-disable-next-line no-console
          console.warn(
            '[useIncrementalAndroidDriver] processFrame failed', err,
          );
        } finally {
          snapshotInFlightRef.current = false;
        }
      };
      // Kick off an immediate first frame so the engine doesn't sit
      // idle for the first interval period.
      tick();
      intervalRef.current = setInterval(tick, snapshotIntervalMs);
    },
    [snapshotIntervalMs, gyroIntervalMs, fovHorizDegrees],
  );

  return {
    start,
    stop,
    get isRunning(): boolean {
      return isRunningRef.current;
    },
  };
}
