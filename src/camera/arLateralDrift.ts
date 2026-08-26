// SPDX-License-Identifier: Apache-2.0
/**
 * arLateralDrift — ABSOLUTE cross-pan drift from the AR camera pose.
 *
 * ## Why this exists
 *
 * The IMU lateral guard in `usePanMotion` cannot see slow drift, and that is
 * not a tuning failure — it is arithmetic.  Recovering displacement from an
 * accelerometer means double-integrating, which lets bias grow without bound:
 * 0.25 deg of attitude error alone fabricates ~32 cm over 20 s (measured).
 * The high-pass that bounds it (`RESIDUAL_BIAS_TAU_S`) is exactly what removes
 * slow real motion.  Sensitivity to slow drift and immunity to slow sensor
 * error are THE SAME KNOB, so no threshold on that channel can have both.
 *
 * A 2026-08-26 device session measured the consequence: across nine captures
 * the accelerometer estimate correlated with the stitcher's own image-derived
 * translation at **r = -0.28** — anti-correlated — with the capture carrying
 * the LEAST real translation producing the HIGHEST reading (2.1 cm real ->
 * 4.84 cm reported, against 10.4 cm real -> 1.55 cm reported).
 *
 * In AR none of that applies.  `ARFrameMeta.pose.translation` is ARKit's
 * VIO world position in METRES.  It is a POSITION, not an acceleration:
 *   - no integration, so no bias accumulation and no high-pass;
 *   - therefore arbitrarily slow drift is visible;
 *   - and tilt cannot masquerade as translation, because tilt changes the
 *     ROTATION, which this never reads for the displacement itself.
 *
 * This module turns that pose stream into an absolute cross-pan distance.
 *
 * ## Choosing the cross-pan axis
 *
 * "Lateral" means orthogonal to the intended sweep, so it depends on pan mode.
 * Critically it must also be an axis the sweep's own ARC does not project onto
 * — otherwise a normal pan (which traces an arc of radius ~15-60 cm about the
 * wrist/elbow/shoulder) reads as drift.  That confusion is precisely what
 * broke the panorama/SCANS resolver: see `resolveStitchModeAuto`, where
 * `ratio` reduces to `r/(r+0.10)` and the pan angle cancels out entirely.
 *
 *   - `panMode: 'vertical'`   — landscape hold, sweeping UP/DOWN.  The arc
 *     lies in a VERTICAL plane, so it has no horizontal component.  Lateral is
 *     the HORIZONTAL direction across the view: the camera's right vector at
 *     capture start, flattened into the horizontal plane.
 *   - `panMode: 'horizontal'` — portrait hold, sweeping LEFT/RIGHT.  The arc
 *     is a yaw and lies in a HORIZONTAL plane, so it has no vertical
 *     component.  Lateral is WORLD UP.
 *
 * In both cases the arc is orthogonal to the measured axis by construction, so
 * an operator pivoting cleanly in place reads ~0 no matter how far they sweep
 * or how long their arms are.
 *
 * ARKit world frame: right-handed, **Y up**, **-Z forward**; quaternion packed
 * `[x, y, z, w]` (see `RNISARFramePlugin.swift`).
 */

import { _evalGraceLatch } from './usePanMotion';

/** A world-space 3-vector. */
export type Vec3 = readonly [number, number, number];
/** A unit quaternion packed `[x, y, z, w]`, matching `ARFrameMeta.pose`. */
export type Quat = readonly [number, number, number, number];

/** Pan axis vocabulary, mirroring `PanMode`. */
export type ArPanMode = 'vertical' | 'horizontal';

/**
 * Default absolute cross-pan drift budget, CENTIMETRES.
 *
 * 4 cm matches `DEFAULT_LATERAL_BUDGET_CM` so the two guards state the same
 * intent — but they are NOT the same measurement.  That one gates a
 * high-passed rate proxy whose readings bear no fixed relation to distance
 * (it peaked at 1.6 cm across an entire device session, so its number is
 * barely load-bearing); this one is REAL centimetres and will be reached.
 *
 * BE AWARE 4 cm is tight against measured behaviour.  Ordinary AR sweeps in
 * the 2026-08-26 session peaked at 4.8 cm of true cross-pan displacement —
 * i.e. ABOVE this budget — so clean captures can be expected to trip it until
 * the number is tuned from field traces.  It was set deliberately LOW to start
 * strict and relax on evidence; `peak=` in the `[panMotion.ar]` line is the
 * number to relax it from.  On 2026-08-26 a
 *
 * A STARTING POINT from one operator, one device and one scene, not a tuned
 * default.  Collect `[panMotion.ar]` peaks from real captures before trusting
 * it; if operators are stopped on sweeps that felt clean, this is the number
 * to raise.
 */
export const DEFAULT_AR_LATERAL_BUDGET_CM = 4;

/** Rotate `v` by unit quaternion `q`. */
export function _rotateByQuat(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  // t = 2 * (qvec x v);  v' = v + w*t + (qvec x t)
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ];
}

/**
 * The world-space axis along which cross-pan drift is measured.
 *
 * Returns `null` when the geometry is degenerate — for `'vertical'`, a camera
 * whose right vector is (near-)parallel to gravity, i.e. the phone rolled to
 * within a few degrees of straight up/down.  The caller must treat `null` as
 * "cannot measure this frame" rather than as zero drift.
 */
export function _lateralAxis(q: Quat, mode: ArPanMode): Vec3 | null {
  if (mode === 'horizontal') {
    // Sweep is a yaw in the horizontal plane; drift is up/down.
    return [0, 1, 0];
  }
  // 'vertical': sweep is a pitch in a vertical plane; drift is horizontal.
  // Flatten the camera's right vector into the horizontal plane so a tilted
  // hold still measures a purely horizontal distance.
  const r = _rotateByQuat(q, [1, 0, 0]);
  const flat: Vec3 = [r[0], 0, r[2]];
  const len = Math.hypot(flat[0], flat[2]);
  // ~5 deg of remaining horizontal component; below this the projection is
  // dominated by numerical noise and the axis is meaningless.
  if (len < 0.087) return null;
  return [flat[0] / len, 0, flat[2] / len];
}

/**
 * Default absolute cross-pan ROTATION budget, DEGREES.
 *
 * The gyro trigger (`lateralTurnRateRadPerSec`) is a RATE gate at 0.15 rad/s
 * = 8.6 deg/s, so it cannot see a slow pivot at all: 6 deg/s accumulates 90
 * DEGREES of yaw over 15 s and never trips it.  That is the same blind spot
 * slow translation had, in the other channel — a rate gate measures how FAST
 * you are turning, never how FAR you have turned.
 *
 * 25 deg is a deliberate starting point, not a tuned default: it is well past
 * the few degrees of wander a straight sweep involves, and well short of the
 * 90 deg a genuine wrong-way pivot reaches.  Collect `arRotDeg` peaks from
 * real captures before trusting it.
 */
export const DEFAULT_AR_LATERAL_ROT_DEG = 10;

/** Camera forward (view) direction in world space. */
export function _forwardOf(q: Quat): Vec3 {
  // The camera looks along -Z in its own frame (ARKit convention).
  return _rotateByQuat(q, [0, 0, -1]);
}

/**
 * Signed cross-pan ROTATION between two poses, RADIANS.
 *
 * Measured on the forward VECTOR rather than by decomposing the quaternion,
 * so a roll about the view axis — which does not change where the camera
 * points — contributes nothing.  That matters: roll is the motion that
 * corrupted the accelerometer guard, and it must not be double-counted here.
 *
 *   - `'vertical'`   — the sweep pitches within a vertical plane, so lateral
 *     rotation is the AZIMUTH change (turning left/right off the plane).
 *   - `'horizontal'` — the sweep yaws within a horizontal plane, so lateral
 *     rotation is the ELEVATION change (tilting up/down off the plane).
 *
 * Both are orthogonal to the intended sweep by construction, so panning
 * further never accumulates lateral rotation.
 */
export function _lateralRotationRad(startQ: Quat, curQ: Quat, mode: ArPanMode): number {
  const f0 = _forwardOf(startQ);
  const f1 = _forwardOf(curQ);
  if (mode === 'horizontal') {
    // Elevation off the horizontal sweep plane.
    const e0 = Math.asin(Math.max(-1, Math.min(1, f0[1])));
    const e1 = Math.asin(Math.max(-1, Math.min(1, f1[1])));
    return e1 - e0;
  }
  // Azimuth in the horizontal plane.  Degenerate when the camera points
  // near-vertically (azimuth undefined); the caller treats NaN as unmeasurable.
  const h0 = Math.hypot(f0[0], f0[2]);
  const h1 = Math.hypot(f1[0], f1[2]);
  if (h0 < 0.087 || h1 < 0.087) return NaN;   // within ~5 deg of straight up/down
  const a0 = Math.atan2(f0[0], f0[2]);
  const a1 = Math.atan2(f1[0], f1[2]);
  let d = a1 - a0;
  // Shortest signed arc, so a sweep across the +/-pi seam does not read as a
  // full turn.
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}


/** Signed cross-pan displacement in METRES between two poses. */
export function _lateralDriftMetres(
  startQ: Quat,
  startT: Vec3,
  curT: Vec3,
  mode: ArPanMode,
): number | null {
  const axis = _lateralAxis(startQ, mode);
  if (axis === null) return null;
  const dx = curT[0] - startT[0];
  const dy = curT[1] - startT[1];
  const dz = curT[2] - startT[2];
  return dx * axis[0] + dy * axis[1] + dz * axis[2];
}

/** Running state for the AR drift guard.  Mutated in place, like `LateralState`. */
export interface ArDriftState {
  /** Pose the drift is measured FROM, or null before a trusted frame arrives. */
  startQ: Quat | null;
  startT: Vec3 | null;
  /** Signed cross-pan displacement, metres. */
  driftM: number;
  /** Largest |driftM| seen this capture — the number worth logging. */
  peakM: number;
  /** Latched once the budget was exceeded for the grace window. */
  exceeded: boolean;
  /** Start of the current continuous over-budget run, or null. */
  overBudgetSinceMs: number | null;
  /** Frames skipped because tracking was not `normal`. */
  untrackedCount: number;
  /** Frames skipped because the lateral axis was degenerate. */
  degenerateCount: number;

  // ── absolute cross-pan ROTATION (the slow-pivot hole) ────────────
  /** Signed cross-pan rotation from the seeded pose, RADIANS. */
  rotRad: number;
  /** Largest |rotRad| this capture — the number worth logging. */
  peakRotRad: number;
  /** Which channel latched: displacement, rotation, or neither. */
  latchedBy: 'none' | 'drift' | 'rotation';
  /** Start of the current continuous over-budget ROTATION run. */
  rotOverSinceMs: number | null;
}

export function _freshArDriftState(): ArDriftState {
  return {
    startQ: null,
    startT: null,
    driftM: 0,
    peakM: 0,
    exceeded: false,
    overBudgetSinceMs: null,
    untrackedCount: 0,
    degenerateCount: 0,
    rotRad: 0,
    peakRotRad: 0,
    latchedBy: 'none',
    rotOverSinceMs: null,
  };
}

export function _resetArDriftState(s: ArDriftState): ArDriftState {
  s.startQ = null;
  s.startT = null;
  s.driftM = 0;
  s.peakM = 0;
  s.exceeded = false;
  s.overBudgetSinceMs = null;
  s.untrackedCount = 0;
  s.degenerateCount = 0;
  s.rotRad = 0;
  s.peakRotRad = 0;
  s.latchedBy = 'none';
  s.rotOverSinceMs = null;
  return s;
}

/**
 * Advance the guard by one AR frame.  Pure (mutates and returns `s`).
 *
 * SEEDING IS DEFERRED TO THE FIRST `normal` FRAME, deliberately.  Finalizing a
 * capture restarts the AR session, so the next capture opens with the tracker
 * relocalising and emitting `limited` poses that can jump metres.  Anchoring
 * the origin to one of those would inject a large phantom drift at t=0 — the
 * same class of bug as the AR hold self-ending on unstable init poses.
 *
 * @param budgetM  absolute cross-pan budget, METRES.  `<= 0` disables the
 *                 latch while still tracking (and logging) the distance.
 */
export function _advanceArDrift(
  s: ArDriftState,
  q: Quat,
  t: Vec3,
  trackingState: string,
  mode: ArPanMode,
  budgetM: number,
  graceMs: number,
  nowMs: number,
  /** Absolute cross-pan ROTATION budget, RADIANS.  `<= 0` disables that
   *  channel while still measuring it. */
  rotBudgetRad = 0,
): ArDriftState {
  if (trackingState !== 'normal') {
    s.untrackedCount += 1;
    return s;
  }
  if (s.startQ === null || s.startT === null) {
    s.startQ = q;
    s.startT = t;
    return s;
  }
  const d = _lateralDriftMetres(s.startQ, s.startT, t, mode);
  if (d === null) {
    s.degenerateCount += 1;
    return s;
  }
  s.driftM = d;
  s.peakM = Math.max(s.peakM, Math.abs(d));

  // ── ABSOLUTE cross-pan ROTATION.  The gyro trigger is a RATE gate, so a
  // slow pivot is invisible to it however far it turns — 6 deg/s reaches 90
  // deg of yaw in 15 s without ever crossing 0.15 rad/s.  Pose-derived angle
  // has no such blind spot: it is a measurement, not a rate.
  const rot = _lateralRotationRad(s.startQ, q, mode);
  if (Number.isFinite(rot)) {
    s.rotRad = rot;
    s.peakRotRad = Math.max(s.peakRotRad, Math.abs(rot));
  } else {
    // Camera pointing near-vertically: azimuth is undefined.  Counted, not
    // silently read as zero rotation.
    s.degenerateCount += 1;
  }

  const latch = _evalGraceLatch(
    budgetM > 0 && Math.abs(d) > budgetM,
    nowMs,
    s.overBudgetSinceMs,
    s.exceeded,
    graceMs,
  );
  const rotLatch = _evalGraceLatch(
    rotBudgetRad > 0 && Number.isFinite(rot) && Math.abs(rot) > rotBudgetRad,
    nowMs,
    s.rotOverSinceMs,
    s.exceeded,
    graceMs,
  );
  s.rotOverSinceMs = rotLatch.overBudgetSinceMs;

  // Record WHICH channel tripped first — the two have different remedies
  // ("stop sliding sideways" vs "stop turning"), and the guidance copy and
  // any future tuning both need to tell them apart.
  if (!s.exceeded) {
    if (latch.exceeded) s.latchedBy = 'drift';
    else if (rotLatch.exceeded) s.latchedBy = 'rotation';
  }
  s.exceeded = latch.exceeded || rotLatch.exceeded;
  s.overBudgetSinceMs = latch.overBudgetSinceMs;
  return s;
}
