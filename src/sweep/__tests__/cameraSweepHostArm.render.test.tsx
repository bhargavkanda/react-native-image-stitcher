// SPDX-License-Identifier: Apache-2.0
/**
 * `<Camera engine="sweep">` ON THE ANDROID HOST ARM — the arm S5/S7 exist
 * for, driven end to end.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────
 *
 * Five adversarial rounds on this rung said some version of "the harness
 * pins `Platform.OS = 'ios'` and `useCameraDevice() => null`, so ownership
 * is false on every render and this assertion cannot fail". That was true of
 * the SHARED mocks — and it was taken as a property of the project, so fix
 * after fix shipped with coverage only at the pure layer while the wiring
 * that made it act went untested. Three separate defects reached a commit
 * that way.
 *
 * The fifth round disproved the premise by simply overriding the two pinned
 * values in a scratch worktree and mounting `<Camera>` on the host arm. So
 * that is what this file does, permanently.
 *
 * ⚠ IT DOES NOT WEAKEN THE SHARED MOCKS, which are pinned deliberately — "a
 * mock that invented a device would make every no-device path untested".
 * The overrides live HERE, in the one file whose subject is the arm that
 * needs them, and every other suite keeps the honest no-device default.
 */
// M8 — the REAL sweep engine, with what `<Camera>` passes it recorded.
jest.mock('../useSweepEngine', () =>
  require('./sweepEngineSpy').sweepEngineSpyFactory());
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Platform } from 'react-native';
import { VisionCameraProxy } from 'react-native-vision-camera';

// ⚠ THE STUB THIS PARAGRAPH USED TO DESCRIBE IS GONE. `PanoPlusResultView`
// was mocked here because it pulled `containFit` through the package barrel;
// ef4e95a deleted that screen — a sweep is now reviewed by the SAME
// `<CapturePreview>` every other engine uses — and removed the mock with it,
// but left this comment explaining a `jest.mock` that is no longer above.
// Rewritten rather than deleted, because "why is there no stub here" is a
// real question for the next reader.
//
// `expo-file-system/legacy` IS mocked, below: it is a HOST dependency that
// `loadVideoFileSystem` resolves at call time inside a try/catch, and the
// verdict sidecar `<Camera>` writes on every sweep goes through it. `written`
// is a module-level sink so that write is OBSERVABLE — without it the sidecar
// silently no-ops and the cases below would pass on a deleted feature.
const written: Array<{ uri: string; body: string }> = [];
jest.mock(
  'expo-file-system/legacy',
  () => ({
    documentDirectory: 'file:///var/mobile/Documents/',
    makeDirectoryAsync: () => Promise.resolve(),
    readAsStringAsync: () => Promise.resolve(''),
    writeAsStringAsync: (uri: string, body: string) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      (globalThis as unknown as { __hostArmWritten: Array<unknown> })
        .__hostArmWritten.push({ uri, body });
      return Promise.resolve();
    },
    deleteAsync: () => Promise.resolve(),
    getInfoAsync: () => Promise.resolve({ exists: false }),
    readDirectoryAsync: () => Promise.resolve([]),
  }),
  { virtual: true },
);
(globalThis as unknown as { __hostArmWritten: unknown[] }).__hostArmWritten = written;

import { NativeModules } from 'react-native';

import { ARToggle, Camera } from '../../camera/Camera';
import { CameraView } from '../../camera/CameraView';
import { __resetHardwareVideoSizesCache } from '../../camera/androidHardwareVideoSizes';
import { lastSweepEngineCall, lastSweepProps } from './sweepEngineSpy';
import { selectCaptureDevice } from '../../camera/selectCaptureDevice';
import {
  coercePanoPlusSummary,
  panoPlusResultOf,
  panoPlusVerdictSidecar,
} from '../panoPlusModel';

const vc = require('react-native-vision-camera') as {
  useCameraDevice: unknown;
  useCameraDevices: unknown;
};
const realDevice = vc.useCameraDevice;
const realDevices = vc.useCameraDevices;
const proxy = VisionCameraProxy as unknown as {
  initFrameProcessorPlugin: unknown;
};
const realInit = proxy.initFrameProcessorPlugin;

/** A plausible Android back camera: wide-only, so the multicam term is off. */
const DEVICE = {
  id: 'back-0',
  position: 'back',
  physicalDevices: ['wide-angle-camera'],
  hasTorch: true,
  minZoom: 1,
  maxZoom: 8,
  neutralZoom: 1,
  formats: [],
  isMultiCam: false,
  supportsFocus: true,
  name: 'back-0',
};

/**
 * The crop seed comes from NATIVE. `computeInscribedRect` reads
 * `<canvas>.coverage.png` — the sidecar the pano+ engine now writes beside
 * the canvas — and falls back to a brightness threshold when it is absent.
 * Neither exists in a render test, so the module is faked here and the
 * answer is the one the operator's own pack measures
 * (`pp_1789931447063`: 68.4% of canvas under a border-connected mask,
 * against 24.3% under the brightness proxy the sidecar exists to replace).
 */
const inscribedCalls: string[] = [];
/** Every `cropToQuad` bag, so the DESTINATION is observable. */
const cropCalls: Array<{ imagePath: string; outputPath?: string }> = [];
/** When true the fake native predates `outputPath` — no marker method. */
let staleNative = false;
beforeEach(() => {
  jest.useFakeTimers();
  (Platform as { OS: string }).OS = 'android';
  vc.useCameraDevice = () => DEVICE;
  vc.useCameraDevices = () => [DEVICE];
  proxy.initFrameProcessorPlugin = () => ({ call: () => undefined });
  inscribedCalls.length = 0;
  cropCalls.length = 0;
  staleNative = false;
  installBatchStitcher();
});
/** Rebuild the fake `BatchStitcher` — call after flipping `staleNative`. */
function installBatchStitcher(): void {
  (NativeModules as Record<string, unknown>).BatchStitcher = {
    // ⚠ THE CAPABILITY MARKER. `cropQuad` refuses a destination BEFORE
    // calling native when this is absent, because a build that predates
    // `outputPath` ignores the key and rewrites the source IN PLACE — and on
    // the sweep path that source is the pack's canvas. Omitted when
    // `staleNative`, which is the case below.
    ...(staleNative
      ? {}
      : { cropToQuadAcceptsOutputPath: () => Promise.resolve(true) }),
    computeInscribedRect: (o: { imagePath: string }) => {
      inscribedCalls.push(o.imagePath);
      return Promise.resolve({
        x: 12, y: 8, width: 3600, height: 1100,
        imageWidth: 4000, imageHeight: 1200,
      });
    },
    cropToQuad: (o: { imagePath: string; outputPath?: string }) => {
      cropCalls.push(o);
      // Native echoes where it wrote — in place when no destination was
      // asked for, exactly as both platforms do.
      const landed = (o.outputPath != null && o.outputPath !== '')
        ? o.outputPath
        : o.imagePath;
      return Promise.resolve({ width: 3600, height: 1100, outputPath: landed });
    },
  };
}
afterEach(() => {
  delete (NativeModules as Record<string, unknown>).BatchStitcher;
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
  (Platform as { OS: string }).OS = 'ios';
  vc.useCameraDevice = realDevice;
  vc.useCameraDevices = realDevices;
  proxy.initFrameProcessorPlugin = realInit;
});

/**
 * ⚠ THE AR-SUPPORT PROBE IS FLUSHED HERE, and it has to be.
 *
 * `useARSession` probes `isSupported()` in a passive effect, so
 * `isARSupportedOnDevice` is FALSE on the first render however the harness
 * is configured — and `<Camera>`'s AR pill is gated on it. Without the
 * flush the pill simply is not in the tree and every case that drives it
 * fails with "found 0", which reads like a wiring bug rather than a
 * timing one.
 */
async function render(
  props: Record<string, unknown> = {},
): Promise<ReactTestRenderer> {
  let t!: ReactTestRenderer;
  act(() => {
    t = create(
      <Camera
        engine="sweep"
        defaultCaptureSource="non-ar"
        {...(props as any)}
      />,
    );
  });
  // Settle the probe's promise — two microtask turns, the same shape the
  // sibling suite uses for its AR case.
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return t;
}

/** Re-render the same tree with a different `engine`. */
async function setEngine(
  tree: ReactTestRenderer,
  engine: string,
  props: Record<string, unknown> = {},
): Promise<void> {
  act(() => {
    tree.update(
      <Camera
        engine={engine as never}
        defaultCaptureSource="non-ar"
        {...(props as any)}
      />,
    );
  });
  await act(async () => { await Promise.resolve(); });
}
const surfaceProps = (_t: ReactTestRenderer): Record<string, unknown> =>
  lastSweepProps() as Record<string, unknown>;
const cameraViews = (t: ReactTestRenderer) => t.root.findAllByType(CameraView);
/** M9 — `onComplete` awaits the canvas COPY (and the inscribed rect) before
 *  the review opens or the result is emitted, so drive it asynchronously. */
async function completeSweep(tree: ReactTestRenderer, r: unknown): Promise<void> {
  await act(async () => {
    void (surfaceProps(tree).onComplete as (x: unknown) => Promise<void> | void)(r);
    for (let i = 0; i < 6; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }
  });
}
const COPY_RE = /^\/tmp\/rnis-captures\/panorama-\d+\.jpg$/;

/**
 * Flip `<Camera>`'s OWN AR pill.
 *
 * ⚠ THE SURFACE NO LONGER HAS ONE. It used to draw a clone fed from the
 * pano+ arm ladder, which on an uncalibrated phone pinned itself ON and
 * could not be tapped off; `<Camera>` withholds `onPoseSourceChange`
 * unconditionally now, so the only AR control on any engine is this one.
 * Driving it here is also what makes these cases exercise the control the
 * operator actually touches.
 */
async function settle(ms = 1200): Promise<void> {
  // An AR flip CHAINS two independent waits — the ~250 ms AR-support/
  // transition grace, and then the 600 ms ownership handoff that the flip
  // itself opens — with a render between them. Draining timers once is not
  // enough; each wait has to be able to schedule the next.
  for (let i = 0; i < 3; i += 1) {
    act(() => { jest.advanceTimersByTime(ms); });
    // eslint-disable-next-line no-await-in-loop
    await act(async () => { await Promise.resolve(); });
  }
}

function toggleAr(tree: ReactTestRenderer): void {
  const pill = tree.root.findAllByType(ARToggle);
  if (pill.length !== 1) {
    throw new Error(`expected exactly one AR pill, found ${pill.length}`);
  }
  act(() => { (pill[0].props.onToggle as () => void)(); });
}

describe('⚑ THE PRECONDITION — this suite really does reach the host arm', () => {
  it('mounts exactly ONE <CameraView> and hands the surface the host arm', async () => {
    // Without this every assertion below is the same vacuous pass the last
    // five rounds kept finding: "false === false" on a pinned harness.
    const tree = await render();
    expect(cameraViews(tree)).toHaveLength(1);
    const p = surfaceProps(tree);
    expect(p.frameSource).toBe('host');
    expect(p.vcPluginArm).toBe(true);
    expect(p.vcCameraId).toBe('back-0');
    act(() => { tree.unmount(); });
  });
});

describe('the preview is not "live" until it is DRAWING', () => {
  const previewProps = (t: ReactTestRenderer) =>
    cameraViews(t)[0].props.cameraProps as {
      onPreviewStarted?: () => void;
      onPreviewStopped?: () => void;
    };

  it('⚑ is FALSE while the session opens, even though the element is mounted', async () => {
    // The window this whole mechanism exists for: mounted is not drawing,
    // and reporting it as drawing makes the surface transparent over a
    // black, session-less CameraView with its explainer suppressed.
    const tree = await render();
    expect(surfaceProps(tree).hostPreviewLive).toBe(false);
    act(() => { tree.unmount(); });
  });

  it('⚑ turns TRUE on the first preview frame', async () => {
    const tree = await render();
    act(() => { previewProps(tree).onPreviewStarted?.(); });
    expect(surfaceProps(tree).hostPreviewLive).toBe(true);
    act(() => { tree.unmount(); });
  });

  it('⚑ …and FALSE again when the preview stops', async () => {
    const tree = await render();
    act(() => { previewProps(tree).onPreviewStarted?.(); });
    act(() => { previewProps(tree).onPreviewStopped?.(); });
    expect(surfaceProps(tree).hostPreviewLive).toBe(false);
    act(() => { tree.unmount(); });
  });
});

describe('⚑ AN UNMOUNT CLEARS "LIVE" — no callback fires for one', () => {
  it('a remounted <CameraView> is never reported as already drawing', async () => {
    // THE DEFECT: `hostPreviewStarted` was cleared only on an ownership
    // change, but the element also unmounts for reasons ownership does not
    // move for — the sweep result viewer being the common one. Neither
    // `onPreviewStopped` nor `onStopped` fires for an unmount, so the flag
    // stayed true and the remounted element, which has no session at all
    // yet, was reported as LIVE: transparent root, explainer suppressed,
    // black underneath.
    //
    // Driven here through the ownership round trip, which unmounts and
    // remounts the same way and needs no result fixture.
    const tree = await render();
    const start = () => act(() => {
      (cameraViews(tree)[0].props.cameraProps as {
        onPreviewStarted?: () => void;
      }).onPreviewStarted?.();
    });

    start();
    expect(surfaceProps(tree).hostPreviewLive).toBe(true);

    // Away and back: the element leaves the tree and a NEW one returns.
    toggleAr(tree);   // AR on
    await settle();
    expect(cameraViews(tree)).toHaveLength(0);

    toggleAr(tree);   // AR off again
    await settle();
    expect(cameraViews(tree)).toHaveLength(1);

    // The new element has had no `onPreviewStarted`.
    expect(surfaceProps(tree).hostPreviewLive).toBe(false);
    // …and says so, rather than showing a transparent root over nothing.
    start();
    expect(surfaceProps(tree).hostPreviewLive).toBe(true);
    act(() => { tree.unmount(); });
  });
});

describe('⚑ THE ERROR CHANNEL — driven through <Camera>, not just the pure fn', () => {
  it('carries vision-camera\'s reason to the surface, INCLUDING the swallowed codes', async () => {
    // `CameraView` deliberately swallows three transient lifecycle codes so
    // routine lock/app-switch churn is not reported to the host as a crash
    // — and those three are exactly the ones that leave this preview dark
    // with nothing else to say. The channel therefore hangs off the
    // UNFILTERED seam; wiring it to the filtered `onError` would have
    // delivered nothing for the cases it exists for.
    const tree = await render();
    const view = cameraViews(tree)[0];
    act(() => {
      (view.props.onAnyError as (e: unknown) => void)({
        code: 'device/camera-already-in-use',
        message: 'another app has it',
      });
    });
    const text = String(surfaceProps(tree).hostPreviewError ?? '');
    expect(text).toContain('camera-already-in-use');
    expect(text).toContain('another app has it');
    act(() => { tree.unmount(); });
  });

  it('⚑ and clears it the moment a frame actually arrives', async () => {
    const tree = await render();
    const view = cameraViews(tree)[0];
    act(() => {
      (view.props.onAnyError as (e: unknown) => void)({ code: 'x', message: 'y' });
    });
    expect(surfaceProps(tree).hostPreviewError).not.toBe('');
    act(() => {
      (view.props.cameraProps as { onPreviewStarted?: () => void })
        .onPreviewStarted?.();
    });
    expect(surfaceProps(tree).hostPreviewError).toBe('');
    act(() => { tree.unmount(); });
  });

  it('⚑ …and does not let a resolved fault caption the NEXT session', async () => {
    // The error had exactly one reset — a first frame — which by definition
    // cannot fire while the preview is down. So after any fault, every
    // later reopen was captioned with the old one, and the notice prints
    // the error BEFORE the handoff copy.
    const tree = await render();
    act(() => {
      (cameraViews(tree)[0].props.onAnyError as (e: unknown) => void)(
        { code: 'device/fatal-error', message: 'gone' },
      );
    });
    expect(surfaceProps(tree).hostPreviewError).not.toBe('');

    toggleAr(tree);
    await settle();
    toggleAr(tree);
    await settle();

    expect(cameraViews(tree)).toHaveLength(1);
    expect(surfaceProps(tree).hostPreviewError).toBe('');
    act(() => { tree.unmount(); });
  });
});

describe('⚑ THE REVIEW CYCLE — M8: the preview stays up, the engine stands down', () => {
  it('the camera is NOT unmounted behind the review, and the engine is deselected there', async () => {
    // ⚠ INVERTED BY M8, and the old hazard went with the old shape. The
    // surface owned a camera and unmounted behind the review, so the
    // remounted `<CameraView>` could be reported "live" before it drew — the
    // case this used to pin. Now the sweep runs on `<Camera>`'s own preview,
    // which stays mounted behind the review exactly as the keyframe engine's
    // always has (M8 plan), while the ENGINE is deselected (`enabled: false`),
    // so nothing sweeps under the review. No remount, so nothing to mis-report.
    const tree = await render({ rectCrop: false, showPreview: true });
    act(() => {
      (cameraViews(tree)[0].props.cameraProps as {
        onPreviewStarted?: () => void;
      }).onPreviewStarted?.();
    });
    expect(surfaceProps(tree).hostPreviewLive).toBe(true);
    await act(async () => {
      void (surfaceProps(tree).onComplete as (r: unknown) => Promise<void>)({
        uri: 'file:///x.jpg',
        width: 4000,
        height: 1200,
        sessionDir: '/tmp/pp_1',
        arms: { rectify: true, gainMatch: true },
        summary: coercePanoPlusSummary({}),
      });
      for (let i = 0; i < 6; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
      }
    });
    const behind = cameraViews(tree);
    expect(behind).toHaveLength(1);                       // still mounted
    expect(lastSweepEngineCall().enabled).toBe(false);    // …the engine is not
    const viewer = tree.root.findAll(
      (n) => typeof n.props?.onRetake === 'function', { deep: true },
    )[0];
    act(() => { (viewer.props.onRetake as () => void)(); });
    expect(cameraViews(tree)).toHaveLength(1);
    expect(lastSweepEngineCall().enabled).toBe(true);
    // The same element drew the whole time, so "live" is simply true.
    expect(surfaceProps(tree).hostPreviewLive).toBe(true);
    act(() => { tree.unmount(); });
  });
});

describe('⚑ THE ENGINE ROUND TRIP — M8: ONE preview, not two', () => {
  const placeholder = (t: ReactTestRenderer) => t.root.findAll(
    (n) => n.props != null && n.props.children === 'Switching camera…',
  ).length > 0;

  it('sweep → keyframe → sweep never unmounts the camera, and "drawing" carries', async () => {
    // INVERTED BY M8. The flag used to be written by an element rendered
    // from TWO places, and the keyframe copy was kept from writing it. There
    // is one element now, in one tree, on both engines: switching the engine
    // switches what the HOLD runs, not the camera (DR-2 I3/A7). The preview
    // that was drawing is still drawing.
    const tree = await render();
    expect(cameraViews(tree)).toHaveLength(1);
    act(() => {
      (cameraViews(tree)[0].props.cameraProps as { onPreviewStarted?: () => void })
        .onPreviewStarted?.();
    });
    await setEngine(tree, 'keyframe');
    expect(placeholder(tree)).toBe(false);
    expect(cameraViews(tree)).toHaveLength(1);
    await setEngine(tree, 'sweep');
    expect(placeholder(tree)).toBe(false);
    expect(cameraViews(tree)).toHaveLength(1);
    expect(surfaceProps(tree).hostPreviewLive).toBe(true);
    // …and a real stop still reads as a stop.
    act(() => {
      (cameraViews(tree)[0].props.cameraProps as { onPreviewStopped?: () => void })
        .onPreviewStopped?.();
    });
    expect(surfaceProps(tree).hostPreviewLive).toBe(false);
    act(() => { tree.unmount(); });
  });

  it('⚑ the preview carries the SAME lifecycle wiring on both engines', async () => {
    const tree = await render();
    const wiring = () => {
      const v = cameraViews(tree)[0];
      const cp = v.props.cameraProps as Record<string, unknown>;
      return {
        started: typeof cp.onPreviewStarted,
        stopped: typeof cp.onPreviewStopped,
        anyError: typeof v.props.onAnyError,
        frameProcessor: typeof cp.frameProcessor,
      };
    };
    const onSweep = wiring();
    await setEngine(tree, 'keyframe');
    expect(wiring()).toEqual(onSweep);
    expect(onSweep.started).toBe('function');
    act(() => { tree.unmount(); });
  });
});

describe('⚑ THE OWNERSHIP FLIP — a handoff, not an instant swap', () => {
  it('M8: the AR pill is NOT a handoff — the sweep follows <Camera>\'s own transition', async () => {
    // Both kinds are `<Camera>`'s cameras now, so the AR pill moves the sweep
    // from `<CameraView>` to `<Camera>`'s AR view the way it moves the keyframe
    // engine: through `<Camera>`'s own transition. The engine never opens one.
    const tree = await render();
    expect(cameraViews(tree)).toHaveLength(1);
    toggleAr(tree);
    expect(cameraViews(tree)).toHaveLength(0);
    act(() => { jest.advanceTimersByTime(1000); });
    await act(async () => { await Promise.resolve(); });
    expect(surfaceProps(tree).frameSource).toBe('host-ar');
    expect(surfaceProps(tree).vcPluginArm).toBe(false);
    act(() => { tree.unmount(); });
  });

  it('hands the camera over with NEITHER side holding one — the DR-1a hatch', async () => {
    // The hatch toggled on at idle moves the camera to pano+'s own. Done in
    // one commit, <CameraView> unmounts and the surface opens its own client
    // in the same frame while Camera2 is still releasing — ERROR_CAMERA_IN_USE
    // for an ordering bug. So: a window in which neither side holds one.
    const tree = await render();
    expect(cameraViews(tree)).toHaveLength(1);
    await setEngine(tree, 'sweep', { sweep: { frameSourceOverride: 'own' } });
    expect(cameraViews(tree)).toHaveLength(0);
    expect(surfaceProps(tree).frameSource).toBe('host');
    expect(surfaceProps(tree).vcPluginArm).toBe(false);
    act(() => { jest.advanceTimersByTime(1000); });
    await act(async () => { await Promise.resolve(); });
    expect(cameraViews(tree)).toHaveLength(0);
    expect(surfaceProps(tree).frameSource).toBe('own');
    act(() => { tree.unmount(); });
  });

  it('⚑ a bag-pinned lens cannot disarm the multicam guard', async () => {
    // `sweep.lens` moves what the SURFACE shows; it cannot move the device,
    // which follows `<Camera>`'s own lens through `useCapture({ lens })`.
    // Feeding the merged value to the predicate turned the
    // virtual-constituent guard off while the device stayed at 0.5×.
    //
    // ⚠ NEEDS A MULTICAM BODY, because that is the only mode in which the
    // device id names a logical CONTAINER whose active constituent moves
    // under zoom. On a wide-only or standalone-ultra-wide body there is no
    // constituent to drift and host ownership at 0.5× is correct — which is
    // why the first draft of this case asserted the wrong thing.
    // ⚠ BOTH HOOKS. `selectCaptureDevice` reads the device LIST, not the
    // single-device hook, so overriding only the latter leaves
    // `captureMode` at 'wide-only' and the case asserts nothing about
    // multicam at all — which is exactly what the first draft did.
    // eslint-disable-next-line @typescript-eslint/no-shadow
    const MULTICAM = {
      ...DEVICE,
      isMultiCam: true,
      minZoom: 0.5,
      neutralZoom: 1,
      physicalDevices: ['ultra-wide-angle-camera', 'wide-angle-camera'],
    };
    vc.useCameraDevice = () => MULTICAM;
    vc.useCameraDevices = () => [MULTICAM];
    // ⚠ `defaultLens`, NOT `lens`. `<Camera>` has no `lens` prop — its lens
    // is state seeded from `defaultLens` — so the second draft of this case
    // passed a prop that does not exist, left the lens at 1×, and asserted
    // a guard that correctly was not firing. Three drafts, three different
    // ways of not arranging the state the claim is about; the precondition
    // assertions below exist so a fourth cannot happen silently.
    const tree = await render({
      defaultLens: '0.5x' as const,
      // D9: the bag's `lens` is no longer typed and no longer read.
      sweep: { lens: 'wide' } as never,
    });
    const p = surfaceProps(tree);
    // ⚠ THE PRECONDITION IS THE DEVICE, NOT THE PROP. An earlier draft
    // asserted `p.lens === 'wide'` and called it "the body really is
    // multicam and the device really is at 0.5×" — but `p.lens` is the
    // MERGED lens, which is `'wide'` because the BAG said so, on any tree.
    // The arrangement is asserted at its source instead.
    expect(selectCaptureDevice([MULTICAM] as never, {
      lens: '0.5x', platform: 'android',
    } as never).mode).toBe('multicam');
    // M3/D9: the lens is `<Camera>`'s own (0.5×); the host keeps the camera
    // (no fallback to a camera of the sweep's own), and the hold is REFUSED
    // BY NAME until the arm can tell which lens a zoomed logical camera is
    // streaming from (D13).
    expect(p.lens).toBe('ultraWide');
    expect(p.frameSource).toBe('host');
    expect((p.hostArmRefusal as { code?: string } | null)?.code).toBe('panoplus-refused-zoom-lens');
    act(() => { tree.unmount(); });
  });
});

/**
 * ── ONE RESULT CHANNEL ──────────────────────────────────────────────────
 *
 * The sweep used to fire `onCapture` FIRST and then show its own screen —
 * so Retake was structurally impossible (the host already had the result)
 * and five public `<Camera>` props did nothing on this engine. It now
 * defers into `cropPending` exactly as a panorama does.
 */
describe('⚑ THE RESULT CHANNEL — the same review every engine uses', () => {
  /**
   * ⚠ BUILT BY THE PRODUCTION CONSTRUCTOR, NOT BY HAND.
   *
   * This fixture used to hand-write `uri: 'file:///x.jpg'` — a value
   * `panoPlusResultOf` CANNOT produce. It returns `summary.canvasPath`
   * verbatim (panoPlusModel.ts:3808), which native gives as a BARE path.
   * A hand-written scheme is a fixture asserting the code is already
   * correct, and it hid a blank review on every single sweep: the stash
   * passed `result.uri` straight to `<Image>`, which needs a scheme.
   */
  const CANVAS = '/data/user/0/com.x/files/panoplus/pp_1/canvas.jpg';
  const RESULT = panoPlusResultOf(
    coercePanoPlusSummary({
      canvasPath: CANVAS,
      sessionDir: '/data/user/0/com.x/files/panoplus/pp_1',
      width: 4000,
      height: 1200,
      // ⚠ `counts.painted`, WITHOUT WHICH THIS FIXTURE IS NOT AN INTACT
      // SWEEP — it is a sweep that painted NOTHING, and the negative control
      // below was asserting that an empty capture carries no warning. It did
      // not, which is the defect: `panoPlusCaptureWarnings` read `hasCuts` /
      // `hasBanding` and neither of those clauses can see an empty pack, so
      // the one capture with nothing in it at all was the one that warned
      // about nothing at all. `isIntact` had the clause; the host channel
      // did not.
      //
      // Left with no `seam` block ON PURPOSE as well: a short sweep ships
      // `seam.boundaries === 0`, which makes `seamMeasured` false and
      // `hasCuts` true from the ABSENCE of evidence. So this same fixture is
      // also the negative control for that half — a good panorama whose
      // seams were never measured must not carry a banner either.
      counts: { seen: 120, painted: 96 },
    }),
    { rectify: true, gainMatch: true, packFrames: 'all', poseSource: 'imu' },
    '2026-09-19T00:00:00.000Z',
  );
  /**
   * ⚠ `visible === true`, NOT JUST "a node with an onRetake".
   *
   * The review surfaces are MOUNTED for the life of the screen and hidden
   * by a prop, so the looser predicate is true of a bare `<Camera>` with no
   * capture at all — measured: `render({})` with nothing taken answers 1.
   * Two cases below were passing on that, and a mutation that deletes the
   * whole defer block (a sweep emits immediately and never opens a review)
   * left them green.
   */
  const review = (tree: ReactTestRenderer) => tree.root.findAll(
    (n) => typeof n.props?.onRetake === 'function' && n.props?.visible === true,
    { deep: true },
  );

  it('⚑ DEFERS the capture — onCapture does NOT fire before the review', async () => {
    // The inversion that made Retake impossible.
    const seen: unknown[] = [];
    const tree = await render({
      rectCrop: false, showPreview: true, onCapture: (r: unknown) => { seen.push(r); },
    });
    await completeSweep(tree, RESULT);
    expect(seen).toHaveLength(0);          // nothing emitted yet
    expect(review(tree)).toHaveLength(1);  // …and the review is up
    // ⚠ AND IT IS SHOWING THE PANORAMA. `<Image>` renders nothing for a
    // scheme-less path, so a review that opens with the bare native path is
    // the right modal around an empty frame — which is how the operator's
    // defect #4 was "fixed". The public result keeps the bare path; only
    // what the viewer is handed is schemed.
    // M9 — the review shows the OUTPUT, a COPY in the capture directory; the
    // pack's canvas is left as the engine painted it.
    expect(RESULT.uri).toBe(CANVAS);
    const shown = String(review(tree)[0].props.imageUri);
    expect(shown.startsWith('file://')).toBe(true);
    expect(shown.replace('file://', '')).toMatch(COPY_RE);
    // …and the surface is gone behind it, so two cameras cannot be open.
    expect(lastSweepEngineCall().enabled).toBe(false);
    act(() => { tree.unmount(); });
  });

  it('⚑ Confirm emits it, exactly once — a PANORAMA with engine "sweep", its pack kept (M9)', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const tree = await render({
      rectCrop: false, showPreview: true,
      onCapture: (r: Record<string, unknown>) => { seen.push(r); },
    });
    await completeSweep(tree, RESULT);
    // The emit must come from CONFIRM, not from `onComplete`. Without this
    // the count of 1 cannot tell the fix from the emit-first defect it
    // replaced — measured: a mutation restoring emit-first kept this green.
    expect(review(tree)).toHaveLength(1);
    act(() => { (review(tree)[0].props.onUseOriginal as (u?: string) => void)(); });
    expect(seen).toHaveLength(1);
    expect(review(tree)).toHaveLength(0);   // …and it closed
    // M9 (D6): one panorama shape for both engines, the engine named, and the
    // pack at the top level exactly as before.
    expect(seen[0].type).toBe('panorama');
    expect(seen[0].engine).toBe('sweep');
    expect(seen[0].ok).toBe(true);
    expect(seen[0].kind).toBe('panoplus');
    expect(seen[0].sessionDir).toBe(RESULT.sessionDir);
    expect(seen[0].summary).toBe(RESULT.summary);
    expect(seen[0].liveness).toBe('unavailable');
    expect(seen[0].framesRequested).toBe(120);   // counts.seen
    expect(seen[0].framesIncluded).toBe(96);     // painted (no seed, no tail here)
    expect(seen[0].framesDropped).toBe(0);
    expect(typeof seen[0].durationMs).toBe('number');
    expect('finalConfidenceThresh' in seen[0]).toBe(false);
    act(() => { tree.unmount(); });
  });

  it('⚑ Retake DISCARDS it — the capture never reaches the host', async () => {
    // Impossible before: the host had the result the moment the sweep ended.
    const seen: unknown[] = [];
    const tree = await render({
      rectCrop: false, showPreview: true, onCapture: (r: unknown) => { seen.push(r); },
    });
    await completeSweep(tree, RESULT);
    act(() => { (review(tree)[0].props.onRetake as () => void)(); });
    expect(seen).toHaveLength(0);
    // …and the surface comes BACK, which is what makes a retake possible.
    expect(review(tree)).toHaveLength(0);
    expect(lastSweepEngineCall().enabled).toBe(true);
    act(() => { tree.unmount(); });
  });

  // ── THE VERDICT SIDECAR ────────────────────────────────────────────────
  //
  // ⚠ ef4e95a NAMED THIS AS ITS #1 SILENT-REGRESSION RISK AND SHIPPED IT
  // UNTESTED. The write used to be a mount effect on `PanoPlusResultView`;
  // that screen no longer mounts, so the commit moved the write into
  // `<Camera>`'s `onComplete`. Mutation-measured afterwards: DELETING THE
  // CALL OUTRIGHT left the whole suite green. "The evidence it wrote is not
  // optional" was asserted in a commit message and nowhere else.

  it('⚑ every sweep writes host_verdict.json into its own session dir', async () => {
    written.length = 0;
    const tree = await render({ rectCrop: false, showPreview: true });
    await completeSweep(tree, RESULT);
    await act(async () => { await Promise.resolve(); });
    const verdict = written.filter((w) => w.uri.endsWith('/host_verdict.json'));
    expect(verdict).toHaveLength(1);
    expect(verdict[0].uri)
      .toBe(`file://${RESULT.sessionDir}/host_verdict.json`);
    // …and it is the REAL sidecar, not an empty file.
    //
    // ⚠ THIS WAS `expect.any(Object)`, WHICH IS TRUE OF `{}` — and of
    // `null`, since jest's Any(Object) tests `typeof other === 'object'`.
    // Measured: replacing the payload with the literal string '{}' left the
    // whole suite green, so every sweep could ship a `host_verdict.json`
    // with no schema, no dimensions and no verdict while this case passed.
    // Asserted against the producer, so a schema change cannot silently
    // hollow it out.
    expect(JSON.parse(verdict[0].body))
      .toEqual(JSON.parse(panoPlusVerdictSidecar(RESULT)));
    expect(Object.keys(JSON.parse(verdict[0].body)).length).toBeGreaterThan(2);
    act(() => { tree.unmount(); });
  });

  it('⚑ …and it SURVIVES a retake — the property the comment claims', async () => {
    // The write happens in `onComplete`, before the result is stashed, so a
    // discarded sweep still leaves its evidence on disk. That is the whole
    // reason the call sits where it does.
    written.length = 0;
    const tree = await render({ rectCrop: false, showPreview: true });
    await completeSweep(tree, RESULT);
    await act(async () => { await Promise.resolve(); });
    act(() => { (review(tree)[0].props.onRetake as () => void)(); });
    await act(async () => { await Promise.resolve(); });
    expect(written.filter((w) => w.uri.endsWith('/host_verdict.json')))
      .toHaveLength(1);
    act(() => { tree.unmount(); });
  });

  it('⚑ NEGATIVE CONTROL: no sessionDir, no sidecar', async () => {
    // Without this the two cases above pass for a write that fires
    // unconditionally and puts `host_verdict.json` at the filesystem root.
    written.length = 0;
    const tree = await render({});
    await completeSweep(tree, { ...RESULT, sessionDir: '' });
    await act(async () => { await Promise.resolve(); });
    expect(written.filter((w) => w.uri.endsWith('/host_verdict.json')))
      .toHaveLength(0);
    act(() => { tree.unmount(); });
  });

  it('⚑ the review carries the sweep\'s OWN verdict, not an empty array', async () => {
    // ⚠ `warnings: []` WAS HARDCODED FOR EVERY SWEEP while `panoPlusIntegrity`
    // — 352 lines of hole/seam/banding/clipping analysis — reached the pack
    // and nothing else. The channel is shared and was already wired, so a
    // host on `onCapture(result).warnings` got silence on one engine and
    // real warnings on the other, through the same callback.
    const holed = panoPlusResultOf(
      coercePanoPlusSummary({
        canvasPath: CANVAS,
        sessionDir: '/data/user/0/com.x/files/panoplus/pp_1',
        width: 4000, height: 1200,
        // A hole along the sweep — the thing the verdict is about.
        unpaintedColumns: 240,
        unpaintedRuns: [{ from: 100, to: 340 }],
        unpaintedRunsAxis: 'x',
      }),
      { rectify: true, gainMatch: true, packFrames: 'all', poseSource: 'imu' },
      '2026-09-21T00:00:00.000Z',
    );
    const seen: Array<Record<string, unknown>> = [];
    const tree = await render({
      rectCrop: false, showPreview: true,
      onCapture: (r: Record<string, unknown>) => { seen.push(r); },
    });
    await completeSweep(tree, holed);
    // The BANNER gets the message strings…
    expect((review(tree)[0].props.warnings as string[]).join(' ')).not.toBe('');
    // …and the HOST gets the coded warning on the result, which is the
    // channel every other engine fills and the sweep left undefined.
    act(() => { (review(tree)[0].props.onUseOriginal as () => void)(); });
    expect((seen[0].warnings as Array<{ code: string }>).map((x) => x.code))
      .toContain('SWEEP_NOT_INTACT');
    act(() => { tree.unmount(); });
  });

  it('⚑ …and an INTACT sweep carries none', async () => {
    // Negative control: without it the case above passes for a warning
    // emitted unconditionally, which would put a scary banner on every
    // good panorama.
    const seen: Array<Record<string, unknown>> = [];
    const tree = await render({
      rectCrop: false, showPreview: true,
      onCapture: (r: Record<string, unknown>) => { seen.push(r); },
    });
    await completeSweep(tree, RESULT);
    act(() => { (review(tree)[0].props.onUseOriginal as () => void)(); });
    expect((seen[0].warnings as Array<{ code: string }>).map((x) => x.code))
      .not.toContain('SWEEP_NOT_INTACT');
    act(() => { tree.unmount(); });
  });

  it('⚑ a sweep IS offered the crop editor, and is seeded from the coverage mask', async () => {
    // ⚠ THIS CASE ASSERTED THE OPPOSITE, under the note "`cropQuad` rewrites
    // the file in place, and the pack in `sessionDir` references that file —
    // cropping desyncs the two". That was true and it was the wrong
    // conclusion: the fix is to make the crop write ELSEWHERE, not to
    // withhold the editor. Withholding it is the divergence the operator
    // reported — one engine offering a crop preview and the other a bare
    // image, when what he asked for was "the SAME EVERYTHING except for the
    // underlying stitch mechanism".
    //
    // `cropQuad` now takes a destination (both natives) and `<Camera>` hands
    // a pano+ crop a SIBLING of the canvas, so `canvas.jpg` is untouched.
    const tree = await render({ rectCrop: true });
    await completeSweep(tree, RESULT);
    expect(review(tree)[0].props.showCropControls).toBe(true);
    // …AND THE QUAD OPENS ON THE INSCRIBED RECTANGLE, which is the half the
    // operator actually asked for ("cropped to the maximum inscribable
    // rectangle — like we do in pano"). Without the seed the editor opens on
    // a blind 8% inset, which is a crop preview that crops the wrong thing.
    expect(review(tree)[0].props.initialRect)
      .toEqual({ x: 12, y: 8, width: 3600, height: 1100 });
    act(() => { tree.unmount(); });
  });

  it('⚑ …and the crop runs IN PLACE on the COPY — canvas.jpg is never touched (M9)', async () => {
    // ⚠ THE WHOLE REASON THE EDITOR WAS WITHHELD. A pano+ canvas is
    // referenced by its pack, so an in-place crop leaves every offline
    // harness reading a pack whose seam residuals, coverage mask and ledger
    // describe a panorama that is no longer on disk. The pack would still
    // look complete, which is what makes it dangerous.
    const seen: Array<Record<string, unknown>> = [];
    const tree = await render({
      rectCrop: true,
      onCapture: (r: Record<string, unknown>) => { seen.push(r); },
    });
    await completeSweep(tree, RESULT);
    await act(async () => {
      (review(tree)[0].props.onConfirm as (q: unknown) => void)({
        quad: [
          { x: 12, y: 8 }, { x: 3612, y: 8 },
          { x: 3612, y: 1108 }, { x: 12, y: 1108 },
        ],
      });
    });
    expect(cropCalls).toHaveLength(1);
    expect(cropCalls[0]!.imagePath).toMatch(COPY_RE);
    expect(cropCalls[0]!.imagePath).not.toContain('canvas.jpg');
    expect(cropCalls[0]!.outputPath).toBeUndefined();
    // …and the HOST is handed the crop, not the canvas.
    expect(String(seen[0]!.uri)).toContain('/tmp/rnis-captures/panorama-');
    act(() => { tree.unmount(); });
  });

  it('⚑ the LEAD-OUT reaches the REVIEW BANNER — the operator\'s own question, answered on screen', async () => {
    // "In the output, I want you to see why there is some broken parts
    // towards the edges." Until now the answer reached no screen:
    // `panoPlusResidualLines`'s sentence renders through
    // `PanoPlusResultView`, which `<Camera>` no longer mounts, and
    // `host_verdict.json` needs a dependency the example does not have.
    //
    // Now it is a WARNING, on the same banner as every other one — which
    // renders in preview-only mode too, not just with the crop controls.
    const bootstrapOnly = panoPlusResultOf(
      coercePanoPlusSummary({
        canvasPath: CANVAS,
        sessionDir: '/data/user/0/com.x/files/panoplus/pp_1',
        // The operator's own A35 pack `pp_1789764257113`: 83 frames seen,
        // ZERO steady-state strips, and a real 720×497 canvas.
        width: 720, height: 497,
        counts: { seen: 83, painted: 0 },
        unpaintedRunsAxis: 'x',
        tailFlushAttempted: true, tailFlushed: true, tailFlushColumns: 249,
      }),
      { rectify: true, gainMatch: true, packFrames: 'all', poseSource: 'imu' },
      '2026-09-21T00:00:00.000Z',
    );
    const seen: Array<Record<string, unknown>> = [];
    const tree = await render({
      rectCrop: false, showPreview: true,            // preview-only — NOT the crop editor
      onCapture: (r: Record<string, unknown>) => { seen.push(r); },
    });
    await completeSweep(tree, bootstrapOnly);
    // ON THE BANNER…
    const banner = (review(tree)[0].props.warnings as string[]).join(' | ');
    expect(banner).toContain('single frame');
    // …and NOT the message that used to appear here, which contradicted the
    // picture the operator was looking at.
    expect(banner).not.toContain('Nothing was painted');
    // …and on the HOST channel, with a code to branch on.
    act(() => { (review(tree)[0].props.onUseOriginal as () => void)(); });
    expect((seen[0]!.warnings as Array<{ code: string }>).map((w) => w.code))
      .toContain('SWEEP_LEAD_OUT');
    act(() => { tree.unmount(); });
  });

  it('⚑ …and a STALE native still crops — in place on the copy needs no output path (M9)', async () => {
    // ⚠ JS NEWER THAN NATIVE IS THE ROUTINE STATE HERE — a Metro reload
    // without a rebuild. Such a build ignores the unknown `outputPath` key
    // and rewrites `imagePath` in place, and on this path `imagePath` IS the
    // pack's `canvas.jpg`: the pack would keep its seam residuals, its
    // coverage mask and its ledger while the image they describe was gone.
    //
    // `cropQuad` preflights on the presence of a marker METHOD, so the
    // refusal lands before native is asked. `cropCalls` empty is the
    // assertion that matters.
    staleNative = true;
    installBatchStitcher();
    const seen: Array<Record<string, unknown>> = [];
    const errs: unknown[] = [];
    const tree = await render({
      rectCrop: true,
      onCapture: (r: Record<string, unknown>) => { seen.push(r); },
      onError: (e: unknown) => { errs.push(e); },
    });
    await completeSweep(tree, RESULT);
    await act(async () => {
      (review(tree)[0].props.onConfirm as (q: unknown) => void)({
        quad: [
          { x: 12, y: 8 }, { x: 3612, y: 8 },
          { x: 3612, y: 1108 }, { x: 12, y: 1108 },
        ],
      });
    });
    // Until M9 the sweep cropped to a SIBLING of the pack's canvas, which an
    // older native could not do, so the crop was refused. Its output is now a
    // standalone copy, cropped in place like every other engine's.
    expect(cropCalls).toHaveLength(1);
    expect(cropCalls[0]!.outputPath).toBeUndefined();
    expect(errs).toHaveLength(0);
    expect(seen).toHaveLength(1);
    expect(String(seen[0]!.uri)).toMatch(/^file:\/\/\/tmp\/rnis-captures\/panorama-/);
    act(() => { tree.unmount(); });
  });

  it('⚑ with rectCrop and showPreview both off there is NO review — as documented', async () => {
    // ⚠ THIS CASE ASSERTED THE OPPOSITE, and the opposite was wrong.
    //
    // It read "a sweep always had a review; deferring must not silently
    // remove it" — which describes the OLD screen, not the contract. Both
    // props are public and documented: "with both off, `onCapture` fires
    // immediately with no UI". On the keyframe engine the defer is gated
    // `(rectCrop || showPreview) && …`; on the sweep it was gated on the
    // dimensions ALONE, so a host on the documented defaults that flipped
    // `engine` and nothing else got a full-screen review it never asked
    // for, and its auto-advance flow stalled behind a modal it could not
    // dismiss. `engine` changes what the hold RUNS and nothing else.
    const seen: unknown[] = [];
    const tree = await render({
      rectCrop: false, showPreview: false,
      onCapture: (r: unknown) => { seen.push(r); },
    });
    await completeSweep(tree, RESULT);
    expect(review(tree)).toHaveLength(0);
    expect(seen).toHaveLength(1);          // …and it emitted immediately
    act(() => { tree.unmount(); });
  });

  it('⚑ rectCrop is ON by default — a host passing NEITHER review prop gets the crop editor', async () => {
    // The operator's 2026-09-23 decision flipped the library default. A host
    // that says nothing about review now gets exactly what `rectCrop: true`
    // gives: the draggable quad, seeded on the inscribed rectangle, and
    // nothing reaches `onCapture` until the operator acts. The "both off"
    // case above is therefore opt-in: it has to say `rectCrop: false`.
    const seen: unknown[] = [];
    const tree = await render({ onCapture: (r: unknown) => { seen.push(r); } });
    await completeSweep(tree, RESULT);
    expect(review(tree)).toHaveLength(1);
    expect(review(tree)[0].props.showCropControls).toBe(true);
    expect(review(tree)[0].props.initialRect)
      .toEqual({ x: 12, y: 8, width: 3600, height: 1100 });
    expect(seen).toHaveLength(0);
    act(() => { tree.unmount(); });
  });

  it('⚑ M9: the output lands in the host\'s outputDir', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const tree = await render({
      rectCrop: false, showPreview: false, outputDir: 'file:///host/out/',
      onCapture: (r: Record<string, unknown>) => { seen.push(r); },
    });
    await completeSweep(tree, RESULT);
    expect(String(seen[0].uri)).toMatch(/^file:\/\/\/host\/out\/panorama-\d+\.jpg$/);
    act(() => { tree.unmount(); });
  });

  it('⚑ M9: frames the engine REFUSED reach onFramesDropped', async () => {
    const dropped: Array<{ requested: number; included: number }> = [];
    const refused = panoPlusResultOf(
      coercePanoPlusSummary({
        canvasPath: CANVAS, sessionDir: '/data/user/0/com.x/files/panoplus/pp_1',
        width: 4000, height: 1200,
        counts: { seen: 120, painted: 96, rejectedOutOfCage: 7, rejectedTracking: 3 },
      }),
      { rectify: true, gainMatch: true, packFrames: 'all', poseSource: 'imu' },
      '2026-09-24T00:00:00.000Z',
    );
    const tree = await render({
      rectCrop: false, showPreview: false,
      onFramesDropped: (d: { requested: number; included: number }) => { dropped.push(d); },
    });
    await completeSweep(tree, refused);
    // M9 review — the result's OWN numbers (framesIncluded is painted + seed,
    // 96 here), plus the refused count; not `requested − dropped`.
    expect(dropped).toEqual([{ requested: 120, included: 96, dropped: 10 }]);
    act(() => { tree.unmount(); });
  });

  it('⚑ NEGATIVE CONTROL: a sweep with no refusals fires no onFramesDropped', async () => {
    const dropped: unknown[] = [];
    const tree = await render({
      rectCrop: false, showPreview: false,
      onFramesDropped: (d: unknown) => { dropped.push(d); },
    });
    await completeSweep(tree, RESULT);
    expect(dropped).toEqual([]);
    act(() => { tree.unmount(); });
  });

  it('⚑ M9: an output that cannot be written is OUTPUT_WRITE_FAILED on both channels', async () => {
    const NM = require('react-native').NativeModules as Record<string, any>;
    const realCopy = NM.RNImageStitcherFileUtils.copyFile;
    NM.RNImageStitcherFileUtils.copyFile = () => Promise.reject(new Error('disk full'));
    const seen: Array<Record<string, any>> = [];
    const errs: Array<{ code: string }> = [];
    try {
      const tree = await render({
        rectCrop: false, showPreview: true,
        onCapture: (r: Record<string, any>) => { seen.push(r); },
        onError: (e: { code: string }) => { errs.push(e); },
      });
      await completeSweep(tree, RESULT);
      expect(errs.map((e) => e.code)).toEqual(['OUTPUT_WRITE_FAILED']);
      expect(seen).toHaveLength(1);
      expect([seen[0].ok, seen[0].type, seen[0].engine]).toEqual([false, 'panorama', 'sweep']);
      expect(review(tree)).toHaveLength(0);     // nothing to review
      act(() => { tree.unmount(); });
    } finally {
      NM.RNImageStitcherFileUtils.copyFile = realCopy;
    }
  });

  it('⚑ M9: a failure reaches onCapture as ok:false, and a FINISH failure is a finalize failure', async () => {
    const seen: Array<Record<string, any>> = [];
    const errs: Array<{ code: string }> = [];
    const tree = await render({
      onCapture: (r: Record<string, any>) => { seen.push(r); },
      onError: (e: { code: string }) => { errs.push(e); },
    });
    const fail = surfaceProps(tree).onFailure as (f: unknown) => void;
    act(() => { fail({ code: 'panoplus-io', message: 'x', sessionDir: null, counts: null, abort: null }); });
    act(() => {
      fail({ code: 'panoplus-io', message: 'y', sessionDir: null, counts: null, abort: null, stage: 'finish' });
    });
    expect(errs.map((e) => e.code)).toEqual(['PANORAMA_START_FAILED', 'PANORAMA_FINALIZE_FAILED']);
    expect(seen.map((r) => [r.ok, r.type, r.engine, r.error.code])).toEqual([
      [false, 'panorama', 'sweep', 'PANORAMA_START_FAILED'],
      [false, 'panorama', 'sweep', 'PANORAMA_FINALIZE_FAILED'],
    ]);
    act(() => { tree.unmount(); });
  });

  it('⚑ NEGATIVE CONTROL: an abandon is a guard rail, not a failure — neither channel hears it', async () => {
    const seen: unknown[] = [];
    const errs: unknown[] = [];
    const tree = await render({
      onCapture: (r: unknown) => { seen.push(r); },
      onError: (e: unknown) => { errs.push(e); },
    });
    act(() => {
      (surfaceProps(tree).onFailure as (f: unknown) => void)({
        code: 'panoplus-abandoned', message: 'x', sessionDir: null, counts: null, abort: null,
      });
    });
    expect(seen).toEqual([]);
    expect(errs).toEqual([]);
    act(() => { tree.unmount(); });
  });

  it('⚑ and the emitted uri is SCHEMED, like every other engine\'s', async () => {
    // Three emit sites, one `onCapture`, and they disagreed: a photo and a
    // panorama emit `file:///…`, a sweep emitted the bare native path that
    // `panoPlusResultOf` returns verbatim. A host cannot branch on the
    // engine, and every `fs`-style API treats `file:///x.jpg` as a literal
    // filename while every `<Image>` needs the scheme — so one of the two
    // always broke, depending on which engine ran.
    const seen: Array<Record<string, unknown>> = [];
    const tree = await render({
      rectCrop: false, showPreview: false,
      onCapture: (r: Record<string, unknown>) => { seen.push(r); },
    });
    await completeSweep(tree, RESULT);
    expect(seen).toHaveLength(1);
    // M9 — the emitted uri is the COPY, schemed like every other engine's…
    expect(String(seen[0].uri).startsWith('file://')).toBe(true);
    expect(String(seen[0].uri).replace('file://', '')).toMatch(COPY_RE);
    // …and the PACK's own path is untouched.
    expect(RESULT.uri).toBe(CANVAS);
    act(() => { tree.unmount(); });
  });
});


// ════════════════════════════════════════════════════════════════════════
// ONE CAMERA, ONE FORMAT — pano and pano+ pick the SAME stream
//
// The objective is one `<Camera>` whose tap takes a photo through the session
// the hold sweeps from. So the format the sweep cell's host preview gets must
// be the format the keyframe cell gets, on the same device — and both must be
// the hardware's 1440x1080, not vision-camera's 640x480. The picker's unit
// tests prove the POLICY; this proves the WIRING reaches both cells.
// ════════════════════════════════════════════════════════════════════════
describe('⚑ one camera, one format — the hardware list reaches BOTH cells', () => {
  const VC_FORMATS = ([[720, 480], [640, 480], [1280, 720], [1920, 1080], [3840, 2160]] as const)
    .flatMap(([vw, vh]) => ([[4080, 3060], [1920, 1440], [1440, 1080]] as const)
      .map(([pw, ph]) => ({
        photoWidth: pw, photoHeight: ph, videoWidth: vw, videoHeight: vh,
        maxFps: 30, supportsVideoHdr: false,
      })));
  const HW_REPORT = { cameras: { cameras: [{ id: 'back-0', streamConfig: { yuv420Sizes: [
    { width: 1920, height: 1440, maxFps: 30 }, { width: 1440, height: 1080, maxFps: 30 },
    { width: 960, height: 720, maxFps: 30 }, { width: 640, height: 480, maxFps: 30 },
  ] } }] } };

  const innerFormat = (t: ReactTestRenderer) => {
    const inner = t.root.findAllByType(
      (require('react-native-vision-camera') as { Camera: React.ComponentType }).Camera,
    );
    if (inner.length !== 1) throw new Error(`expected one vision-camera <Camera>, found ${inner.length}`);
    return inner[0].props.format as { videoWidth: number; videoHeight: number; photoWidth: number; photoHeight: number };
  };
  const withProbe = (report: unknown) => {
    (NativeModules as Record<string, unknown>).RNSSweepProbe = {
      probeCapabilities: () => Promise.resolve(report),
    };
  };

  beforeEach(() => {
    __resetHardwareVideoSizesCache();
    const withFormats = { ...DEVICE, formats: VC_FORMATS };
    vc.useCameraDevice = () => withFormats;
    vc.useCameraDevices = () => [withFormats];
  });
  afterEach(() => {
    delete (NativeModules as Record<string, unknown>).RNSSweepProbe;
    __resetHardwareVideoSizesCache();
  });

  it('FAILS BEFORE: the SWEEP cell picks the hardware 1440x1080 at 4:3', async () => {
    withProbe(HW_REPORT);
    const tree = await render();
    await settle(50);
    const fmt = innerFormat(tree);
    expect([fmt.videoWidth, fmt.videoHeight]).toEqual([1440, 1080]);
    expect(fmt.photoWidth / fmt.photoHeight).toBeCloseTo(4 / 3, 2);
    act(() => { tree.unmount(); });
  });

  it('FAILS BEFORE: the KEYFRAME cell on the SAME device picks the SAME 1440x1080', async () => {
    withProbe(HW_REPORT);
    const tree = await render();
    await setEngine(tree, 'keyframe');
    act(() => { jest.advanceTimersByTime(2000); });
    await settle(50);
    expect(cameraViews(tree)).toHaveLength(1);
    expect([innerFormat(tree).videoWidth, innerFormat(tree).videoHeight]).toEqual([1440, 1080]);
    act(() => { tree.unmount(); });
  });

  it('CHARACTERIZATION: without the probe both cells stay on vision-camera\'s 640x480 — fail-open', async () => {
    // No RNSSweepProbe in NativeModules: the list is as vision-camera gave it,
    // the mount is not held, and the pick is the old one. Documents the
    // fail-open contract rather than the fix.
    const tree = await render();
    expect([innerFormat(tree).videoWidth, innerFormat(tree).videoHeight]).toEqual([640, 480]);
    await setEngine(tree, 'keyframe');
    act(() => { jest.advanceTimersByTime(2000); });
    expect([innerFormat(tree).videoWidth, innerFormat(tree).videoHeight]).toEqual([640, 480]);
    act(() => { tree.unmount(); });
  });

  it('FAILS BEFORE: does not cry "inert floor" from the transient pre-probe pick', async () => {
    // Seen on the A35: the warning fired at 13.797 s from the incomplete
    // list, and the 1440x1080 session opened at 14.117 s. The pick runs on
    // the held renders too, so the warning must wait for the probe.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      let resolveProbe!: (r: unknown) => void;
      (NativeModules as Record<string, unknown>).RNSSweepProbe = {
        probeCapabilities: () => new Promise((res) => { resolveProbe = res; }),
      };
      const tree = await render({ keyframeQualityCapture: true });
      const floorWarnings = () =>
        warn.mock.calls.filter((c) => String(c[0]).includes('video floor')).length;
      expect(floorWarnings()).toBe(0); // pending: say nothing
      await act(async () => { resolveProbe(HW_REPORT); await Promise.resolve(); await Promise.resolve(); });
      expect(floorWarnings()).toBe(0); // answered, and it cleared: still nothing
      act(() => { tree.unmount(); });
    } finally {
      warn.mockRestore();
    }
  });

  it('CHARACTERIZATION: with no probe at all the inert-floor warning still fires', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const tree = await render({ keyframeQualityCapture: true });
      expect(warn.mock.calls.some((c) => String(c[0]).includes('video floor 1280px'))).toBe(true);
      act(() => { tree.unmount(); });
    } finally {
      warn.mockRestore();
    }
  });

  it('holds the mount until the probe answers, then mounts ONCE with the final format', async () => {
    // A pick from the incomplete list followed by a re-pick would restart the
    // session and make a sweep started in between refuse every frame.
    let resolveProbe!: (r: unknown) => void;
    (NativeModules as Record<string, unknown>).RNSSweepProbe = {
      probeCapabilities: () => new Promise((res) => { resolveProbe = res; }),
    };
    const tree = await render();
    expect(tree.root.findAllByType(
      (require('react-native-vision-camera') as { Camera: React.ComponentType }).Camera,
    )).toHaveLength(0);
    await act(async () => { resolveProbe(HW_REPORT); await Promise.resolve(); await Promise.resolve(); });
    expect([innerFormat(tree).videoWidth, innerFormat(tree).videoHeight]).toEqual([1440, 1080]);
    act(() => { tree.unmount(); });
  });
});

// ── M3: ONE COMPOSED FRAME PROCESSOR ────────────────────────────────────────
//
// vision-camera sets `enableFrameProcessor={frameProcessor != null}`, and a
// flip of that REBINDS the camera's outputs. The processor used to be
// `host ?? (engine === 'sweep' ? sweep : keyframe)`, with the keyframe one
// null until its plugin was ready — so switching engines rebuilt the session.
describe('M3 — the frame processor vision-camera sees is one composed worklet', () => {
  const vcAny = require('react-native-vision-camera') as {
    Camera: unknown;
    useFrameProcessor: unknown;
  };
  const realUseFP = vcAny.useFrameProcessor;
  beforeEach(() => {
    // Memoised by deps, as the real hook is — identity is the property here.
    vcAny.useFrameProcessor = (fn: unknown, deps: unknown[]) =>
      // eslint-disable-next-line react-hooks/rules-of-hooks, react-hooks/exhaustive-deps
      React.useMemo(() => ({ frameProcessor: fn, type: 'readonly' }), deps);
  });
  afterEach(() => { vcAny.useFrameProcessor = realUseFP; });

  const fpOf = (t: ReactTestRenderer): unknown => {
    const cams = t.root.findAll((n) => n.type === vcAny.Camera);
    expect(cams.length).toBe(1);
    return cams[0]!.props.frameProcessor;
  };

  it('is present on BOTH engines and is the SAME object across a switch', async () => {
    const tree = await render({ engine: 'keyframe', enablePanoramaMode: true });
    const kf = fpOf(tree);
    expect(kf).not.toBeUndefined();
    await setEngine(tree, 'sweep', { enablePanoramaMode: true });
    // Let the ownership settle window pass so the host preview is mounted.
    await act(async () => { jest.advanceTimersByTime(700); await Promise.resolve(); });
    const sw = fpOf(tree);
    expect(sw).toBe(kf);
    await setEngine(tree, 'keyframe', { enablePanoramaMode: true });
    await act(async () => { jest.advanceTimersByTime(700); await Promise.resolve(); });
    expect(fpOf(tree)).toBe(kf);
    act(() => { tree.unmount(); });
  });

  it('a host processor runs WITH the sweep — the host no longer costs the sweep its camera', async () => {
    const hostCalls: string[] = [];
    const host = { type: 'readonly', frameProcessor: () => { hostCalls.push('host'); } };
    const tree = await render({ engine: 'sweep', frameProcessor: host });
    await act(async () => { jest.advanceTimersByTime(700); await Promise.resolve(); });
    const surface = { props: lastSweepProps() as Record<string, any> };
    expect(surface.props.frameSource).toBe('host');
    expect(surface.props.hostArmRefusal).toBeNull();
    const fp = fpOf(tree) as { frameProcessor: (f: unknown) => void };
    expect(fp).not.toBe(host);           // composed, not replaced
    fp.frameProcessor({});
    expect(hostCalls).toEqual(['host']);
    act(() => { tree.unmount(); });
  });

  it('a DRAWABLE host processor is passed through, and a sweep hold is refused by name', async () => {
    const host = { type: 'drawable-skia', frameProcessor: () => undefined };
    const tree = await render({ engine: 'sweep', frameProcessor: host });
    await act(async () => { jest.advanceTimersByTime(700); await Promise.resolve(); });
    expect(fpOf(tree)).toBe(host);
    const surface = { props: lastSweepProps() as Record<string, any> };
    expect(surface.props.hostArmRefusal?.code).toBe('panoplus-refused-drawable-processor');
    act(() => { tree.unmount(); });
  });
});
