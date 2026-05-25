// SPDX-License-Identifier: Apache-2.0
/**
 * useFrameProcessorDriver — vision-camera Frame Processor + gyro
 * driver for the incremental panorama engine.  Sole non-AR driver
 * from v0.6 onward (replaced the deprecated `useIncrementalJSDriver`
 * hook, which was removed in v0.6).
 *
 * Why this exists (vs the pre-v0.6 JS-driver predecessor)
 *
 *   The old JS driver took a JPEG snapshot every ~250 ms and fed the
 *   path to `IncrementalStitcher.processFrameAtPath` (both removed in
 *   v0.6).  That path had three costs:
 *
 *     1. JPEG encode (`takeSnapshot` ≈ 30–80 ms on iPhone 16 Pro)
 *     2. Disk write of the JPEG
 *     3. JPEG decode + cv::Mat alloc inside the engine
 *
 *   Per-frame round-trip ~80 ms means ~4 Hz max throughput, and
 *   ~80 ms latency between "this is the moment to accept" and "this
 *   frame is in the engine".  Both numbers caused operator-felt lag
 *   on long shelf pans.
 *
 *   This hook uses vision-camera's Frame Processor instead.  The
 *   worklet runs on the camera producer thread at the native frame
 *   rate (30 fps on iOS).  Each frame goes through a JSI plugin
 *   (`cv_flow_gate_process_frame`) directly into
 *   `IncrementalStitcher.consumeFrame` — the SAME entry point AR
 *   mode uses, with the engine's existing KeyframeGate making the
 *   accept/reject decision.  Rejected frames cost ~3–8 ms; accepted
 *   frames take the same deep-copy + workQueue path AR mode takes.
 *
 *   Net wins: no JPEG round-trip on rejected frames, no disk thrash
 *   during recording, lower latency to accept, full 30 fps gate
 *   evaluation budget.
 *
 * Pose synthesis
 *
 *   Non-AR mode has no ARKit pose.  We integrate the gyroscope on
 *   the JS thread (`react-native-sensors`), accumulate yaw + pitch,
 *   and publish them via Reanimated `useSharedValue` so the worklet
 *   can read them WITHOUT a thread hop.  Translation is reported as
 *   zero (no IMU translation; this is a known limitation we share
 *   with the legacy driver — drift ~1–2°/min over a 30 s capture is
 *   below the gate's overlap threshold and rarely matters).
 *
 *   Quaternion synthesis (q = q_yaw * q_pitch * q_roll, Tait-Bryan
 *   YPR order to match the legacy driver's body-frame intent):
 *     q_yaw   = (0, sin(yaw/2), 0, cos(yaw/2))
 *     q_pitch = (sin(pitch/2), 0, 0, cos(pitch/2))
 *     q_roll  = (0, 0, sin(roll/2), cos(roll/2))
 *
 *   Expanded (cy, sy = cos/sin(yaw/2); analogous for cp/sp, cr/sr):
 *     qx = cy*sp*cr + sy*cp*sr
 *     qy = sy*cp*cr - cy*sp*sr
 *     qz = cy*cp*sr - sy*sp*cr
 *     qw = cy*cp*cr + sy*sp*sr
 *
 *   When roll=0 this collapses to the 2-axis form
 *   `(cy*sp, sy*cp, -sy*sp, cy*cp)` the legacy driver used, so
 *   captures held perfectly level produce identical poses to the
 *   pre-roll behaviour.
 *
 *   Intrinsics are synthesised from the actual frame dimensions
 *   (`frame.width`, `frame.height`) plus the host-provided
 *   horizontal/vertical FoV defaults.  The stitcher derives its FoV-
 *   overlap window from these, so the assumed FoV matters for the
 *   gate's overlap math but not for the panorama itself (the
 *   stitcher feature-matches + RANSACs the final alignment).
 *
 * Throttling
 *
 *   `evalEveryNFrames` controls how often the worklet calls the
 *   plugin.  Default 1 (every frame).  Set higher to amortise the
 *   plugin call + consumeFrame's gate evaluation across multiple
 *   producer-thread frames on lower-end devices.  Independent of —
 *   and stacks on top of — the stitcher's own internal
 *   `flowEvalEveryNFrames` (see `KeyframeGate.swift`); both
 *   throttles can be active simultaneously and the effective cadence
 *   is `evalEveryNFrames * flowEvalEveryNFrames`.
 *
 * Lifecycle
 *
 *   `start()` subscribes to the gyro and resets pose accumulators.
 *   `stop()` unsubscribes and resets.  The returned `frameProcessor`
 *   is meant to be passed to `<Camera frameProcessor={...} />` —
 *   it's stable as long as the plugin reference and the FoV props
 *   haven't changed.  Returns `null` when the plugin isn't loaded
 *   yet; pass `null`-or-fallback to the Camera in that case.
 *
 * Pairing with `IncrementalStitcher.start({frameSourceMode})`
 *
 *   The plugin's per-frame call into `consumeFrameFromPlugin` is
 *   gated by `IncrementalStitcher.frameProcessorIngestEnabled`,
 *   which is TRUE only when the stitcher was started with
 *   `frameSourceMode === 'frameProcessor'`.  Hosts MUST call
 *   `incrementalStitcher.start({ frameSourceMode: 'frameProcessor',
 *   ... })` to actually get frames into the engine — otherwise the
 *   worklet runs to completion but the wrapper drops the call.
 *   `Camera.tsx` does this wiring automatically when the host opts
 *   into this driver.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  gyroscope,
  setUpdateIntervalForType,
  SensorTypes,
} from 'react-native-sensors';
import type { Subscription } from 'rxjs';
// Reanimated's `useSharedValue` is the documented vision-camera
// idiom, but it's a heavy peer dep.  `react-native-worklets-core`
// (already a transitive dep via vision-camera v4 on RN 0.84) exposes
// the same API surface (a `value` getter/setter readable from
// worklets and the JS thread) and is sufficient for our use.
import { useSharedValue } from 'react-native-worklets-core';
import {
  useFrameProcessor,
  VisionCameraProxy,
} from 'react-native-vision-camera';
import type {
  FrameProcessorPlugin,
  ReadonlyFrameProcessor,
} from 'react-native-vision-camera';


export interface UseFrameProcessorDriverOptions {
  /**
   * Gyro sample interval in ms (~30 Hz default).  Drives the JS-
   * thread pose integration loop; not the producer-thread plugin
   * call rate (the plugin runs at vision-camera's frame rate,
   * usually 30 fps).
   */
  gyroIntervalMs?: number;

  /**
   * Approximate horizontal FoV of the device camera, used to
   * synthesise `fx` from frame width.  Default 65° matches a typical
   * mid-tier smartphone main camera.  Host apps that know the actual
   * FoV (e.g. via `Camera.getCameraFormat`) should pass it here —
   * the engine's overlap gate gets a slightly better estimate.
   */
  fovHorizDegrees?: number;

  /**
   * Approximate vertical FoV of the device camera, used to
   * synthesise `fy` from frame height.  Default 50° matches a
   * typical 4:3 phone camera in landscape; for 16:9 portrait you
   * probably want ~75°.
   */
  fovVertDegrees?: number;

  /**
   * Evaluate the plugin every Nth producer-thread frame.  Default 1
   * (every frame).  Higher values reduce the producer-thread cost
   * linearly at the price of acceptance latency — N=3 with 30 fps
   * source = up to 100 ms before a key moment is evaluated.
   */
  evalEveryNFrames?: number;
}


export interface FrameProcessorDriverHandle {
  /** Subscribe to the gyro + reset pose accumulators.  Idempotent. */
  start: () => void;
  /** Unsubscribe + reset pose. */
  stop: () => void;
  /**
   * Pass this to `<Camera frameProcessor={...} />`.  `null` until
   * the JSI plugin is loaded (typically resolves within ~1 frame of
   * mount); the consumer should fall back to undefined / a no-op
   * processor in that window.
   */
  frameProcessor: ReadonlyFrameProcessor | null;
  /** Whether `start()` has been called and `stop()` hasn't. */
  isRunning: boolean;
}


export function useFrameProcessorDriver(
  options: UseFrameProcessorDriverOptions = {},
): FrameProcessorDriverHandle {
  const {
    gyroIntervalMs = 33,
    fovHorizDegrees = 65,
    fovVertDegrees = 50,
    evalEveryNFrames = 1,
  } = options;

  // ── Plugin acquisition ──────────────────────────────────────────
  //
  // `initFrameProcessorPlugin` can return `undefined` if called
  // before vision-camera's plugin registry has finished initialising
  // (race observed in F8.1.a).  We retry on a fixed timer instead of
  // firing on every render — the earlier render-driven pattern
  // (adversarial-review H3) re-invoked `initFrameProcessorPlugin`
  // 60+ times per second during recording, and the vision-camera
  // contract for repeated lookups is undocumented.
  //
  // Pattern: mount-once useEffect, try synchronously, fall back to a
  // 16-ms retry timer until success or unmount.
  const [plugin, setPlugin] = useState<FrameProcessorPlugin | null>(null);
  useEffect(() => {
    let cancelled = false;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    const tryAcquire = () => {
      if (cancelled) return;
      const p = VisionCameraProxy.initFrameProcessorPlugin(
        'cv_flow_gate_process_frame',
        {},
      );
      if (p != null) {
        setPlugin(p);
        return;
      }
      // ~one display-frame retry — matches the F8.1.a observation
      // that the registry becomes ready by the next render tick.
      timerId = setTimeout(tryAcquire, 16);
    };
    tryAcquire();
    return () => {
      cancelled = true;
      if (timerId != null) clearTimeout(timerId);
    };
    // Empty deps on purpose — runs ONCE on mount.  Re-acquiring on
    // re-render would race with worklet binding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Shared values (worklet ↔ JS thread) ─────────────────────────
  //
  // Reanimated guarantees coherent reads from the producer thread.
  // We write yaw/pitch on the JS thread (gyro callbacks); the worklet
  // reads them every frame.  No round-trip cost — these are mapped
  // into the worklet's runtime by the Reanimated bridge.
  //
  // FoV-derived values (the "half-angle tangent reciprocal"
  // f-numerators) are pre-computed on the JS thread + published via
  // shared values so the worklet's dependency array shrinks to just
  // `[plugin]`.  Earlier draft baked `fovHorizDegrees` /
  // `fovVertDegrees` into the closure → worklet re-serialised on
  // every host re-render that changed the prop refs (adversarial-
  // review M1).
  const sharedYaw = useSharedValue(0);
  const sharedPitch = useSharedValue(0);
  // F8.3-followup-roll — integrate gyroscope Z (out-of-screen for a
  // portrait device) to track wrist-twist roll.  Field captures with
  // casual hand-hold rarely stay perfectly level; without this the
  // pose stream lies and the cv::Stitcher's intrinsic estimator may
  // pick a worse projection mode.
  const sharedRoll = useSharedValue(0);
  const sharedFrameCounter = useSharedValue(0);
  const sharedEvalEveryN = useSharedValue(Math.max(1, evalEveryNFrames));
  const sharedFxNumerator = useSharedValue(
    1.0 / (2.0 * Math.tan((fovHorizDegrees * Math.PI / 180) / 2)),
  );
  const sharedFyNumerator = useSharedValue(
    1.0 / (2.0 * Math.tan((fovVertDegrees * Math.PI / 180) / 2)),
  );

  // Keep prop-derived shared values in sync.  Cheap re-renders;
  // these don't trigger worklet rebuild.
  useEffect(() => {
    sharedEvalEveryN.value = Math.max(1, evalEveryNFrames);
  }, [evalEveryNFrames, sharedEvalEveryN]);
  useEffect(() => {
    sharedFxNumerator.value =
      1.0 / (2.0 * Math.tan((fovHorizDegrees * Math.PI / 180) / 2));
  }, [fovHorizDegrees, sharedFxNumerator]);
  useEffect(() => {
    sharedFyNumerator.value =
      1.0 / (2.0 * Math.tan((fovVertDegrees * Math.PI / 180) / 2));
  }, [fovVertDegrees, sharedFyNumerator]);

  // ── Lifecycle state (JS thread only) ────────────────────────────
  const gyroSubRef = useRef<Subscription | null>(null);
  const lastGyroAtRef = useRef<number | null>(null);
  const isRunningRef = useRef(false);

  const stop = useCallback(() => {
    if (gyroSubRef.current) {
      gyroSubRef.current.unsubscribe();
      gyroSubRef.current = null;
    }
    isRunningRef.current = false;
    sharedYaw.value = 0;
    sharedPitch.value = 0;
    sharedRoll.value = 0;
    sharedFrameCounter.value = 0;
    lastGyroAtRef.current = null;
  }, [sharedYaw, sharedPitch, sharedRoll, sharedFrameCounter]);

  const start = useCallback(() => {
    if (isRunningRef.current) return;
    sharedYaw.value = 0;
    sharedPitch.value = 0;
    sharedRoll.value = 0;
    sharedFrameCounter.value = 0;
    lastGyroAtRef.current = null;
    isRunningRef.current = true;

    // Gyro integration.  Each sample carries angular velocity in
    // rad/s; multiply by dt to accumulate displacement.  Axes for a
    // device held portrait:
    //   y = horizontal pan (yaw, about world-Y)
    //   x = vertical tilt (pitch, about world-X)
    //   z = wrist-twist roll (about world-Z, normal to the screen)
    // Right-hand-rule convention throughout — same signs the pre-v0.6
    // `useIncrementalJSDriver` produced.  If field captures show
    // inverted roll, flip the sign on `z * dt` below.
    setUpdateIntervalForType(SensorTypes.gyroscope, gyroIntervalMs);
    gyroSubRef.current = gyroscope.subscribe({
      next: ({ x, y, z }) => {
        const now = Date.now();
        if (lastGyroAtRef.current === null) {
          lastGyroAtRef.current = now;
          return;
        }
        const dt = (now - lastGyroAtRef.current) / 1000.0;
        lastGyroAtRef.current = now;
        sharedYaw.value += y * dt;
        sharedPitch.value += x * dt;
        sharedRoll.value += z * dt;
      },
      error: (err) => {
        // eslint-disable-next-line no-console
        console.warn('[useFrameProcessorDriver] gyro error', err);
      },
    });
  }, [gyroIntervalMs, sharedYaw, sharedPitch, sharedRoll, sharedFrameCounter]);

  // ── Worklet ─────────────────────────────────────────────────────
  //
  // Memoised: rebuilt only when the plugin acquires (null → defined)
  // or when the FoV props change (cheap math but they're in the
  // closure so they must be in the deps).  Shared values are NOT in
  // the deps — Reanimated wires their .value reads through the
  // worklet's frozen runtime independently of React's render cycle.
  const frameProcessor = useFrameProcessor((frame) => {
    'worklet';
    if (plugin == null) return;

    // Throttle: only every Nth frame.  Counter increments first so
    // frame #0 is "due" (N>=1 always divides 0).  Cheaper than
    // calling the plugin on rejected frames; saves the ~1 µs
    // marshalling cost per skip.
    sharedFrameCounter.value += 1;
    const N = sharedEvalEveryN.value;
    if (N > 1 && (sharedFrameCounter.value % N) !== 0) return;

    // Synthesise quaternion from accumulated yaw + pitch + roll.
    // YPR Tait-Bryan order: q = q_yaw * q_pitch * q_roll.  When
    // roll=0 this reduces to the legacy 2-axis form (cy*sp, sy*cp,
    // -sy*sp, cy*cp), so captures held level produce identical
    // poses to the pre-F8.3-followup-roll behaviour.  See the
    // expanded math in the file header doc-comment.
    const halfYaw = sharedYaw.value / 2;
    const halfPitch = sharedPitch.value / 2;
    const halfRoll = sharedRoll.value / 2;
    const cy_ = Math.cos(halfYaw);
    const sy_ = Math.sin(halfYaw);
    const cp = Math.cos(halfPitch);
    const sp = Math.sin(halfPitch);
    const cr = Math.cos(halfRoll);
    const sr = Math.sin(halfRoll);
    const qx = cy_ * sp * cr + sy_ * cp * sr;
    const qy = sy_ * cp * cr - cy_ * sp * sr;
    const qz = cy_ * cp * sr - sy_ * sp * cr;
    const qw = cy_ * cp * cr + sy_ * sp * sr;

    // Intrinsics from FoV + actual frame dims.
    //   fx = w * (1 / (2 * tan(fovH/2)))   (the parenthesised half
    // is the precomputed `sharedFxNumerator` — see M1 fix).
    const w = frame.width;
    const h = frame.height;
    const fx = w * sharedFxNumerator.value;
    const fy = h * sharedFyNumerator.value;

    plugin.call(frame, {
      tx: 0, ty: 0, tz: 0,
      qx, qy, qz, qw,
      fx, fy,
      cx: w / 2, cy: h / 2,
      imageWidth: w, imageHeight: h,
      timestampMs: 0,
      // 2 == RNSARTrackingState.tracking — we always claim "good
      // tracking" because there's no ARKit signal to differentiate.
      // (Same contract as the pre-v0.6 useIncrementalJSDriver.)
      trackingStateRaw: 2,
    });
    // Deps array intentionally minimal: only `plugin` actually
    // requires worklet rebuild.  All FoV / pose / counter / cadence
    // values flow through stable shared-value refs that Reanimated
    // wires through the producer-thread runtime independently of
    // React's render cycle.  (Adversarial-review M1.)
  }, [plugin]);

  // ── Return handle ───────────────────────────────────────────────
  //
  // Returns a getter for `isRunning` so callers always see the live
  // state (the hook itself doesn't re-render on start/stop — that's
  // intentional, avoids stale-Camera-prop churn).
  return useMemo<FrameProcessorDriverHandle>(() => ({
    start,
    stop,
    frameProcessor: plugin != null ? frameProcessor : null,
    get isRunning() { return isRunningRef.current; },
  }), [start, stop, plugin, frameProcessor]);
}
