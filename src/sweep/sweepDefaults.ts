// SPDX-License-Identifier: Apache-2.0
/**
 * sweepDefaults.ts — what `<Camera engine="sweep">` supplies when the host
 * supplies nothing.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────
 * `PanoPlusCaptureSurface` grew up inside one host — the the host app capture
 * shell — which passed it twenty-odd props off a field-flag store. Its own
 * prop defaults were therefore never the configuration anyone actually ran;
 * they were whatever was left when that host said nothing, which was nothing.
 *
 * Then pano+ moved into this package and `<Camera engine="sweep">` mounted
 * the surface with `{...sweep}` where `sweep` is usually `undefined`. Every
 * bare default fired at once, for the first time, on a device. The result,
 * measured on a Galaxy A35:
 *
 *   * `poseSource` defaulted to `'ar'` (surface prop default), so the
 *     recorder opened ARCore in shared-camera mode and latched the AR pose
 *     arm. The room was dim; ARCore reported PAUSED on all 175 frames with
 *     INSUFFICIENT_LIGHT on 115. The AR pose ring admits TRACKING poses
 *     only, so it stayed empty, and all 120 frames refused `buffer-empty`.
 *     tracking never reached 2, the engine's reference latch never latched,
 *     and the sweep painted NOTHING.
 *
 *     Meanwhile the IMU ring beside it held 858 rotation-vector samples at
 *     121.6 Hz, accuracy 3 on every one, with a derived basis and a passing
 *     clock gate. Re-running the join offline: all 120 frames solve, bracket
 *     gap ~8.2 ms against a 25 ms bound. The attitude was there the whole
 *     time and the arm could not reach it.
 *
 *   * every engine tuning option defaulted to its native value, which is the
 *     PRE-2026-09 engine: `crossTraj: 0` puts the elbow back.
 *
 * The first of those is now handled by `<Camera>` wiring `poseSource` to its
 * own `arPreference` (see the note below the table); what remains here is the
 * engine tuning, and it is not taste — it is the configuration that has
 * evidence behind it, and each entry names that evidence.
 *
 * ⚠ HOST OVERRIDES ALWAYS WIN. These are a floor, not a policy: the
 * delegation spreads the host's `sweep` prop AFTER them, and merges
 * `engineOptions` key-by-key rather than replacing the object (a whole-object
 * spread would silently drop every default the moment a host set one option).
 */
import type { PanoPlusEngineOptions } from './panoPlusTypes';

/**
 * The engine tuning the only configuration ever observed to paint well was
 * running. Read straight off a working pack's `meta.json config` block and
 * cross-checked against the reference host's own flag mapping.
 *
 * ⚠ THESE ARE NOT THE NATIVE DEFAULTS, AND THAT IS THE POINT. A pack taken
 * with the native defaults and one taken with these differ in the elbow —
 * the hinge at block/strip joins that trajectory continuation was added to
 * remove. Shipping the native defaults from a brand-new public API would
 * ship a fixed bug back to every consumer that says nothing.
 */
export const SWEEP_ENGINE_DEFAULTS: Readonly<PanoPlusEngineOptions> = Object.freeze({
  /** Trajectory continuation ON. `0` is the pre-fix engine and elbows at
   *  every block/strip join. */
  crossTraj: 2,
  /** The RELAX budget, in px. With continuation on and this at 0 the far end
   *  of a long sweep keeps stretching; 100 is where it stops. */
  crossTrajRelaxPx: 100,
  /** Continue from the frontier rather than from the band's end. Read only
   *  while `crossTraj` is on, which is why it moves with it. */
  leadOutFromFrontier: true,
  /** The image-space cross-scale fit (`2` is the geometric fallback). */
  crossFitMode: 1,
  /** Remove the DC term from that fit. Paired with `crossFitMode: 1`. */
  crossFitDcRemove: 1,
  /** The fit's per-strip leak. Paired with `crossFitMode: 1`. */
  crossScaleLeak: 0.005,
  /**
   * ⚠ OFF, AND DELIBERATELY NOT MATCHED TO THE OTHERS. This pads the PREVIEW
   * with the lead-out trajectory, and it made the preview jump size mid-sweep
   * — an operator-visible regression. The engine clamp fixed the jump; the
   * default stayed off because the preview is not the deliverable and a
   * surprising preview costs more than the padding buys.
   */
  leadOutTraj: false,
});

/**
 * ── WHY THERE IS NO `poseSource` DEFAULT HERE ANY MORE ──────────────────
 * There was one, and it returned `'imu'` on Android unconditionally, because
 * the AR arm could not degrade: ARCore failing to bootstrap cost the entire
 * sweep. That is fixed in the recorder now (a one-way degrade to the IMU
 * ring, triggered by ARCore's own verdict), so the arm no longer has to be
 * avoided — it has to be CHOSEN, by whoever is choosing AR for everything
 * else on the screen.
 *
 * `<Camera>` already owns that choice as `arPreference`, and the sweep
 * surface's AR pill writes back to it. A second, hidden default here would
 * mean the operator could toggle AR on and watch the sweep ignore it — the
 * same class of defect as the missing pills, one layer down.
 *
 * The engine tuning above stays, because nothing else in the system has an
 * opinion about `crossTraj`.
 */
