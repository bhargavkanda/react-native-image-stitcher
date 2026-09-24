// SPDX-License-Identifier: Apache-2.0
/**
 * THE SWEEP'S GUARD RAILS, OBSERVED AT THE HANDLE.
 *
 * ── WHY THIS FILE EXISTS AND `cameraSweepEngine.render.test.tsx` IS NOT
 *    ENOUGH ────────────────────────────────────────────────────────────
 *
 * That suite drives a REAL `PanoPlusCaptureSurface`, which is the right rig
 * for the questions it asks (which arm, which props, which chrome). But it
 * installs no native fakes, so the surface never leaves `'idle'` — and every
 * imperative call `<Camera>` makes into it (`holdEnd`, `abandon`) is
 * swallowed by that phase guard and is unobservable. Its own comments say so
 * three times, and name the consequence each time:
 *
 *   · "WHAT THIS DOES NOT PROVE … that the SWEEP itself stopped. Removing
 *      the sweep branch from the abandon effect leaves this case green."
 *   · the finalize window: "This rig cannot witness it."
 *   · the cap: its one assertion is `expect(abandoned).toHaveLength(0)`,
 *      which is equally true of a cap that was deleted.
 *
 * A guard rail whose ACTION cannot be seen is a guard rail covered by its
 * arming only, and the arming is the half that was never in doubt.
 *
 * So this file replaces the surface with a stub that installs a SPY
 * imperative handle. `<Camera>` then calls the same three methods through
 * the same ref, and the test reads which one was called, with what, and in
 * what order — which is the only layer at which "the cap FINALIZES rather
 * than abandoning" is a falsifiable sentence.
 *
 * ⚠ THE STUB IS A CONTRACT, NOT A CONVENIENCE, and it is kept honest two
 * ways: `SweepSurfaceHandle` types it, so a method added to the real handle
 * and missed here is a compile error; and the real surface is still driven
 * end-to-end by the two suites above, so nothing here is the only thing
 * standing between the sweep and a device.
 */
import React from 'react';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const sensorsMock = require('react-native-sensors') as {
  __emitAccelerometer: (s: { x: number; y: number; z: number }) => void;
  __resetAccelerometer: () => void;
};
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { coercePanoPlusSummary, panoPlusResultOf } from '../panoPlusModel';

/** Every imperative call `<Camera>` made into the surface, in order. */
const calls: string[] = [];
/** The props of the live stub, so a test can drive its callbacks. */
let surfaceProps: Record<string, any> = {};

// ⚠ M8: THE ENGINE IS A HOOK `<Camera>` CALLS, SO THE STUB IS THE HOOK. The
// surface component this used to replace is no longer in `<Camera>`'s tree:
// `<Camera>` calls `useSweepEngine` on every engine and renders
// `SweepScreenView` from it. The stub keeps the contract the real hook keeps:
//   · not SELECTED (`enabled: false`) → the handle is inert and nothing is
//     recorded, as the unmounted surface was;
//   · deselected → `onSweepingChange(false)`, which the real hook reports on
//     every falling edge (M8a).
jest.mock('../useSweepEngine', () => {
  const ReactLocal = require('react') as typeof React;
  function useSweepEngine(props: any, ref: any, options: { enabled?: boolean } = {}) {
    const enabled = options.enabled !== false;
    if (enabled) surfaceProps = props;
    const inert = () => undefined;
    ReactLocal.useImperativeHandle(ref, () => (!enabled ? {
      capture: inert, finalize: inert, holdStart: inert, holdEnd: inert, abandon: inert,
    } : {
      capture: () => { calls.push('capture'); },
      finalize: () => { calls.push('finalize'); },
      holdStart: () => {
        calls.push('holdStart');
        props.onSweepingChange?.(true);
      },
      // ⚠ THESE TWO REPORT WHAT THE REAL SURFACE REPORTS, AND THE FIRST CUT
      // OF THIS FILE DID NOT — which made the modal case a VACUOUS PASS of
      // exactly the shape this repo keeps paying for.
      //
      // A stub is a contract, and a contract that omits the one transition
      // the code under test reacts to is worse than no stub. `abandon()`
      // ends with `setPhase('idle')`; the surface's `busy = phase !== 'idle'`
      // then flips and `onSweepingChange(false)` reaches `<Camera>`. Leaving
      // that out held the capture "recording" forever, so
      // `useOrientationDrift` never reset and the rotation explainer stayed
      // up in the test while it could NOT stay up on a phone — the modal was
      // bound to `drift.drifted`, which the hook clears the moment the
      // capture ends. An adversarial round found it by re-running this file
      // against a faithful stub.
      //
      // Measured after the fix: restore the inert stub AND the old
      // `visible={drift.drifted}` together and all 12 cases pass. That pair
      // is the vacuous pass, and it is why the fidelity here is load-bearing
      // rather than cosmetic.
      //
      // `holdEnd` likewise latches `busy` before the pack write, which is
      // what `sweepFinalizing` reads.
      holdEnd: () => {
        calls.push('holdEnd');
        props.onControlsState?.({ canCapture: true, canFinalize: false, busy: true });
      },
      abandon: (reason: string) => {
        calls.push(`abandon:${reason}`);
        props.onSweepingChange?.(false);
      },
    }), [props, enabled]);
    const wasEnabled = ReactLocal.useRef(enabled);
    ReactLocal.useEffect(() => {
      const was = wasEnabled.current;
      wasEnabled.current = enabled;
      if (was && !enabled) props.onSweepingChange?.(false);
    }, [enabled]);
    // The fields `<Camera>`'s own tree reads off the engine.
    return { phase: 'idle', setSurfaceBox: () => undefined, handleArFrame: () => undefined };
  }
  return { __esModule: true, useSweepEngine };
});
jest.mock('../PanoPlusCaptureSurface', () => {
  const actual = jest.requireActual('../PanoPlusCaptureSurface');
  const SweepScreenView = () => null;
  return { __esModule: true, ...actual, SweepScreenView };
});

// eslint-disable-next-line import/first
import { Camera } from '../../camera/Camera';
// eslint-disable-next-line import/first
import { CaptureStatusOverlay } from '../../camera/CaptureStatusOverlay';
// eslint-disable-next-line import/first
import { OrientationDriftModal } from '../../camera/OrientationDriftModal';
// eslint-disable-next-line import/first
import { RectCropPreview } from '../../camera/RectCropPreview';
import { LateralMotionModal } from '../../camera/LateralMotionModal';
// eslint-disable-next-line import/first
import { DEFAULT_GUIDANCE_COPY } from '../../camera/cameraGuidanceCopy';

beforeEach(() => {
  jest.useFakeTimers();
  calls.length = 0;
  surfaceProps = {};
});
// ⚠ `afterEach`, NOT THE LAST LINE OF EACH CASE. The accelerometer mock's
// subscriber set is module-global and a case that THROWS never reaches a
// trailing reset — so one failure leaked its subscribers into every case
// after it, and the mounted-but-unreset tree kept receiving samples. A
// failing case would then change the behaviour of passing ones, which is the
// worst possible way for a suite to be wrong.
afterEach(() => {
  sensorsMock.__resetAccelerometer();
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

/**
 * A finished sweep, in the shape `PanoPlusCaptureSurface.onComplete` hands
 * back. Painted and clean, so `panoPlusCaptureWarnings` contributes nothing
 * and the only codes on the result are `<Camera>`'s own — which is what the
 * two lateral cases are about.
 */
const SWEEP_RESULT = panoPlusResultOf(
  coercePanoPlusSummary({
    canvasPath: '/d/pp_1/canvas.jpg',
    sessionDir: '/d/pp_1',
    width: 4000,
    height: 1200,
    counts: { seen: 300, painted: 280 },
  }),
  { rectify: true, gainMatch: true, packFrames: 'all', poseSource: 'ar' },
  '2026-09-21T00:00:00.000Z',
);

function render(props: Record<string, unknown>): ReactTestRenderer {
  let t!: ReactTestRenderer;
  act(() => { t = create(<Camera engine="sweep" {...(props as any)} />); });
  return t;
}
/** Settle the surface's mount effects. */
async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
/**
 * Put the sweep into the recording state the guards gate on, with `painted`
 * strips already down.
 *
 * ⚠ THE PAINTED COUNT IS PART OF THE CONTRACT, as the real surface reports it
 * (`onPaintedChange`, from its live status). `<Camera>`'s lateral-stop policy
 * counts the engine's own progress — keyframes on one engine, strips on this
 * one — and arms the IMU guard only once there are 2. A stub that never
 * reported progress would hold every sweep at "nothing captured yet".
 */
async function startSweep(painted = 30): Promise<void> {
  await act(async () => { (surfaceProps.onSweepingChange as (b: boolean) => void)(true); });
  await act(async () => { (surfaceProps.onPaintedChange as (n: number) => void)(painted); });
}
/** What the surface reports while `finish()` writes the pack. */
async function setBusy(busy: boolean): Promise<void> {
  await act(async () => {
    (surfaceProps.onControlsState as (s: Record<string, unknown>) => void)(
      { canCapture: true, canFinalize: false, busy },
    );
  });
}

describe('the rotation guard STOPS THE SWEEP, not just the host callback', () => {
  it('⚑ calls abandon() on the surface with the reason', async () => {
    // ⚠ THE HALF `cameraSweepEngine` CANNOT SEE. Gut the sweep branch of the
    // abandon effect (`sweepRef.current?.abandon?.(…)`) and that suite stays
    // green, because `onCaptureAbandoned` fires on the line below it either
    // way: the host is told the capture was abandoned while the native sweep
    // keeps running and keeps painting.
    const abandoned: string[] = [];
    const tree = render({ onCaptureAbandoned: (r: string) => { abandoned.push(r); } });
    await settle();
    await act(async () => { sensorsMock.__emitAccelerometer({ x: 0, y: 9.8, z: 0 }); });
    await startSweep();
    expect(calls).not.toContain('abandon:orientation-drift');

    await act(async () => { sensorsMock.__emitAccelerometer({ x: 9.8, y: 0, z: 0 }); });
    await act(async () => { await Promise.resolve(); });
    expect(calls).toContain('abandon:orientation-drift');
    expect(abandoned).toEqual(['orientation-drift']);
    act(() => { tree.unmount(); });
  });

  it('⚑ …and NOT once the hold is FINALIZING — a finished panorama is kept', async () => {
    // THE BLOCKER, at the layer that can witness it. `sweepRunning` is
    // `phase !== 'idle'`, which INCLUDES 'finishing' — the native `stop()`
    // and the pack write, seconds on a device, during which the operator has
    // already released and is turning the phone to look at the result. A
    // guard still armed there abandoned a FINISHED panorama, and because
    // `onCaptureAbandoned` fires one line after the handle call, the host was
    // told the capture was abandoned AND THEN handed that same capture.
    const abandoned: string[] = [];
    const tree = render({ onCaptureAbandoned: (r: string) => { abandoned.push(r); } });
    await settle();
    await act(async () => { sensorsMock.__emitAccelerometer({ x: 0, y: 9.8, z: 0 }); });
    await startSweep();
    // The operator releases; the surface reports the pack write.
    await setBusy(true);
    // …and only now turns the phone.
    await act(async () => { sensorsMock.__emitAccelerometer({ x: 9.8, y: 0, z: 0 }); });
    await act(async () => { await Promise.resolve(); });
    expect(calls).not.toContain('abandon:orientation-drift');
    expect(abandoned).toHaveLength(0);
    act(() => { tree.unmount(); });
  });

  it('⚑ the explainer is IN THE SWEEP TREE — the guard does not fire into an empty screen', async () => {
    // Both modals lived only in the keyframe tree, after the
    // `engine === 'sweep'` early return — the same miss that stranded the
    // review surfaces one screen later. The guard fired, the capture was
    // destroyed, and the screen said nothing at all: the viewfinder returned
    // to idle with no panorama and no reason.
    const tree = render({});
    await settle();
    // Mounted-and-hidden, like every other review surface on this screen.
    expect(tree.root.findAllByType(OrientationDriftModal)).toHaveLength(1);
    expect(tree.root.findAllByType(LateralMotionModal)).toHaveLength(1);
    expect(tree.root.findByType(OrientationDriftModal).props.visible).toBe(false);

    await act(async () => { sensorsMock.__emitAccelerometer({ x: 0, y: 9.8, z: 0 }); });
    await startSweep();
    await act(async () => { sensorsMock.__emitAccelerometer({ x: 9.8, y: 0, z: 0 }); });
    await act(async () => { await Promise.resolve(); });
    expect(tree.root.findByType(OrientationDriftModal).props.visible).toBe(true);
    act(() => { tree.unmount(); });
  });

  it('⚑ …and a guard rail is NOT reported to the host as an ERROR', async () => {
    // `abandon()` emits `panoplus-abandoned` through `onFailure` for every
    // caller of the handle, and `<Camera>` wrapped EVERY failure as
    // `PANORAMA_START_FAILED` on `onError`. A host that surfaces `onError`
    // as a toast or a Sentry breadcrumb got a start-failure event for a
    // capture that started fine, ran, and was deliberately stopped — with a
    // code naming a phase it was nowhere near. On the keyframe engine the
    // same rotation produces no `onError` at all.
    const errors: unknown[] = [];
    const tree = render({ onError: (e: unknown) => { errors.push(e); } });
    await settle();
    await act(async () => {
      (surfaceProps.onFailure as (f: unknown) => void)(
        { code: 'panoplus-abandoned', message: 'sweep abandoned: orientation-drift' },
      );
    });
    expect(errors).toHaveLength(0);
    // NEGATIVE CONTROL — a real failure still reaches the host, so the
    // early return above cannot be widened into silence.
    await act(async () => {
      (surfaceProps.onFailure as (f: unknown) => void)(
        { code: 'panoplus-busy', message: 'another sweep is running' },
      );
    });
    expect(errors).toHaveLength(1);
    act(() => { tree.unmount(); });
  });
});

describe('M8 — the built-in shutter\'s hold runs the SELECTED engine', () => {
  it('a press-and-hold on <Camera>\'s own shutter reaches the sweep, and its release ends it', async () => {
    // One shutter for both engines: its hold goes through the same dispatch
    // as `startPanorama`, so on the sweep engine it is the sweep's hold.
    const { CameraShutter } = require('../../camera/CameraShutter');
    const tree = render({});
    await settle();
    const shutter = tree.root.findByType(CameraShutter);
    await act(async () => { shutter.props.onHoldStart(); });
    expect(calls).toContain('holdStart');
    await act(async () => { shutter.props.onHoldComplete(); });
    expect(calls).toContain('holdEnd');
    act(() => { tree.unmount(); });
  });
});

describe('the sideways-drift guard is ARMED, and armed on EVERY arm', () => {
  /**
   * Let the ORIENTATION guard see a steady phone first.
   *
   * ⚠ WITHOUT THIS THE ROTATION GUARD FIRES INSTEAD, and the case would be
   * measuring the wrong rail: `useDeviceOrientation` seeds its state to
   * `'portrait'` before any sample arrives, so the FIRST accelerometer
   * sample of a sideways slide is itself an orientation change and abandons
   * the capture before the lateral integrator has a chance to latch. The
   * slide below then stays inside this orientation, so the only guard that
   * can fire is the one under test.
   */
  async function settleUpright(): Promise<void> {
    await act(async () => { sensorsMock.__emitAccelerometer({ x: 0, y: 9.8, z: 0 }); });
  }

  /** One second of sustained cross-axis acceleration, at the hook's rate. */
  async function slideSideways(): Promise<void> {
    for (let i = 0; i < 120; i += 1) {
      // Alternate so the gravity IIR cannot absorb it, and hold it well past
      // the 500 ms grace window.
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        sensorsMock.__emitAccelerometer({ x: 0, y: i % 2 === 0 ? 9.8 : 6.0, z: 0 });
        jest.advanceTimersByTime(20);
      });
    }
  }

  it('⚑ ON THE AR ARM the IMU guard STANDS DOWN — the pose guard owns lateral drift (M8)', async () => {
    // ⚠ INVERTED BY M8, and on purpose. This case used to prove the IMU guard
    // fired on an AR sweep, because the sweep drew its OWN AR view and no pose
    // reached `<Camera>`: the accelerometer was the only lateral guard it had
    // (M0's stand-in). The sweep now runs on `<Camera>`'s AR view, its poses
    // reach `handleArFrame`, and AR is pose-guarded on both engines — exactly
    // as the keyframe engine has always been. The pose guard firing on an AR
    // sweep is pinned in `mergeGuardRegressions` ("an AR SWEEP is
    // pose-guarded"), where the drift latch is controllable.
    const tree = render({
      captureSources: 'both', defaultCaptureSource: 'ar', lateralBudgetCm: 1,
    });
    await settle();
    expect(surfaceProps.poseSource).toBe('ar');   // the AR arm, not a proxy for it
    await settleUpright();
    await startSweep();
    await slideSideways();
    expect(calls).not.toContain('holdEnd');
    expect(calls.some((c) => c.startsWith('abandon:'))).toBe(false);
    act(() => { tree.unmount(); });
  });

  it('⚑ …and the RESULT says why it is short — LATERAL_DRIFT_FINALIZE', async () => {
    // ⚠ THE HALF A MODAL CANNOT CARRY. The keyframe engine attaches
    // `LATERAL_DRIFT_FINALIZE` to `onCapture(result).warnings` so a host can
    // branch on it — re-queue the capture, flag the audit, refuse the
    // upload. The sweep branch showed the popup, called `holdEnd()` and set
    // nothing, so the ONE event whose entire point is "this capture is
    // short, and here is why" reached the host as a normal completion.
    const seen: Array<Record<string, unknown>> = [];
    const tree = render({
      lateralBudgetCm: 1,
      showPreview: false,
      rectCrop: false,
      onCapture: (r: Record<string, unknown>) => { seen.push(r); },
    });
    await settle();
    await settleUpright();
    await startSweep();
    await slideSideways();
    expect(calls).toContain('holdEnd');

    // The surface finishes and reports the panorama.
    await act(async () => {
      (surfaceProps.onComplete as (r: unknown) => void)(SWEEP_RESULT);
    });
    const codes = (seen[0]?.warnings as Array<{ code: string }> | undefined)
      ?.map((w) => w.code) ?? [];
    expect(codes).toContain('LATERAL_DRIFT_FINALIZE');
    act(() => { tree.unmount(); });
  });

  it('⚑ NEGATIVE CONTROL — a sweep that did NOT drift carries no such code', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const tree = render({
      lateralBudgetCm: 1,
      showPreview: false,
      rectCrop: false,
      onCapture: (r: Record<string, unknown>) => { seen.push(r); },
    });
    await settle();
    await settleUpright();
    await startSweep();
    await act(async () => {
      (surfaceProps.onComplete as (r: unknown) => void)(SWEEP_RESULT);
    });
    const codes = (seen[0]?.warnings as Array<{ code: string }> | undefined)
      ?.map((w) => w.code) ?? [];
    expect(codes).not.toContain('LATERAL_DRIFT_FINALIZE');
    act(() => { tree.unmount(); });
  });

  it('⚑ …and the operator is TOLD, in the sweep tree — when nothing else will tell him', async () => {
    // With `rectCrop` and `showPreview` both OFF (passed explicitly below —
    // `rectCrop` defaults ON since 2026-09-23) NO review mounts, so the popup is the only channel and must fire.
    //
    // ⚠ DECIDED UP FRONT, BY `modalPresentation`: with no review surface
    // configured the popup is the only channel, so it latches on the trip and
    // is still up when the sweep completes — see the next test for the case
    // where a review follows and the popup must stay down.
    const tree = render({ lateralBudgetCm: 1, rectCrop: false, showPreview: false });
    await settle();
    expect(tree.root.findByType(LateralMotionModal).props.visible).toBe(false);
    await settleUpright();
    await startSweep();
    await slideSideways();
    await act(async () => {
      (surfaceProps.onComplete as (r: unknown) => void)(SWEEP_RESULT);
    });
    expect(tree.root.findByType(LateralMotionModal).props.visible).toBe(true);
    act(() => { tree.unmount(); });
  });

  it('⚑ ONE POLICY, BOTH ENGINES — a sweep stopped at 3 strips is DISCARDED under the default floor of 5', async () => {
    // `lateralStopFinalizeMinFrames` counts the engine's own progress. On a
    // sweep that is strips painted, so a trip at 3 strips lands in the same
    // band as a keyframe capture at 3 keyframes: stitchable, but binned by
    // the default floor of 5.
    const abandoned: string[] = [];
    const tree = render({
      lateralBudgetCm: 1,
      onCaptureAbandoned: (r: string) => { abandoned.push(r); },
    });
    await settle();
    await settleUpright();
    await startSweep(3);
    await slideSideways();
    expect(calls).toContain('abandon:lateral-drift');
    expect(calls).not.toContain('holdEnd');
    expect(abandoned).toEqual(['lateral-drift']);
    // A discard shows the popup — nothing was kept and no review follows —
    // with the DISCARD copy, never the "we stitched what you captured" one.
    const modal = tree.root.findByType(LateralMotionModal);
    expect(modal.props.visible).toBe(true);
    expect(modal.props.title).toBe(DEFAULT_GUIDANCE_COPY.lateralStopDiscardedTitle);
    expect(modal.props.body).toBe(DEFAULT_GUIDANCE_COPY.lateralStopDiscardedBody);
    act(() => { tree.unmount(); });
  });

  it('⚑ …and the host can move the floor — lateralStopFinalizeMinFrames={2} keeps the same 3-strip sweep', async () => {
    const tree = render({ lateralBudgetCm: 1, lateralStopFinalizeMinFrames: 2 });
    await settle();
    await settleUpright();
    await startSweep(3);
    await slideSideways();
    expect(calls).toContain('holdEnd');
    expect(calls.some((c) => c.startsWith('abandon:'))).toBe(false);
    act(() => { tree.unmount(); });
  });

  it('⚑ …and a sweep with fewer than 2 strips never arms the IMU guard at all', async () => {
    // Same warm-up rule as keyframes: stopping a capture that has nothing to
    // protect cannot save it, and it is the path that produced the misleading
    // "follow the arrow" popup.
    const tree = render({ lateralBudgetCm: 1 });
    await settle();
    await settleUpright();
    await startSweep(1);
    await slideSideways();
    expect(calls.filter((c) => c === 'holdEnd' || c.startsWith('abandon:'))).toEqual([]);
    act(() => { tree.unmount(); });
  });

  it('⚑ …but NOT on top of the review — two modals orphan the one underneath', async () => {
    // THE OPERATOR'S REPORT, 2026-09-22, on iOS: "the popup is shown … the
    // screen goes blank. I thought the expected behaviour is show the preview
    // till then". It was: `<RectCropPreview>` had the partial panorama and was
    // orphaned by this popup stacking over it — two simultaneous react-native
    // `<Modal>`s leave an invisible, touch-swallowing one on iOS, the same
    // defect 28d11df fixed for a different pair.
    //
    // FAILS BEFORE THE FIX: the lateral effect raised the popup directly, so
    // both were visible at once.
    const tree = render({ lateralBudgetCm: 1, rectCrop: true, showPreview: true });
    await settle();
    await settleUpright();
    await startSweep();
    await slideSideways();
    await act(async () => {
      (surfaceProps.onComplete as (r: unknown) => void)(SWEEP_RESULT);
    });
    // The review mounts with the partial panorama…
    expect(tree.root.findByType(RectCropPreview).props.visible).toBe(true);
    // …and the popup stays down, because the reason is already on its banner.
    expect(tree.root.findByType(LateralMotionModal).props.visible).toBe(false);
    act(() => { tree.unmount(); });
  });

  // ⚠ AND THE ROTATION GUARD'S OWN OFF-CAPTURE TERM IS PINNED ONE LAYER
  // DOWN, not here. `useOrientationDrift` returns INITIAL_STATE whenever
  // `active` is false, so the `|| !captureRecording` term in `<Camera>`'s
  // abandon effect is defence in depth and deleting it reddens nothing at
  // this level. Its three cases live in `useOrientationDrift.test.ts`.

  it('⚑ NEGATIVE CONTROL — no drift, no stop', async () => {
    const tree = render({ lateralBudgetCm: 1 });
    await settle();
    await settleUpright();
    await startSweep();
    for (let i = 0; i < 120; i += 1) {
      // Dead still: the same sample every tick, which the gravity estimate
      // absorbs exactly. Without this case the two above pass for a latch
      // wired to fire on any accelerometer traffic at all.
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        sensorsMock.__emitAccelerometer({ x: 0, y: 9.8, z: 0 });
        jest.advanceTimersByTime(20);
      });
    }
    expect(calls).not.toContain('holdEnd');
    expect(tree.root.findByType(LateralMotionModal).props.visible).toBe(false);
    act(() => { tree.unmount(); });
  });

  it('⚑ …and the budget is OFF at 0 — the documented opt-out still opts out', async () => {
    const tree = render({ lateralBudgetCm: 0 });
    await settle();
    await settleUpright();
    await startSweep();
    await slideSideways();
    expect(calls).not.toContain('holdEnd');
    act(() => { tree.unmount(); });
  });
});

describe('the wall-clock cap', () => {
  it('⚑ FINALIZES the hold — it calls holdEnd, not abandon', async () => {
    // The case this replaces asserted only `expect(abandoned).toHaveLength(0)`
    // under the name "…and the cap FINALIZES the hold rather than abandoning
    // it". Deleting the cap entirely satisfies that, and so does a cap that
    // fires `abandon()` — `<Camera>`'s abandon path for a sweep does not call
    // `onCaptureAbandoned` from the cap. Both mutations left it green.
    const tree = render({ maxPanDurationMs: 3000 });
    await settle();
    await startSweep();
    expect(calls).not.toContain('holdEnd');
    await act(async () => { jest.advanceTimersByTime(3200); });
    expect(calls).toContain('holdEnd');
    expect(calls.some((c) => c.startsWith('abandon:'))).toBe(false);
    act(() => { tree.unmount(); });
  });

  it('⚑ does NOT fire before its time', async () => {
    const tree = render({ maxPanDurationMs: 3000 });
    await settle();
    await startSweep();
    await act(async () => { jest.advanceTimersByTime(2800); });
    expect(calls).not.toContain('holdEnd');
    act(() => { tree.unmount(); });
  });

  it('⚑ a cap CHANGED mid-hold is measured from the hold, not from the change', async () => {
    // ⚠ THE CAP COULD BE POSTPONED INDEFINITELY. Stamping the clock and
    // arming the timer in ONE effect keyed `[sweepRunning, maxPanDurationMs]`
    // meant any change to the cap re-ran the whole body: the elapsed time was
    // thrown away, the REC banner jumped back to 0:00, and a FULL-LENGTH
    // timer was armed again. A host rendering
    // `maxPanDurationMs={settings.maxPanMs}` across a settings refetch does
    // exactly that, and one that moved the value on a schedule would hold the
    // cap off forever — which is precisely the promise the cap exists to make.
    //
    // 2 s in, the cap moves 3000 → 4000. Correct: 2 more seconds, because
    // 4000 is measured from the HOLD. Fused: 4000 more, from the change.
    const tree = render({ maxPanDurationMs: 3000 });
    await settle();
    await startSweep();
    const bannerStart = tree.root.findByType(CaptureStatusOverlay)
      .props.recordingStartedAt as number;
    await act(async () => { jest.advanceTimersByTime(2000); });
    await act(async () => {
      tree.update(<Camera engine="sweep" maxPanDurationMs={4000} />);
    });
    expect(tree.root.findByType(CaptureStatusOverlay).props.recordingStartedAt)
      .toBe(bannerStart);                    // the clock did not jump forward
    expect(calls).not.toContain('holdEnd');  // and 4 s have not elapsed yet
    await act(async () => { jest.advanceTimersByTime(2100); });
    expect(calls).toContain('holdEnd');      // …4 s from the HOLD, not 6
    act(() => { tree.unmount(); });
  });

  it('⚑ the REC banner counts from the hold, not from zero', async () => {
    // `countdownSecondsFrom` returns `maxSeconds` when `recordingStartedAt`
    // is null, so dropping the clock stamp leaves a countdown frozen at its
    // full value — visible on a phone, invisible to a case that reads only
    // `phase`.
    const tree = render({ maxPanDurationMs: 4000 });
    await settle();
    expect(tree.root.findByType(CaptureStatusOverlay).props.recordingStartedAt)
      .toBeUndefined();
    await startSweep();
    expect(typeof tree.root.findByType(CaptureStatusOverlay).props.recordingStartedAt)
      .toBe('number');
    act(() => { tree.unmount(); });
  });
});


describe('CAPTURE_TOO_SHORT counts the frames that reached a sweep\'s canvas', () => {
  /** A sweep whose canvas is one seed frame: latched, no strip, no lead-out. */
  const ONE_FRAME = panoPlusResultOf(
    coercePanoPlusSummary({
      canvasPath: '/d/pp_2/canvas.jpg',
      sessionDir: '/d/pp_2',
      width: 1440,
      height: 1080,
      counts: { seen: 40, painted: 0 },
      latch: { latched: true },
      tailFlushed: false,
    }),
    { rectify: true, gainMatch: true, packFrames: 'all', poseSource: 'ar' },
    '2026-09-21T00:00:00.000Z',
  );
  /** The seed, one strip and the lead-out: three frames, one of them a strip. */
  const THREE_FRAMES = panoPlusResultOf(
    coercePanoPlusSummary({
      canvasPath: '/d/pp_3/canvas.jpg',
      sessionDir: '/d/pp_3',
      width: 2400,
      height: 1080,
      counts: { seen: 60, painted: 1 },
      latch: { latched: true },
      tailFlushed: true,
    }),
    { rectify: true, gainMatch: true, packFrames: 'all', poseSource: 'ar' },
    '2026-09-21T00:00:00.000Z',
  );

  async function complete(
    props: Record<string, unknown>, result: unknown,
  ): Promise<string[]> {
    const seen: Array<Record<string, unknown>> = [];
    const tree = render({
      rectCrop: false, showPreview: false, ...props,
      onCapture: (r: Record<string, unknown>) => { seen.push(r); },
    });
    await settle();
    await startSweep(1);
    await act(async () => {
      (surfaceProps.onComplete as (r: unknown) => void)(result);
    });
    act(() => { tree.unmount(); });
    return ((seen[0]?.warnings as Array<{ code: string }> | undefined) ?? [])
      .map((w) => w.code);
  }

  it('⚑ one frame under minPanoramaKeyframes={2} is flagged', async () => {
    expect(await complete({ minPanoramaKeyframes: 2 }, ONE_FRAME))
      .toContain('CAPTURE_TOO_SHORT');
  });

  it('⚑ …but the seed and the lead-out count: one strip is still three frames', async () => {
    // `counts.painted` alone reads 1 here and would call it too short.
    expect(await complete({ minPanoramaKeyframes: 2 }, THREE_FRAMES))
      .not.toContain('CAPTURE_TOO_SHORT');
  });

  it('⚑ NEGATIVE CONTROL — the default of 1 never warns', async () => {
    expect(await complete({}, ONE_FRAME)).not.toContain('CAPTURE_TOO_SHORT');
  });
});
