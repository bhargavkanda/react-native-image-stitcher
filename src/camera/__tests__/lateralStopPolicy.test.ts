// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the lateral-stop policy — the pure decision behind "a
 * sideways drift stopped this capture: keep what was captured, or bin it?"
 *
 * Two things here are load-bearing:
 *
 *   1. **`minFrames === 0` means ALWAYS DISCARD.**  The natural
 *      implementation (`count >= minFrames`) is unconditionally TRUE at 0,
 *      i.e. it silently means "always FINALIZE" — the exact opposite of what
 *      a host asking for 0 wants.  The 0 cases below exist to fail loudly if
 *      the explicit guard is ever refactored away.
 *   2. **The default is 5, and that is a BEHAVIOUR CHANGE.**  The old code
 *      hardcoded `MIN_STITCHABLE_KEYFRAMES = 2`, so a 2-to-4-keyframe drifted
 *      capture used to finalize and now discards.  The tests pin the new
 *      default AND pin that the old behaviour is still reachable by passing
 *      `2` explicitly — that escape hatch is what we tell hosts to use.
 *
 * Pure-TS test per jest.config.js — `lateralStopPolicy.ts` imports nothing at
 * all (no React, no react-native, no native module), so no stubbing is needed.
 */

import {
  DEFAULT_LATERAL_STOP_FINALIZE_MIN_FRAMES,
  lateralStopOutcome,
  normaliseLateralStopFinalizeMinFrames,
  shouldFinalizeLateralStop,
  type LateralStopOutcome,
} from '../lateralStopPolicy';
import {
  DEFAULT_GUIDANCE_COPY,
  lateralStopCopyFor,
} from '../cameraGuidanceCopy';

const SOME_COUNTS = [0, 1, 2, 3, 4, 5, 10, 50];

describe('shouldFinalizeLateralStop', () => {
  describe('minFrames = 0 → ALWAYS DISCARD (the `count >= 0` trap)', () => {
    it.each(SOME_COUNTS)(
      'discards at any accepted-keyframe count: %i',
      (count) => {
        expect(shouldFinalizeLateralStop(count, 0)).toBe(false);
      },
    );

    it('discards even at an absurdly large count', () => {
      expect(shouldFinalizeLateralStop(1_000_000, 0)).toBe(false);
    });

    it('is NOT satisfiable — no count finalizes at 0', () => {
      const anyFinalized = SOME_COUNTS.some((c) =>
        shouldFinalizeLateralStop(c, 0),
      );
      expect(anyFinalized).toBe(false);
    });
  });

  describe('default (5) — the boundary, and the behaviour change', () => {
    it('the exported default is 5, NOT the old hardcoded 2', () => {
      expect(DEFAULT_LATERAL_STOP_FINALIZE_MIN_FRAMES).toBe(5);
    });

    it('count 0 → discard', () => {
      expect(shouldFinalizeLateralStop(0, 5)).toBe(false);
    });
    it('count 4 → discard (one short of the boundary)', () => {
      expect(shouldFinalizeLateralStop(4, 5)).toBe(false);
    });
    it('count 5 → finalize (the boundary is inclusive)', () => {
      expect(shouldFinalizeLateralStop(5, 5)).toBe(true);
    });
    it('count 6 → finalize', () => {
      expect(shouldFinalizeLateralStop(6, 5)).toBe(true);
    });

    it('omitting the prop matches passing 5, at every count', () => {
      for (const count of SOME_COUNTS) {
        expect(shouldFinalizeLateralStop(count, undefined)).toBe(
          shouldFinalizeLateralStop(count, 5),
        );
      }
    });

    it.each([2, 3, 4])(
      'BEHAVIOUR CHANGE: count %i finalized under the old hardcoded 2 and '
      + 'now discards at the default',
      (count) => {
        expect(shouldFinalizeLateralStop(count, 2)).toBe(true);
        expect(shouldFinalizeLateralStop(count, undefined)).toBe(false);
      },
    );
  });

  describe('explicit 2 — the documented escape hatch (regression)', () => {
    // This is what we tell hosts to pass to keep the pre-policy behaviour, so
    // it has to keep working even though it is no longer the default.
    it('count 1 → discard (too few frames to stitch)', () => {
      expect(shouldFinalizeLateralStop(1, 2)).toBe(false);
    });
    it('count 2 → finalize (the old inclusive boundary)', () => {
      expect(shouldFinalizeLateralStop(2, 2)).toBe(true);
    });
    it('count 3 → finalize', () => {
      expect(shouldFinalizeLateralStop(3, 2)).toBe(true);
    });
    it('reproduces the old hardcoded rule at every count', () => {
      for (const count of SOME_COUNTS) {
        expect(shouldFinalizeLateralStop(count, 2)).toBe(count >= 2);
      }
    });
  });

  describe('N = 1 — the loosest keep-anything setting', () => {
    it('count 0 → discard (nothing was captured)', () => {
      expect(shouldFinalizeLateralStop(0, 1)).toBe(false);
    });
    it('count 1 → finalize (honoured literally, no hidden floor at 2)', () => {
      expect(shouldFinalizeLateralStop(1, 1)).toBe(true);
    });
  });

  describe('malformed thresholds normalise to the default', () => {
    const MALFORMED: (number | undefined)[] = [
      undefined,
      -1,
      -2,
      -0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ];

    it.each(MALFORMED)('%p behaves exactly like the default', (minFrames) => {
      for (const count of SOME_COUNTS) {
        expect(shouldFinalizeLateralStop(count, minFrames)).toBe(
          shouldFinalizeLateralStop(
            count,
            DEFAULT_LATERAL_STOP_FINALIZE_MIN_FRAMES,
          ),
        );
      }
    });

    it('a negative threshold does NOT become "always discard"', () => {
      // Guards the tempting `Math.max(0, minFrames)` clamp, which would turn
      // a host's typo into "throw every capture away".  A negative value must
      // land on the DEFAULT (5), so a 5-keyframe capture still finalizes.
      expect(shouldFinalizeLateralStop(5, -1)).toBe(true);
      expect(shouldFinalizeLateralStop(4, -1)).toBe(false);
    });

    it('a non-finite ACCEPTED COUNT discards rather than propagating NaN', () => {
      expect(shouldFinalizeLateralStop(Number.NaN, 2)).toBe(false);
    });
  });

  describe('fractional thresholds round UP (whole frames only)', () => {
    it('2.5 needs 3 frames', () => {
      expect(shouldFinalizeLateralStop(2, 2.5)).toBe(false);
      expect(shouldFinalizeLateralStop(3, 2.5)).toBe(true);
    });
    it('0.5 is not the always-discard 0', () => {
      expect(shouldFinalizeLateralStop(1, 0.5)).toBe(true);
    });
  });
});

describe('normaliseLateralStopFinalizeMinFrames', () => {
  it('passes through valid whole counts', () => {
    expect(normaliseLateralStopFinalizeMinFrames(1)).toBe(1);
    expect(normaliseLateralStopFinalizeMinFrames(5)).toBe(5);
  });
  it('preserves 0 — it is a setting, not a missing value', () => {
    expect(normaliseLateralStopFinalizeMinFrames(0)).toBe(0);
  });
  it('rounds fractions up', () => {
    expect(normaliseLateralStopFinalizeMinFrames(2.1)).toBe(3);
  });
  it.each([undefined, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    '%p → the default',
    (v) => {
      expect(normaliseLateralStopFinalizeMinFrames(v)).toBe(
        DEFAULT_LATERAL_STOP_FINALIZE_MIN_FRAMES,
      );
    },
  );
});

describe('lateralStopOutcome', () => {
  it('finalize → "finalized"', () => {
    expect(lateralStopOutcome(5, 5)).toBe<LateralStopOutcome>('finalized');
    expect(lateralStopOutcome(2, 2)).toBe<LateralStopOutcome>('finalized');
  });

  it('discard with nothing stitchable → "wrong-direction" (unchanged UX)', () => {
    expect(lateralStopOutcome(0, 2)).toBe<LateralStopOutcome>(
      'wrong-direction',
    );
    expect(lateralStopOutcome(1, 2)).toBe<LateralStopOutcome>(
      'wrong-direction',
    );
  });

  it('discard of a STITCHABLE capture → "discarded" (the new state)', () => {
    expect(lateralStopOutcome(4, 5)).toBe<LateralStopOutcome>('discarded');
    expect(lateralStopOutcome(50, 0)).toBe<LateralStopOutcome>('discarded');
  });

  it('at minFrames 0 a 1-frame stop still reads as wrong-direction', () => {
    // Nothing stitchable was captured either way, so the "follow the arrow"
    // coaching is more useful than "we discarded it".
    expect(lateralStopOutcome(1, 0)).toBe<LateralStopOutcome>(
      'wrong-direction',
    );
  });

  describe('the three-way split AT THE DEFAULT (threshold 5)', () => {
    // Requirement: below 2 the operator still gets the "follow the arrow"
    // coaching; the new 2-to-4 band must read as DISCARDED — not as
    // wrong-direction, and emphatically not as the finalized copy, which
    // would promise a stitch that never happened.
    it.each([0, 1])('count %i → "wrong-direction"', (count) => {
      expect(lateralStopOutcome(count, undefined)).toBe<LateralStopOutcome>(
        'wrong-direction',
      );
    });

    it.each([2, 3, 4])('count %i → "discarded"', (count) => {
      expect(lateralStopOutcome(count, undefined)).toBe<LateralStopOutcome>(
        'discarded',
      );
    });

    it.each([5, 6, 10, 50])('count %i → "finalized"', (count) => {
      expect(lateralStopOutcome(count, undefined)).toBe<LateralStopOutcome>(
        'finalized',
      );
    });

    it('the 2-to-4 band never shows the stitch-promising copy', () => {
      for (const count of [2, 3, 4]) {
        const { body } = lateralStopCopyFor(
          lateralStopOutcome(count, undefined),
          DEFAULT_GUIDANCE_COPY,
        );
        expect(body).not.toBe(DEFAULT_GUIDANCE_COPY.lateralStopBody);
        expect(body).toBe(DEFAULT_GUIDANCE_COPY.lateralStopDiscardedBody);
      }
    });
  });

  it('"discarded" IS unreachable at the escape-hatch threshold of 2', () => {
    // Passing 2 restores the pre-policy world, where only the two original
    // states exist.
    for (const count of SOME_COUNTS) {
      expect(lateralStopOutcome(count, 2)).not.toBe('discarded');
    }
  });
});

describe('lateralStopCopyFor', () => {
  it('"finalized" keeps the existing stitch-promising copy', () => {
    expect(lateralStopCopyFor('finalized', DEFAULT_GUIDANCE_COPY)).toEqual({
      title: DEFAULT_GUIDANCE_COPY.lateralStopTitle,
      body: DEFAULT_GUIDANCE_COPY.lateralStopBody,
    });
  });

  it('"wrong-direction" keeps the existing follow-the-arrow copy', () => {
    expect(lateralStopCopyFor('wrong-direction', DEFAULT_GUIDANCE_COPY))
      .toEqual({
        title: DEFAULT_GUIDANCE_COPY.lateralWrongDirectionTitle,
        body: DEFAULT_GUIDANCE_COPY.lateralWrongDirectionBody,
      });
  });

  it('"discarded" uses the new discarded copy', () => {
    expect(lateralStopCopyFor('discarded', DEFAULT_GUIDANCE_COPY)).toEqual({
      title: DEFAULT_GUIDANCE_COPY.lateralStopDiscardedTitle,
      body: DEFAULT_GUIDANCE_COPY.lateralStopDiscardedBody,
    });
  });

  it('the discarded body does NOT promise a stitch', () => {
    // The whole reason this third state exists: `lateralStopBody` says "we
    // stitched what you captured", which is a lie for a discarded capture and
    // sends the operator hunting for a file that was never written.
    const { body } = lateralStopCopyFor('discarded', DEFAULT_GUIDANCE_COPY);
    expect(body).not.toMatch(/stitch/i);
    expect(body).toMatch(/discard/i);
  });

  it('honours a host copy override for every state', () => {
    const override = {
      ...DEFAULT_GUIDANCE_COPY,
      lateralStopTitle: 'ES finalized',
      lateralWrongDirectionTitle: 'ES arrow',
      lateralStopDiscardedTitle: 'ES discarded',
    };
    expect(lateralStopCopyFor('finalized', override).title)
      .toBe('ES finalized');
    expect(lateralStopCopyFor('wrong-direction', override).title)
      .toBe('ES arrow');
    expect(lateralStopCopyFor('discarded', override).title)
      .toBe('ES discarded');
  });
});
