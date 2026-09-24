// SPDX-License-Identifier: Apache-2.0
/**
 * lateralStopPolicy — the pure decision behind "a lateral (cross-axis) drift
 * stopped the capture: do we KEEP what was captured, or throw it away?"
 *
 * ## Why this is a policy and not a constant
 *
 * Item 6 stops a capture the moment the operator's integrated sideways
 * translation blows the `lateralBudgetCm` budget.  Historically the SDK made
 * that call itself with a hardcoded `MIN_STITCHABLE_KEYFRAMES = 2`: two or
 * more accepted keyframes → FINALIZE (stitch the partial sweep and hand it to
 * `onCapture`), fewer → ABANDON (no stitch, so no misleading "need more
 * images" error) and show the "follow the arrow" popup.
 *
 * That constant encoded a product judgement the SDK is not entitled to make,
 * and for the primary shelf-capture use case it made the WRONG call: a two-
 * to-four-frame remnant of a drifted sweep is not a shelf panorama.  It is
 * waste that still costs a stitch, a file, and an operator's attention on
 * output they will bin.  `lateralStopFinalizeMinFrames` moves the threshold
 * to the host, and its default is 5 — a real sweep, not a stub.  This module
 * is the arithmetic behind it.
 *
 * ## The `0` trap
 *
 * `0` means ALWAYS DISCARD.  It is special-cased rather than falling out of
 * the comparison because the natural implementation — `count >= minFrames` —
 * is *unconditionally true* at `minFrames === 0` (keyframe counts are never
 * negative), i.e. it would mean the exact OPPOSITE, "always finalize".  The
 * guard below is load-bearing, and `lateralStopPolicy.test.ts` pins it.
 *
 * No React, no OpenCV, no native module, no sensors — so the decision is
 * unit-testable in the plain node jest env, the same way `panModeGate.ts`
 * makes the rotate gate testable without booting a render.
 */

/**
 * Default for `lateralStopFinalizeMinFrames`: a laterally-drifted capture is
 * kept only when at least this many keyframes were accepted.
 *
 * **This is 5, deliberately NOT the 2 the SDK used to hardcode.**  It is a
 * real BEHAVIOUR CHANGE, not a no-op: captures that accepted 2-4 keyframes
 * used to finalize and now discard.  That is the point — a 2-to-4-frame
 * remnant of a sweep the operator drifted out of is not a usable shelf
 * panorama, and asking for a clean re-shoot beats handing the host output it
 * has to detect and reject downstream.
 *
 * Hosts that want the previous finalize-anything-stitchable behaviour pass
 * `lateralStopFinalizeMinFrames={2}` explicitly.
 */
export const DEFAULT_LATERAL_STOP_FINALIZE_MIN_FRAMES = 5;

/**
 * The lower bound at which a partial sweep is worth stitching at all.  Below
 * it the capture produced nothing a user would recognise as a panorama, so
 * the popup shows the "you panned the wrong way" copy rather than either of
 * the "we stopped a real capture" messages.  This is a COPY-selection
 * threshold only — it never overrides the host's finalize/discard policy.
 *
 * Deliberately INDEPENDENT of
 * {@link DEFAULT_LATERAL_STOP_FINALIZE_MIN_FRAMES}: at the default of 5 the
 * 2-to-4-keyframe band is a capture that WAS stitchable but that policy
 * declined to keep, so it reads as `'discarded'` and not as the operator
 * having panned the wrong way.
 */
export const MIN_STITCHABLE_KEYFRAMES = 2;

/**
 * Which of the three lateral-stop outcomes fired, and therefore which popup
 * copy the modal renders:
 *
 *   - `'wrong-direction'` — the operator veered off almost immediately and
 *     too few frames landed to stitch anything.  Capture ABANDONED.
 *   - `'discarded'`       — enough frames to stitch, but the host's
 *     `lateralStopFinalizeMinFrames` policy says a drifted sweep isn't worth
 *     keeping.  Capture ABANDONED.  At the default of 5 this is the
 *     2-to-4-keyframe band.
 *   - `'finalized'`       — the sweep is kept and stitched; `onCapture` fires
 *     with a `LATERAL_DRIFT_FINALIZE` warning attached.
 */
export type LateralStopOutcome =
  | 'wrong-direction'
  | 'discarded'
  | 'finalized';

/**
 * Normalise the host-supplied `lateralStopFinalizeMinFrames` to a usable
 * integer frame count.
 *
 * `undefined` (prop omitted), a negative number, and any non-finite value
 * (`NaN`, `±Infinity` — e.g. a host computing the threshold from an empty
 * config and landing on `Number('')`) all fall back to the default, so a
 * broken host config degrades to the standard default rather than to "throw
 * every capture away".  `0` is preserved verbatim: it is a meaningful
 * setting (always discard), not a missing one.
 *
 * Fractional values round UP (`2.5` → `3`): the prop is a MINIMUM whole-frame
 * count, and you cannot hold half a keyframe.
 */
export function normaliseLateralStopFinalizeMinFrames(
  minFrames: number | undefined,
): number {
  if (
    typeof minFrames !== 'number'
    || !Number.isFinite(minFrames)
    || minFrames < 0
  ) {
    return DEFAULT_LATERAL_STOP_FINALIZE_MIN_FRAMES;
  }
  return Math.ceil(minFrames);
}

/**
 * True when a lateral-drift stop should FINALIZE (keep + stitch what was
 * captured); false when the capture should be DISCARDED instead.
 *
 *   - `minFrames === 0`  → always false (ALWAYS DISCARD).  See the `0` trap
 *     note in the module docstring — this is NOT `count >= 0`.
 *   - `minFrames >= 1`   → `acceptedKeyframeCount >= minFrames`.
 *   - anything else (negative / non-finite / omitted) → normalised to the
 *     default of {@link DEFAULT_LATERAL_STOP_FINALIZE_MIN_FRAMES} first.
 *
 * A non-finite `acceptedKeyframeCount` is treated as 0 (discard) rather than
 * propagating `NaN` through the comparison: an unreadable engine count is not
 * evidence that frames exist.
 */
export function shouldFinalizeLateralStop(
  acceptedKeyframeCount: number,
  minFrames: number | undefined,
): boolean {
  const threshold = normaliseLateralStopFinalizeMinFrames(minFrames);
  // The `0` trap: `count >= 0` is always true, which would invert the
  // meaning of the setting.  Guard it explicitly, before the comparison.
  if (threshold === 0) return false;
  const count = Number.isFinite(acceptedKeyframeCount)
    ? acceptedKeyframeCount
    : 0;
  return count >= threshold;
}

/**
 * Classify a lateral-drift stop into the outcome whose copy the
 * `LateralMotionModal` should render.
 *
 * The finalize/discard half is entirely {@link shouldFinalizeLateralStop};
 * this only splits the DISCARD half into "the operator captured nothing
 * usable" (`'wrong-direction'`, the pre-existing behaviour) and "policy threw
 * away a stitchable sweep" (`'discarded'`, new).  At the default threshold of
 * 5 that split lands at: 0-1 keyframes → `'wrong-direction'` (nothing
 * stitchable ever existed), 2-4 → `'discarded'` (stitchable, but not a sweep
 * worth keeping), 5+ → `'finalized'`.
 */
export function lateralStopOutcome(
  acceptedKeyframeCount: number,
  minFrames: number | undefined,
): LateralStopOutcome {
  if (shouldFinalizeLateralStop(acceptedKeyframeCount, minFrames)) {
    return 'finalized';
  }
  const count = Number.isFinite(acceptedKeyframeCount)
    ? acceptedKeyframeCount
    : 0;
  return count < MIN_STITCHABLE_KEYFRAMES ? 'wrong-direction' : 'discarded';
}
