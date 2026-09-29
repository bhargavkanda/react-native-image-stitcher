// SPDX-License-Identifier: Apache-2.0
//
// panoPlusCalibration — the JS shell over the pano+ CALIBRATION step.
//
// ── Why this file exists at all ──────────────────────────────────────────
//
// `rnis_pano_attitude` REFUSES to align a frame without two measured numbers:
// τ (the PTS↔IMU offset) and the basis index `C` (device→camera). It is right
// to refuse. But nothing in the programme produced either number on hardware,
// so the decoupled arm was not merely off — it was UNREACHABLE, and a refusal
// was the only observable it could ever produce. This is the shell over the
// step that earns both.
//
// ── THE TWO GATES, AND WHY NEITHER IS THE OBVIOUS ONE ────────────────────
//
//  τ  is graded on its UNCERTAINTY, never on |τ|. The study's 3.08 ms p95 is
//     the budget for the alignment error that SURVIVES the correction — and
//     the whole point of measuring τ is to remove the offset. Grading the
//     magnitude of τ against that budget grades the disease against the
//     tolerance for the cure. A −11 ms offset repeatable to ±0.1 ms is an
//     EXCELLENT calibration; a +0.9 ms one recovered from runs that disagree
//     by 6 ms is not a calibration at all. So: three repeats minimum, and the
//     standard error is the gate.
//
//  C  is graded on the GESTURE first and the fit second. The prototype run
//     proved a pure pan cannot identify `C`: a one-axis log leaves an EXACT
//     4-way tie (margin 9.86e-15 deg) and the tie-break silently returned the
//     wrong candidate. That is a theorem, not a numerical accident — the
//     rotations about a single axis have a centraliser containing the
//     quarter-turns about that axis, which are signed permutations. So the
//     calibration gesture is DELIBERATELY OFF-AXIS, it is coached per named
//     axis, and an insufficient gesture is REPORTED as insufficient with the
//     axis named. The operator is never silently fitted.
//
// ── Where the arithmetic lives ───────────────────────────────────────────
//
// In C++ (`cpp/rnis_pano_calib.{hpp,cpp}`), host-tested, called from both
// platforms. NOT here. A bar decided in TypeScript is a bar Android re-invents,
// and the two would disagree in the one place nobody looks — the gate that
// decides whether a number is good enough to keep. This file parses, types and
// phrases; it decides nothing.

import { NativeModules, Platform } from 'react-native';

// ⚠ DECLARED HERE, NOT IMPORTED FROM THE HOST SDK, and the two cases differ.
//
// `SweepVerdict`/`SweepVerdictTone` are a FIELD-IDENTICAL re-declaration of
// the host's own probe-verdict pair. That matters: five exported functions
// below return this type and a host panel consumes them by name, so
// structural compatibility is the contract. `sweepVerdictParity` in the tests
// asserts the shapes still match — if the host widens its version, that test
// is what says so.
//
// `TauRunInput` is NOT a re-declaration. The host's clock-probe result is a
// 51-field interface and this reads FOUR of them, so the narrow input is the
// honest signature — a caller cannot smuggle a magnitude verdict in, which
// the paragraph above `combineTauRuns` already promised and the wide type
// never enforced.
export type SweepVerdictTone = 'yes' | 'no' | 'unknown';

export interface SweepVerdict {
  tone: SweepVerdictTone;
  /** The headline. Short enough to survive a phone width. */
  headline: string;
  /** One sentence of what it means for the decision behind the probe. */
  detail: string;
}

/**
 * The four fields of a capture-clock run that a tau fit actually reads.
 *
 * ⚠ `resolved` is `boolean | null`, not `boolean | undefined`. A narrow
 * re-declaration is only useful if it ACCEPTS what real callers hold, and a
 * clock probe reports three states — resolved, refused, and not yet run —
 * with `null` for the third. Tightening it to `undefined` made every real
 * call site a type error, which is how this was caught.
 */
export interface TauRunInput {
  resolved?: boolean | null;
  tauMs: number | null;
  tauPeakR: number | null;
  tauBandWidthMs: number | null;
}

// ════════════════════════════════════════════════════════════════════════
//  Types
// ════════════════════════════════════════════════════════════════════════

/** The three named axes of the reference (ARKit camera) frame. */
export type CalibAxis = 'tilt' | 'pan' | 'roll';

/** The RN module name declared by `RCT_EXTERN_MODULE(RNSSweepCalibration, …)`. */
const CALIB_MODULE_NAME = 'RNSSweepCalibration';

export const CALIB_AXES: readonly CalibAxis[] = ['tilt', 'pan', 'roll'];

/**
 * How much the gesture has turned, and about what.
 *
 * ⚠ `perAxisDeg` / `needMore` are read off the REFERENCE (ARKit) series ONLY.
 * Naming the IMU series' axes would be naming the very thing `C` has not been
 * solved for. `rank2` / `rank3` ARE frame-invariant and are comparable between
 * the two.
 */
export interface CalibExcitation {
  ok: boolean;
  steps: number | null;
  /** Increments dropped under the 0.02°/step noise floor. */
  stepsBelowFloor: number | null;
  minStepDeg: number | null;
  sweptDeg: number | null;
  spanDeg: number | null;
  perAxisDeg: Record<CalibAxis, number | null>;
  /** Eigenvalues of the angle-weighted axis scatter, descending, deg². */
  eig: Array<number | null>;
  /** √(λ₂/λ₁) — the second axis' amplitude. The 4-way tie lives at 0 exactly. */
  rank2: number | null;
  rank3: number | null;
  sufficient: boolean;
  /**
   * "ok" | "too-few-samples" | "stationary" | "single-axis" |
   * "axes-too-close" | "not-enough-turning"
   */
  reason: string | null;
  needMore: Record<CalibAxis, boolean>;
  exercisedAxes: number | null;
  /** 0..1, the LEAST-complete requirement — never "nearly there" with an axis untouched. */
  progress: number | null;
}

/** The live coaching read while the gesture is being performed. */
export interface CalibLiveStatus extends CalibExcitation {
  recording: boolean;
  autoStopped: boolean;
  imuSamples: number | null;
  refSamples: number | null;
  /** ARKit frames DROPPED because tracking was not `normal`. Never used silently. */
  refRejectedTracking: number | null;
  truncated: boolean;
  elapsedS: number | null;
  maxDurationS: number | null;
  refSpanS: number | null;
}

export interface CalibBasisFit {
  index: number | null;
  label: string | null;
  pairs: number | null;
  rmsDeg: number | null;
  maxDeg: number | null;
  finalDeg: number | null;
  driftDegPerS: number | null;
  rmsDetrendedDeg: number | null;
}

/**
 * The gyro-bias term that can veto the WHOLE architecture — kept separate from
 * the basis decision on purpose.
 *
 * ⚠ IT IS NOT A PERSIST GATE. The basis is a discrete choice among 24 signed
 * permutations; a drifting gyro does not make a different permutation correct.
 * Refusing to keep a correct `C` because the drift is large would throw away a
 * measurement that is exactly right and send the operator to redo a gesture
 * that cannot fix it.
 */
export interface CalibDrift {
  measured: boolean;
  degPerS: number | null;
  canvasPxOverSweep: number | null;
  sweepSeconds: number | null;
  canvasPxPerDeg: number | null;
  budgetPx: number | null;
  withinBudget: boolean;
  rmsDetrendedDeg: number | null;
  /**
   * TRUE always. The slope is fitted to |residual|, a MAGNITUDE, so zero-mean
   * noise still produces a positive slope: read `degPerS` as an upper-ish
   * bound, not an unbiased estimate.
   */
  biasedHigh: boolean;
}

export interface CalibStability {
  ok: boolean;
  reason: string | null;
  winnerStable: boolean;
  winnerIndex: number | null;
  triedOffsets: number | null;
  agreeingOffsets: number | null;
  minMarginDeg: number | null;
  offsetsS: Array<number | null>;
}

export interface CalibBasisSolve {
  ran: boolean;
  tauUsedS: number | null;
  imuSamples: number | null;
  refSamples: number | null;
  refRejectedTracking: number | null;
  truncated: boolean;
  durationS: number | null;
  deliveredImuHz: number | null;
  autoStopped: boolean;

  excitationRef: CalibExcitation | null;
  excitationImu: CalibExcitation | null;

  selection: {
    refusal: string | null;
    unique: boolean;
    marginDeg: number | null;
    candidates: number | null;
    ranked: CalibBasisFit[];
  } | null;

  /** `ok` is the ONLY field a caller may act on. */
  basis: {
    ok: boolean;
    reason: string | null;
    index: number | null;
    label: string | null;
    pairs: number | null;
    rmsDeg: number | null;
    maxDeg: number | null;
    marginDeg: number | null;
    unique: boolean;
    runnerUpIndex: number | null;
    runnerUpLabel: string | null;
    runnerUpRmsDeg: number | null;
  } | null;

  drift: CalibDrift | null;
  stability: CalibStability | null;
}

/** τ combined across repeats, with the uncertainty that decides whether it keeps. */
export interface CalibTauFit {
  ok: boolean;
  /**
   * "ok" | "no-runs" | "too-few-resolved-runs" | "weak-peak" |
   * "spread-too-wide" | "std-err-too-wide"
   */
  reason: string | null;
  runs: number | null;
  resolvedRuns: number | null;
  /** THE NUMBER, milliseconds — the median of the resolved runs. */
  tauMs: number | null;
  tauS: number | null;
  meanMs: number | null;
  sdMs: number | null;
  spreadMs: number | null;
  /** sd/√n — the uncertainty ON the persisted number. THIS is what the budget grades. */
  stdErrMs: number | null;
  worstPeakR: number | null;
  maxBandWidthMs: number | null;
  budgetMs: number | null;
  budgetFractionUsed: number | null;
  /** With n = 3 the SD is itself uncertain to roughly ±40 %. Say so; do not hide it. */
  smallSample: boolean;
  tauSign: string | null;
}

export interface CalibSnapshot {
  deviceModel: string | null;
  tauKey: string | null;
  basisKey: string | null;
  haveTau: boolean;
  haveBasis: boolean;
  complete: boolean;
  /** "tau" | "basis" | "tau+basis" | null */
  missing: string | null;
  tauS: number | null;
  tauStdErrMs: number | null;
  tauMeasuredAt: string | null;
  basisIndex: number | null;
  basisLabel: string | null;
  basisMeasuredAt: string | null;
  path: string | null;
  storedTauKeys: string[];
  storedBasisKeys: string[];
}

// ════════════════════════════════════════════════════════════════════════
//  THE GESTURE SCRIPT — what the operator is actually asked to do
// ════════════════════════════════════════════════════════════════════════

export interface CalibGestureStep {
  axis: CalibAxis;
  /** Imperative, second person, no jargon. This is read while moving. */
  title: string;
  /** One sentence of what the phone should physically do. */
  how: string;
  /** Why THIS motion, in one line — an operator who knows why does it better. */
  why: string;
  /** Roughly how long, seconds. The bar is the METER, not the clock. */
  seconds: number;
}

/**
 * THE CALIBRATION GESTURE.
 *
 * Three segments, one per axis, ~4 s each — and the ORDER matters. Pan first
 * because it is the motion the operator already performs for a sweep and it
 * gets him moving; tilt second because it is the axis that BREAKS the
 * degeneracy and the meter will show it doing so; roll last because it is the
 * least natural and is a bonus rather than a requirement (two independent axes
 * are mathematically sufficient).
 *
 * ⚠ A CAREFUL STRAIGHT SWEEP IS THE WORST POSSIBLE CALIBRATION CAPTURE, which
 * is the exact opposite of the instinct an operator has been trained into by
 * every other capture in this app. That sentence is on the panel, first, in
 * full — because the failure it prevents does not look like a failure: it looks
 * like a confident basis index that is wrong.
 */
export const CALIB_GESTURE: readonly CalibGestureStep[] = [
  {
    axis: 'pan',
    title: 'Turn left and right',
    how: 'Hold the phone up as if sweeping a shelf and swing it left–right '
      + 'through about 60°, twice.',
    why: 'Gets the gesture moving on the axis a sweep uses — but on its own '
      + 'this axis CANNOT identify the basis.',
    seconds: 4,
  },
  {
    axis: 'tilt',
    title: 'Now nod it up and down',
    how: 'Keep pointing at the same spot and tip the top of the phone toward '
      + 'you and away, through about 45°, twice.',
    why: 'THIS is the segment that breaks the tie. A pan-only log leaves four '
      + 'candidates matching EXACTLY, and the answer would be picked by '
      + 'enumeration order.',
    seconds: 4,
  },
  {
    axis: 'roll',
    title: 'Finally, twist it',
    how: 'Rotate the phone about the lens, like turning a steering wheel, '
      + 'through about 45° each way.',
    why: 'Not required — two axes are enough — but it is free margin, and it '
      + 'is the one axis the τ measurement is blind to.',
    seconds: 4,
  },
];

/** Human sentence for what is still missing, or null when nothing is. */
export function gestureCoaching(e: CalibExcitation | null): string | null {
  if (e == null) return 'Start the recording and begin moving the phone.';
  if (e.sufficient) return null;
  switch (e.reason) {
    case 'too-few-samples':
      return 'No motion recorded yet — is the AR camera mounted and tracking?';
    case 'stationary':
      return 'The phone has barely moved. Pick it up and start turning it.';
    case 'not-enough-turning':
      return 'Keep going — more of everything. The total turning is still short.';
    case 'single-axis': {
      const missing = CALIB_AXES.filter((a) => e.needMore[a]);
      if (missing.length === 0) return 'Keep going.';
      const names: Record<CalibAxis, string> = {
        tilt: 'NOD it up and down',
        pan: 'TURN it left and right',
        roll: 'TWIST it about the lens',
      };
      return `Only one axis so far. Now ${names[missing[0]]} — a pan alone `
        + 'leaves four candidates matching exactly.';
    }
    case 'axes-too-close':
      return 'The two motions are too close to the same axis. Make the second '
        + 'one bigger and clearly separate from the first.';
    default:
      return 'Keep moving the phone on more than one axis.';
  }
}

// ════════════════════════════════════════════════════════════════════════
//  Parsing
// ════════════════════════════════════════════════════════════════════════

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function boolOf(v: unknown): boolean {
  return v === true;
}
function obj(v: unknown): Record<string, unknown> | null {
  return v != null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function axisNums(v: unknown): Record<CalibAxis, number | null> {
  const r = obj(v);
  return {
    tilt: num(r?.['tilt']),
    pan: num(r?.['pan']),
    roll: num(r?.['roll']),
  };
}

function axisBools(v: unknown): Record<CalibAxis, boolean> {
  const r = obj(v);
  // DEFAULT TRUE. "We have not seen enough of this axis" is the safe default;
  // defaulting to false would render a green meter for an axis nobody measured.
  return {
    tilt: r?.['tilt'] !== false,
    pan: r?.['pan'] !== false,
    roll: r?.['roll'] !== false,
  };
}

export function parseExcitation(v: unknown): CalibExcitation {
  const r = obj(v) ?? {};
  const eig = Array.isArray(r['eig']) ? (r['eig'] as unknown[]).map(num) : [];
  return {
    ok: boolOf(r['ok']),
    steps: num(r['steps']),
    stepsBelowFloor: num(r['stepsBelowFloor']),
    minStepDeg: num(r['minStepDeg']),
    sweptDeg: num(r['sweptDeg']),
    spanDeg: num(r['spanDeg']),
    perAxisDeg: axisNums(r['perAxisDeg']),
    eig,
    rank2: num(r['rank2']),
    rank3: num(r['rank3']),
    sufficient: boolOf(r['sufficient']),
    reason: str(r['reason']),
    needMore: axisBools(r['needMore']),
    exercisedAxes: num(r['exercisedAxes']),
    progress: num(r['progress']),
  };
}

export function parseLiveStatus(v: unknown): CalibLiveStatus {
  const r = obj(v) ?? {};
  return {
    ...parseExcitation(v),
    recording: boolOf(r['recording']),
    autoStopped: boolOf(r['autoStopped']),
    imuSamples: num(r['imuSamples']),
    refSamples: num(r['refSamples']),
    refRejectedTracking: num(r['refRejectedTracking']),
    truncated: boolOf(r['truncated']),
    elapsedS: num(r['elapsedS']),
    maxDurationS: num(r['maxDurationS']),
    refSpanS: num(r['refSpanS']),
  };
}

function parseFit(v: unknown): CalibBasisFit {
  const r = obj(v) ?? {};
  return {
    index: num(r['index']),
    label: str(r['label']),
    pairs: num(r['pairs']),
    rmsDeg: num(r['rmsDeg']),
    maxDeg: num(r['maxDeg']),
    finalDeg: num(r['finalDeg']),
    driftDegPerS: num(r['driftDegPerS']),
    rmsDetrendedDeg: num(r['rmsDetrendedDeg']),
  };
}

export function parseBasisSolve(v: unknown): CalibBasisSolve {
  const r = obj(v) ?? {};
  const sel = obj(r['selection']);
  const b = obj(r['basis']);
  const d = obj(r['drift']);
  const st = obj(r['stability']);
  return {
    ran: boolOf(r['ran']),
    tauUsedS: num(r['tauUsedS']),
    imuSamples: num(r['imuSamples']),
    refSamples: num(r['refSamples']),
    refRejectedTracking: num(r['refRejectedTracking']),
    truncated: boolOf(r['truncated']),
    durationS: num(r['durationS']),
    deliveredImuHz: num(r['deliveredImuHz']),
    autoStopped: boolOf(r['autoStopped']),
    excitationRef: r['excitationRef'] != null ? parseExcitation(r['excitationRef']) : null,
    excitationImu: r['excitationImu'] != null ? parseExcitation(r['excitationImu']) : null,
    selection: sel == null ? null : {
      refusal: str(sel['refusal']),
      unique: boolOf(sel['unique']),
      marginDeg: num(sel['marginDeg']),
      candidates: num(sel['candidates']),
      ranked: Array.isArray(sel['ranked'])
        ? (sel['ranked'] as unknown[]).map(parseFit) : [],
    },
    basis: b == null ? null : {
      ok: boolOf(b['ok']),
      reason: str(b['reason']),
      index: num(b['index']),
      label: str(b['label']),
      pairs: num(b['pairs']),
      rmsDeg: num(b['rmsDeg']),
      maxDeg: num(b['maxDeg']),
      marginDeg: num(b['marginDeg']),
      unique: boolOf(b['unique']),
      runnerUpIndex: num(b['runnerUpIndex']),
      runnerUpLabel: str(b['runnerUpLabel']),
      runnerUpRmsDeg: num(b['runnerUpRmsDeg']),
    },
    drift: d == null ? null : {
      measured: boolOf(d['measured']),
      degPerS: num(d['degPerS']),
      canvasPxOverSweep: num(d['canvasPxOverSweep']),
      sweepSeconds: num(d['sweepSeconds']),
      canvasPxPerDeg: num(d['canvasPxPerDeg']),
      budgetPx: num(d['budgetPx']),
      withinBudget: boolOf(d['withinBudget']),
      rmsDetrendedDeg: num(d['rmsDetrendedDeg']),
      biasedHigh: d['biasedHigh'] !== false,
    },
    stability: st == null ? null : {
      ok: boolOf(st['ok']),
      reason: str(st['reason']),
      winnerStable: boolOf(st['winnerStable']),
      winnerIndex: num(st['winnerIndex']),
      triedOffsets: num(st['triedOffsets']),
      agreeingOffsets: num(st['agreeingOffsets']),
      minMarginDeg: num(st['minMarginDeg']),
      offsetsS: Array.isArray(st['offsetsS'])
        ? (st['offsetsS'] as unknown[]).map(num) : [],
    },
  };
}

export function parseTauFit(v: unknown): CalibTauFit {
  const r = obj(v) ?? {};
  return {
    ok: boolOf(r['ok']),
    reason: str(r['reason']),
    runs: num(r['runs']),
    resolvedRuns: num(r['resolvedRuns']),
    tauMs: num(r['tauMs']),
    tauS: num(r['tauS']),
    meanMs: num(r['meanMs']),
    sdMs: num(r['sdMs']),
    spreadMs: num(r['spreadMs']),
    stdErrMs: num(r['stdErrMs']),
    worstPeakR: num(r['worstPeakR']),
    maxBandWidthMs: num(r['maxBandWidthMs']),
    budgetMs: num(r['budgetMs']),
    budgetFractionUsed: num(r['budgetFractionUsed']),
    smallSample: r['smallSample'] !== false,
    tauSign: str(r['tauSign']),
  };
}

export function parseSnapshot(v: unknown): CalibSnapshot {
  const r = obj(v) ?? {};
  const res = obj(r['resolved']) ?? {};
  const strArr = (x: unknown): string[] =>
    Array.isArray(x) ? (x as unknown[]).filter((e): e is string => typeof e === 'string') : [];
  return {
    deviceModel: str(r['deviceModel']),
    tauKey: str(r['tauKey']),
    basisKey: str(r['basisKey']),
    haveTau: boolOf(res['haveTau']),
    haveBasis: boolOf(res['haveBasis']),
    complete: boolOf(res['complete']),
    missing: str(res['missing']),
    tauS: num(res['tauS']),
    tauStdErrMs: num(res['tauStdErrMs']),
    tauMeasuredAt: str(res['tauMeasuredAt']),
    basisIndex: num(res['basisIndex']),
    basisLabel: str(res['basisLabel']),
    basisMeasuredAt: str(res['basisMeasuredAt']),
    path: str(r['path']),
    storedTauKeys: strArr(r['storedTauKeys']),
    storedBasisKeys: strArr(r['storedBasisKeys']),
  };
}

// ════════════════════════════════════════════════════════════════════════
//  The bridge
// ════════════════════════════════════════════════════════════════════════

interface NativeCalib {
  startBasisCalibration: (o: Record<string, unknown>) => Promise<Record<string, unknown>>;
  basisCalibrationStatus: () => Promise<Record<string, unknown>>;
  stopBasisCalibration: (o: Record<string, unknown>) => Promise<Record<string, unknown>>;
  resolveBasisCalibration: (o: Record<string, unknown>) => Promise<Record<string, unknown>>;
  discardBasisCalibration: () => Promise<Record<string, unknown>>;
  combineTauRuns: (runs: unknown[]) => Promise<Record<string, unknown>>;
  getCalibration: (o: Record<string, unknown>) => Promise<Record<string, unknown>>;
  saveTauCalibration: (o: Record<string, unknown>) => Promise<Record<string, unknown>>;
  saveBasisCalibration: (o: Record<string, unknown>) => Promise<Record<string, unknown>>;
  clearCalibration: (o: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** Added 2026-08-31. OPTIONAL on the type, because an app installed from
   *  a binary built before it exists will have every other method and not
   *  this one — and a `mod.plannedCaptureFormat(...)` on that build is a
   *  TypeError, not a rejection. Guarded at the call site. */
  plannedCaptureFormat?: (o: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

/**
 * The native module, or null.
 *
 * NULL IS A REAL ANSWER AND MUST BE HANDLED: an Android build, or an iOS build
 * that has not been re-podded since these files were added. Every pano+ native
 * file this session is UNTRACKED, so `git status` can never catch a missing
 * `pod install` — the module simply is not there, and a panel that assumed it
 * would be would fail at the first tap with a TypeError instead of a sentence.
 */
export function panoCalibNative(): NativeCalib | null {
  const mod = (NativeModules as Record<string, unknown>)[CALIB_MODULE_NAME];
  if (mod == null || typeof mod !== 'object') return null;
  const fn = (mod as Record<string, unknown>)['startBasisCalibration'];
  return typeof fn === 'function' ? (mod as unknown as NativeCalib) : null;
}

/** True when this build can run the calibration at all. */
export function panoCalibAvailable(): boolean {
  return panoCalibNative() != null;
}

export const CALIB_UNAVAILABLE =
  `NativeModules.${CALIB_MODULE_NAME} is not registered — an Android `
  + 'build, or an iOS build that has not been re-podded since the '
  + 'calibration was added.';

export interface CalibFormatKey {
  lens?: string;
  width?: number;
  height?: number;
  fps?: number;
}

export async function startBasisCalibration(
  options: { maxDurationS?: number } = {},
): Promise<Record<string, unknown>> {
  const m = panoCalibNative();
  if (m == null) throw new Error(CALIB_UNAVAILABLE);
  return m.startBasisCalibration({ maxDurationS: options.maxDurationS ?? 90 });
}

export async function basisCalibrationStatus(): Promise<CalibLiveStatus> {
  const m = panoCalibNative();
  if (m == null) return parseLiveStatus(null);
  return parseLiveStatus(await m.basisCalibrationStatus());
}

export async function stopBasisCalibration(tauS = 0): Promise<CalibBasisSolve> {
  const m = panoCalibNative();
  if (m == null) throw new Error(CALIB_UNAVAILABLE);
  return parseBasisSolve(await m.stopBasisCalibration({ tauS }));
}

export async function resolveBasisCalibration(tauS: number): Promise<CalibBasisSolve> {
  const m = panoCalibNative();
  if (m == null) throw new Error(CALIB_UNAVAILABLE);
  return parseBasisSolve(await m.resolveBasisCalibration({ tauS }));
}

export async function discardBasisCalibration(): Promise<void> {
  const m = panoCalibNative();
  if (m == null) return;
  await m.discardBasisCalibration();
}

/**
 * Combine repeated `measureCaptureClock` results into one τ with a stated
 * uncertainty. Pass the raw results; only the four fields the fit needs are
 * forwarded, so a caller cannot accidentally smuggle a magnitude verdict in.
 */
export async function combineTauRuns(
  runs: readonly TauRunInput[],
): Promise<CalibTauFit> {
  const m = panoCalibNative();
  if (m == null) throw new Error(CALIB_UNAVAILABLE);
  const payload = runs.map((r) => ({
    resolved: r.resolved === true,
    tauMs: r.tauMs,
    peakR: r.tauPeakR,
    bandWidthMs: r.tauBandWidthMs,
  }));
  return parseTauFit(await m.combineTauRuns(payload));
}

/**
 * THE FORMAT AN IMU SWEEP WOULD OPEN ON THIS BODY — and therefore the key its τ
 * is stored under.
 *
 * ⚠️ READ THIS BEFORE LOOKING τ UP UNDER ANYTHING ELSE. τ is keyed
 * `model | lens | W×H | fps` because the rolling-shutter readout constant is
 * folded into it and is a property of the FORMAT. But the format is not the
 * host's to choose: `RNISPanoAvfSource.planFormat` picks the biggest 4:3 format
 * reaching 60 fps on the physical ultra-wide, and only the device knows what
 * that is. A caller who guesses looks up a key nothing was written under, and
 * gets "NOT CALIBRATED" from a store that is holding the number.
 *
 * `ok: false` is a HARDWARE answer, not a calibration one: this body publishes
 * no physical ultra-wide, or none of its 4:3 formats reaches 60 fps. Those
 * refusals must not render as "run the calibration" — there is nothing on this
 * device to calibrate, and the study's own rule is that 60 fps is the
 * motion-blur defence and is not tradeable.
 */
export interface CalibPlannedFormat {
  ok: boolean;
  /** `panoplus-no-ultrawide` | `panoplus-no-wide` | `panoplus-bad-lens`
   *  | `panoplus-no-60fps-format` | `panoplus-no-camera` | `panoplus-io`
   *  | `calib-unavailable`, or null when `ok`.
   *
   *  `panoplus-no-wide` and `panoplus-bad-lens` arrived with pano+ ⇄ Pano
   *  parity (2026-09-03): the planner now refuses a requested lens the body
   *  does not publish under ITS OWN code (it used to fall back to the first
   *  device, silently, for the wide), and refuses an unknown `lens` spelling
   *  instead of opening the ultra-wide on it. */
  reason: string | null;
  detail: string | null;
  /** The device that WOULD open — `AVCaptureDevice.DeviceType` raw value. */
  lens: string | null;
  /**
   * The lens that was ASKED for, in the flag's spelling (`ultraWide` |
   * `wide`), echoed by native on every answer including refusals — so a
   * caller asking "is there a 0.5× on this body" reads the request beside
   * `reason` rather than matching a bare refusal back to its own question.
   * Null on a build that predates it, or when the spelling itself was refused.
   */
  lensRequested: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  /** The assembled τ key, so no caller has to know the grammar. */
  tauKey: string | null;
  basisKey: string | null;
}

export function parsePlannedFormat(v: unknown): CalibPlannedFormat {
  const r = (v ?? {}) as Record<string, unknown>;
  const num = (x: unknown): number | null =>
    typeof x === 'number' && Number.isFinite(x) ? x : null;
  const str = (x: unknown): string | null => (typeof x === 'string' ? x : null);
  return {
    ok: r['ok'] === true,
    reason: str(r['reason']),
    detail: str(r['detail']),
    lens: str(r['lens']),
    lensRequested: str(r['lensRequested']),
    width: num(r['width']),
    height: num(r['height']),
    fps: num(r['fps']),
    tauKey: str(r['tauKey']),
    basisKey: str(r['basisKey']),
  };
}

/**
 * WHICH OF THE TWO BACK LENSES THE DECOUPLED ARM CAN OPEN ON THIS BODY — the
 * iOS answer to Pano's `has0_5x`.
 *
 * pano+ ⇄ Pano parity (2026-09-03): the lens switcher is Pano's own chip,
 * which shows two pills only when a 0.5× exists and a static `1×` otherwise.
 * Pano learns that from vision-camera's device list; the decoupled arm does
 * not run through vision-camera, so it asks the SAME selector the sweep and
 * the idle viewfinder use (`RNISPanoAvfSource.planFormat`, through
 * `plannedCaptureFormat`) once per lens.  A lens is "available" exactly when
 * the planner would OPEN it — physical device present AND a 4:3 format at
 * 60 fps — because a pill the sweep would refuse is a pill that lies.
 *
 * Returns `null` where the question is not this module's to answer:
 *  - Android — the recorder resolves lenses by facing/FOV in
 *    `PanoPlusAndroidRecorder`; the calibration module does not exist there
 *    and its absence must not read as "no 0.5×".
 *  - An iOS build without the calibration module or its planner method — the
 *    same "cannot answer" distinction `calibrationForPlannedFormat` draws.
 *
 * Never throws: a planner rejection is reported as that lens being
 * unavailable with the rejection's message as its reason.
 */
export interface PanoPlusLensAvailability {
  ultraWide: boolean;
  wide: boolean;
  /** The planner's `reason` when unavailable (`panoplus-no-ultrawide`,
   *  `panoplus-no-60fps-format`, …); null when available. */
  ultraWideReason: string | null;
  wideReason: string | null;
}

export async function panoPlusLensAvailability(): Promise<PanoPlusLensAvailability | null> {
  if (Platform.OS !== 'ios') return null;
  const m = panoCalibNative();
  if (m == null || typeof m.plannedCaptureFormat !== 'function') return null;
  const ask = async (lens: 'ultraWide' | 'wide'): Promise<CalibPlannedFormat> => {
    try {
      return await plannedCaptureFormat({ lens });
    } catch (e: unknown) {
      return {
        ...parsePlannedFormat(null),
        reason: 'panoplus-io',
        detail: e instanceof Error ? e.message : String(e),
        lensRequested: lens,
      };
    }
  };
  const [uw, w] = await Promise.all([ask('ultraWide'), ask('wide')]);
  return {
    ultraWide: uw.ok,
    wide: w.ok,
    ultraWideReason: uw.ok ? null : (uw.reason ?? 'panoplus-io'),
    wideReason: w.ok ? null : (w.reason ?? 'panoplus-io'),
  };
}

/**
 * Ask the device which format an IMU sweep would run on.
 *
 * Returns a REFUSAL rather than throwing when the build predates the native
 * method (`calib-unavailable`): an app installed from an older binary has every
 * other calibration method and not this one, so calling it blind is a TypeError
 * inside a promise chain — the exact failure `panoCalibNative()` exists to stop
 * one layer up.
 */
export async function plannedCaptureFormat(
  key: CalibFormatKey = {},
): Promise<CalibPlannedFormat> {
  const m = panoCalibNative();
  if (m == null || typeof m.plannedCaptureFormat !== 'function') {
    return {
      ...parsePlannedFormat(null),
      reason: 'calib-unavailable',
      detail: CALIB_UNAVAILABLE,
    };
  }
  return parsePlannedFormat(
    await m.plannedCaptureFormat(key as Record<string, unknown>),
  );
}

/**
 * What is on file FOR THE FORMAT A SWEEP WOULD ACTUALLY RUN.
 *
 * The composition every caller wants and nobody should have to remember:
 * resolve the planned format first, then read the store under that key. Reading
 * it with no key at all is what made the panel report "τ saved" and then "NOT
 * CALIBRATED — missing tau" one refresh later, with the record it had just
 * written listed under `storedTauKeys`.
 *
 * When the hardware itself refuses, the snapshot is returned UNREAD with the
 * plan's reason attached — because "there is no format" and "there is no τ for
 * this format" are different findings and a screen must not merge them.
 */
export async function calibrationForPlannedFormat(
  // P5 review fix — the key (in practice `{ lens }`) is forwarded to the
  // native planner, so the precondition the surface gates the arm on is read
  // for the SAME camera the sweep will open.  Empty = the planner's default
  // (ultraWide), which is also every pre-P5 caller's behaviour.
  key: CalibFormatKey = {},
): Promise<{
  plan: CalibPlannedFormat;
  snapshot: CalibSnapshot | null;
}> {
  const plan = await plannedCaptureFormat(key);
  if (!plan.ok) return { plan, snapshot: null };
  const snapshot = await getCalibration({
    ...(plan.lens != null ? { lens: plan.lens } : {}),
    ...(plan.width != null ? { width: plan.width } : {}),
    ...(plan.height != null ? { height: plan.height } : {}),
    ...(plan.fps != null ? { fps: plan.fps } : {}),
  });
  return { plan, snapshot };
}

export async function getCalibration(key: CalibFormatKey = {}): Promise<CalibSnapshot> {
  const m = panoCalibNative();
  if (m == null) return parseSnapshot(null);
  return parseSnapshot(await m.getCalibration(key as Record<string, unknown>));
}

/**
 * Persist τ.
 *
 * REJECTS when the fit did not pass its own gate — the native store enforces
 * it, and this signature does not offer a way around it. A silently-wrong τ is
 * worse than none: it produces a sweep that looks plausible and is not.
 */
export async function saveTauCalibration(
  fit: CalibTauFit,
  key: CalibFormatKey = {},
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const m = panoCalibNative();
  if (m == null) throw new Error(CALIB_UNAVAILABLE);
  return m.saveTauCalibration({ fit: fit as unknown as Record<string, unknown>, ...key, extra });
}

export async function saveBasisCalibration(
  solve: CalibBasisSolve,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const m = panoCalibNative();
  if (m == null) throw new Error(CALIB_UNAVAILABLE);
  return m.saveBasisCalibration({
    solve: solve as unknown as Record<string, unknown>, extra,
  });
}

export async function clearCalibration(
  scope: 'tau' | 'basis' | 'all',
  key: CalibFormatKey = {},
): Promise<Record<string, unknown>> {
  const m = panoCalibNative();
  if (m == null) throw new Error(CALIB_UNAVAILABLE);
  return m.clearCalibration({ scope, ...key });
}

// ════════════════════════════════════════════════════════════════════════
//  Verdicts — the sentences the operator reads
// ════════════════════════════════════════════════════════════════════════

function f(v: number | null, d = 2, unit = ''): string {
  return v == null ? '—' : `${v.toFixed(d)}${unit}`;
}

/** τ, graded on its UNCERTAINTY. Never on |τ|. */
export function tauFitVerdict(fit: CalibTauFit | null): SweepVerdict {
  if (fit == null) {
    return {
      tone: 'unknown',
      headline: 'τ NOT MEASURED',
      detail:
        'Run the clock probe three times with the AR session down, sweeping the '
        + 'phone across a textured shelf for each one. One run has no '
        + 'uncertainty to quote, and an uncertainty is what the budget grades.',
    };
  }
  const sign = fit.tauMs != null && fit.tauMs >= 0 ? '+' : '';
  if (!fit.ok) {
    return {
      tone: 'no',
      headline: `τ NOT PERSISTABLE — ${fit.reason ?? 'unknown'}`,
      detail: tauRefusalSentence(fit)
        + ` Best estimate so far ${sign}${f(fit.tauMs, 2, ' ms')} from `
        + `${fit.resolvedRuns ?? 0}/${fit.runs ?? 0} resolved runs, spread `
        + `${f(fit.spreadMs, 2, ' ms')}. Nothing was written.`,
    };
  }
  return {
    tone: 'yes',
    headline: `τ = ${sign}${f(fit.tauMs, 2, ' ms')} ± ${f(fit.stdErrMs, 2, ' ms')}`,
    detail:
      `${fit.resolvedRuns} resolved runs, spread ${f(fit.spreadMs, 2, ' ms')}, `
      + `worst peak r ${f(fit.worstPeakR, 3)}. The uncertainty spends `
      + `${f((fit.budgetFractionUsed ?? 0) * 100, 0, ' %')} of the `
      + `${f(fit.budgetMs, 2, ' ms')} residual budget. `
      + 'POSITIVE τ means the motion a frame recorded is LATER in the CoreMotion '
      + 'timebase than its PTS — align by sampling attitude at (pts + τ). '
      + 'The MAGNITUDE of τ is not graded: correcting for it is the whole point.'
      + (fit.smallSample
        ? ' At this n the SD is itself uncertain to roughly ±40 % — more runs tighten it.'
        : ''),
  };
}

function tauRefusalSentence(fit: CalibTauFit): string {
  switch (fit.reason) {
    case 'no-runs':
      return 'No measurements have been taken.';
    case 'too-few-resolved-runs':
      return 'Not enough runs RESOLVED. A run whose correlation peak was weak '
        + 'is not a measurement, however plausible its number looks.';
    case 'weak-peak':
      return 'One run\'s correlation peak was below the 0.80 bar, so the image '
        + 'and gyro series did not agree well enough anywhere for the peak '
        + 'location to mean anything.';
    case 'spread-too-wide':
      return 'The runs disagree by more than 2 ms. That disagreement IS the '
        + 'uncertainty, and it is larger than the budget the correction is '
        + 'supposed to buy back.';
    case 'std-err-too-wide':
      return 'The standard error is over 1 ms — a third of the whole residual '
        + 'budget spent on the calibration\'s own error.';
    default:
      return 'The fit did not pass its gate.';
  }
}

/** The gesture, graded LIVE. */
export function excitationVerdict(e: CalibExcitation | null): SweepVerdict {
  if (e == null || !e.ok) {
    return {
      tone: 'unknown',
      headline: 'GESTURE NOT STARTED',
      detail:
        'A CAREFUL STRAIGHT SWEEP IS THE WORST CAPTURE FOR THIS. The basis is '
        + 'recovered from rotation about MORE THAN ONE axis; a pan alone leaves '
        + 'four candidates matching EXACTLY and the answer would be picked by '
        + 'enumeration order.',
    };
  }
  if (e.sufficient) {
    return {
      tone: 'yes',
      headline: `GESTURE SUFFICIENT — ${e.exercisedAxes ?? 0} axes`,
      detail:
        `Turned ${f(e.sweptDeg, 0, '°')} in total: tilt ${f(e.perAxisDeg.tilt, 0, '°')}, `
        + `pan ${f(e.perAxisDeg.pan, 0, '°')}, roll ${f(e.perAxisDeg.roll, 0, '°')}. `
        + `Second-axis amplitude ${f(e.rank2, 2)} (bar 0.25). Two independent axes `
        + 'generate all of SO(3), which is what makes the basis identifiable.',
    };
  }
  return {
    tone: 'no',
    headline: `KEEP GOING — ${e.reason ?? 'insufficient'}`,
    detail:
      (gestureCoaching(e) ?? '')
      + ` So far: tilt ${f(e.perAxisDeg.tilt, 0, '°')}, pan ${f(e.perAxisDeg.pan, 0, '°')}, `
      + `roll ${f(e.perAxisDeg.roll, 0, '°')} (25° each counts an axis), `
      + `second-axis amplitude ${f(e.rank2, 2)} of 0.25.`,
  };
}

/**
 * MAY THIS BASIS BE PERSISTED? — the SCREEN's mirror of the native store's gate.
 *
 * ⚠️ It is a MIRROR, not the decision. `RNISPanoCalibStore.saveBasis` refuses on
 * its own terms and throws `calibration-not-persistable`; this exists so the
 * button that leads there is not enabled into a rejection. An entry that answers
 * a tap with a native error reads as broken rather than as unmet, and the
 * natural next move is to distrust the calibration — the one piece that was
 * right. If the two ever disagree, NATIVE WINS and this is the bug.
 *
 * TWO GATES, and the second is the 2026-08-31 addition:
 *
 *  1. `basis.ok` — the fit passed excitation, uniqueness, pairs and rms.
 *  2. `stability.winnerStable` — the fit was re-run at −10/−5/0/+5/+10 ms and
 *     the SAME candidate won every time. A winner that moves under a 5 ms clock
 *     offset was chosen by the clock, not by the geometry, which is direct
 *     evidence that the permutation is not identified. The single-τ margin
 *     cannot see this; the sweep exists precisely because it cannot.
 *
 * The drift term is deliberately NOT a gate here, for the reason the store
 * states: C is a discrete choice among 24 permutations, and a drifting gyro
 * does not make a different permutation correct.
 */
export function basisIsPersistable(
  s: CalibBasisSolve | null,
): { ok: boolean; reason: string } {
  if (s == null || !s.ran || s.basis == null) {
    return { ok: false, reason: 'not-solved' };
  }
  if (s.basis.ok !== true) {
    return { ok: false, reason: s.basis.reason ?? 'fit-refused' };
  }
  if (s.stability == null || s.stability.ok !== true) {
    return { ok: false, reason: s.stability?.reason ?? 'stability-not-run' };
  }
  if (s.stability.winnerStable !== true) {
    return { ok: false, reason: s.stability.reason ?? 'winner-changed' };
  }
  return { ok: true, reason: 'ok' };
}

/** The basis, after the solve. */
export function basisVerdict(s: CalibBasisSolve | null): SweepVerdict {
  if (s == null || !s.ran || s.basis == null) {
    return {
      tone: 'unknown',
      headline: 'BASIS NOT SOLVED',
      detail: 'Record the gesture and finish it to solve for C.',
    };
  }
  const b = s.basis;
  if (!b.ok) {
    return {
      tone: 'no',
      headline: `BASIS REFUSED — ${b.reason ?? 'unknown'}`,
      detail: basisRefusalSentence(s)
        + (b.index != null && b.index >= 0
          ? ` The best candidate was #${b.index} ${b.label ?? ''} at rms `
            + `${f(b.rmsDeg, 3, '°')}, margin ${f(b.marginDeg, 3, '°')} over `
            + `#${b.runnerUpIndex} ${b.runnerUpLabel ?? ''} — shown so it is `
            + 'visible, NOT because it may be used.'
          : ''),
    };
  }
  const evidence =
    `Residual ${f(b.rmsDeg, 3, '°')} over ${b.pairs} pairs; the runner-up `
    + `(#${b.runnerUpIndex} ${b.runnerUpLabel ?? ''}) is worse by `
    + `${f(b.marginDeg, 2, '°')}. `;

  // ⚠️ THE HEADLINE MUST NOT ACCEPT WHAT THE STORE WILL REFUSE.
  //
  // This used to read `BASIS C = #7 …` with tone `yes` and then append a
  // "treat it as provisional" clause — an accept headline over a refusal.
  // Since 2026-08-31 the store REFUSES an unstable winner, so a green headline
  // would send the operator looking for a Save button that is disabled instead
  // of back to the gesture, which is the only thing that can fix it.
  if (s.stability?.winnerStable !== true) {
    return {
      tone: 'no',
      headline: `BASIS REFUSED — the winner moved under the ±10 ms sweep`,
      detail:
        evidence
        + `But the fit was re-run at −10/−5/0/+5/+10 ms and the winner did not `
        + `survive it (${s.stability?.reason ?? 'unknown'}), so it was chosen by `
        + `the CLOCK and not by the geometry — direct evidence that the `
        + `permutation is not identified, which a single-τ margin structurally `
        + `cannot see. Nothing will be saved. Record the gesture again with more `
        + `OFF-AXIS motion — tilt and roll, not a straighter pan. `
        + `#${b.index} ${b.label ?? ''} is shown so it is visible, NOT because it `
        + `may be used.`,
    };
  }

  return {
    tone: 'yes',
    headline: `BASIS C = #${b.index} ${b.label ?? ''}`,
    detail:
      evidence
      + `The same winner survives every offset in ±10 ms, so it was chosen by the `
      + `geometry and not by the clock.`,
  };
}

function basisRefusalSentence(s: CalibBasisSolve): string {
  const r = s.basis?.reason;
  switch (r) {
    case 'excitation-insufficient':
      return 'THE GESTURE, not the maths. ' + (gestureCoaching(s.excitationRef) ?? '');
    case 'ambiguous-axis':
      return 'The log cannot tell the candidates apart: several matched to '
        + 'within floating-point dust. That is the one-axis degeneracy — a pan '
        + 'identifies one column of C and leaves an exact four-way tie.';
    case 'stationary':
      return 'The reference barely rotated, so every candidate reproduces the '
        + 'identity perfectly and the winner would be noise.';
    case 'too-few-pairs':
      return 'Too few reference frames were bracketed by the IMU log to make '
        + 'the residual mean anything. Record for longer.';
    case 'too-few-samples':
      return 'The logs are too short to fit anything.';
    case 'rms-too-large':
      return 'The best candidate still misses by more than 2°, so either the '
        + 'basis is not among the 24 or one of the two sensors is not '
        + 'reporting what it claims.';
    default:
      return 'The fit did not pass its gate.';
  }
}

/**
 * The gyro-bias drift — an ARCHITECTURE verdict, reported beside the basis and
 * never gating it.
 */
export function driftVerdict(d: CalibDrift | null): SweepVerdict {
  if (d == null || !d.measured) {
    return {
      tone: 'unknown',
      headline: 'DRIFT NOT MEASURED',
      detail:
        'This is the term that can veto the decoupled arm outright: ARKit '
        + 'corrects gyro bias against the image every frame, and a bare motion '
        + 'sensor does not.',
    };
  }
  const tone: SweepVerdictTone = d.withinBudget ? 'yes' : 'no';
  return {
    tone,
    headline: `GYRO DRIFT ${f(d.degPerS, 4, ' °/s')} → `
      + `${f(d.canvasPxOverSweep, 2, ' px')} over ${f(d.sweepSeconds, 0, ' s')}`,
    detail:
      (d.withinBudget
        ? `Inside the ${f(d.budgetPx, 2, ' px')} bar these packs already fail `
          + 'integrity at, so the drift term alone does not veto the arm. '
        : `OVER the ${f(d.budgetPx, 2, ' px')} bar these packs already fail `
          + 'integrity at. This term accumulates LINEARLY in the rectification '
          + 'channel and does not self-correct — it is an architecture finding, '
          + 'not a gesture problem. ')
      + 'It does NOT gate the basis: C is a choice among 24 permutations and a '
      + 'drifting gyro does not make a different one correct. '
      + `⚠ The slope is fitted to |residual|, a magnitude, so this reads HIGH; `
      + `de-trended residual ${f(d.rmsDetrendedDeg, 3, '°')} is what says whether `
      + 'it really is a ramp.',
  };
}

/** What is on file, and what a sweep would therefore do right now. */
export function storedCalibrationVerdict(s: CalibSnapshot | null): SweepVerdict {
  if (s == null) {
    return {
      tone: 'unknown',
      headline: 'CALIBRATION STORE NOT READ',
      detail: CALIB_UNAVAILABLE,
    };
  }
  if (s.complete) {
    return {
      tone: 'yes',
      headline: `CALIBRATED — τ ${f(s.tauS != null ? s.tauS * 1000 : null, 2, ' ms')}, `
        + `C #${s.basisIndex} ${s.basisLabel ?? ''}`,
      detail:
        `τ key ${s.tauKey ?? '—'} (measured ${s.tauMeasuredAt ?? '—'}); basis key `
        + `${s.basisKey ?? '—'} (measured ${s.basisMeasuredAt ?? '—'}). A pano+ `
        + 'sweep on the IMU arm will start with these without asking again.',
    };
  }
  return {
    tone: 'no',
    headline: `NOT CALIBRATED — missing ${s.missing ?? 'tau+basis'}`,
    detail:
      'A CALIBRATED sweep on the IMU arm needs both numbers, and refusing '
      + 'without them is correct: there is no default τ and an unvalidated '
      + 'basis would rotate the canvas silently. '
      + (s.haveTau
        ? 'τ is on file; run the gesture to get the basis.'
        : s.haveBasis
          // ⚠ THE ONE ROUTE THAT DOES NOT NEED τ, stated here because this
          // panel used to say the arm refuses "without both numbers" FULL
          // STOP — which stopped being true on 2026-08-31 and would have sent
          // the operator to re-run a probe whose own gate had already, and
          // correctly, refused to persist what it measured.
          ? 'The basis is on file, which is the half that cannot be worked '
            + 'around. For a CALIBRATED sweep, run the clock probe three times '
            + 'to get τ. To sweep WITHOUT one — the declared τ = 0 experiment, '
            + 'which is what answers whether τ binds at all — turn on '
            + '"τ=0 EXPERIMENT" under the pose source in the gear. That pack '
            + 'records tauProvenance: uncorrected and never claims a τ.'
          : 'Run both stages below.')
      + (s.storedTauKeys.length > 0 && !s.haveTau
        ? ` (There ARE stored τ records, under other keys: ${s.storedTauKeys.join(', ')}. `
          + 'A different lens or format needs its own τ — the readout constant '
          + 'is part of it.)'
        : ''),
  };
}
