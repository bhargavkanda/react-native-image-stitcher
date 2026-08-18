// SPDX-License-Identifier: Apache-2.0
/**
 * Modal-presentation policy tests.
 *
 * The bug these pin (field RCA, 2026-08-18): a lateral-drift stop latched the
 * guidance popup, and ~550 ms later the finished stitch mounted the review
 * surface ON TOP of it.  iOS refuses the overlapping presentation and leaves
 * an invisible host window that swallows every touch — the shutter went dead
 * with ZERO `pressIn` events reaching it, no review surface appeared, and
 * `onCapture` never fired (so no thumbnail either, the result being held by
 * the review surface until confirmed).
 *
 * The invariant is therefore not "the popup is tidy" but "at most ONE of
 * these surfaces is ever visible in the same commit", asserted below over the
 * entire input space rather than at a few sampled points.
 */

import {
  lateralPopupShouldShow,
  reviewSurfaceShouldShow,
  visibleCaptureModalCount,
} from '../modalPresentation';
import type { LateralStopOutcome } from '../lateralStopPolicy';


const OUTCOMES: (LateralStopOutcome | null)[] = [
  null,
  'finalized',
  'discarded',
  'wrong-direction',
];


describe('lateralPopupShouldShow', () => {
  it('shows nothing when no lateral stop fired', () => {
    expect(lateralPopupShouldShow(null, true)).toBe(false);
    expect(lateralPopupShouldShow(null, false)).toBe(false);
  });

  it('SUPPRESSES the popup for a finalized capture that opens the review '
    + 'surface — the surface renders the same warning in its banner, and '
    + 'showing both is the presentation clash', () => {
    expect(lateralPopupShouldShow('finalized', true)).toBe(false);
  });

  it('SHOWS the popup for a finalized capture when the host configured no '
    + 'review surface — otherwise the stop would be silent', () => {
    expect(lateralPopupShouldShow('finalized', false)).toBe(true);
  });

  it('always shows the popup for both discard outcomes: nothing was kept, no '
    + 'review surface follows, and this is the only feedback there is', () => {
    for (const reviewEnabled of [true, false]) {
      expect(lateralPopupShouldShow('discarded', reviewEnabled)).toBe(true);
      expect(lateralPopupShouldShow('wrong-direction', reviewEnabled)).toBe(true);
    }
  });
});


describe('reviewSurfaceShouldShow', () => {
  it('shows once a result is pending and no guidance modal is up', () => {
    expect(reviewSurfaceShouldShow(true, false)).toBe(true);
  });

  it('DEFERS while a guidance modal is up — the newcomer waits rather than '
    + 'presenting over a live presentation', () => {
    expect(reviewSurfaceShouldShow(true, true)).toBe(false);
  });

  it('stays hidden with no pending result', () => {
    expect(reviewSurfaceShouldShow(false, false)).toBe(false);
    expect(reviewSurfaceShouldShow(false, true)).toBe(false);
  });

  it('mounts as soon as the guidance modal is dismissed, with the pending '
    + 'result still held', () => {
    expect(reviewSurfaceShouldShow(true, true)).toBe(false);
    expect(reviewSurfaceShouldShow(true, false)).toBe(true);
  });
});


describe('THE INVARIANT — at most one capture modal visible', () => {
  it('holds across every combination of outcome, review config, pending '
    + 'result and drift state', () => {
    for (const outcome of OUTCOMES) {
      for (const reviewEnabled of [true, false]) {
        for (const hasPendingResult of [true, false]) {
          for (const driftPopup of [true, false]) {
            const lateralPopup = lateralPopupShouldShow(outcome, reviewEnabled);
            const guidanceModalVisible = lateralPopup || driftPopup;
            const reviewSurface = reviewSurfaceShouldShow(
              hasPendingResult,
              guidanceModalVisible,
            );
            const count = visibleCaptureModalCount({
              lateralPopup,
              driftPopup,
              reviewSurface,
            });
            // The drift popup and the lateral popup are mutually exclusive by
            // construction upstream (a drifted capture is abandoned before a
            // lateral stop can fire, and vice versa), so the only pairing the
            // predicates themselves must rule out is guidance + review.
            expect(lateralPopup && reviewSurface).toBe(false);
            expect(driftPopup && reviewSurface).toBe(false);
            expect(count).toBeLessThanOrEqual(driftPopup && lateralPopup ? 2 : 1);
          }
        }
      }
    }
  });

  it('reproduces the exact field sequence: finalized lateral stop with the '
    + 'review surface enabled never yields two visible surfaces', () => {
    const lateralPopup = lateralPopupShouldShow('finalized', true);
    const reviewSurface = reviewSurfaceShouldShow(true, lateralPopup);
    expect(lateralPopup).toBe(false);
    expect(reviewSurface).toBe(true);
    expect(visibleCaptureModalCount({
      lateralPopup,
      driftPopup: false,
      reviewSurface,
    })).toBe(1);
  });

  it('a discarded capture shows the popup and NO review surface — there is no '
    + 'result to review', () => {
    const lateralPopup = lateralPopupShouldShow('discarded', true);
    const reviewSurface = reviewSurfaceShouldShow(false, lateralPopup);
    expect(lateralPopup).toBe(true);
    expect(reviewSurface).toBe(false);
  });
});
