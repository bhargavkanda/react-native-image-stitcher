// SPDX-License-Identifier: Apache-2.0
//
// useIMUTranslationGate — JS-side IMU translation tracker that fires
// a callback when integrated lateral displacement on the device-X
// axis exceeds a budget.  Drives `<Camera>`'s non-AR keyframe-
// acceptance path: every time the gate fires, the host calls the
// C++ engine's `markNextFrameAsLastKeyframe()` so the trailing frame
// lands as a keyframe regardless of what the flow-novelty algorithm
// alone would decide.
//
// V0.2 history note
// ─────────────────
// 0.1.x used `expo-sensors`' `DeviceMotion.acceleration`, which
// returned gravity-subtracted linear acceleration via CoreMotion's
// native fusion (iOS) / Android's `TYPE_LINEAR_ACCELERATION` sensor
// (Android) — both significantly less noisy than raw accel + JS-side
// gravity subtraction.  v0.2 drops the Expo modules dependency
// (see CHANGELOG / docs/host-app-integration.md), so the gate is now
// implemented on `react-native-sensors`' raw `accelerometer` with a
// JS-side IIR low-pass to estimate the gravity vector.  The IIR
// version is noisier — expect a few extra cm of apparent drift on a
// stationary phone over several seconds — but the budget threshold
// (~8 cm at default `flowMaxTranslationCm = 8`) and the anchor
// resets (every accepted keyframe + recording start) keep the
// per-interval drift window short enough that the budget still
// meaningfully discriminates real translation from noise.
//
// Why device-X (the shorter side)
// ───────────────────────────────
// We track motion ALONG the pan axis (the direction the operator is
// supposed to be rotating-through but might be translating-through
// instead).  In BOTH supported pan modes the pan axis maps to
// device-X:
//   Portrait  + horizontal pan: device-X = user-left/right.
//   Landscape + vertical   pan: device-X has rotated 90° into the
//                                user's up/down direction.
// So a single-axis tracker works without knowing the orientation.
//
// Drift mitigation
// ────────────────
// 1. IIR low-pass on the raw X accel estimates the gravity offset.
//    Subtracting that gives linear-acceleration-on-X.  Alpha = 0.9
//    at the default 50 Hz sample rate → ~200 ms gravity tracking
//    time constant.  Slow enough that hand motion (>1 Hz) gets
//    through; fast enough to converge after device rotations within
//    ~1 second.
// 2. Per-sample velocity damping at 5 % so a constant noise-floor
//    offset decays to ~1 % of its initial value in 2 s.  This caps
//    apparent drift for a stationary phone.
// 3. Anchor reset on recording start AND every accepted keyframe
//    (callers do this) — bounds the integration window to typically
//    0.3-2 s, well inside the regime where IIR-estimated linear
//    accel is usable.
//
// Platform unit handling
// ──────────────────────
// `react-native-sensors`' accelerometer reports:
//   iOS:     values in G's (multiples of 9.81 m/s²), via CoreMotion.
//   Android: values in m/s², via Sensor.TYPE_ACCELEROMETER.
// We scale iOS by `G_TO_MPS2` so the integration math stays in
// standard m/s², m/s, m units.  Sign convention doesn't matter for
// the gate because the gravity offset is estimated and subtracted
// per-axis; what's left is the platform-agnostic linear acceleration.

import { useCallback, useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import {
  accelerometer,
  setUpdateIntervalForType,
  SensorTypes,
} from 'react-native-sensors';
import type { Subscription } from 'rxjs';


export interface UseIMUTranslationGateOptions {
  /**
   * Whether the gate is engaged.  Pass `false` to skip the
   * subscription entirely — useful when the host is in AR mode
   * (where the gate gets pose-derived translation natively).
   * Hot-toggleable; subscribing/unsubscribing is cheap.
   */
  enabled: boolean;

  /**
   * Translation budget in METRES along the device-X (pan) axis.
   * Default 0.40 m / 40 cm.  Callers in `<Camera>` typically pass
   * `panoramaSettings.flowMaxTranslationCm / 100.0` (default 8 cm).
   */
  budgetMeters?: number;

  /**
   * Update interval in MILLISECONDS for the accelerometer.
   * Default 20 ms ≈ 50 Hz.  Lower = more accurate integration;
   * higher = lower CPU + battery.
   */
  sampleIntervalMs?: number;

  /**
   * Fired exactly once per "budget crossing" — i.e., when the
   * running translation along device-X crosses `budgetMeters` from
   * below.  The host is responsible for both (a) calling
   * `IncrementalStitcher.markNextFrameAsLastKeyframe()` to force-
   * accept the next frame, and (b) invoking the returned
   * `resetAnchor()` once that next keyframe actually accepts, so
   * the integrator restarts from zero.
   */
  onBudgetExceeded: () => void;
}


export interface UseIMUTranslationGateReturn {
  /**
   * Reset the position + velocity integrators to zero AND clear the
   * "already fired" latch so `onBudgetExceeded` can fire again.
   * The gravity IIR estimate is intentionally preserved — it
   * benefits from continuous history across anchors.
   */
  resetAnchor: () => void;
  /**
   * 2026-05-22 (audit follow-up) — read the latest integrated
   * translation magnitude in METRES.  Useful for debug overlays
   * that want to surface "how much translation has the operator
   * accumulated since the last keyframe accept" so they can sanity-
   * check whether the budget is going to fire.  Cheap: returns the
   * ref value, no React state subscription (the integrator runs at
   * 50 Hz and we don't want to force a re-render every sample).
   * Callers that want a live UI value should poll on an interval
   * or use a frame-driven re-render trigger.
   */
  getTranslationMetres: () => number;
}


const DEFAULT_BUDGET_METERS = 0.40;
const DEFAULT_SAMPLE_INTERVAL_MS = 20;
/// Per-sample multiplicative damping on the velocity integrator.
/// 5 % at 50 Hz → constant offset decays to ~1 % in 2 s.  Bounds
/// the apparent-drift window for a stationary phone.
const VELOCITY_DAMPING_PER_SAMPLE = 0.05;
/// IIR low-pass coefficient for the gravity estimate.  At 50 Hz
/// this gives ~200 ms time constant.  Higher = slower gravity
/// tracking (more lag during device rotation, less hand-motion
/// bleed into the gravity estimate); lower = faster.
const GRAVITY_IIR_ALPHA = 0.9;
/// 1 G in m/s².  Standard gravity per CGPM 1901 (good to all the
/// digits anyone cares about for this application).
const G_TO_MPS2 = 9.81;


export function useIMUTranslationGate({
  enabled,
  budgetMeters = DEFAULT_BUDGET_METERS,
  sampleIntervalMs = DEFAULT_SAMPLE_INTERVAL_MS,
  onBudgetExceeded,
}: UseIMUTranslationGateOptions): UseIMUTranslationGateReturn {
  // All running-integrator state lives in a single ref so the
  // subscription callback can update it without forcing a re-render
  // every frame (50 Hz worth of re-renders would tank performance).
  const stateRef = useRef({
    posX: 0,
    velX: 0,
    /// NaN sentinel for "uninitialised"; first sample seeds it.
    gravityX: NaN,
    fired: false,
  });

  // Latest onBudgetExceeded callback in a ref so callers can pass
  // an inline closure that captures fresh state without us re-
  // subscribing the sensor (which would reset the integrators).
  const onExceededRef = useRef(onBudgetExceeded);
  onExceededRef.current = onBudgetExceeded;

  const resetAnchor = useCallback(() => {
    const s = stateRef.current;
    s.posX = 0;
    s.velX = 0;
    s.fired = false;
    // s.gravityX is intentionally preserved — see header.
  }, []);

  useEffect(() => {
    if (!enabled) return;

    setUpdateIntervalForType(SensorTypes.accelerometer, sampleIntervalMs);
    const scale = Platform.OS === 'ios' ? G_TO_MPS2 : 1;
    const dt = sampleIntervalMs / 1000.0;

    const sub: Subscription = accelerometer.subscribe(({ x }) => {
      const ax = x * scale;  // device-X acceleration in m/s²
      const s = stateRef.current;

      // First sample: seed gravity from this reading.  Assumes the
      // phone is roughly stationary at recording start — true in
      // practice because the operator just tap-and-held the shutter.
      if (Number.isNaN(s.gravityX)) {
        s.gravityX = ax;
        return;
      }

      // IIR low-pass to track the gravity component on device-X.
      s.gravityX = GRAVITY_IIR_ALPHA * s.gravityX + (1 - GRAVITY_IIR_ALPHA) * ax;

      // Linear acceleration on X = raw - gravity estimate.
      const linX = ax - s.gravityX;

      // Single integration with per-sample velocity damping.
      s.velX = (s.velX + linX * dt) * (1 - VELOCITY_DAMPING_PER_SAMPLE);
      s.posX += s.velX * dt;

      if (!s.fired && Math.abs(s.posX) > budgetMeters) {
        s.fired = true;
        onExceededRef.current();
      }
    });

    return () => sub.unsubscribe();
  }, [enabled, budgetMeters, sampleIntervalMs]);

  const getTranslationMetres = useCallback(() => {
    return stateRef.current.posX;
  }, []);

  return { resetAnchor, getTranslationMetres };
}
