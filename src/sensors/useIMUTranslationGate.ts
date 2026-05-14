// SPDX-License-Identifier: UNLICENSED
//
// useIMUTranslationGate.ts — JS-side IMU translation integrator that
// force-accepts keyframes when the operator has translated more than
// a configurable budget since the last accepted frame.
//
// Why this exists
// ───────────────
//
// In non-AR mode (`PanoramaSettings.captureSource ∈ { 'wide',
// 'ultrawide' }`), the SDK doesn't have ARKit / ARCore pose data —
// only the device's accelerometer + gyro from `react-native-sensors`.
// The shared C++ `KeyframeGate` has a translation-budget feature
// (`flowMaxTranslationM`, default 0.0 = disabled) that force-accepts
// when the camera has translated more than the budget since the last
// accepted keyframe.  In AR mode that translation comes from the pose
// stream the AR delegate forwards into the gate.  In non-AR mode there
// is no pose stream — the gate's translation tracker stays at zero
// and never trips.
//
// This hook fills the gap.  It subscribes to the accelerometer at
// ~50 Hz, integrates (after gravity removal) to derive a windowed
// translation estimate, and:
//
//   • Either pushes the windowed displacement into the gate via
//     `RetaiLensIncrementalStitcher.setFlowMaxTranslationM` (deferred
//     — Android JNI shipped 2026-05-14 but the gate uses pose-derived
//     translation internally, not externally-supplied displacement).
//
//   • Or, more pragmatically, watches its own running translation and
//     calls `RetaiLensIncrementalStitcher.markNextFrameAsLastKeyframe()`
//     when the running translation crosses the budget — telling the
//     gate "this next frame is special, accept it regardless of
//     novelty".  The gate's existing force-accept mechanism handles
//     the rest.  Then we reset the running translation to zero on
//     the next accept event.
//
// The hook chooses the second approach because it's the path of
// least resistance: the gate's force-accept path is already battle-
// tested, the only new behaviour is JS-side integration + threshold
// detection.
//
// Drift bound
// ───────────
//
// Integrating accelerometer twice (accel → vel → pos) accumulates
// drift quadratically.  Over 30 seconds of continuous motion this
// would be tens of metres of error.  Two mitigations:
//
//   1. Reset on every accept.  The integrator runs only between two
//      consecutive accept events.  Typical pan-past-shelf accept
//      cadence is 0.3-1.0 s, keeping the drift window tight.
//
//   2. Low-pass the accel signal to suppress gravity-bleed-through
//      and high-freq noise.  We use a 1-pole IIR with α=0.1 for
//      gravity tracking, then subtract gravity from raw accel to
//      recover "linear" acceleration in the device frame.  This
//      mirrors what ARCore's TYPE_LINEAR_ACCELERATION sensor does
//      natively; we replicate it in JS for cross-platform parity.
//
// Limitations
// ───────────
//
// • Translation is in DEVICE FRAME, not world frame.  We don't have a
//   way to rotate to world without integrating gyro too.  For the
//   purpose of "how much did the operator translate the device since
//   the last keyframe?" device-frame magnitude is fine — what matters
//   is the magnitude of motion, not its world-frame direction.
//
// • Direction of motion isn't differentiated (sideways vs forward).
//   A forward push and a sideways pan both count toward the budget.
//   For the shelf-scan use case this is correct — both are "the
//   operator moved", both should force-accept eventually.
//
// • No native module needed.  This is pure JS using `react-native-
//   sensors` already in the dependency tree.  A native module
//   (CMMotionManager / SensorManager.TYPE_LINEAR_ACCELERATION direct)
//   would give better sample-rate stability + lower drift but is
//   2026-05-15+ scope.

import { useEffect, useRef } from 'react';
import {
  accelerometer,
  setUpdateIntervalForType,
  SensorTypes,
} from 'react-native-sensors';
import type { Subscription } from 'rxjs';


export interface UseIMUTranslationGateOptions {
  /**
   * Whether the gate is engaged.  Pass `false` to skip the subscription
   * entirely — useful when the host is in AR mode (where the gate
   * gets pose-derived translation natively).  Hot-toggleable;
   * subscribing/unsubscribing is cheap.
   */
  enabled: boolean;

  /**
   * Translation budget in METRES.  When the integrated device-frame
   * translation magnitude exceeds this since the last accept, the
   * hook fires `onBudgetExceeded`.  Default 0.08 m / 8 cm (matches the
   * recommended starting value from the `fe4b31d` commit and the
   * `2026-05-13-non-ar-ultrawide-capture` design doc).
   */
  budgetMeters?: number;

  /**
   * Sample interval in MILLISECONDS for the accelerometer.  Default
   * 20 ms ≈ 50 Hz.  Lower (faster sampling) = more accurate
   * integration; higher = lower CPU + battery.  20 ms is the sweet
   * spot most stitcher work has converged on.
   */
  sampleIntervalMs?: number;

  /**
   * Fired exactly once per "budget crossing" — i.e., when the
   * running translation magnitude crosses `budgetMeters` from below.
   * The host is responsible for calling
   * `RetaiLensIncrementalStitcher.markNextFrameAsLastKeyframe()`
   * AND for invoking the returned `resetAnchor()` once the keyframe
   * is actually accepted, so the integrator starts counting from
   * zero again.
   */
  onBudgetExceeded: () => void;
}


export interface UseIMUTranslationGateReturn {
  /**
   * Reset the running translation to zero.  Call this after each
   * confirmed keyframe accept — the typical wiring is to subscribe
   * to the `RetaiLensIncrementalStateUpdate` event and call
   * `resetAnchor()` from inside the listener.
   */
  resetAnchor: () => void;

  /**
   * Read the current integrated translation magnitude (metres).
   * Useful for the on-screen debug HUD ("translation since last
   * accept: 0.07 m").  Not exposed via state — host can poll via
   * the returned function for diagnostic display.
   */
  getCurrentTranslationM: () => number;
}


/**
 * IMU-based translation tracker.  See file header for algorithm and
 * limitations.  Pure JS — no native module dependency beyond what
 * react-native-sensors already provides.
 */
export function useIMUTranslationGate(
  options: UseIMUTranslationGateOptions,
): UseIMUTranslationGateReturn {
  const {
    enabled,
    budgetMeters = 0.08,
    sampleIntervalMs = 20,
    onBudgetExceeded,
  } = options;

  // Integrator state, kept in refs so the rxjs subscription can write
  // to them without re-creating the closure on every render.
  // ─ velocity (m/s, device frame, 3 axes)
  // ─ position (m,  device frame, 3 axes — magnitude is what we care about)
  // ─ gravity (m/s², device frame, slowly-tracked via 1-pole IIR)
  // ─ lastSampleMs (epoch ms; for dt calculation)
  // ─ budgetCrossedThisCycle (debounce flag — clears on resetAnchor)
  const vel = useRef<[number, number, number]>([0, 0, 0]);
  const pos = useRef<[number, number, number]>([0, 0, 0]);
  const gravity = useRef<[number, number, number]>([0, 0, 9.81]);  // start ≈ phone-flat
  const lastSampleMs = useRef<number>(0);
  const budgetCrossed = useRef<boolean>(false);

  // Keep the callback in a ref so we don't tear down + re-subscribe
  // on every prop change.  React idiom for stable callback identity.
  const onBudgetExceededRef = useRef(onBudgetExceeded);
  useEffect(() => { onBudgetExceededRef.current = onBudgetExceeded; },
    [onBudgetExceeded]);

  useEffect(() => {
    if (!enabled) return;

    // Lock in the accelerometer update rate.  react-native-sensors is
    // shared across hooks in the SDK (PanoramaGuidance, useDeviceOrientation,
    // useIncrementalAndroidDriver, IncrementalPanGuide) — they all call
    // `setUpdateIntervalForType` for their preferred sensor.  We do the
    // same for the accelerometer; subsequent hooks that need a different
    // rate will call it again and override.
    setUpdateIntervalForType(SensorTypes.accelerometer, sampleIntervalMs);

    // Reset state on (re-)engage so the first measurement after enabled
    // toggles to true doesn't carry stale velocity from a previous
    // capture session.
    vel.current = [0, 0, 0];
    pos.current = [0, 0, 0];
    gravity.current = [0, 0, 9.81];
    lastSampleMs.current = 0;
    budgetCrossed.current = false;

    const sub: Subscription = accelerometer.subscribe(({ x, y, z, timestamp }) => {
      // First sample: just record time, no integration yet (no dt).
      // react-native-sensors gives `timestamp` in MILLISECONDS.
      if (lastSampleMs.current === 0) {
        lastSampleMs.current = timestamp;
        return;
      }
      const dt = Math.max(0, Math.min(0.1, (timestamp - lastSampleMs.current) / 1000.0));
      lastSampleMs.current = timestamp;
      if (dt === 0) return;

      // Gravity tracking — 1-pole IIR at α=0.1.  After ~1 s the IIR
      // converges on the steady-state gravity direction; subtracting
      // it from raw accel gives "linear acceleration" similar to
      // Android's `TYPE_LINEAR_ACCELERATION` and iOS' `userAcceleration`.
      const alpha = 0.1;
      gravity.current[0] = alpha * x + (1 - alpha) * gravity.current[0];
      gravity.current[1] = alpha * y + (1 - alpha) * gravity.current[1];
      gravity.current[2] = alpha * z + (1 - alpha) * gravity.current[2];
      const ax = x - gravity.current[0];
      const ay = y - gravity.current[1];
      const az = z - gravity.current[2];

      // Integrate.  Trapezoidal would be slightly more accurate but
      // rectangular Euler is fine at 50 Hz for sub-second windows.
      vel.current[0] += ax * dt;
      vel.current[1] += ay * dt;
      vel.current[2] += az * dt;

      // Damp velocity slightly to absorb double-integration drift.
      // 5% per sample at 50 Hz ≈ 2.5 / s exponential decay — keeps
      // velocity bounded when the operator is stationary but small
      // residual accel noise would otherwise pile up.  Doesn't affect
      // actual translation captured in the working second; affects
      // background drift over the ~0.3-1.0 s window we care about.
      const damp = 0.95;
      vel.current[0] *= damp;
      vel.current[1] *= damp;
      vel.current[2] *= damp;

      pos.current[0] += vel.current[0] * dt;
      pos.current[1] += vel.current[1] * dt;
      pos.current[2] += vel.current[2] * dt;

      const px = pos.current[0];
      const py = pos.current[1];
      const pz = pos.current[2];
      const magnitude = Math.sqrt(px * px + py * py + pz * pz);

      // Budget crossing — fire exactly once per crossing (the
      // `budgetCrossed` flag clears on `resetAnchor`).  Without the
      // debounce the same crossing would fire dozens of times until
      // the host's force-accept landed and the gate's own re-anchor
      // event fed back.
      if (!budgetCrossed.current && magnitude >= budgetMeters) {
        budgetCrossed.current = true;
        onBudgetExceededRef.current();
      }
    });

    return () => {
      sub.unsubscribe();
    };
  }, [enabled, budgetMeters, sampleIntervalMs]);

  return {
    resetAnchor: () => {
      vel.current = [0, 0, 0];
      pos.current = [0, 0, 0];
      // Keep gravity — it's a steady-state estimate that's been
      // refining throughout the capture; resetting it would force
      // the IIR to re-converge over the next second and the first
      // bit of post-reset accel would be misattributed as gravity.
      lastSampleMs.current = 0;
      budgetCrossed.current = false;
    },
    getCurrentTranslationM: () => {
      const px = pos.current[0];
      const py = pos.current[1];
      const pz = pos.current[2];
      return Math.sqrt(px * px + py * py + pz * pz);
    },
  };
}
