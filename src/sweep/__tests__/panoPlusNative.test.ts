// SPDX-License-Identifier: Apache-2.0
//
// panoPlusNative — the module resolver + the marshalling into `start()`.
//
// What these pin, and the failure each one prevents:
//
//   1. DEGRADATION, NOT CRASH. Android, a jest env, or an app built before the
//      private pod landed has no `RNISPanoPlus`. Every entry point must
//      resolve/reject in a way the surface can render, and `cancel()` in
//      particular must ALWAYS resolve — a cancel that can fail leaves the
//      native session latched and every later `start()` rejects
//      `panoplus-busy` for the life of the process.
//   2. WHAT CROSSES THE BRIDGE IS WHAT THE CALLER CHOSE. `undefined` values are
//      stripped so native sees only keys someone actually set. Stated honestly:
//      today's native helpers all guard with `isKindOfClass:`, so an NSNull
//      would already fall back — this pins the JS side so a future native
//      helper written as a plain `[v doubleValue]` (NSNull answers 0) cannot
//      silently run the engine at `stripMargin: 0` with nothing in JS looking
//      different. An explicit `false` must NOT be stripped.
//   3. PER-METHOD PROBING. A module object existing is not evidence its
//      methods are linked (the codebase's standing typeof-probe rule).
//   4. CALL-TIME resolution, so a test assigning NativeModules after import
//      behaves like a real registry.

import { NativeModules } from 'react-native';

import {
  cancelPanoPlus,
  getPanoPlusStatus,
  panoPlusIsAvailable,
  setPanoPlusIdlePreview,
  startPanoPlus,
  stopPanoPlus,
} from '../panoPlusNative';
import { panoPlusErrorInfo } from '../panoPlusModel';
import type { PanoPlusFailure } from '../panoPlusTypes';

const NM = NativeModules as Record<string, unknown>;

afterEach(() => {
  delete NM.RNISPanoPlus;
});

describe('availability', () => {
  it('is false with no module linked', () => {
    expect(panoPlusIsAvailable()).toBe(false);
  });

  it('is false for a PARTIAL module — presence is not linkage', () => {
    NM.RNISPanoPlus = { start: () => undefined };
    expect(panoPlusIsAvailable()).toBe(false);
  });

  it('is true once start/stop/cancel are all callable, resolved at CALL time', () => {
    NM.RNISPanoPlus = {
      start: () => Promise.resolve({}),
      stop: () => Promise.resolve({}),
      cancel: () => Promise.resolve({}),
      getStatus: () => Promise.resolve({}),
    };
    expect(panoPlusIsAvailable()).toBe(true);
  });
});

describe('degraded build', () => {
  it('start rejects with a code the shared failure reader understands', async () => {
    await expect(startPanoPlus({ sessionDir: '/d' })).rejects.toThrow();
    // `.catch` widens the union with the success type, so the failure is read
    // through an explicit try/catch — the same shape a caller uses.
    let info: PanoPlusFailure | null = null;
    try {
      await startPanoPlus({ sessionDir: '/d' });
    } catch (e) {
      info = panoPlusErrorInfo(e);
    }
    expect(info?.code).toBe('panoplus-unavailable');
  });

  it('cancel ALWAYS resolves — a failed cancel would latch the native session', async () => {
    await expect(cancelPanoPlus()).resolves.toBeUndefined();
  });

  it('getStatus resolves null rather than rejecting', async () => {
    await expect(getPanoPlusStatus()).resolves.toBeNull();
  });
});

describe('start marshalling', () => {
  it('strips undefined values so native falls back to ITS defaults', async () => {
    let seen: Record<string, unknown> | null = null;
    NM.RNISPanoPlus = {
      start: (o: Record<string, unknown>) => {
        seen = o;
        return Promise.resolve({ sessionDir: o.sessionDir, startedAtMs: 1, pluginAvailable: true });
      },
      stop: () => Promise.resolve({}),
      cancel: () => Promise.resolve({}),
    };
    await startPanoPlus({
      sessionDir: '/d/pp_1',
      rectify: true,
      // An explicit `undefined` is how a host spells "I did not choose this" —
      // it must not reach native as a key at all.
      stripMargin: undefined,
      canvasScale: undefined,
      gainMatch: false,
    });
    expect(seen).not.toBeNull();
    expect(Object.keys(seen!).sort()).toEqual(['gainMatch', 'rectify', 'sessionDir']);
    expect(seen!.gainMatch).toBe(false); // an explicit false is NOT stripped
  });

  it('falls back to the requested sessionDir if native omits it', async () => {
    NM.RNISPanoPlus = {
      start: () => Promise.resolve({}),
      stop: () => Promise.resolve({}),
      cancel: () => Promise.resolve({}),
    };
    const r = await startPanoPlus({ sessionDir: '/d/pp_2' });
    expect(r.sessionDir).toBe('/d/pp_2');
    expect(r.pluginAvailable).toBe(false);
  });
});

describe('stop', () => {
  it('coerces the summary rather than trusting the dict shape', async () => {
    NM.RNISPanoPlus = {
      start: () => Promise.resolve({}),
      stop: () =>
        Promise.resolve({
          sessionDir: '/d/pp_3',
          canvasPath: '/d/pp_3/canvas.jpg',
          width: 4000,
          height: 600,
          counts: { seen: 300, painted: 290 },
          unpaintedRuns: [[10, 20]],
        }),
      cancel: () => Promise.resolve({}),
    };
    const s = await stopPanoPlus();
    expect(s.width).toBe(4000);
    expect(s.counts.painted).toBe(290);
    expect(s.unpaintedRuns).toEqual([[10, 20]]);
    // Absent keys are zero-filled, not undefined — the review renders numbers.
    expect(s.droppedQueue).toBe(0);
    expect(s.abort).toBeNull();
  });

  it('passes a native rejection through UNMODIFIED so its userInfo survives', async () => {
    const nativeError = Object.assign(new Error('The sweep produced no panorama.'), {
      code: 'panoplus-empty',
      userInfo: { sessionDir: '/d/pp_4', abort: 'chain-lost', counts: { seen: 12 } },
    });
    NM.RNISPanoPlus = {
      start: () => Promise.resolve({}),
      stop: () => Promise.reject(nativeError),
      cancel: () => Promise.resolve({}),
    };
    let info: PanoPlusFailure | null = null;
    try {
      await stopPanoPlus();
    } catch (e) {
      info = panoPlusErrorInfo(e);
    }
    expect(info?.code).toBe('panoplus-empty');
    expect(info?.sessionDir).toBe('/d/pp_4');
    expect(info?.abort).toBe('chain-lost');
  });
});

describe('idle viewfinder — the lens that is live rides the answer', () => {
  // pano+ ⇄ Pano parity (2026-09-03): native's `setIdlePreview` resolves the
  // AVF source's own report — `on`, a reason sentence, and the lens that is
  // live in both spellings — so the viewfinder note can say which camera the
  // operator is framing through instead of inferring it from the request.
  const base = {
    start: () => Promise.resolve({}),
    stop: () => Promise.resolve({}),
    cancel: () => Promise.resolve({}),
  };

  it('keeps lens and lensRequested when native sends them', async () => {
    NM.RNISPanoPlus = {
      ...base,
      setIdlePreview: () => Promise.resolve({
        on: true,
        reason: 'idle viewfinder LIVE on the 1× wide (AVCaptureDeviceTypeBuiltInWideAngleCamera)',
        lens: 'AVCaptureDeviceTypeBuiltInWideAngleCamera',
        lensRequested: 'wide',
      }),
    };
    const r = await setPanoPlusIdlePreview(true, { lens: 'wide', poseSource: 'imu' });
    expect(r.on).toBe(true);
    expect(r.lens).toBe('AVCaptureDeviceTypeBuiltInWideAngleCamera');
    expect(r.lensRequested).toBe('wide');
  });

  it('is null — never a guessed lens — on a build that predates the fields', async () => {
    NM.RNISPanoPlus = {
      ...base,
      setIdlePreview: () => Promise.resolve({ on: true, reason: '' }),
    };
    const r = await setPanoPlusIdlePreview(true, { lens: 'wide' });
    expect(r.on).toBe(true);
    expect(r.lens).toBeNull();
    expect(r.lensRequested).toBeNull();
  });

  it('a refusal carries the planner code in its reason and no live lens', async () => {
    // What iOS answers for a wide request on a body with no wide, or a chip
    // label that skipped the host's mapping: the code leads the sentence.
    NM.RNISPanoPlus = {
      ...base,
      setIdlePreview: () => Promise.resolve({
        on: false,
        reason: "panoplus-bad-lens: '1x' is not a lens this arm knows.",
        lens: null,
        lensRequested: null,
      }),
    };
    const r = await setPanoPlusIdlePreview(true, { lens: '1x' });
    expect(r.on).toBe(false);
    expect(r.reason.startsWith('panoplus-bad-lens')).toBe(true);
    expect(r.lens).toBeNull();
  });

  it('a build without the method, and a bridge rejection, both answer with null lenses', async () => {
    NM.RNISPanoPlus = { ...base };
    const none = await setPanoPlusIdlePreview(true, {});
    expect(none.on).toBe(false);
    expect(none.lens).toBeNull();
    expect(none.lensRequested).toBeNull();

    NM.RNISPanoPlus = {
      ...base,
      setIdlePreview: () => Promise.reject(new Error('bridge fell over')),
    };
    const rej = await setPanoPlusIdlePreview(true, {});
    expect(rej.on).toBe(false);
    expect(rej.reason).toContain('bridge fell over');
    expect(rej.lens).toBeNull();
  });
});

describe('idle viewfinder — WHAT HAPPENED TO THE FRAME RATE rides the answer', () => {
  // ⚠ THE KEYS EXISTED NATIVELY AND COULD NOT REACH THE SCREEN. Android's
  // `PanoPlusLiveModule.setIdlePreview` has answered `previewFpsApplied` /
  // `previewFpsRange` / `previewFpsNote` on EVERY path since 2026-09-07
  // (`PanoPlusLiveModule.kt:932-941`), and this coercion — which builds its
  // result field by field and drops every key it does not name — was where
  // they died. A report native computes and JS discards is the same as no
  // report, which is the "built, wired, tests pass, unreachable" shape this
  // project keeps paying for.
  const base = {
    start: () => Promise.resolve({}),
    stop: () => Promise.resolve({}),
    cancel: () => Promise.resolve({}),
  };

  it('keeps the pin report when native sends it', async () => {
    NM.RNISPanoPlus = {
      ...base,
      setIdlePreview: () => Promise.resolve({
        on: true,
        reason: 'idle viewfinder LIVE on camera 0 at 1440x1080 · the viewfinder '
          + 'is pinned to [60, 60]',
        previewFpsApplied: true,
        previewFpsRange: '[60, 60]',
        previewFpsNote: 'the viewfinder is pinned to [60, 60] — the same range '
          + 'the sweep will request, chosen by the same selector',
      }),
    };
    const r = await setPanoPlusIdlePreview(true, { pinPreviewFps: true });
    expect(r.previewFpsApplied).toBe(true);
    expect(r.previewFpsRange).toBe('[60, 60]');
    expect(r.previewFpsNote).toContain('the same range the sweep will request');
  });

  it('carries a DECLINED pin as false — the case the panel has to speak', async () => {
    NM.RNISPanoPlus = {
      ...base,
      setIdlePreview: () => Promise.resolve({
        on: true,
        reason: 'idle viewfinder LIVE on camera 0 at 1440x1080 · camera 0 REFUSED',
        previewFpsApplied: false,
        previewFpsRange: '[60, 60]',
        previewFpsNote: 'camera 0 REFUSED CONTROL_AE_TARGET_FPS_RANGE [60, 60] '
          + '— the viewfinder does NOT match what the sweep will record',
      }),
    };
    const r = await setPanoPlusIdlePreview(true, { pinPreviewFps: true });
    expect(r.on).toBe(true);
    expect(r.previewFpsApplied).toBe(false);
    expect(r.previewFpsNote).toContain('does NOT match');
  });

  it('is NULL — not false — on a binary that does not report the pin', async () => {
    // ⚠ THE DIFFERENCE IS THE WHOLE CONTRACT. `false` means "native tried and
    // the rate is not pinned", which the panel SHOUTS about; a build that
    // predates the keys (every iOS build, every Android binary before
    // 2026-09-07) says nothing about the rate at all, and coercing that
    // silence to `false` would print a fault on a viewfinder nobody has any
    // evidence against.
    NM.RNISPanoPlus = {
      ...base,
      setIdlePreview: () => Promise.resolve({ on: true, reason: 'live' }),
    };
    const r = await setPanoPlusIdlePreview(true, { pinPreviewFps: true });
    expect(r.on).toBe(true);
    expect(r.previewFpsApplied).toBeNull();
    expect(r.previewFpsRange).toBeNull();
    expect(r.previewFpsNote).toBe('');
  });

  it('says nothing about the rate on a missing method or a bridge rejection', async () => {
    NM.RNISPanoPlus = { ...base };
    const none = await setPanoPlusIdlePreview(true, { pinPreviewFps: true });
    expect(none.previewFpsApplied).toBeNull();
    expect(none.previewFpsNote).toBe('');

    NM.RNISPanoPlus = {
      ...base,
      setIdlePreview: () => Promise.reject(new Error('bridge fell over')),
    };
    const rej = await setPanoPlusIdlePreview(true, { pinPreviewFps: true });
    expect(rej.previewFpsApplied).toBeNull();
    expect(rej.previewFpsRange).toBeNull();
  });
});

describe('iOS\'s OWN answer for the same fault survives the coercion', () => {
  const base = {
    start: () => Promise.resolve({}),
    stop: () => Promise.resolve({}),
    cancel: () => Promise.resolve({}),
  };

  // ⚠ THE FAULT IS ONE FAULT AND NATIVE REPORTS IT UNDER TWO NAMES. Android
  // answers `previewFpsApplied`; iOS answers `previewFormatApplied`
  // (`RNISPanoAvfSource.swift:407`) because it pins the FORMAT and the RATE
  // together, under one `lockForConfiguration()` — `activeFormat` and both
  // frame durations are set inside the same `do` block
  // (`RNISPanoAvfSource.swift:383-389`), so a throw declines BOTH and one flag
  // is the honest report of it.
  //
  // A lock failure at idle is deliberately NOT fatal there: the session still
  // starts and native returns `on: true` with the sentence "PREVIEW FORMAT NOT
  // APPLIED (…) — this viewfinder does NOT match what the sweep will record"
  // inside `reason` (`:400-401`). This coercion used to build a fresh object
  // that never mentioned the key, so the flag died here and the sentence died
  // one layer up — `PanoPlusCaptureSurface` clears `res.reason` on the success
  // path, and `on` is TRUE on exactly this case. Net, before this test: an iOS
  // viewfinder that does not match the sweep was silent on screen, which is the
  // one fault the whole notice exists for.

  it('carries previewFormatApplied through as the same three-state', async () => {
    NM.RNISPanoPlus = {
      ...base,
      setIdlePreview: () => Promise.resolve({
        on: true,
        reason: 'idle viewfinder LIVE on the wide (builtInWideAngleCamera), '
          + 'PREVIEW FORMAT NOT APPLIED (locked) — this viewfinder does NOT '
          + 'match what the sweep will record',
        previewFormatApplied: false,
      }),
    };
    const r = await setPanoPlusIdlePreview(true, {});
    expect(r.on).toBe(true);
    expect(r.previewFormatApplied).toBe(false);
    // Android's key is genuinely absent on iOS, and stays silent rather than
    // borrowing the other platform's answer.
    expect(r.previewFpsApplied).toBeNull();
  });

  it('is TRUE when iOS applied the format, and NULL where nobody said', async () => {
    NM.RNISPanoPlus = {
      ...base,
      setIdlePreview: () => Promise.resolve({
        on: true,
        reason: 'idle viewfinder LIVE on the wide (builtInWideAngleCamera), '
          + '1920x1440 @ 60 fps — the frame the sweep will record',
        previewFormatApplied: true,
      }),
    };
    expect((await setPanoPlusIdlePreview(true, {})).previewFormatApplied).toBe(true);

    // Every Android build, and every iOS build older than 2026-09-07. Silence
    // is not evidence of a mismatch — the same contract `previewFpsApplied`
    // documents.
    NM.RNISPanoPlus = {
      ...base,
      setIdlePreview: () => Promise.resolve({ on: true, reason: 'live' }),
    };
    expect((await setPanoPlusIdlePreview(true, {})).previewFormatApplied).toBeNull();

    NM.RNISPanoPlus = { ...base };
    expect(
      (await setPanoPlusIdlePreview(true, {})).previewFormatApplied,
    ).toBeNull();

    NM.RNISPanoPlus = {
      ...base,
      setIdlePreview: () => Promise.reject(new Error('bridge fell over')),
    };
    expect(
      (await setPanoPlusIdlePreview(true, {})).previewFormatApplied,
    ).toBeNull();
  });
});

// ── THE PLUMBING GUARD (2026-09-10) ──────────────────────────────────────────
//
// ⚠ THIS TEST EXISTS BECAUSE THE FLAG SHIPPED AND DID NOTHING. The attitude
// source was flipped ON in the field baseline, the persisted file on the A35
// read `panoPlusAttitudeMagFree: true` at version 12 — and every pack still
// came back `attitudeMagFree: false`, `drivingSeries: rotation-vector
// (magnetometer-fused)`. The type had been declared on PanoPlusPackOptions
// instead of the surface's own props, so the surface silently dropped it on the
// floor between the flags store and the bridge. The operator burned a capture
// session on a build whose headline change was inert.
//
// A knob that is typed, defaulted, documented and NOT FORWARDED is worse than
// no knob, because every downstream measurement then describes the wrong arm.
describe('sweep-level arms actually reach the native start options', () => {
  it('forwards attitudeMagFree when the host sets it, and omits it when unset', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'PanoPlusCaptureSurface.tsx'),
      'utf8',
    ) as string;
    // Declared as a PROP of the surface, not merely as a type somewhere else.
    expect(src).toMatch(/^\s*attitudeMagFree\?: boolean;/m);
    // Destructured, so it is in scope at the start call.
    expect(src).toMatch(/^\s*attitudeMagFree,$/m);
    // FORWARDED into the object handed to startPanoPlus, conditionally so an
    // unset prop leaves the native default alone.
    expect(src).toContain('...(attitudeMagFree != null ? { attitudeMagFree } : {})');
  });
});

// ── THE ARM-SELECTION GUARD (2026-09-10) ─────────────────────────────────────
//
// ⚠ THIS SHIPPED BROKEN AND BLOCKED ALL CAPTURE. `arPluginArm` selects an ARM,
// and it was read on its own instead of together with the arm. The field
// baseline has it ON, so an IMU sweep — AR switched OFF — also took the
// AR-plugin path: the recorder opened no camera and waited for frames from a
// plugin whose AR view the surface had correctly declined to mount. Nothing
// captured, on either arm. The operator: "Even I switch off AR, I only see the
// AR tracking message and nothing gets captured!!!!"
//
// A flag that selects an arm must be gated on that arm at BOTH ends.
describe('the Android AR arm is the AR-plugin arm, with no flag to forget (M2)', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'PanoPlusCaptureSurface.tsx'),
    'utf8',
  ) as string;

  it('the surface sends no arm-selecting flag at all', () => {
    // The recorder takes the AR-plugin arm for every live AR sweep
    // (PanoPlusStartMode.kt), so there is no flag to send — and no flag that
    // could reach the wrong arm, which is how this shipped broken once.
    expect(src).not.toMatch(/arPluginArm\s*[:?]/);
    expect(src).not.toContain('{ arPluginArm');
  });

  it('arArmed on Android still requires the AR pose source', () => {
    // Mounting the AR view on an IMU sweep would take the one back camera from
    // the arm that needs it.
    expect(src).toMatch(/\? \(runningArm != null\s*\n\s*\? runningArm\.poseSource !== 'imu'/);
  });
});

// ── THE FLAG-REACHES-NATIVE GUARD, THIRD INSTANCE (2026-09-10) ───────────────
//
// ⚠ THREE FLAGS IN ONE NIGHT WERE PLUMBED AND INERT: attitudeMagFree (typed on
// the wrong interface, dropped by the surface), arPluginArm (read without its
// arm), and lockCamera on Android (never forwarded by the bridge, so the AE
// lock was unconditional and a four-capture A/B — "lock off, on, on, off" —
// came back locked four times).
//
// Every one had a store entry, a flags-screen row and a passing test suite. The
// break was always the same shape: a hop that silently drops the value. This
// asserts the hops exist for the sweep-level arms, in the source, because no
// behavioural test can see a value that never arrives.
describe('every sweep-level arm actually reaches the bridge', () => {
  const surface = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'PanoPlusCaptureSurface.tsx'),
    'utf8',
  ) as string;

  it('lockCamera is forwarded — it was inert on Android for the whole v6 era', () => {
    expect(surface).toMatch(/^\s*lockCamera,$/m);
  });

  it('attitudeMagFree is forwarded conditionally', () => {
    expect(surface).toContain('...(attitudeMagFree != null ? { attitudeMagFree } : {})');
  });

});

// ── THE SCREEN MUST NOT ROTATE (2026-09-10) ──────────────────────────────────
//
// ⚠ MOUNTING THE ANDROID AR VIEW BROKE THIS. The operator: "when in AR and I
// move to landscape, the screen rotates!! The camera screen is supposed to stay
// as is - shutter button stuck to the home button edge." And the rule he gave:
// "follow whatever pano does today. It does not rotate."
//
// Pano does not rotate because the stitcher's <Camera> calls
// RNSARSession.lockPortrait() on mount and unlockOrientation() on unmount.
// pano+ never did, and only got away with it while it mounted no view that let
// the window follow the device.
describe('the pano+ surface pins portrait the way Pano does', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'PanoPlusCaptureSurface.tsx'),
    'utf8',
  ) as string;

  it('locks on mount and RESTORES on unmount — never one without the other', () => {
    expect(src).toContain('arModule?.lockPortrait?.()');
    // Leaving the host stranded in portrait would be a worse bug than the one
    // this fixes, so the cleanup is asserted explicitly.
    expect(src).toContain('arModule?.unlockOrientation?.()');
  });

  it('is Android-only — iOS has always mounted an AR view without this problem', () => {
    const i = src.indexOf('arModule?.lockPortrait?.()');
    expect(src.slice(Math.max(0, i - 500), i)).toContain("Platform.OS !== 'android'");
  });
});

// ── THE AR ARM MUST NOT SWEEP AT VGA (2026-09-10) ────────────────────────────
//
// ⚠ MEASURED ON THE FIRST WORKING ANDROID AR CAPTURES. Frames reaching the
// engine were 640x480 while the non-AR arm's were 1440x1080 — five times the
// area — and the operator's verdict was "the output quality is decisively worse
// than non-AR. WHY??" He then asked the right question directly: "Is the AR
// resolution lower?"
//
// ARCore's default on his handset pairs a 1920x1080 GPU texture with a 640x480
// CPU image; the library names that device in its own comment. Its config
// selector picks a matched-aspect config at the highest image resolution, and it
// is gated on a refcount that only this prop raises. Mosaic sets it. pano+ did
// not, so pano+ got ARCore's default.
describe('the AR camera view is asked for keyframe-quality capture', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'PanoPlusCaptureSurface.tsx'),
    'utf8',
  ) as string;

  it('sets keyframeQualityCapture on the AR view', () => {
    const i = src.indexOf('<ARCameraView');
    expect(i).toBeGreaterThan(-1);
    const el = src.slice(i, src.indexOf('/>', i));
    expect(el).toContain('keyframeQualityCapture');
  });
});
