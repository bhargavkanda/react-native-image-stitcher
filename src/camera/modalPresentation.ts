// SPDX-License-Identifier: Apache-2.0
/**
 * modalPresentation — which of `<Camera>`'s overlay surfaces may be on
 * screen at any one moment.
 *
 * ## Why this exists (field RCA, 2026-08-18)
 *
 * Every surface here is a React Native `<Modal>`, and on iOS a `<Modal>` is
 * a real UIViewController presentation.  A view controller can present only
 * ONE child at a time: asking a second to present while the first is up is
 * not a no-op and not a queue — the presentation is refused, and RN is left
 * holding a host window that is IN the view hierarchy but was never actually
 * presented.  That window is invisible and still swallows every touch.
 *
 * The field symptom was a dead shutter.  A lateral-drift stop latched the
 * guidance popup, and ~550 ms later the stitch finished and mounted the
 * post-capture review surface on top of it.  The review surface never
 * appeared, `onCapture` never fired (the review surface holds the result
 * until the user confirms, so no thumbnail either), and every subsequent
 * press on the shutter was eaten by the orphaned window — device logs showed
 * ZERO `pressIn` events reaching the button while every gate in the capture
 * state machine sat open and idle.
 *
 * These predicates are pure so the invariant can be tested over the whole
 * input space without mounting a renderer: **at most one surface visible.**
 * They are deliberately NOT "hide the newcomer" — see below.
 */

import type { LateralStopOutcome } from './lateralStopPolicy';


/**
 * Should the lateral-drift guidance popup be shown for `outcome`?
 *
 * `reviewSurfaceWillFollow` is the host's static configuration (`rectCrop ||
 * showPreview`) — i.e. whether a finalized capture opens the review surface
 * at all.
 *
 * A FINALIZED capture that is about to open the review surface shows NO
 * popup: the surface renders the very same `LATERAL_DRIFT_FINALIZE` warning
 * in its own banner, where the user is already looking, so the popup is
 * duplicate information whose only other effect is the presentation clash
 * above.  Suppressing it up front (rather than showing it and hiding it when
 * the stitch lands) also avoids a present-then-dismiss-then-present churn,
 * which is the same iOS mechanism by a slower route.
 *
 * The DISCARD outcomes always show it: nothing was kept, no review surface
 * follows, and the popup is the only feedback the user gets.
 *
 * Edge case, deliberate: if the stitch yields a zero-dimension image the
 * review surface does not mount even though `reviewSurfaceWillFollow` was
 * true, so a finalized capture shows nothing here.  That path already
 * surfaces itself through `onError`, and biasing the other way — showing the
 * popup — would reinstate the clash for every normal capture.
 */
export function lateralPopupShouldShow(
  outcome: LateralStopOutcome | null,
  reviewSurfaceWillFollow: boolean,
): boolean {
  if (outcome === null) return false;
  if (outcome === 'finalized' && reviewSurfaceWillFollow) return false;
  return true;
}


/**
 * Should the post-capture review surface (`RectCropPreview`) be shown?
 *
 * Belt-and-braces companion to {@link lateralPopupShouldShow}: even when a
 * guidance modal IS up — the orientation-drift popup, or a lateral popup on
 * a host with no review surface configured — the review surface must not try
 * to present over it.  It waits, and mounts on dismissal.
 *
 * Deferring the NEWCOMER is the safe direction.  Hiding the surface that is
 * already presented would ask iOS to dismiss and present in one commit,
 * which is the clash again with extra steps; and the pending result is held
 * safely in state either way, so waiting costs nothing but a beat.
 */
export function reviewSurfaceShouldShow(
  hasPendingResult: boolean,
  guidanceModalVisible: boolean,
): boolean {
  return hasPendingResult && !guidanceModalVisible;
}


/**
 * The invariant the two predicates above exist to hold, expressed once so a
 * test can assert it directly: no two of `<Camera>`'s capture-flow modals may
 * be visible in the same commit.
 */
export function visibleCaptureModalCount(flags: {
  lateralPopup: boolean;
  driftPopup: boolean;
  reviewSurface: boolean;
}): number {
  return (
    (flags.lateralPopup ? 1 : 0)
    + (flags.driftPopup ? 1 : 0)
    + (flags.reviewSurface ? 1 : 0)
  );
}
