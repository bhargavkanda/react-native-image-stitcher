// SPDX-License-Identifier: Apache-2.0
/**
 * cameraTransitionGate — the pure decision behind "the settled camera identity
 * disagrees with the requested one: what should the handoff effect DO?"
 *
 * ## The machine this models
 *
 * `<Camera>` guards the AR ↔ non-AR / 1x ↔ 0.5x camera handoff with a pair of
 * refs holding the LAST FULLY SETTLED identity (`settledIsARRef`,
 * `settledLensRef`) plus a `cameraTransitioning` state flag.  Their disjunction
 * is `inFlightTransition`, which unmounts the live camera
 * (`cameraShouldUnmount`) and defers shutter holds (`holdShouldDeferForCamera`).
 * The refs are compared SYNCHRONOUSLY during render so the gate closes on the
 * very first render where the identity changes; the flag then holds the gate
 * closed across the async settle, because the refs are updated BEFORE the flag
 * clears and would otherwise re-open the gate a commit too early.
 *
 * Two pieces of state for one concept is exactly where the latch bug below
 * lived, so the decision is extracted here as a total function over both.
 *
 * ## The latch this closes (v0.25.1)
 *
 * The effect used to early-return whenever the refs already matched, on the
 * assumption that "refs match" implies "nothing in flight".  A flip-BACK inside
 * the 250 ms grace breaks that assumption:
 *
 *   1. Lens 1x → 0.5x.  Refs still say 1x, so the gate closes:
 *      `setCameraTransitioning(true)`, and `finishTransition` is scheduled for
 *      +250 ms.  The refs are NOT yet updated — that happens in the callback.
 *   2. Inside that window the lens goes BACK 0.5x → 1x.  React runs the
 *      cleanup, which sets `cancelled = true`, so the pending `finishTransition`
 *      will no-op — it never reaches its `setCameraTransitioning(false)`.
 *   3. The effect re-runs.  The refs (never updated, still 1x) now MATCH the
 *      current lens (back to 1x), so the old code early-returned.
 *
 * Nothing is left to clear the flag: `setCameraTransitioning(false)` appears at
 * exactly ONE site, inside the callback step 2 just cancelled.  So the flag
 * latches TRUE FOREVER, `inFlightTransition` stays true, and the consequences
 * are total and unrecoverable without a remount:
 *
 *   - `cameraShouldUnmount(...)` stays true — the live camera never remounts
 *     and the UI is stuck on the "Switching camera…" placeholder.
 *   - `holdShouldDeferForCamera(...)` stays true — every shutter hold defers
 *     into `pendingPanStart`, and `handleHoldEnd` cancels it on release.  A
 *     permanently dead shutter.
 *
 * The fix is `'clear-stuck-flag'`: on the already-settled path, if the flag is
 * still set, clear it.  The guard on the flag being set is load-bearing — an
 * unconditional clear would re-trigger the effect off its own state write.
 *
 * ## PROVENANCE — found by INSPECTION, *not* field-reproduced
 *
 * This path was found by reading the effect, not by hitting it on a device.
 * The operator tried to wedge it by hand and could NOT: the flip-back has to
 * land inside a ~250 ms window, which is hard to hit deliberately with a lens
 * chip.  So the failure sequence above is a code-reading result — sound as an
 * argument, unconfirmed as a field observation.  Treat the reproduction as
 * open; the reasoning and the tests are what justify the change.
 *
 * No React, no react-native, no native module, no imports at all — so the
 * decision is unit-testable in the plain node jest env, the same way
 * `panModeGate.ts` makes the rotate gate testable without booting a render.
 */

/**
 * What the camera-handoff effect should do on this run.
 *
 *   - `'start-transition'` — the requested identity differs from the settled
 *     one: close the gate, stop the AR session, start the 250 ms grace.
 *   - `'clear-stuck-flag'` — already settled, but the flag is still set: a
 *     cancelled settle left it latched.  Clear it and do nothing else.  This is
 *     the recovery path for the flip-back-within-grace sequence.
 *   - `'noop'` — already settled and the flag is clear.  Nothing to do; in
 *     particular do NOT write state, or the effect re-triggers itself.
 */
export type CameraTransitionAction =
  | 'start-transition'
  | 'clear-stuck-flag'
  | 'noop';

/**
 * Decide what the handoff effect should do, given the settled identity, the
 * requested identity, and whether the transition flag is currently set.
 *
 * Generic in the lens type (compared with `!==`, like the effect's own
 * synchronous render-time compare) so this module needs no imports and cannot
 * drag React or `react-native` into the pure test env.
 *
 * Total by construction: every (settled, requested, flag) triple maps to
 * exactly one action, which is the property that makes the latch impossible to
 * reintroduce — there is no longer an "early return" path that can silently
 * skip the flag.
 *
 * @param settledIsAR         `settledIsARRef.current` — last settled AR mode.
 * @param settledLens         `settledLensRef.current` — last settled lens.
 * @param isAR                the currently requested AR mode.
 * @param lens                the currently requested lens.
 * @param cameraTransitioning the `cameraTransitioning` state flag right now.
 */
export function cameraTransitionAction<L>(
  settledIsAR: boolean,
  settledLens: L,
  isAR: boolean,
  lens: L,
  cameraTransitioning: boolean,
): CameraTransitionAction {
  // Identity moved — this dominates the flag: a transition that is already in
  // flight must still be restarted for the NEW target (the old one's cleanup
  // cancels its pending settle).
  if (settledIsAR !== isAR || settledLens !== lens) return 'start-transition';
  // Settled.  The flag may still be set if a settle was cancelled mid-grace by
  // a flip-back — that is the latch, and clearing it here is the only exit.
  if (cameraTransitioning) return 'clear-stuck-flag';
  // Settled and clear: write NOTHING.  Returning 'clear-stuck-flag' here
  // instead would make the effect set state on every settled run, and if
  // `cameraTransitioning` is ever added to the dep array that is an infinite
  // render loop.  The guard above is what makes the recovery converge in a
  // single extra commit.
  return 'noop';
}
