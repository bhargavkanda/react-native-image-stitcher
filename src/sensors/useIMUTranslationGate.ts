// SPDX-License-Identifier: UNLICENSED
//
// useIMUTranslationGate.ts — JS-side IMU translation tracker for the
// non-AR translation-warning banner + (optional) gate force-accept.
//
// 2026-05-17 (Issue #4-A v3): rewritten on top of `expo-sensors`
// `DeviceMotion` (which returns gravity-subtracted linear
// acceleration via Apple's CoreMotion fusion on iOS and Android's
// `TYPE_LINEAR_ACCELERATION` sensor on Android — both significantly
// less noisy than raw accel + JS-side IIR gravity subtraction).
// Tracks a SINGLE device-frame axis (device-X — the phone's lateral /
// short side) rather than the 3D translation magnitude.
//
// Why exists
// ──────────
//
// In non-AR mode the SDK has no ARSession pose stream, so the shared
// C++ `KeyframeGate`'s translation-budget feature stays at zero and
// never trips.  This hook fills the gap on the JS side and emits a
// budget-crossed callback the host can wire to either:
//
//   (a) `markNextFrameAsLastKeyframe()` — tell the gate "force-accept
//       the next frame regardless of overlap", so the trailing-edge
//       frame still lands when the operator translates instead of
//       rotates.
//
//   (b) A user-facing warning banner ("Rotate the camera instead of
//       moving it sideways" — see AuditCaptureScreen).
//
// AuditCaptureScreen wires it to both.
//
// Why device-X (the shorter side)
// ───────────────────────────────
//
// We track motion ALONG the pan axis (the direction the operator is
// supposed to be rotating-through but might be translating-through
// instead) because translation orthogonal to the pan axis is
// acceptable — vertical translation while panning horizontally in
// portrait, for example, doesn't cause horizontal parallax.
//
// The pan axis maps to device-X in BOTH supported orientations
// (per memory/ar-stitching-two-modes.md):
//
//   Portrait  + horizontal pan: device-X = user-left/right = pan axis.
//   Landscape + vertical   pan: device-X has rotated 90° into the
//                                user's up/down direction = pan axis.
//
// The lateral axis of the phone (its short side) always aligns with
// the pan direction in either supported mode, so a single-axis
// tracker works without needing to know which orientation we're in.
//
// Drift mitigation
// ────────────────
//
// `DeviceMotion.acceleration` (gravity removed in native code via
// IMU fusion) has a noise floor roughly 30-50 % lower than what the
// previous raw-accel + JS IIR pipeline produced.  Single-axis math
// further reduces apparent drift by ≈√3 vs the prior 3D magnitude.
// Together they should keep the typical "stationary phone" reading
// below ~5-10 cm even after several seconds.
//
// Anchor resets happen at (a) recording start (via the host calling
// `resetAnchor()` from handleHoldStart) and (b) every accepted
// keyframe — these bound the per-interval drift window to typically
// 0.3-2 s.
//
// What we no longer do
// ────────────────────
//
//   - JS-side 1-pole IIR for gravity subtraction (native API gives
//     gravity-subtracted accel directly).
//   - 3D vector magnitude (now single device-X axis).
//   - Velocity damping (kept as a safety net at 5%/sample so a
//     persistent noise-floor offset doesn't slowly drift the axis —
//     low cost, high robustness).

import { useEffect, useRef } from 'react';
import { DeviceMotion } from 'expo-sensors';
import type { DeviceMotionMeasurement } from 'expo-sensors';

// expo-sensors doesn't re-export Subscription from its index, but
// `addListener` returns one — use the inferred return type so we
// don't have to chase the right deep-import path.
type DeviceMotionSubscription = ReturnType<typeof DeviceMotion.addListener>;


export interface UseIMUTranslationGateOptions {
  /**
   * Whether the gate is engaged.  Pass `false` to skip the subscription
   * entirely — useful when the host is in AR mode (where the gate
   * gets pose-derived translation natively).  Hot-toggleable;
   * subscribing/unsubscribing is cheap.
   */
  enabled: boolean;

  /**
   * Translation budget in METRES along the device-X (pan) axis.
   * When the integrated displacement magnitude exceeds this since
   * the last accept, the hook fires `onBudgetExceeded`.  Default
   * 0.40 m / 40 cm (80 % of the 50 cm default
   * `flowMaxTranslationCm`).  Caller typically passes
   * `panoramaSettings.flowMaxTranslationCm * 0.8 / 100`.
   */
  budgetMeters?: number;

  /**
   * Update interval in MILLISECONDS for the DeviceMotion sensor.
   * Default 20 ms ≈ 50 Hz.  Lower (faster sampling) = more accurate
   * integration; higher = lower CPU + battery.  Matches the previous
   * raw-accel cadence so reset/integrate behaviour stays comparable.
   */
  sampleIntervalMs?: number;

  /**
   * Fired exactly once per "budget crossing" — i.e., when the
   * running translation along device-X crosses `budgetMeters` from
   * below.  The host is responsible for both (a) calling
   * `RetaiLensIncrementalStitcher.markNextFrameAsLastKeyframe()` and
   * (b) invoking the returned `resetAnchor()` once the next
   * keyframe actually accepts, so the integrator restarts from zero.
   */
  onBudgetExceeded: () => void;

  /**
   * 2026-05-18 (Issue #4 investigation) — when true, log every Nth
   * accelerometer sample (default N=20 ≈ 400 ms at 50 Hz) showing
   * the current `acceleration.x`, accumulated `posX`, and time
   * since anchor reset.  Helps diagnose drift behaviour vs real
   * translation magnitude in field testing.  Defaults to false —
   * production captures stay quiet.
   */
  debug?: boolean;
}


export interface UseIMUTranslationGateReturn {
  /**
   * Reset the running translation to zero.  Call this at recording
   * start AND after each confirmed keyframe accept — the typical
   * wiring is to subscribe to `RetaiLensIncrementalStateUpdate` and
   * call `resetAnchor()` from inside the listener AND from the host's
   * `handleHoldStart`.
   */
  resetAnchor: () => void;

  /**
   * Read the current running displacement along device-X in METRES.
   * Returns the absolute value (sign is uninteresting — either left
   * or right counts the same toward the budget).
   * Useful for the on-screen debug HUD ("translation since last
   * accept: 0.07 m").  Not exposed via state — host polls if needed.
   */
  getCurrentTranslationM: () => number;
}


/**
 * IMU-based translation tracker — single-axis (device-X / pan axis),
 * fused IMU via `expo-sensors` `DeviceMotion`.  See file header for
 * algorithm + rationale.  No platform-specific code; the underlying
 * native fusion is platform-aware (CoreMotion on iOS, fused
 * `TYPE_LINEAR_ACCELERATION` on Android).
 */
export function useIMUTranslationGate(
  options: UseIMUTranslationGateOptions,
): UseIMUTranslationGateReturn {
  const {
    enabled,
    budgetMeters = 0.40,
    sampleIntervalMs = 20,
    onBudgetExceeded,
    debug = false,
  } = options;

  // Integrator state, kept in refs so the listener can write without
  // re-creating its closure on every render.
  // ─ velX  : velocity along device-X (m/s)
  // ─ posX  : position along device-X (m)
  // ─ lastMs: epoch ms of the previous sample (for dt)
  // ─ budgetCrossed: debounce flag — clears on resetAnchor
  // ─ sampleCount: rolling counter for debug log throttle
  // ─ anchorMs: timestamp of the most recent resetAnchor (or first
  //             sample) — gives "time since anchor" in debug output
  const velX = useRef<number>(0);
  const posX = useRef<number>(0);
  const lastMs = useRef<number>(0);
  const budgetCrossed = useRef<boolean>(false);
  const sampleCount = useRef<number>(0);
  const anchorMs = useRef<number>(0);

  // Keep the callback in a ref so we don't tear down + re-subscribe
  // on every prop change.  React idiom for stable callback identity.
  const onBudgetExceededRef = useRef(onBudgetExceeded);
  useEffect(() => { onBudgetExceededRef.current = onBudgetExceeded; },
    [onBudgetExceeded]);

  useEffect(() => {
    if (!enabled) return;

    // Lock in the DeviceMotion update rate.  Other expo-sensors
    // consumers in the SDK can override later; the LAST setter wins
    // per Expo's docs, which is fine because our budget logic
    // tolerates a wide range of cadences.
    DeviceMotion.setUpdateInterval(sampleIntervalMs);

    // Reset state on (re-)engage so the first measurement after
    // enabled-toggles-true doesn't carry stale velocity from a
    // previous capture session.
    velX.current = 0;
    posX.current = 0;
    lastMs.current = 0;
    budgetCrossed.current = false;
    sampleCount.current = 0;
    anchorMs.current = Date.now();

    const sub: DeviceMotionSubscription = DeviceMotion.addListener((m: DeviceMotionMeasurement) => {
      const a = m.acceleration;       // gravity-subtracted (m/s²)
      if (!a) return;                 // can be null briefly on cold start
      const now = Date.now();
      if (lastMs.current === 0) {
        lastMs.current = now;
        return;
      }
      const dt = Math.max(0, Math.min(0.1, (now - lastMs.current) / 1000.0));
      lastMs.current = now;
      if (dt === 0) return;

      // Single-axis integration along device-X (lateral / pan axis).
      // See file header for why device-X is the right axis in both
      // portrait and landscape captures.
      velX.current += a.x * dt;
      velX.current *= 0.95;            // 5%/sample damping — see file header
      posX.current += velX.current * dt;

      const mag = Math.abs(posX.current);

      // 2026-05-18 (Issue #4 investigation) — debug-gated diagnostic
      // log.  Throttled to every 20th sample (~400 ms at 50 Hz) so
      // the log isn't a firehose.  When this runs and we still see
      // posX hovering at < 5 cm during a real translation, the
      // sensor source isn't capturing what we think it is.
      sampleCount.current += 1;
      if (debug && sampleCount.current % 20 === 0) {
        const secs = (now - anchorMs.current) / 1000.0;
        // eslint-disable-next-line no-console
        console.log(
          `[IMUTransGate] t+${secs.toFixed(2)}s `
          + `ax=${a.x.toFixed(3)}m/s² `
          + `velX=${velX.current.toFixed(4)}m/s `
          + `posX=${posX.current.toFixed(4)}m `
          + `(|mag|=${mag.toFixed(4)}m, budget=${budgetMeters.toFixed(2)}m, crossed=${budgetCrossed.current})`,
        );
      }

      // Budget crossing — fire exactly once per crossing (the
      // `budgetCrossed` flag clears on `resetAnchor`).
      if (!budgetCrossed.current && mag >= budgetMeters) {
        budgetCrossed.current = true;
        if (debug) {
          // eslint-disable-next-line no-console
          console.log(
            `[IMUTransGate] BUDGET CROSSED at posX=${posX.current.toFixed(4)}m `
            + `(budget=${budgetMeters.toFixed(2)}m)`,
          );
        }
        onBudgetExceededRef.current();
      }
    });

    return () => {
      sub.remove();
    };
  }, [enabled, budgetMeters, sampleIntervalMs, debug]);

  return {
    resetAnchor: () => {
      velX.current = 0;
      posX.current = 0;
      lastMs.current = 0;
      budgetCrossed.current = false;
      sampleCount.current = 0;
      anchorMs.current = Date.now();
    },
    getCurrentTranslationM: () => Math.abs(posX.current),
  };
}
