// SPDX-License-Identifier: Apache-2.0
/**
 * WHICH ARM SHOWS A PREVIEW IN WHICH STATE — the matrix, walked.
 *
 * The regression these exist for is a SENTENCE, not a crash: on 2026-09-03 the
 * Android AR arm printed "ARCore is UP, inside the sweep's own camera session"
 * while sitting at idle with the camera closed and no session anywhere. Every
 * clause was false, and nothing could have caught it because the copy lived in
 * a JSX ternary keyed on the ARM rather than on the STATE.
 */

import {
  panoPlusCameraOffNotice,
  type PanoPlusCameraOffInput,
} from '../panoPlusCameraOffNotice';

/** A live Android idle viewfinder — the state the operator should be in. */
function androidIdle(
  over: Partial<PanoPlusCameraOffInput> = {},
): PanoPlusCameraOffInput {
  return {
    armContract: 'android-sensor',
    arArmed: false,
    arReady: true,
    androidArArm: false,
    hasViewfinderView: true,
    frameSource: 'own',
    hostPreviewLive: true,
    idleFeedLive: true,
    idleReason: '',
    phase: 'idle',
    ...over,
  };
}

describe('panoPlusCameraOffNotice — a live feed says nothing', () => {
  it('is silent on the Android IMU arm at idle when the feed is up', () => {
    expect(panoPlusCameraOffNotice(androidIdle())).toBeNull();
  });

  it('is silent on the Android AR arm at idle when the feed is up', () => {
    // THE FIX, AS ONE ASSERTION. This is the case the operator reported: the
    // AR arm at idle. There is a viewfinder and it is live, so the screen
    // must say nothing at all.
    expect(
      panoPlusCameraOffNotice(androidIdle({ androidArArm: true })),
    ).toBeNull();
  });

  it.each(['starting', 'sweeping', 'finishing'] as const)(
    'is silent during %s — the sweep session feeds the same view',
    (phase) => {
      expect(
        panoPlusCameraOffNotice(
          androidIdle({ phase, idleFeedLive: false, androidArArm: true }),
        ),
      ).toBeNull();
    },
  );
});

describe('panoPlusCameraOffNotice — the false copy is gone', () => {
  it('never claims ARCore is up at idle, on either Android arm', () => {
    for (const androidArArm of [true, false]) {
      const text = panoPlusCameraOffNotice(
        androidIdle({
          androidArArm,
          idleFeedLive: false,
          idleReason: 'the camera did not reach a configured preview.',
        }),
      );
      expect(text).not.toBeNull();
      // The exact sentence that shipped, and the claim behind it.
      expect(text).not.toContain('ARCore is UP');
      expect(text).not.toMatch(/ARCore is UP/i);
      expect(text).not.toContain('sweep’s own camera session');
    }
  });

  it('reports native’s reason at idle instead of guessing from the arm', () => {
    const reason = 'no viewfinder surface was offered within 1500ms.';
    expect(
      panoPlusCameraOffNotice(
        androidIdle({ androidArArm: true, idleFeedLive: false, idleReason: reason }),
      ),
    ).toBe(`No live camera feed — ${reason}`);
  });

  it('falls back to a plain line when native gave no reason', () => {
    expect(
      panoPlusCameraOffNotice(
        androidIdle({ idleFeedLive: false, idleReason: '   ' }),
      ),
    ).toBe('The camera has not opened yet.');
  });

  it('reports "not opened yet" during a re-open, never a stale success line', () => {
    // The surface clears `idleReason` on success precisely so this window —
    // `idleFeedLive` false for one round-trip while the next open resolves —
    // cannot render native's LIVE sentence under a "no feed" heading.
    const text = panoPlusCameraOffNotice(
      androidIdle({ androidArArm: true, idleFeedLive: false, idleReason: '' }),
    );
    expect(text).toBe('The camera has not opened yet.');
    expect(text).not.toContain('LIVE');
  });

  it('names a build with no viewfinder component as exactly that', () => {
    const text = panoPlusCameraOffNotice(
      androidIdle({ idleFeedLive: false, hasViewfinderView: false }),
    );
    expect(text).toContain('No viewfinder in this build');
  });
});

describe('panoPlusCameraOffNotice — a sweep with no viewfinder is HEADLESS', () => {
  it('says the pack is still being recorded, on the AR arm', () => {
    const text = panoPlusCameraOffNotice(
      androidIdle({
        phase: 'sweeping',
        androidArArm: true,
        hasViewfinderView: false,
      }),
    );
    // The operator's instinct on a black screen is to stop and restart, which
    // throws away a good pack. The copy has to head that off.
    expect(text).toContain('still recording');
    expect(text).toContain('ARCore owns the camera');
  });

  it('does not blame ARCore on the IMU arm', () => {
    const text = panoPlusCameraOffNotice(
      androidIdle({
        phase: 'sweeping',
        androidArArm: false,
        hasViewfinderView: false,
      }),
    );
    expect(text).toContain('still recording');
    expect(text).not.toContain('ARCore');
  });
});

describe('panoPlusCameraOffNotice — iOS keeps the behaviour it shipped', () => {
  const ios: PanoPlusCameraOffInput = {
    armContract: 'ios-coremotion',
    arArmed: true,
    arReady: false,
    androidArArm: false,
    hasViewfinderView: false,
    frameSource: 'own',
    hostPreviewLive: true,
    idleFeedLive: false,
    idleReason: '',
    phase: 'idle',
  };

  it('shows the warm-up line while the AR view is inside its swap grace', () => {
    expect(panoPlusCameraOffNotice(ios)).toBe('Starting the camera…');
  });

  it('goes silent once ARKit is ready — it draws its own view', () => {
    expect(panoPlusCameraOffNotice({ ...ios, arReady: true })).toBeNull();
  });

  it('reports the idle refusal on the iOS IMU arm too', () => {
    expect(
      panoPlusCameraOffNotice({
        ...ios,
        arArmed: false,
        arReady: true,
        hasViewfinderView: true,
        idleReason: 'ARKit holds the camera.',
      }),
    ).toBe('No live camera feed — ARKit holds the camera.');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  THE OTHER HALF: THERE ARE PIXELS, AND THEY DO NOT MATCH
// ═══════════════════════════════════════════════════════════════════════════
//
// The explainer above is for a screen with NO picture. This is the case the
// same incident has on its other side and which no notice covered: a
// viewfinder that is UP, sharp and live, running at a rate the sweep will not
// — iOS names it "PREVIEW FORMAT NOT APPLIED … this viewfinder does NOT match
// what the sweep will record" (`RNISPanoAvfSource.swift:400`), and Android
// answers the same fact as a FLAG (`previewFpsApplied`) precisely so the panel
// does not have to parse it back out of an English sentence. A wrong
// viewfinder that looks right is worse than a black one, and until this
// function nothing on the screen could say so.

import { panoPlusPreviewPinNotice } from '../panoPlusCameraOffNotice';

describe('panoPlusPreviewPinNotice — the viewfinder that does not match', () => {
  const live = {
    applied: false as boolean | null,
    range: '[60, 60]',
    note: 'camera 0 REFUSED CONTROL_AE_TARGET_FPS_RANGE [60, 60] (IllegalArgumentException) '
      + 'even though it advertises it; the viewfinder is up at the HAL\'s own rate and does '
      + 'NOT match what the sweep will record',
    idleFeedLive: true,
    phase: 'idle' as const,
  };

  it('prints native\'s own sentence when the pin was declined', () => {
    const text = panoPlusPreviewPinNotice(live);
    expect(text).not.toBeNull();
    expect(text).toContain('does NOT match what the sweep will record');
  });

  it('is silent when the pin APPLIED — a matching viewfinder explains itself', () => {
    expect(panoPlusPreviewPinNotice({ ...live, applied: true })).toBeNull();
  });

  it('is silent when the build does not report the pin at all', () => {
    // Every iOS build and every Android binary before 2026-09-07. Silence is
    // not evidence of a fault, and printing one here would be inventing it.
    expect(
      panoPlusPreviewPinNotice({ ...live, applied: null, note: '', range: null }),
    ).toBeNull();
  });

  it('is silent when there are no pixels — the explainer owns that screen', () => {
    // A rate complaint stacked under "No live camera feed —" is two notices
    // about one camera, and the one that matters is the one about the feed.
    expect(panoPlusPreviewPinNotice({ ...live, idleFeedLive: false })).toBeNull();
  });

  it.each(['starting', 'sweeping', 'finishing'] as const)(
    'is silent during %s — the idle session is gone and the sweep pins its own rate',
    (phase) => {
      expect(panoPlusPreviewPinNotice({ ...live, phase })).toBeNull();
    },
  );

  it('still says something when native declined without a sentence', () => {
    // `previewFpsNote` is never empty on the Android path that sets
    // `previewFpsApplied` (`PanoPlusLiveModule.kt:935-941`), but a flag
    // without its words must not degrade into silence — the flag is the fact.
    const text = panoPlusPreviewPinNotice({ ...live, note: '  ' });
    expect(text).not.toBeNull();
    expect(text).toContain('[60, 60]');
  });

  // ── THE SAME FAULT WITH THE OTHER PLATFORM'S NOUN ────────────────────────
  //
  // iOS pins the FORMAT and the RATE together, under one
  // `lockForConfiguration()` (`RNISPanoAvfSource.swift:383-389`), and reports
  // the pair as `previewFormatApplied`. So when it declines, "RATE NOT PINNED"
  // is true but half the story: the viewfinder is also the wrong SHAPE, which
  // is the half the operator found in the field — `.high` 16:9 framing for a
  // 4:3 sweep, "a band above and below what he had framed"
  // (`RNISPanoAvfSource.swift:335-345`). `subject` picks the honest noun;
  // Android passes nothing and keeps its own words byte-for-byte.

  it('names the FRAMING, not just the rate, when iOS declined the whole pin', () => {
    const text = panoPlusPreviewPinNotice({
      ...live, subject: 'framing', note: '', range: null,
    });
    expect(text).not.toBeNull();
    expect(text).toContain('VIEWFINDER DOES NOT MATCH THE SWEEP');
    expect(text).toContain('shape');
    // The rate is part of it too — one lock declined both.
    expect(text).toContain('rate');
  });

  it('keeps Android\'s headline when no subject is given — the default is the rate', () => {
    expect(panoPlusPreviewPinNotice(live)).toContain('VIEWFINDER RATE NOT PINNED');
    expect(panoPlusPreviewPinNotice({ ...live, subject: 'rate' }))
      .toContain('VIEWFINDER RATE NOT PINNED');
  });

  it('is silent on the framing subject for the SAME four reasons', () => {
    const framing = { ...live, subject: 'framing' as const };
    expect(panoPlusPreviewPinNotice({ ...framing, applied: true })).toBeNull();
    expect(panoPlusPreviewPinNotice({ ...framing, applied: null })).toBeNull();
    expect(panoPlusPreviewPinNotice({ ...framing, idleFeedLive: false })).toBeNull();
    expect(panoPlusPreviewPinNotice({ ...framing, phase: 'sweeping' })).toBeNull();
  });
});

// ── THE AR WAIT MESSAGE MUST SAY WHY (2026-09-10) ────────────────────────────
//
// ⚠ THE OPERATOR SAT ON "Waiting for AR tracking" THROUGH FOUR ATTEMPTS. Its
// advice — point at textured shelf and hold steady — is actively WRONG for the
// reason he was actually hitting: ARCore reported INSUFFICIENT_LIGHT on 126 of
// 186 poses in a dark room, where holding steady forever changes nothing. The
// reason was written into every pack and reached the screen never.
describe('the AR wait message names ARCore’s own reason', () => {
  const { panoPlusGuidance } = require('../panoPlusModel');
  const waiting = (arTrackingFailure: string) =>
    panoPlusGuidance({
      ...({} as Record<string, unknown>),
      phase: 'recording',
      tracking: 0,
      arTrackingFailure,
      abort: null,
      seq: 5,
      frames: 5,
      painted: 0,
      stalled: false,
    } as never);

  it('does NOT blame the light — the label is a bootstrap timeout, not a photometer', () => {
    // ⚠ THIS TEST WAS WRONG WHEN IT WAS WRITTEN AND IT PASSED. It asserted the
    // headline "Too dark for AR" against a label that measurement later showed
    // has nothing to do with light: it first appears at ARCore row 60 in 12 of
    // 13 failing packs, ~2.0 s in, latches, and never clears, while ISO across
    // the corpus spans 30 to 1911 without moving it. A green test around a
    // false claim is worse than no test, so it is inverted here rather than
    // deleted — the old wording must never come back.
    const n = waiting('INSUFFICIENT_LIGHT');
    expect(n?.headline).toBe('AR tracking did not start');
    expect(n?.detail).not.toContain('Turn a light on');
    expect(n?.detail).toContain('says nothing about the light');
    // The escape hatch matters as much as the diagnosis: the sweep does not
    // need AR at all, and he was never told that while stuck.
    expect(n?.detail).toContain('IMU');
  });

  it('distinguishes no-texture from no-light — they need opposite actions', () => {
    expect(waiting('INSUFFICIENT_FEATURES')?.headline).toBe('Not enough texture for AR');
    expect(waiting('EXCESSIVE_MOTION')?.headline).toBe('Moving too fast for AR');
  });

  it('prints an UNKNOWN reason raw rather than swallowing it', () => {
    // A reason this build has no phrasing for is still worth more than a
    // generic wait he has already watched fail: he can read it back to me.
    const n = waiting('SOME_FUTURE_ARCORE_REASON');
    expect(n?.detail).toContain('SOME_FUTURE_ARCORE_REASON');
  });

  it('falls back to the original wording only when ARCore gave no reason', () => {
    const n = waiting('');
    expect(n?.headline).toBe('Waiting for AR tracking');
    expect(n?.detail).toContain('hold steady');
  });
});

/**
 * ── THE HOST ARM (S7) ────────────────────────────────────────────────────
 *
 * When `<Camera>` owns the camera, the sweep surface opens no session — so
 * every input this module reads goes to its "nothing is live" value while
 * vision-camera's feed is drawn RIGHT BEHIND the surface. Before
 * `frameSource` existed, the function fell through all of them and printed
 * "The camera has not opened yet." over that live feed.
 *
 * The rows below are the worst case on purpose: they are the exact inputs
 * that produced each of the four captions on the own arm, so if any future
 * branch stops honouring the host arm, one of them starts printing again.
 */
describe('panoPlusCameraOffNotice — the host owns the camera', () => {
  const host = (over: Partial<PanoPlusCameraOffInput> = {}) =>
    panoPlusCameraOffNotice(androidIdle({
      frameSource: 'host',
      hostPreviewLive: true,
      // What the host arm actually reports: the idle effect never runs, so
      // the feed reads dead and native never gives a reason.
      idleFeedLive: false,
      idleReason: '',
      ...over,
    }));

  it('says nothing at idle — the pixels behind it are vision-camera\'s', () => {
    expect(host()).toBeNull();
  });

  it('says nothing while sweeping', () => {
    // ⚠ `hasViewfinderView: false` IS LOAD-BEARING. With it left true this
    // row reached the "there is something live" branch
    // (`hasViewfinderView && sweepOwnsCamera(phase)`) and returned null
    // whoever owned the camera — so it passed with the host-arm guard
    // DELETED and exercised none of the code it is filed under. Measured.
    expect(host({ phase: 'sweeping', hasViewfinderView: false })).toBeNull();
  });

  it('says nothing when this build has no native viewfinder — it needs none', () => {
    expect(host({ hasViewfinderView: false })).toBeNull();
  });

  it('says nothing even when native volunteers an idle reason', () => {
    expect(host({ idleReason: 'no camera permission' })).toBeNull();
  });

  it('⚑ NEGATIVE CONTROL: every one of those inputs DOES print on the own arm', () => {
    // Without this the rows above pass for a trivial reason — a function
    // that returned null unconditionally would satisfy them all. Run as a
    // TABLE rather than one sample, because a single sample is what let the
    // sweeping row sit here exercising nothing: each input must produce a
    // caption on the own arm, or the matching host row proves nothing.
    const rows: Array<[string, Partial<PanoPlusCameraOffInput>]> = [
      ['idle', {}],
      ['sweeping', { phase: 'sweeping', hasViewfinderView: false }],
      ['no viewfinder in build', { hasViewfinderView: false }],
      ['native gave a reason', { idleReason: 'no camera permission' }],
    ];
    const silent = rows
      .filter(([, over]) => panoPlusCameraOffNotice(androidIdle({
        frameSource: 'own', idleFeedLive: false, idleReason: '', ...over,
      })) == null)
      .map(([name]) => name);
    expect(silent).toEqual([]);
  });
});

/**
 * ── THE HANDOFF WINDOW ──────────────────────────────────────────────────
 *
 * `frameSource: 'host'` answers who OWNS the camera. For the ~600 ms of an
 * ownership flip the host says `'host'` — so whoever held a camera lets go
 * — while mounting NOTHING, so the loser's release finishes before the
 * winner opens. Reading ownership as "there are pixels" put this module
 * straight back into the state it exists to prevent: a black screen with
 * the one component that would have described it deliberately silenced.
 */
describe('panoPlusCameraOffNotice — the camera is being handed over', () => {
  const handoff = (over: Partial<PanoPlusCameraOffInput> = {}) =>
    panoPlusCameraOffNotice(androidIdle({
      frameSource: 'host',
      hostPreviewLive: false,          // told 'host', nothing drawn yet
      idleFeedLive: false,
      idleReason: '',
      ...over,
    }));

  it('⚑ SAYS SOMETHING when the host owns the camera but is not drawing', () => {
    expect(handoff()).toBe('Handing the camera over…');
  });

  it('says it while sweeping too — the window does not care about phase', () => {
    expect(handoff({ phase: 'sweeping', hasViewfinderView: false }))
      .toBe('Handing the camera over…');
  });

  it('⚑ and goes quiet the moment the preview is actually up', () => {
    // The pair that makes the row above meaningful: the ONLY difference is
    // `hostPreviewLive`, so this is the flag being read, not some other
    // branch happening to fire.
    expect(handoff({ hostPreviewLive: true })).toBeNull();
  });

  it('⚑ never offers an ACTION — the window clears itself', () => {
    // The other captions name something the operator can do. This one must
    // not, because there is nothing to do and it is gone in 600 ms.
    const text = handoff() ?? '';
    for (const verb of ['Turn', 'switch', 'Try again', 'restart']) {
      expect(text).not.toContain(verb);
    }
  });
});
