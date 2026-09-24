// SPDX-License-Identifier: Apache-2.0
/**
 * panoPlusBasisAcquisition — WHERE THE BASIS `C` COMES FROM, AND IN WHAT ORDER.
 *
 * The decoupled pano+ arm refuses to align a frame without a validated basis,
 * and until now the only way to obtain one was a panel the operator had to know
 * existed, find in a gear menu, and drive through two stages. The operator's
 * 2026-09-01 decision replaced that with a rule: *derive if possible, else guide
 * the gesture on the camera screen before the first sweep, then persist forever*
 * — and, on the separate entry point, *"if this is needed, it should come up
 * automatically … and if it is not needed, it is not needed anyway"*.
 *
 * This module is the RULE, pure and testable. It decides nothing about pixels
 * and touches no native module; it answers ONE question — which of the five
 * routes this device is on — so the surface can act on a route rather than
 * re-deriving a ladder in JSX.
 *
 * ── THE LADDER, AND WHY IT IS IN THIS ORDER ──────────────────────────────
 *
 *   1. STORED    — a basis persisted for THIS device model. `C` is a property
 *                  of how the sensor is bolted into the chassis, so the store
 *                  keys it by model alone (`RNISPanoCalibStore.basisKey()`).
 *                  "Persist forever" means exactly this: measured once per
 *                  phone model, never asked again.
 *   2. DERIVED   — the platform can compute it analytically. Android can:
 *                  it documents its sensor frame and `SENSOR_ORIENTATION` pins
 *                  the camera raster, so `rnis::pano::android::deriveBasis()`
 *                  returns the index from two documented rotations. No gesture,
 *                  and the provenance is `derived` — NEVER `measured`.
 *   3. GESTURE   — the guided in-camera acquisition. This is iOS, and it is
 *                  iOS because CoreMotion's frame versus the camera frame is
 *                  NOT documented anywhere by Apple. That undocumented seam is
 *                  the whole reason basis #8 had to be MEASURED on hardware
 *                  (0.234° over 777 pairs) instead of looked up.
 *   4. BLOCKED   — no route at all: the binary carries no calibration module,
 *                  or the hardware publishes no lens the arm could use. A
 *                  gesture cannot fix either, so offering one would send the
 *                  operator to do work that cannot help him.
 *   0. NOT-ASKED — the question was never PUT. Numbered zero because it is not
 *                  a rung of the ladder at all: it is the answer for a caller
 *                  that has not run the build probe, and it short-circuits
 *                  above STORED because every other input is un-sourced there.
 *                  It exists because "nobody asked" and "asked, and this binary
 *                  has no calibration module" were the same answer until
 *                  2026-09-03, and a null `plan` is produced by both. On the
 *                  iOS ARKit arm the surface's precondition read early-returns
 *                  (that arm consumes no `C`), so `plan` stays null for the
 *                  life of the mount and this module reported
 *                  `no-calibration-module` — "This binary carries no
 *                  calibration module" — about a build carrying the pod
 *                  perfectly well. `needsGesture` was false either way, so no
 *                  gate ever moved; the cost is a diagnostic that sends its
 *                  reader to rebuild the wrong artefact, which is the expensive
 *                  kind of wrong. The two states need different sentences for
 *                  the same reason this file already splits the BUILD question
 *                  from the HARDWARE one.
 *
 * ── WHAT THIS MODULE MUST NEVER DO ──────────────────────────────────────
 *
 * It must never return `provenance: 'measured'` for a route that measured
 * nothing. `rnis_pano_android_basis.hpp` argues this at length for the derived
 * case and the argument is not platform-specific: a pack stamped `measured`
 * gives a reader no way to find out that a mounting assumption was wrong, while
 * one stamped `derived` tells them exactly which claim to go and check. The
 * three words here are the same three the pack uses, and they are produced from
 * the ROUTE rather than asserted beside it.
 */

// ════════════════════════════════════════════════════════════════════════
//  1.  THE PLATFORM CAPABILITY — can this OS derive `C` at all?
// ════════════════════════════════════════════════════════════════════════

export interface PanoPlusBasisCapability {
  /** TRUE ⇒ the platform resolves `C` from its own documented frames. */
  canDerive: boolean;
  /** Stable, greppable: `documented-sensor-frame` | `undocumented-imu-frame` |
   *  `unknown-platform`. */
  reason: string;
  /** One sentence an operator (or a pack reader) can act on. */
  detail: string;
}

/**
 * THE ASYMMETRY, stated once, as data.
 *
 * ⚠ THIS IS A CLAIM ABOUT THE PLATFORM, NOT ABOUT THE BUILD. `canDerive` says
 * the operating system publishes enough to compute `C`; it does NOT say this
 * binary has the module that does it. The build question is asked separately
 * (the `plan` argument to {@link resolvePanoPlusBasis}), because "Android, so
 * it derives" and "Android, but this .so did not link" lead to different
 * screens and the two must not merge.
 *
 * An unrecognised OS answers NO. The conservative answer is the only honest
 * one: a platform we have not read the sensor documentation for is a platform
 * whose derivation would be a guess, and a guessed `C` rotates the whole canvas
 * by one of 24 permutations with nothing in the pixels to contradict it.
 */
export function panoPlusBasisCapability(os: string): PanoPlusBasisCapability {
  if (os === 'android') {
    return {
      canDerive: true,
      reason: 'documented-sensor-frame',
      detail:
        'Android documents its sensor coordinate frame and SENSOR_ORIENTATION '
        + 'pins the camera raster to it, so C is the product of two documented '
        + 'rotations. deriveBasis() returns it analytically — no gesture, and '
        + 'the pack says `derived`, never `measured`.',
    };
  }
  if (os === 'ios') {
    return {
      canDerive: false,
      reason: 'undocumented-imu-frame',
      detail:
        "Apple does not document CoreMotion's attitude frame relative to the "
        + 'camera raster, so there is no arithmetic that yields C on iOS. That '
        + 'undocumented seam is why basis #8 had to be MEASURED against a live '
        + 'ARKit reference rather than looked up, and it is why this platform '
        + 'gets the guided gesture.',
    };
  }
  return {
    canDerive: false,
    reason: 'unknown-platform',
    detail:
      `No sensor-frame documentation has been read for "${os}", so a derivation `
      + 'here would be a guess. The gesture measures it instead.',
  };
}

// ════════════════════════════════════════════════════════════════════════
//  2.  THE RESOLUTION
// ════════════════════════════════════════════════════════════════════════

export type PanoPlusBasisRoute =
  'stored' | 'derived' | 'gesture' | 'blocked' | 'not-asked';

/** The pack's own three words. Produced from the ROUTE, never asserted. */
export type PanoPlusBasisProvenance = 'measured' | 'derived' | 'none';

export interface PanoPlusBasisResolutionInput {
  capability: PanoPlusBasisCapability;
  /**
   * The HARDWARE answer — `plannedCaptureFormat()`. `null` or a
   * `calib-unavailable` reason means this BINARY cannot answer, which is a
   * build fact and not a device one.
   */
  plan: { ok: boolean; reason: string | null; detail: string | null } | null;
  /** The persisted index for this device model, or null. */
  basisIndex: number | null;
  basisLabel: string | null;
  /**
   * The operator has said "not now" for this session.
   *
   * ⚠ IT DOES NOT PERSIST AND IT MUST NOT. Declining is an answer about this
   * capture, not about this phone; writing it to disk would turn one impatient
   * tap into a permanently un-offered calibration, and the operator would have
   * no affordance to get the offer back.
   */
  gestureDeclined?: boolean;
  /**
   * THE BUILD PROBE ACTUALLY RAN. Default `true` — every existing caller passes
   * a `plan` it went and fetched, and a defaulted-false would turn all of them
   * into `not-asked` overnight.
   *
   * Pass `false` when `plan` is null because NOBODY LOOKED, not because the
   * look came back empty. The only caller that does is the surface on the iOS
   * ARKit arm, where the precondition read early-returns by design — see the
   * NOT-ASKED note in this file's header for what it was reporting instead.
   * Android always passes `true`: its plan is synthesized from a mount-time
   * availability fact, so it is genuinely known on both arms.
   */
  planRead?: boolean;
}

export interface PanoPlusBasisResolution {
  route: PanoPlusBasisRoute;
  /** The ONLY field the surface gates the overlay on. */
  needsGesture: boolean;
  basisIndex: number | null;
  basisLabel: string | null;
  provenance: PanoPlusBasisProvenance;
  /**
   * Stable slug, greppable by an offline harness:
   * `stored` | `derived-by-platform` | `gesture-required` | `gesture-declined` |
   * `no-calibration-module` | `hardware-refused`
   */
  reason: string;
  /** The sentence a screen renders. Never a bare slug. */
  detail: string;
}

/**
 * Walk the ladder. Pure and total.
 *
 * ⚠ THE STORE IS CONSULTED FIRST EVEN WHERE THE PLATFORM CAN DERIVE, and that
 * order is deliberate rather than incidental. `rnis_pano_android_basis.hpp`'s
 * FALSIFICATION section says the derivation is a HYPOTHESIS about the sensor
 * mounting and a `selectBasis()` measurement against a concurrent reference log
 * is EVIDENCE; when the two disagree the measurement is right by definition of
 * what each one is. The Android recorder's own authority ladder
 * (`panoResolveBasisAuthority`) already ranks them that way, and inverting the
 * order here would let a derivation overwrite the falsification that was run to
 * check it.
 */
export function resolvePanoPlusBasis(
  i: PanoPlusBasisResolutionInput,
): PanoPlusBasisResolution {
  // ── THE QUESTION WAS NEVER PUT ──────────────────────────────────────────
  // Above STORED deliberately: with no probe run there is no `plan`, and there
  // is no `basisIndex` either — the store read is the same read — so every
  // rung below would be answering from inputs nobody sourced. Reporting the
  // ABSENCE of an answer is the only honest thing available, and it is a
  // different sentence from "asked, and the module is missing".
  if (i.planRead === false) {
    return {
      route: 'not-asked',
      // The whole point of the rung: it must not move the gate. An arm that
      // does not consume `C` is the operator's own "if it is not needed, it is
      // not needed anyway", and this is that clause spelled as data.
      needsGesture: false,
      basisIndex: null,
      basisLabel: null,
      provenance: 'none',
      reason: 'arm-does-not-consume-c',
      detail:
        'No basis was looked up: the selected arm takes its pose from the '
        + 'camera frame already, so there is nothing for C to map. This says '
        + 'nothing about what is on file for this phone — the store has not '
        + 'been read.',
    };
  }

  if (i.basisIndex != null && i.basisIndex >= 0) {
    return {
      route: 'stored',
      needsGesture: false,
      basisIndex: i.basisIndex,
      basisLabel: i.basisLabel,
      provenance: 'measured',
      reason: 'stored',
      detail:
        `C #${i.basisIndex}${i.basisLabel != null ? ` ${i.basisLabel}` : ''} is on `
        + 'file for this phone model. The basis is a property of how the sensor '
        + 'is bolted into the chassis, so it is measured once per model and '
        + 'never asked for again.',
    };
  }

  // THE BUILD, BEFORE THE PLATFORM. A binary with no calibration module cannot
  // derive OR record a gesture, and the fault is a missing pod install rather
  // than anything about the phone in the operator's hand.
  if (i.plan == null || i.plan.reason === 'calib-unavailable') {
    return {
      route: 'blocked',
      needsGesture: false,
      basisIndex: null,
      basisLabel: null,
      provenance: 'none',
      reason: 'no-calibration-module',
      detail:
        'This binary carries no calibration module, so neither a derivation nor '
        + 'a gesture can run. That is an app-build fact — nothing on this phone '
        + 'can change it.',
    };
  }

  if (i.capability.canDerive) {
    return {
      route: 'derived',
      needsGesture: false,
      basisIndex: null,
      basisLabel: null,
      // NEVER `measured`. Nothing on this device was measured against anything;
      // two documented frames were multiplied together.
      provenance: 'derived',
      reason: 'derived-by-platform',
      detail: i.capability.detail,
    };
  }

  // THE HARDWARE, ASKED ONLY ON THE GESTURE BRANCH. A phone that publishes no
  // lens the arm can open has nothing for a gesture to calibrate, and telling
  // the operator to perform one would be work that cannot fix the fault.
  if (!i.plan.ok) {
    return {
      route: 'blocked',
      needsGesture: false,
      basisIndex: null,
      basisLabel: null,
      provenance: 'none',
      reason: 'hardware-refused',
      detail:
        (i.plan.detail
          ?? 'The lens or format the decoupled arm needs is not published by this '
            + 'device.')
        + ' A calibration cannot change that, so no gesture is offered.',
    };
  }

  if (i.gestureDeclined === true) {
    return {
      route: 'blocked',
      needsGesture: false,
      basisIndex: null,
      basisLabel: null,
      provenance: 'none',
      reason: 'gesture-declined',
      detail:
        'The basis measurement was declined for this capture, so the sweep runs '
        + 'on ARKit. Leave and re-enter pano+ to be offered it again — the '
        + 'decline is not remembered.',
    };
  }

  return {
    route: 'gesture',
    needsGesture: true,
    basisIndex: null,
    basisLabel: null,
    provenance: 'none',
    reason: 'gesture-required',
    detail: i.capability.detail,
  };
}
