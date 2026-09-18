// SPDX-License-Identifier: Apache-2.0
//
// panoPlusAndroidArm — THE ANDROID ARM'S TABLE, AND THE THREE CLAIMS IT MUST
// NEVER MAKE.
//
// The failure this suite exists for is not a crash. It is a SENTENCE: the
// operator read "pano+ … is iOS-only" on a Galaxy A35 whose engine had already
// replayed one of his own sweeps into a clean 986x1470 panorama. A screen that
// is wrong about what the build can do is worse than a screen that says
// nothing, because he acts on it — and this programme's whole discipline is
// that a capability which has not run is not certified AND a capability that
// HAS is not hidden.
//
// So the properties pinned here are about what may be SAID:
//   · the derived basis is never called `measured` (the pack's own word);
//   · the ARCore arm's two real costs — camera 0, and no AE lock — are stated
//     before the sweep rather than discovered as banding afterwards;
//   · τ = 0 is announced on EVERY Android IMU sweep, not only when a flag was
//     flipped, because it is unconditional on this platform;
//   · the iOS bag is untouched — `panoPlusArmSessionDefaults` is empty there,
//     which is what makes "the shipped surface sends the bag it always sent" a
//     property of the code rather than a claim in a comment.

import {
  PANO_PLUS_ANDROID_CANVAS_MAX_PIXELS,
  PANO_PLUS_ANDROID_PREVIEW_MAX_ALONG,
  PANO_PLUS_ANDROID_PREVIEW_MAX_CROSS,
  panoPlusAndroidArmNotice,
  panoPlusArSessionName,
  panoPlusArmContract,
  panoPlusArmSessionDefaults,
  panoPlusUnavailableDetail,
} from '../panoPlusAndroidArm';
import { resolvePanoPlusBasis, panoPlusBasisCapability } from '../panoPlusBasisAcquisition';
import type { PanoPlusBasisResolution } from '../panoPlusBasisAcquisition';

/** The basis ladder as the SURFACE feeds it on Android — through the real
 *  resolver, never a hand-built literal, so a change to the ladder that broke
 *  this arm would fail here instead of passing against a stale fixture. */
function androidBasis(over: {
  liveModule?: boolean;
  basisIndex?: number | null;
  basisLabel?: string | null;
} = {}): PanoPlusBasisResolution {
  const live = over.liveModule ?? true;
  return resolvePanoPlusBasis({
    capability: panoPlusBasisCapability('android'),
    plan: {
      ok: live,
      reason: live ? null : 'calib-unavailable',
      detail: live ? null : 'no module',
    },
    basisIndex: over.basisIndex ?? null,
    basisLabel: over.basisLabel ?? null,
  });
}

describe('panoPlusArmContract', () => {
  it('is the Android contract only on Android', () => {
    expect(panoPlusArmContract('android')).toBe('android-sensor');
    expect(panoPlusArmContract('ios')).toBe('ios-coremotion');
  });

  it('defaults an UNKNOWN platform to the shipped iOS contract', () => {
    // The conservative direction. The iOS contract's precondition read degrades
    // to an announced ARKit fallback on a platform with no calibration module;
    // the Android one would instead CLAIM a derived basis that nothing derived,
    // and a wrong C rotates the whole canvas.
    expect(panoPlusArmContract('web')).toBe('ios-coremotion');
    expect(panoPlusArmContract('')).toBe('ios-coremotion');
  });

  it('names the AR session per contract', () => {
    expect(panoPlusArSessionName('android-sensor')).toBe('ARCore');
    expect(panoPlusArSessionName('ios-coremotion')).toBe('ARKit');
  });
});

describe('the unavailable card', () => {
  it('never says iOS-only on Android — the sentence the operator read', () => {
    const a = panoPlusUnavailableDetail('android');
    expect(a).not.toMatch(/iOS-only/i);
    // It must name the artefact that actually has to be rebuilt. Naming the pod
    // on Android costs a build cycle chasing a file that is not involved.
    expect(a).toMatch(/Gradle module/);
    expect(a).toMatch(/RNImageStitcherPackage/);
  });

  it('still names the pod on iOS', () => {
    expect(panoPlusUnavailableDetail('ios')).toMatch(/pod/);
  });

  it('is a REFUSAL on both, never a capability claim', () => {
    for (const os of ['ios', 'android']) {
      expect(panoPlusUnavailableDetail(os)).toMatch(/not registered/);
    }
  });
});

describe('the session defaults', () => {
  it('are EMPTY on iOS — the shipped bag is byte-for-byte unchanged', () => {
    expect(panoPlusArmSessionDefaults('ios-coremotion')).toEqual({});
  });

  it('cap the preview box and the canvas on Android', () => {
    expect(panoPlusArmSessionDefaults('android-sensor')).toEqual({
      previewMaxAlong: PANO_PLUS_ANDROID_PREVIEW_MAX_ALONG,
      previewMaxCross: PANO_PLUS_ANDROID_PREVIEW_MAX_CROSS,
      canvasMaxPixels: PANO_PLUS_ANDROID_CANVAS_MAX_PIXELS,
    });
  });

  it('stays UNDER the native defaults it is replacing', () => {
    // Native is 2000 x 800 and 18e6. The point of these numbers is that they
    // are smaller; a "cap" that raised them would be the opposite feature and
    // would read identically in a diff.
    expect(PANO_PLUS_ANDROID_PREVIEW_MAX_ALONG).toBeLessThan(2000);
    expect(PANO_PLUS_ANDROID_PREVIEW_MAX_CROSS).toBeLessThan(800);
    expect(PANO_PLUS_ANDROID_CANVAS_MAX_PIXELS).toBeLessThan(18.0e6);
    // …and above the largest canvas this phone has actually produced
    // (2048 x 1216 = 2.5e6 on the operator's own replayed sweep). A cap below
    // the measured sweep would refuse growth on the very pack that motivated
    // the port.
    expect(PANO_PLUS_ANDROID_CANVAS_MAX_PIXELS).toBeGreaterThan(2048 * 1216 * 3);
  });
});

// ═════════════════════════════════════════════════════════════════════════
//  THE AR PILL ON ANDROID — 2026-09-02, AND THIS BLOCK IS THE INVERSE OF WHAT
//  IT SAID YESTERDAY.
//
//  ⚠ AND THEN INVERTED AGAIN, LATER THE SAME DAY. Read the three states in
//  order, because the middle one is the lesson:
//
//   1. ORIGINALLY it asserted an ARCore ARM — `effectivePoseSource: 'ar'`, a
//      headline about the lost AE lock. Every assertion was green and every one
//      was FALSE about the build: nothing fed ARCore's poses to the engine, and
//      `PanoPlusLiveModule.StartShim` answered `poseSource: "imu"`
//      unconditionally. The copy had been written from the capability PROBE —
//      what a shared-camera sweep WOULD cost — and read as a description of a
//      shipped arm. The suite pinned the COPY and not the CLAIM, which is why it
//      never caught it.
//   2. It was then inverted to assert `AR PILL IGNORED`, which was the honest
//      description of that build.
//   3. The arm was WIRED (ArCorePoseSink → a live ring → an ingest fork with no
//      basis), and this block now asserts the arm again — but against the
//      MECHANISM rather than against a paragraph: the costs it names are read
//      out of `device.json`'s `arm` block on a real A35 sweep, and the one
//      assertion that must never move is that the notice PROMISES AN ATTEMPT
//      and not an outcome, because nothing in JS can know whether ARCore will
//      open shared.
// ═════════════════════════════════════════════════════════════════════════
describe('the AR pill on Android — A REAL ARM SINCE 2026-09-02', () => {
  // ⚠ THIS BLOCK USED TO ASSERT THE OPPOSITE, AND THE OPPOSITE USED TO BE
  // TRUE. Until 2026-09-02 `PanoPlusLiveModule.start()` answered
  // `poseSource: "imu"` unconditionally and nothing fed ARCore's poses to the
  // engine, so the honest notice was "AR PILL IGNORED". The arm is now wired
  // end to end — `arcoreReference:'shared'` in the recorder's bag,
  // `ArCorePoseSink` into a live ring, the ingest solving against that ring
  // with NO basis — and these tests pin the new truth. The old assertions are
  // not softened; they are inverted, because the fact under them moved.
  const n = panoPlusAndroidArmNotice({
    poseSource: 'ar',
    liveModule: true,
    basis: androidBasis(),
  });

  it('resolves to the AR arm — the pill finally changes what runs', () => {
    // THE ASSERTION THAT MATTERS. `effectivePoseSource` is what the surface
    // puts in the start bag, and native reads it to decide whether to open the
    // shared-camera ARCore channel at all.
    expect(n.effectivePoseSource).toBe('ar');
    expect(n.canStart).toBe(true);
    // Nothing was downgraded: he asked for AR and is getting AR attempted.
    expect(n.fallbackToAr).toBe(false);
    expect(n.startLabel).toMatch(/ARCore/);
  });

  it('states the price in the headline, not only in the paragraph', () => {
    // The two costs that make an AR pack incomparable with an ultra-wide IMU
    // pack. Burying them in the detail would let the comparison the operator
    // asked for be run on two different cameras without either screen saying
    // so.
    expect(n.headline).toMatch(/AR ARM/);
    expect(n.headline).toMatch(/ULTRA-WIDE/);
    expect(n.headline).toMatch(/AE LOCK/);
  });

  it('names every measured cost: camera, exposure, rate', () => {
    expect(n.detail).toMatch(/CameraConfig/);
    expect(n.detail).toMatch(/69\.7/);          // the FOV ARCore forces
    expect(n.detail).toMatch(/CONTROL_AE_LOCK/);
    expect(n.detail).toMatch(/30 Hz/);
    expect(n.detail).toMatch(/122 Hz/);
  });

  it('promises an ATTEMPT and never an outcome', () => {
    // Nothing in JS can know whether ARCore will open shared. A notice that
    // said "runs on ARCore" would be a claim the SDK cannot keep, and the
    // operator would read an IMU pack as an AR one.
    expect(n.detail).toMatch(/ATTEMPTED, NOT PROMISED/);
    expect(n.detail).toMatch(/runs on the IMU arm instead of being lost/);
  });

  it('says the arm uses NO basis, and why that is a fact not a shortcut', () => {
    expect(n.detail).toMatch(/NO basis/);
    expect(n.detail).toMatch(/Camera\.getPose\(\)/);
    // The τ chip must be DARK here: τ is the camera↔IMU offset and this arm
    // has no IMU in its pose path, so a τ warning would describe an
    // approximation this sweep does not make.
    expect(n.tauUncorrectedRun).toBeFalsy();
  });

  it('warns rather than reading `ok`, even on a measured basis', () => {
    // A measured basis makes the IMU rung `ok`. It says nothing about the AR
    // arm, which does not use a basis at all — and the AR arm's own costs are
    // reason enough not to be green.
    expect(n.tone).toBe('warn');
    const stored = panoPlusAndroidArmNotice({
      poseSource: 'ar',
      liveModule: true,
      basis: androidBasis({ basisIndex: 8, basisLabel: '(+Y,+Z,+X)' }),
    });
    expect(stored.tone).toBe('warn');
    expect(stored.effectivePoseSource).toBe('ar');
    // …and it does NOT recite the basis it is not using.
    expect(stored.detail).not.toMatch(/C #8/);
  });

  it('refuses BOTH arms when the build carries no session module', () => {
    // The build rung is above the arm fork on purpose: an APK with no
    // RNISPanoPlus cannot open an ARCore sweep either, and describing one
    // would be the same class of promise the old copy made.
    const noModule = panoPlusAndroidArmNotice({
      poseSource: 'ar',
      liveModule: false,
      basis: androidBasis(),
    });
    expect(noModule.canStart).toBe(false);
    expect(noModule.effectivePoseSource).toBe('imu');
    expect(noModule.headline).toMatch(/NO pano\+ SESSION/);
  });
});

describe('the IMU arm', () => {
  it('runs on a DERIVED basis with no gesture and no calibration trip', () => {
    const n = panoPlusAndroidArmNotice({
      poseSource: 'imu',
      liveModule: true,
      basis: androidBasis(),
    });
    expect(n.canStart).toBe(true);
    expect(n.effectivePoseSource).toBe('imu');
    expect(n.fallbackToAr).toBe(false);
  });

  it('says DERIVED and never `measured`', () => {
    const n = panoPlusAndroidArmNotice({
      poseSource: 'imu',
      liveModule: true,
      basis: androidBasis(),
    });
    expect(n.headline).toMatch(/DERIVED, NEVER MEASURED/);
    // The pack stamps `derived`; a screen saying `measured` would leave a
    // reader no way to find out that a mounting assumption was wrong. Every
    // occurrence of the word must therefore be a DENIAL — asserted by walking
    // the occurrences rather than by one clever regex, because a regex that
    // silently stopped matching would pass this test while the claim drifted.
    for (const before of n.detail.split('`measured`').slice(0, -1)) {
      expect(before.endsWith('never ')).toBe(true);
    }
    // …and no BARE use of the word either: the walk above only constrains the
    // quoted provenance token, and "the basis was measured" in plain prose
    // would slip straight past it.
    expect(n.detail.split('`measured`').join('')).not.toMatch(/\bmeasured\b/);
    expect(n.tone).toBe('warn');
  });

  it('names the refusal that means no basis has been checked on this phone', () => {
    const n = panoPlusAndroidArmNotice({
      poseSource: 'imu',
      liveModule: true,
      basis: androidBasis(),
    });
    expect(n.detail).toMatch(/excitation-insufficient/);
  });

  it('announces τ = 0 unconditionally, not behind a flag', () => {
    // THE ONE THAT MATTERS MOST. On iOS an uncorrected sweep is a declared
    // experiment; on Android it is the only mode, so a chip driven by the
    // caller's flag would be dark on precisely the platform where the statement
    // is always true.
    const n = panoPlusAndroidArmNotice({
      poseSource: 'imu',
      liveModule: true,
      basis: androidBasis(),
    });
    expect(n.tauUncorrectedRun).toBe(true);
    expect(n.detail).toMatch(/τ IS 0 AND UNCORRECTED/);
    expect(n.detail).toMatch(/97 ms/);
  });

  it('drops the derived caveat once a basis has been MEASURED and stored', () => {
    const n = panoPlusAndroidArmNotice({
      poseSource: 'imu',
      liveModule: true,
      basis: androidBasis({ basisIndex: 8, basisLabel: '(+Y,+Z,+X)' }),
    });
    expect(n.tone).toBe('ok');
    expect(n.headline).toMatch(/BASIS MEASURED/);
    expect(n.detail).toMatch(/C #8/);
    expect(n.effectivePoseSource).toBe('imu');
    // …but τ is still 0. A measured basis says nothing about the clock.
    expect(n.tauUncorrectedRun).toBe(true);
  });

  it('REFUSES on its own terms when the derivation failed — there is no ARCore to fall back to', () => {
    // `blocked` on Android is a real state: SENSOR_ORIENTATION unread,
    // LENS_POSE_REFERENCE not GYROSCOPE, or a mirrored mounting no member of
    // the 24-candidate set can express. None is fixable at the shelf.
    const blocked: PanoPlusBasisResolution = {
      route: 'blocked',
      needsGesture: false,
      basisIndex: null,
      basisLabel: null,
      provenance: 'none',
      reason: 'hardware-refused',
      detail: 'LENS_POSE_REFERENCE is not GYROSCOPE.',
    };
    const n = panoPlusAndroidArmNotice({
      poseSource: 'imu', liveModule: true, basis: blocked,
    });
    // ⚠ THIS ASSERTION WAS INVERTED ON 2026-09-02. It used to require
    // `fallbackToAr: true` + `effectivePoseSource: 'ar'` + a button reading
    // "Sweep on ARCore instead" — a fallback that, on this platform, starts the
    // SAME IMU sweep the notice had just refused, with ARCore holding the
    // camera the recorder needs. A refusal that runs the refused thing is worse
    // than no refusal at all.
    expect(n.fallbackToAr).toBe(false);
    expect(n.effectivePoseSource).toBe('imu');
    expect(n.canStart).toBe(false);
    // The CONTROL STAYS — a state with no primary button is one the operator
    // cannot leave except backwards — but the label names the outcome instead
    // of promising a sweep.
    expect(n.startLabel).toMatch(/expect no canvas/);
    expect(n.detail).toMatch(/GYROSCOPE/);
    // And it says what actually happens without `C`, rather than implying a
    // route around it.
    expect(n.detail).toMatch(/qSource/);
    expect(n.detail).not.toMatch(/ARCore needs no basis/);
  });

  it('refuses when the live session module is not in the APK', () => {
    const n = panoPlusAndroidArmNotice({
      poseSource: 'imu',
      liveModule: false,
      basis: androidBasis({ liveModule: false }),
    });
    expect(n.fallbackToAr).toBe(false);
    expect(n.canStart).toBe(false);
    expect(n.headline).toMatch(/NO pano\+ SESSION/);
  });
});

describe('the Android basis ladder, end to end', () => {
  it('routes a live Android build to `derived` with provenance `derived`', () => {
    const b = androidBasis();
    expect(b.route).toBe('derived');
    expect(b.provenance).toBe('derived');
    // No gesture is ever offered on Android — there is nothing for one to
    // measure that two documented rotations do not already give.
    expect(b.needsGesture).toBe(false);
  });

  it('lets a STORED (measured) index outrank the derivation', () => {
    const b = androidBasis({ basisIndex: 8 });
    expect(b.route).toBe('stored');
    expect(b.provenance).toBe('measured');
  });
});
