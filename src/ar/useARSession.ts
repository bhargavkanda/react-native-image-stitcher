// SPDX-License-Identifier: Apache-2.0
/**
 * useARSession — React hook for the SDK's ARKit (iOS) / ARCore
 * (Android) session foundation.
 *
 * Phase 4 of the AR measurement plan
 * (docs/site-content/design/2026-04-29-ar-measurement-and-detection.md).
 *
 * What this gives the host:
 *   - `isAvailable`: whether the device can run AR at all
 *   - `trackingState`: current AR tracking quality (mirrors Apple's
 *     enum values exactly — same numeric ids on both platforms)
 *   - `start()` / `stop()`: lifecycle controls
 *   - `getFramePoses()`: snapshot the per-frame pose log captured
 *     during the most recent session, used by Phase 5 stitching
 *     and Phase 6 measurement
 *
 * What this does NOT give:
 *   The hook is camera-agnostic.  It just runs the AR tracking
 *   session.  Frame display + capture happen via the SDK's
 *   AR-backed `<CameraView>` (Phase 4.4 — coming) or the existing
 *   vision-camera-backed view if AR is unavailable.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { NativeModules } from 'react-native';


/**
 * AR tracking state.  Numeric values mirror iOS' enum and the
 * Android constants in `RNSARSession.companion`.  Cross-
 * platform identical; no branching needed in JS.
 */
export enum ARTrackingState {
  /** AR not running, not supported, or session was stopped. */
  NotAvailable = 0,
  /** Session running but tracking quality not yet usable. */
  Initialising = 1,
  /** Session running with usable tracking — poses are good. */
  Tracking = 2,
  /** Tracking quality dropped mid-session.  Poses degraded. */
  Limited = 3,
}


/**
 * One captured frame's pose.  Coordinates are in the AR session's
 * world frame (right-handed, Y-up on iOS / Y-up on Android), with
 * translation in metres.  Rotation is a unit quaternion; w is the
 * real component.
 */
export interface FramePose {
  tx: number; ty: number; tz: number;
  qx: number; qy: number; qz: number; qw: number;
  /** Camera intrinsics (focal length + principal point) in pixels. */
  fx: number; fy: number; cx: number; cy: number;
  imageWidth: number;
  imageHeight: number;
  /** Frame timestamp in ms relative to AR session start. */
  timestampMs: number;
  trackingState: ARTrackingState;
}


export interface UseARSessionReturn {
  /**
   * Whether the device can run AR.  Set after the first `start()`
   * call (or by the explicit `checkAvailability()`).  False on
   * older iPhones, simulators, and unsupported Android devices.
   */
  isAvailable: boolean;
  /**
   * Whether the one-shot `isSupported()` probe has resolved (success OR
   * failure).  `false` only during the brief async window right after
   * mount; `true` thereafter.  Lets consumers distinguish "AR not
   * supported" (probed && !isAvailable) from "support not yet known"
   * (!probed), so they don't prematurely mount the non-AR camera and
   * lose a camera-handoff race when AR is the intended source.
   */
  supportProbed: boolean;
  /**
   * Whether the session is currently running.  True between
   * `start()` and `stop()`.
   */
  isRunning: boolean;
  /** Current tracking quality.  Polled every 500ms while running. */
  trackingState: ARTrackingState;
  /**
   * Start the AR session.  On Android, may trigger a Play Services
   * for AR install dialog the first time it runs.  Throws if the
   * device doesn't support AR.
   */
  start: () => Promise<void>;
  /**
   * Stop the AR session and clear the pose log.  Idempotent;
   * calling on a stopped session is a no-op.
   */
  stop: () => Promise<void>;
  /**
   * Snapshot the per-frame pose log captured since the last
   * `start()`.  Used by the stitcher and measurement APIs after
   * recording stops.
   *
   * `sinceNs` (optional): a watermark in NANOSECONDS on the AR clock (the
   * same clock `FramePose.timestampMs` is expressed in, ×10⁶).  When set,
   * only poses whose timestamp is STRICTLY AFTER the watermark are
   * returned — an incremental poller passes the last pose's
   * `timestampMs * 1e6` and never re-reads entries it already has.
   * Omitted (or ≤ 0) = the full log, exactly as before the parameter
   * existed.
   */
  getFramePoses: (sinceNs?: number) => Promise<FramePose[]>;
  /**
   * Drop everything in the pose log.  Call before each new
   * panorama capture so the log doesn't carry stale poses from
   * an earlier session.
   */
  clearPoseLog: () => Promise<void>;
}


interface NativeARSessionModule {
  isSupported(): Promise<boolean>;
  start(): Promise<void>;
  stop(): Promise<void>;
  getState(): Promise<{ isRunning: boolean; trackingState: number }>;
  snapshotPoseLog(): Promise<FramePose[]>;
  /** Watermark accessor — poses strictly after `sinceNs`.  Optional at the
   *  type level so the JS layer can degrade against an older native binary
   *  that predates the method (see `getFramePoses` below). */
  getFramePoses?(sinceNs: number): Promise<FramePose[]>;
  clearPoseLog(): Promise<void>;
}


function getNativeModule(): NativeARSessionModule | null {
  const m = (NativeModules as Record<string, unknown>)['RNSARSession'];
  if (!m || typeof m !== 'object') return null;
  return m as NativeARSessionModule;
}


/**
 * Polling interval for tracking-state updates.  500ms is enough to
 * feel responsive in the UI without flooding the bridge.
 */
const STATE_POLL_INTERVAL_MS = 500;


export function useARSession(): UseARSessionReturn {
  const [isAvailable, setIsAvailable] = useState(false);
  const [supportProbed, setSupportProbed] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [trackingState, setTrackingState] = useState<ARTrackingState>(
    ARTrackingState.NotAvailable,
  );
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const native = getNativeModule();

  // Probe availability once on mount.  Running on a device without
  // AR support shouldn't crash anything — `isAvailable` stays
  // false and the rest of the SDK falls back to vision-camera.
  useEffect(() => {
    if (!native) {
      // No native module at all — treat the probe as resolved
      // (unsupported) so consumers don't wait forever for AR.
      setSupportProbed(true);
      return;
    }
    let cancelled = false;
    native
      .isSupported()
      .then((ok) => {
        if (!cancelled) setIsAvailable(ok);
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[useARSession] isSupported failed', err);
      })
      .finally(() => {
        // Mark the probe resolved either way so the non-AR fallback
        // (or AR mount) can proceed exactly once support is known.
        if (!cancelled) setSupportProbed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [native]);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();
    if (!native) return;
    pollRef.current = setInterval(async () => {
      try {
        const state = await native.getState();
        setIsRunning(state.isRunning);
        setTrackingState(state.trackingState as ARTrackingState);
      } catch {
        // Bridge errors during tear-down are expected; ignore.
      }
    }, STATE_POLL_INTERVAL_MS);
  }, [native, stopPolling]);

  // Always tear down the poll on unmount.
  useEffect(() => stopPolling, [stopPolling]);

  const start = useCallback(async () => {
    if (!native) {
      throw new Error('useARSession: RNSARSession native module unavailable');
    }
    await native.start();
    setIsRunning(true);
    startPolling();
  }, [native, startPolling]);

  const stop = useCallback(async () => {
    if (!native) return;
    stopPolling();
    await native.stop();
    setIsRunning(false);
    setTrackingState(ARTrackingState.NotAvailable);
  }, [native, stopPolling]);

  const getFramePoses = useCallback(
    async (sinceNs?: number): Promise<FramePose[]> => {
      if (!native) return [];
      // No watermark (or a non-filtering one) → the historical full-log
      // call, byte-identical to before `sinceNs` existed.
      if (sinceNs === undefined || sinceNs <= 0) {
        return native.snapshotPoseLog();
      }
      // Watermarked read — native filters when it can; against an older
      // binary that predates `getFramePoses` we fetch the full log and
      // apply the identical strictly-after filter here.
      if (typeof native.getFramePoses === 'function') {
        return native.getFramePoses(sinceNs);
      }
      const all = await native.snapshotPoseLog();
      return all.filter((p) => p.timestampMs * 1e6 > sinceNs);
    },
    [native],
  );

  const clearPoseLog = useCallback(async (): Promise<void> => {
    if (!native) return;
    await native.clearPoseLog();
  }, [native]);

  return {
    isAvailable,
    supportProbed,
    isRunning,
    trackingState,
    start,
    stop,
    getFramePoses,
    clearPoseLog,
  };
}
