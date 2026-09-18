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

import type { CalibAxis, CalibExcitation, CalibLiveStatus } from './panoPlusCalibration';
import { CALIB_AXES, gestureCoaching } from './panoPlusCalibration';

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

// ════════════════════════════════════════════════════════════════════════
//  3.  THE OVERLAY'S OWN MODEL — the gesture, as the operator sees it
// ════════════════════════════════════════════════════════════════════════

/**
 * The phases the in-camera acquisition passes through.
 *
 * `refused` is a FIRST-CLASS phase and not an error toast. The solve refuses
 * for reasons the operator can act on — `ambiguous-axis` means "you only
 * panned", which is the single most likely outcome because a straight sweep is
 * the motion this whole app has trained him to perform. A refusal that vanished
 * would leave him repeating the motion that caused it.
 */
export type PanoPlusBasisGesturePhase =
  | 'arming'
  | 'recording'
  | 'solving'
  | 'refused'
  | 'saving'
  | 'acquired'
  | 'failed';

/** How much one named axis has turned, against the bar it must clear. */
export interface PanoPlusBasisAxisMeter {
  axis: CalibAxis;
  /** Upper-case, for a meter: `TILT` / `PAN` / `ROLL`. */
  label: string;
  /** The gesture word — what the hand actually does. */
  verb: string;
  deg: number;
  barDeg: number;
  /** 0..1, clamped — a bar cannot read past full. */
  fraction: number;
  done: boolean;
}

/**
 * The per-axis bar, mirroring `ExcitationPolicy::minAxisDeg` in
 * `rnis_pano_calib.hpp`.
 *
 * ⚠ IT IS A MIRROR, NOT THE GATE. The C++ decides; this only draws. If the two
 * ever disagree the C++ wins and this constant is the bug — the same relation
 * `basisIsPersistable` has to the native store's persist gate.
 */
export const PANO_PLUS_BASIS_AXIS_BAR_DEG = 25;

/**
 * How long a live recording may report ZERO reference frames before the screen
 * stops blaming the operator's hands and names the AR session instead.
 *
 * Carried over from `PanoCalibrationPanel`'s `NO_REF_WARN_S`. A session that is
 * genuinely up still takes a beat to produce its first `normal` pose, and the
 * coaching poll runs at 4 Hz — so without a grace the very first read of a
 * perfectly healthy gesture renders a hardware accusation.
 */
export const REFERENCE_GRACE_S = 3;

const AXIS_VERB: Record<CalibAxis, string> = {
  tilt: 'Nod it up and down',
  pan: 'Turn it left and right',
  roll: 'Twist it about the lens',
};

export interface PanoPlusBasisGestureView {
  tone: 'ok' | 'warn' | 'stop';
  /** Short, upper-case, readable while the phone is moving. */
  headline: string;
  /** One imperative sentence. Never a slug, never a stack of numbers. */
  coach: string;
  /** 0..1 — the LEAST-complete requirement, so the bar cannot read "nearly
   *  there" while an axis is untouched. */
  progress: number;
  axes: PanoPlusBasisAxisMeter[];
  /** The gesture has cleared its own bars — the solve is worth attempting. */
  sufficient: boolean;
  /**
   * TRUE ⇒ the reference is not arriving at all, so the meters are measuring
   * nothing and blaming the operator's hands would be wrong.
   */
  referenceMissing: boolean;
}

function axisMeters(e: CalibExcitation | null): PanoPlusBasisAxisMeter[] {
  return CALIB_AXES.map((axis) => {
    const deg = e?.perAxisDeg[axis] ?? 0;
    const done = e != null && !e.needMore[axis];
    return {
      axis,
      label: axis.toUpperCase(),
      verb: AXIS_VERB[axis],
      deg,
      barDeg: PANO_PLUS_BASIS_AXIS_BAR_DEG,
      fraction: Math.max(0, Math.min(1, deg / PANO_PLUS_BASIS_AXIS_BAR_DEG)),
      done,
    };
  });
}

/**
 * Everything the overlay renders, from the phase plus the live read.
 *
 * PURE, and for the same reason `panoPlusArmNotice` is: every interesting state
 * here is a device state that cannot be produced on this machine — a phone
 * mid-gesture, a solve that refused `ambiguous-axis`, an ARKit session that is
 * up but not tracking. The copy and the meter arithmetic are the only parts
 * that can be pinned by a test, so they live where a test can reach them.
 *
 * `refusal` is the reason string from `basisIsPersistable` (or the solve's own
 * `basis.reason`) — carried through verbatim rather than re-worded here, so the
 * screen and an offline harness are reading the same token.
 */
export function panoPlusBasisGestureView(
  phase: PanoPlusBasisGesturePhase,
  live: CalibLiveStatus | null,
  refusal: string | null = null,
): PanoPlusBasisGestureView {
  const axes = axisMeters(live);
  const progress = Math.max(0, Math.min(1, live?.progress ?? 0));
  const sufficient = live?.sufficient === true;
  // ZERO REFERENCE FRAMES WITH THE RECORDING LIVE is a different fault from a
  // still hand, and it has a different fix (the AR session, not the operator).
  // `refRejectedTracking` counts frames DROPPED for a non-normal pose, so a
  // session that is up but lost is visible here rather than looking identical
  // to one that never started.
  //
  // ⚠ NOT BEFORE {@link REFERENCE_GRACE_S}. A healthy ARKit session takes a
  // moment to deliver its first `normal` frame, and the first coaching poll
  // lands 250 ms in — so an un-graced test would flash "the AR camera is not
  // feeding this" at every operator who did nothing wrong, on the one screen
  // whose whole job is telling him what IS wrong. `PanoCalibrationPanel` used
  // 3 s for exactly this and the number is carried over rather than re-picked.
  const referenceMissing =
    phase === 'recording'
    && (live?.refSamples ?? 0) === 0
    && (live?.elapsedS ?? 0) >= REFERENCE_GRACE_S;

  switch (phase) {
    case 'arming':
      return {
        tone: 'warn',
        headline: 'ONE-TIME SETUP FOR THIS PHONE',
        coach:
          'Bringing the reference camera up. Hold the phone as if you were about '
          + 'to sweep a shelf.',
        progress: 0,
        axes,
        sufficient: false,
        referenceMissing: false,
      };

    case 'recording': {
      if (referenceMissing) {
        return {
          tone: 'stop',
          headline: 'NO REFERENCE YET',
          coach:
            'The AR camera is not feeding this measurement, so nothing is being '
            + 'recorded. Point the phone at a lit, textured surface and give it a '
            + 'moment to find its footing.',
          progress: 0,
          axes,
          sufficient: false,
          referenceMissing: true,
        };
      }
      if (sufficient) {
        return {
          tone: 'ok',
          headline: 'THAT IS ENOUGH — SOLVING',
          coach:
            `Turned ${Math.round(live?.sweptDeg ?? 0)}° across `
            + `${live?.exercisedAxes ?? 0} axes. Hold still for a second.`,
          progress: 1,
          axes,
          sufficient: true,
          referenceMissing: false,
        };
      }
      return {
        tone: 'warn',
        headline: 'MOVE IT ON MORE THAN ONE AXIS',
        // ⚠ THE COACHING COMES FROM THE C++ VERDICT, NOT FROM THIS FILE. The
        // reason strings are produced by `gradeExcitation` and a second phrasing
        // here would be a second policy — the thing that drifts silently.
        coach:
          gestureCoaching(live)
          ?? 'Keep going — tilt, pan and twist, not a straight sweep.',
        progress,
        axes,
        sufficient: false,
        referenceMissing: false,
      };
    }

    case 'solving':
      return {
        tone: 'warn',
        headline: 'SOLVING',
        coach: 'Working out which of the 24 mountings matches what you just did.',
        progress: 1,
        axes,
        sufficient: true,
        referenceMissing: false,
      };

    case 'refused':
      return {
        tone: 'stop',
        headline: 'NOT GOOD ENOUGH — GO AGAIN',
        coach: basisRefusalCoaching(refusal),
        progress: 0,
        axes,
        sufficient: false,
        referenceMissing: false,
      };

    case 'saving':
      return {
        tone: 'ok',
        headline: 'SAVING',
        coach: 'Writing it to this phone. It will not be asked for again.',
        progress: 1,
        axes,
        sufficient: true,
        referenceMissing: false,
      };

    case 'acquired':
      return {
        tone: 'ok',
        headline: 'DONE',
        coach: 'Saved for this phone model. Carry on.',
        progress: 1,
        axes,
        sufficient: true,
        referenceMissing: false,
      };

    case 'failed':
    default:
      return {
        tone: 'stop',
        headline: 'COULD NOT MEASURE IT',
        coach:
          (refusal ?? 'The measurement could not run on this device.')
          + ' The sweep will run on ARKit instead, which needs no basis.',
        progress: 0,
        axes,
        sufficient: false,
        referenceMissing: false,
      };
  }
}

/**
 * Plain words for a refusal, and the MOTION that fixes it.
 *
 * ⚠ NEVER PRESENT A REFUSAL AS A MEASUREMENT. Each of these is a state in which
 * the solve declined to name an index, and the operator's next move differs by
 * case — `ambiguous-axis` is fixed by tilting, `winner-changed` by more
 * off-axis motion, `too-few-pairs` by recording for longer. A single "try
 * again" would leave him repeating whatever he did the first time.
 */
export function basisRefusalCoaching(refusal: string | null): string {
  switch (refusal) {
    case 'ambiguous-axis':
      return 'You panned in a straight line, and a straight pan leaves FOUR '
        + 'mountings matching exactly — the answer would be picked by list '
        + 'order, not by your phone. Nod it up and down as well.';
    case 'excitation-insufficient':
      return 'The motion did not turn far enough on a second axis. Bigger '
        + 'movements: a nod and a twist, each clearly its own direction.';
    case 'stationary':
      return 'The phone barely rotated, so every mounting fits equally well. '
        + 'Pick it up and turn it.';
    case 'too-few-pairs':
    case 'too-few-samples':
      return 'Too short to fit anything. Keep moving for a few seconds longer.';
    case 'rms-too-large':
      return 'The best match still misses by more than 2°, so either the '
        + 'mounting is not one of the 24 or a sensor is not reporting what it '
        + 'claims. Try once more, slower and smoother.';
    case 'winner-changed':
    case 'not-unique-at-some-offset':
      return 'The answer moved when the clock was nudged by ±10 ms, so it was '
        + 'picked by the timing rather than by the geometry. More off-axis '
        + 'motion — tilt and twist, not a straighter pan.';
    case 'stability-not-run':
      return 'The stability check did not run, so the answer cannot be trusted '
        + 'yet. Record the gesture again.';
    case null:
      return 'The measurement did not pass its own gate. Record the gesture '
        + 'again, on more than one axis.';
    default:
      return `The measurement did not pass its own gate (${refusal}). Record it `
        + 'again, turning on more than one axis.';
  }
}
