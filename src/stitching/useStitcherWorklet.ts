// SPDX-License-Identifier: Apache-2.0
/**
 * useStitcherWorklet — exposes the lib's first-party stitching as a
 * callable worklet function for host-composed Frame Processors.
 *
 * v0.11.0 — closes the v0.8.0 Phase 5 either-or constraint by letting
 * hosts COMPOSE: write ONE `useFrameProcessor` worklet body that calls
 * BOTH your custom logic AND the lib's first-party stitching, instead
 * of one displacing the other.  See `docs/host-app-integration.md`
 * § Tier 3 composition for the pattern.
 *
 * ## Why this is a separate hook
 *
 * vision-camera v4 lets a `<Camera>` mount accept exactly ONE frame
 * processor.  Pre-v0.11.0, hosts that passed a `frameProcessor` prop
 * to the lib's `<Camera>` REPLACED the lib's first-party stitching
 * processor in non-AR mode.  Composing required hand-writing both
 * worklet bodies in the host's processor.  v0.11.0 extracts the
 * lib's worklet body into this hook so hosts can compose with a
 * single call:
 *
 *   const stitcher = useStitcherWorklet();
 *   const fp = useFrameProcessor((frame) => {
 *     'worklet';
 *     hostPreLogic(frame);
 *     stitcher.call(frame);   // ← lib's first-party stitching
 *     hostPostLogic(frame);
 *   }, [stitcher.call]);
 *   return <Camera frameProcessor={fp} ... />;
 *
 * AR mode is unaffected — the AR-session dispatch path (v0.8.0 Phase
 * 4b.i / 4b.iii) already composes natively.
 *
 * ## What this owns
 *
 *   - vc Frame Processor plugin acquisition for
 *     `cv_flow_gate_process_frame` (the same plugin the legacy
 *     `useFrameProcessorDriver` used; reentrant by construction).
 *   - Shared values backing pose (yaw / pitch / roll), throttle
 *     counter, every-N gate, and FoV-derived intrinsics scalars.
 *   - Gyro subscription on the JS thread (always-on between mount
 *     and unmount; subscription cost is tiny).
 *   - The worklet body itself: throttle → pose synthesis →
 *     `plugin.call(frame, params)`.
 *
 * ## Lifecycle
 *
 *   - Gyro auto-subscribes on mount, auto-unsubscribes on unmount.
 *     Composed hosts get pose tracking for free.
 *   - `reset()` zeros the accumulated yaw / pitch / roll between
 *     captures.  `useFrameProcessorDriver` calls this on `start()` to
 *     preserve pre-v0.11.0 per-capture pose-reset behaviour;
 *     composed hosts should call it at the start of each capture too
 *     (otherwise pose drifts across captures).
 *
 * ## Behaviour delta from pre-v0.11.0
 *
 *   Before: `useFrameProcessorDriver.start()` subscribed the gyro;
 *   `stop()` unsubscribed.  The subscription was tied to the
 *   capture lifecycle.
 *
 *   After: the gyro is subscribed for the lifetime of this hook
 *   (i.e., as long as the component using it is mounted).  In the
 *   default `<Camera>` integration the hook mounts when the camera
 *   screen mounts, so the practical effect is the same; in
 *   custom-composed integrations the host controls mount/unmount
 *   by mounting/unmounting the component that calls
 *   `useStitcherWorklet`.  The battery delta is small: gyroscope
 *   sampling at 33ms costs ≪1% CPU on every Android/iOS device
 *   the lib supports.
 *
 *   `pose reset` semantics are preserved via the new explicit
 *   `reset()` method.  Hosts that previously relied on `start()`
 *   to zero pose now call `stitcher.reset()` at the capture start.
 *
 * ## Pose synthesis (verbatim from `useFrameProcessorDriver`)
 *
 *   Quaternion: q = q_yaw * q_pitch * q_roll (Tait-Bryan YPR, body
 *   frame).  Expanded:
 *     qx = cy*sp*cr + sy*cp*sr
 *     qy = sy*cp*cr - cy*sp*sr
 *     qz = cy*cp*sr - sy*sp*cr
 *     qw = cy*cp*cr + sy*sp*sr
 *
 *   When roll=0 this collapses to the legacy 2-axis form so captures
 *   held level produce bit-identical poses to the pre-v0.6 driver
 *   (and bit-identical to v0.10.x's `useFrameProcessorDriver`).
 *
 * ## Throttling (verbatim)
 *
 *   `evalEveryNFrames` controls how often the worklet calls the
 *   plugin.  Default 1.  Independent of — and stacks on top of —
 *   the stitcher's own internal `flowEvalEveryNFrames` in
 *   `KeyframeGate.swift`; effective cadence is the product.
 *
 * ## Pairing with `IncrementalStitcher.start`
 *
 *   The plugin's per-frame call into `consumeFrameFromPlugin` is
 *   gated by `IncrementalStitcher.frameProcessorIngestEnabled`,
 *   which is TRUE only when the stitcher was started with
 *   `frameSourceMode === 'frameProcessor'`.  Hosts MUST call
 *   `incrementalStitcher.start({ frameSourceMode: 'frameProcessor',
 *   ... })` to actually get frames into the engine — otherwise the
 *   worklet runs to completion but the wrapper drops the call.
 *   `Camera.tsx` does this wiring automatically when the host opts
 *   into the lib's `useFrameProcessorDriver`.  Hosts that compose
 *   their own worklet via this hook must do the wiring themselves.
 */

import { useCallback, useEffect, useState } from 'react';
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
import { VisionCameraProxy } from 'react-native-vision-camera';
import type {
  Frame,
  FrameProcessorPlugin,
} from 'react-native-vision-camera';

import type { CameraFrame } from './CameraFrame';

/**
 * Frames the lib's stitching worklet accepts.  Accepting either a
 * vc `Frame` (what the host's `useFrameProcessor` body sees) or the
 * lib's `CameraFrame` (what the lib's `useFrameProcessor` body
 * sees) keeps the same `useStitcherWorklet` usable from both kinds
 * of host worklet bodies without a cast on the call site.  The
 * worklet only reads `width` / `height`; the rest of the frame
 * object is forwarded verbatim to the native plugin.
 */
export type StitcherWorkletInput = Frame | CameraFrame;


export interface UseStitcherWorkletOptions {
  /**
   * Gyro sample interval in ms (~30 Hz default).  Drives the JS-
   * thread pose integration loop; not the producer-thread plugin
   * call rate.
   */
  gyroIntervalMs?: number;

  /**
   * Approximate horizontal FoV of the device camera, used to
   * synthesise `fx` from frame width.  Default 65° matches a typical
   * mid-tier smartphone main camera.
   */
  fovHorizDegrees?: number;

  /**
   * Approximate vertical FoV of the device camera, used to
   * synthesise `fy` from frame height.  Default 50° matches a typical
   * 4:3 phone camera in landscape; for 16:9 portrait you probably
   * want ~75°.
   */
  fovVertDegrees?: number;

  /**
   * Evaluate the plugin every Nth producer-thread frame.  Default 1
   * (every frame).  Clamped to [1, 10] to match native's cadence clamp
   * (`IncrementalStitcher.kt:531-533`) so an out-of-range host setting
   * keeps its effective cadence once the throttle runs JS-side.
   */
  evalEveryNFrames?: number;

  /**
   * perf-3a change 1 — initial ingest-gate state.  `true` (default) =
   * gate OPEN, so a bare `useStitcherWorklet()` behaves exactly as before
   * (every frame runs pose synthesis + `plugin.call`).  Managed
   * integrations (`useFrameProcessorDriver`) pass `false` and drive the
   * gate via `setActive()` so idle / stitch-phase frames cost only a
   * shared-value read instead of a full JSI→JNI plugin dispatch.
   */
  initialIngestActive?: boolean;
}


export interface StitcherWorkletHandle {
  /**
   * Worklet function: pass a `CameraFrame` to perform one frame of
   * the lib's first-party stitching (throttle + pose synthesis +
   * native plugin call).  Safe to call from inside another
   * `'worklet'`-prefixed function (this is the canonical
   * composition pattern).
   *
   * The returned function reference is stable across re-renders as
   * long as the plugin reference doesn't change (which happens at
   * most once — at the moment the JSI plugin finishes
   * registering).  Include `stitcher.call` in your `useFrameProcessor`
   * deps so the host worklet rebuilds when the plugin acquires.
   *
   * Safe to invoke before the plugin is ready: the worklet
   * internally short-circuits (the frame is silently skipped).
   * Hosts that want to display a "stitcher initialising…" UI can
   * read `isReady` to gate their own behaviour.
   */
  call: (frame: StitcherWorkletInput) => void;

  /**
   * Zero accumulated yaw / pitch / roll.  Call at the start of each
   * capture so the pose stream starts from `(0, 0, 0)` instead of
   * carrying drift from the previous capture or from idle time
   * between captures.  Idempotent; safe to call from JS.
   */
  reset: () => void;

  /**
   * perf-3a change 1 — open/close the ingest gate.  While closed, `call`
   * returns after a single shared-value read (no pose synthesis, no
   * plugin dispatch) and the gyro handler skips its accumulator writes.
   * The native `AtomicBoolean` fast-exit stays authoritative; this is the
   * cheap JS-side gate and may lag native by a frame or two.  Bare-hook
   * users leave the gate open (`initialIngestActive` default `true`);
   * `useFrameProcessorDriver` drives it from `start()`/`stop()`.
   */
  setActive: (active: boolean) => void;

  /**
   * `true` once the JSI Frame Processor plugin
   * (`cv_flow_gate_process_frame`) has resolved.  Before this flips
   * `true`, `call(frame)` is a no-op (the plugin reference is
   * `null`).  Hosts integrating via `useFrameProcessorDriver` use
   * this to decide whether to render the frame-processor at all —
   * the driver returns `null` for `frameProcessor` until ready, so
   * `<Camera>` falls back gracefully.
   */
  isReady: boolean;
}


export function useStitcherWorklet(
  options: UseStitcherWorkletOptions = {},
): StitcherWorkletHandle {
  const {
    gyroIntervalMs = 33,
    fovHorizDegrees = 65,
    fovVertDegrees = 50,
    evalEveryNFrames = 1,
    initialIngestActive = true,
  } = options;

  // Clamp cadence to [1, 10], matching native (IncrementalStitcher.kt:531-533).
  const clampEval = (n: number): number => Math.min(10, Math.max(1, Math.floor(n)));

  // ── Plugin acquisition ──────────────────────────────────────────
  //
  // `initFrameProcessorPlugin` can return `undefined` if called
  // before vision-camera's plugin registry has finished initialising
  // (race observed in F8.1.a).  Mount-once useEffect with a 16ms
  // retry until success.  Verbatim from `useFrameProcessorDriver`.
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
      timerId = setTimeout(tryAcquire, 16);
    };
    tryAcquire();
    return () => {
      cancelled = true;
      if (timerId != null) clearTimeout(timerId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Shared values (worklet ↔ JS thread) ─────────────────────────
  const sharedYaw = useSharedValue(0);
  const sharedPitch = useSharedValue(0);
  const sharedRoll = useSharedValue(0);
  const sharedFrameCounter = useSharedValue(0);
  const sharedEvalEveryN = useSharedValue(clampEval(evalEveryNFrames));
  // perf-3a change 1 — ingest gate (worklet reads it lock-free).
  const sharedIngestActive = useSharedValue(initialIngestActive);
  const sharedFxNumerator = useSharedValue(
    1.0 / (2.0 * Math.tan((fovHorizDegrees * Math.PI / 180) / 2)),
  );
  const sharedFyNumerator = useSharedValue(
    1.0 / (2.0 * Math.tan((fovVertDegrees * Math.PI / 180) / 2)),
  );

  // Prop-derived shared values stay in sync via cheap effects.
  useEffect(() => {
    sharedEvalEveryN.value = clampEval(evalEveryNFrames);
  }, [evalEveryNFrames, sharedEvalEveryN]);
  useEffect(() => {
    sharedFxNumerator.value =
      1.0 / (2.0 * Math.tan((fovHorizDegrees * Math.PI / 180) / 2));
  }, [fovHorizDegrees, sharedFxNumerator]);
  useEffect(() => {
    sharedFyNumerator.value =
      1.0 / (2.0 * Math.tan((fovVertDegrees * Math.PI / 180) / 2));
  }, [fovVertDegrees, sharedFyNumerator]);

  // ── Gyro subscription (always-on while mounted) ─────────────────
  //
  // v0.11.0 — moved here from `useFrameProcessorDriver.start()`.
  // The composition pattern needs gyro running whenever
  // `useStitcherWorklet` is in use; gating the subscription on a
  // separate start/stop pair would force every composed host to
  // wire its own lifecycle.  Cost is tiny: ≪1% CPU at 33ms
  // sampling.  See module header "Behaviour delta from pre-v0.11.0".
  useEffect(() => {
    let lastGyroAt: number | null = null;
    setUpdateIntervalForType(SensorTypes.gyroscope, gyroIntervalMs);
    const sub: Subscription = gyroscope.subscribe({
      next: ({ x, y, z }) => {
        const now = Date.now();
        if (lastGyroAt === null) {
          lastGyroAt = now;
          return;
        }
        const dt = (now - lastGyroAt) / 1000.0;
        lastGyroAt = now;
        // perf-3a change 1 — while the gate is closed, skip the three
        // accumulator writes (they'd be dead work: reset() zeros the
        // accumulators at every capture start, so idle accumulation is
        // provably discarded). Keep advancing lastGyroAt above so the
        // first sample after reactivation doesn't integrate a giant
        // idle-gap dt. Bare-hook users keep the gate open → unchanged.
        if (!sharedIngestActive.value) return;
        sharedYaw.value += y * dt;
        sharedPitch.value += x * dt;
        sharedRoll.value += z * dt;
      },
      error: (err) => {
        // eslint-disable-next-line no-console
        console.warn('[useStitcherWorklet] gyro error', err);
      },
    });
    return () => {
      sub.unsubscribe();
    };
  }, [gyroIntervalMs, sharedYaw, sharedPitch, sharedRoll, sharedIngestActive]);

  // ── Explicit reset (for per-capture pose zero-ing) ──────────────
  const reset = useCallback(() => {
    sharedYaw.value = 0;
    sharedPitch.value = 0;
    sharedRoll.value = 0;
    sharedFrameCounter.value = 0;
  }, [sharedYaw, sharedPitch, sharedRoll, sharedFrameCounter]);

  // perf-3a change 1 — open/close the ingest gate (see the handle doc).
  const setActive = useCallback((active: boolean) => {
    sharedIngestActive.value = active;
  }, [sharedIngestActive]);

  // ── Worklet body ────────────────────────────────────────────────
  //
  // Returned as `handle.call`.  Re-created when `plugin` changes
  // (which happens at most once at acquire time); deps array on the
  // useCallback ensures consumers' `useFrameProcessor([handle.call])`
  // re-binds when the worklet identity changes.
  //
  // The `'worklet'` directive marks this function for the
  // worklets-core transformer so it can be serialised into the
  // producer-thread runtime; that's the contract that lets a host
  // `useFrameProcessor` worklet body call it without a thread hop.
  const call = useCallback((frame: StitcherWorkletInput) => {
    'worklet';
    if (plugin == null) return;

    // v0.11.1 — AR-source frames are stitched natively by the AR-
    // side dispatcher (`RNSARSession.swift:510-511` → the first-
    // party callback installed in `RNSARWorkletRuntime`).  Calling
    // the vc Frame Processor plugin here would throw
    // `getPropertyAsObject: property '__frame' is undefined`
    // because AR frames are `CameraFrameHostObject` instances
    // and don't carry the vc `Frame` proxy's JSI marker.  The
    // throw is caught silently by the per-worklet error handler
    // (`RNSARWorkletRuntime.mm:284-301`) and bubbles up only to
    // `os_log` — invisible to JS, which is why pre-v0.11.1
    // composed hosts saw their post-`stitcher.call` lines
    // (`fireFrameProcessorLog`, `runOnJS` callbacks) silently
    // never execute in AR mode.  Silent no-op here matches the
    // module-header promise that AR mode is "unaffected" by this
    // hook (the AR-side stitching path runs natively, independent
    // of the composed worklet body).
    //
    // The `(frame as CameraFrame).source` cast is safe: vc
    // `Frame` doesn't carry a `source` property so the check
    // returns `undefined !== 'ar'` → `true`, and the worklet
    // proceeds normally.  Only frames that explicitly tag
    // themselves as AR-source (which our native AR dispatcher
    // does — see `CameraFrameHostObject.mm`) get short-circuited.
    if ((frame as CameraFrame).source === 'ar') return;

    // perf-3a change 1 — ingest gate: while closed, skip the entire
    // per-frame cost (pose synthesis + the 13-key params object + the
    // JSI→JNI plugin dispatch), paying only this shared-value read. The
    // gate check sits BEFORE the counter increment so idle/gated frames
    // don't advance the cadence grid (reset() re-anchors it at every
    // capture start regardless). Bare-hook users keep the gate open
    // (initialIngestActive default true) → this is a no-op for them.
    if (!sharedIngestActive.value) return;

    // Throttle (0-based: frame 0 always evaluates for any N; matches
    // native's (counter-1)%N semantics, IncrementalStitcher.kt:284-291).
    const c = sharedFrameCounter.value;
    sharedFrameCounter.value = c + 1;
    const N = sharedEvalEveryN.value;
    if (N > 1 && (c % N) !== 0) return;

    // Pose synthesis (verbatim from useFrameProcessorDriver).
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
    const w = frame.width;
    const h = frame.height;
    const fx = w * sharedFxNumerator.value;
    const fy = h * sharedFyNumerator.value;

    // vc's `plugin.call` is typed against vc's `Frame`.  The worklet
    // accepts the union (`Frame | CameraFrame`); cast through
    // `unknown` because the union doesn't satisfy vc's interface
    // even though structurally both members do.
    plugin.call(frame as unknown as Frame, {
      tx: 0, ty: 0, tz: 0,
      qx, qy, qz, qw,
      fx, fy,
      cx: w / 2, cy: h / 2,
      imageWidth: w, imageHeight: h,
      timestampMs: 0,
      trackingStateRaw: 2, // RNSARTrackingState.tracking (no AR signal in non-AR mode)
    });
  }, [
    plugin,
    sharedFrameCounter,
    sharedEvalEveryN,
    sharedIngestActive,
    sharedYaw,
    sharedPitch,
    sharedRoll,
    sharedFxNumerator,
    sharedFyNumerator,
  ]);

  return { call, reset, setActive, isReady: plugin != null };
}
