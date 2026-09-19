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
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Platform } from 'react-native';
import { VisionCameraProxy } from 'react-native-vision-camera';

// ⚠ THE RESULT VIEWER IS STUBBED, and only it. `PanoPlusResultView` pulls
// `containFit` through the package barrel, which does not resolve under this
// project's module map — a harness artifact, not a behaviour. What this file
// needs from the viewer is that it EXISTS and takes `onDismiss`, because the
// subject is `<Camera>`'s decision to unmount the preview behind it, not the
// viewer's own rendering (which `panoPlusResultView.render.test.tsx` owns).
jest.mock('../PanoPlusResultView', () => ({
  PanoPlusResultView: (props: { onDismiss: () => void }) =>
    require('react').createElement('PanoPlusResultViewStub', props),
}));

import { Camera } from '../../camera/Camera';
import { CameraView } from '../../camera/CameraView';
import { PanoPlusCaptureSurface } from '../PanoPlusCaptureSurface';
import { coercePanoPlusSummary } from '../panoPlusModel';

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

beforeEach(() => {
  jest.useFakeTimers();
  (Platform as { OS: string }).OS = 'android';
  vc.useCameraDevice = () => DEVICE;
  vc.useCameraDevices = () => [DEVICE];
  proxy.initFrameProcessorPlugin = () => ({ call: () => undefined });
});
afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
  (Platform as { OS: string }).OS = 'ios';
  vc.useCameraDevice = realDevice;
  vc.useCameraDevices = realDevices;
  proxy.initFrameProcessorPlugin = realInit;
});

function render(props: Record<string, unknown> = {}): ReactTestRenderer {
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
  return t;
}
const surfaceProps = (t: ReactTestRenderer): Record<string, unknown> =>
  t.root.findByType(PanoPlusCaptureSurface).props as Record<string, unknown>;
const cameraViews = (t: ReactTestRenderer) => t.root.findAllByType(CameraView);

describe('⚑ THE PRECONDITION — this suite really does reach the host arm', () => {
  it('mounts exactly ONE <CameraView> and hands the surface the host arm', () => {
    // Without this every assertion below is the same vacuous pass the last
    // five rounds kept finding: "false === false" on a pinned harness.
    const tree = render();
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

  it('⚑ is FALSE while the session opens, even though the element is mounted', () => {
    // The window this whole mechanism exists for: mounted is not drawing,
    // and reporting it as drawing makes the surface transparent over a
    // black, session-less CameraView with its explainer suppressed.
    const tree = render();
    expect(surfaceProps(tree).hostPreviewLive).toBe(false);
    act(() => { tree.unmount(); });
  });

  it('⚑ turns TRUE on the first preview frame', () => {
    const tree = render();
    act(() => { previewProps(tree).onPreviewStarted?.(); });
    expect(surfaceProps(tree).hostPreviewLive).toBe(true);
    act(() => { tree.unmount(); });
  });

  it('⚑ …and FALSE again when the preview stops', () => {
    const tree = render();
    act(() => { previewProps(tree).onPreviewStarted?.(); });
    act(() => { previewProps(tree).onPreviewStopped?.(); });
    expect(surfaceProps(tree).hostPreviewLive).toBe(false);
    act(() => { tree.unmount(); });
  });
});

describe('⚑ AN UNMOUNT CLEARS "LIVE" — no callback fires for one', () => {
  it('a remounted <CameraView> is never reported as already drawing', () => {
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
    const tree = render();
    const start = () => act(() => {
      (cameraViews(tree)[0].props.cameraProps as {
        onPreviewStarted?: () => void;
      }).onPreviewStarted?.();
    });

    start();
    expect(surfaceProps(tree).hostPreviewLive).toBe(true);

    // Away and back: the element leaves the tree and a NEW one returns.
    const setArm = surfaceProps(tree).onPoseSourceChange as (s: string) => void;
    act(() => { setArm('ar'); });
    act(() => { jest.advanceTimersByTime(1000); });
    expect(cameraViews(tree)).toHaveLength(0);

    act(() => { setArm('imu'); });
    act(() => { jest.advanceTimersByTime(1000); });
    expect(cameraViews(tree)).toHaveLength(1);

    // The new element has had no `onPreviewStarted`.
    expect(surfaceProps(tree).hostPreviewLive).toBe(false);
    // …and says so, rather than showing a transparent root over nothing.
    start();
    expect(surfaceProps(tree).hostPreviewLive).toBe(true);
    act(() => { tree.unmount(); });
  });
});

describe('⚑ THE REVIEW CYCLE — where ownership does NOT move but the element goes', () => {
  it('a preview remounted after the result viewer is not reported as live', () => {
    // THE DISTINGUISHING PATH, and the one three drafts of this coverage
    // missed. On sweep → review → dismiss → sweep, `mountHostPreview` never
    // changes: the latch clears, no ownership term moves, `statusPhase`
    // never reaches 'stitching' on the sweep path. What unmounts the
    // preview is `sweepReview != null` alone.
    //
    // So a "started" flag cleared on the OWNERSHIP change is never cleared
    // here, and the remounted `<CameraView>` — a new instance with no
    // session — was reported as drawing. Transparent root, explainer
    // suppressed, black underneath, on every capture after the first.
    //
    // The ownership round-trip case above cannot see this: ownership DOES
    // move there, so both the right and the wrong keying clear the flag.
    const tree = render();
    act(() => {
      (cameraViews(tree)[0].props.cameraProps as {
        onPreviewStarted?: () => void;
      }).onPreviewStarted?.();
    });
    expect(surfaceProps(tree).hostPreviewLive).toBe(true);
    const armBefore = surfaceProps(tree).vcPluginArm;

    // `coercePanoPlusSummary({})` fills every field a real summary has, so
    // the viewer renders without a hand-built fixture drifting from it.
    const onComplete = surfaceProps(tree).onComplete as (r: unknown) => void;
    act(() => {
      onComplete({
        uri: 'file:///x.jpg',
        width: 4000,
        height: 1200,
        sessionDir: '/tmp/pp_1',
        arms: { rectify: true, gainMatch: true },
        summary: coercePanoPlusSummary({}),
      });
    });
    // The viewer REPLACES the surface (it owns a camera, and leaving it
    // mounted behind a review holds the device while the operator reads),
    // so the surface's props are unreadable until dismissal.
    expect(cameraViews(tree)).toHaveLength(0);

    const viewer = tree.root.findAll(
      (n) => typeof n.props?.onDismiss === 'function', { deep: true },
    )[0];
    act(() => { (viewer.props.onDismiss as () => void)(); });
    expect(cameraViews(tree)).toHaveLength(1);

    // ⚠ THE PRECONDITION THAT MAKES THIS CASE DISTINGUISHING, asserted on
    // the far side because the surface is unreadable mid-review: ownership
    // did NOT move across the cycle. If it ever does, this case silently
    // degrades into a duplicate of the ownership round-trip above, which
    // both the right and the wrong keying already pass.
    expect(surfaceProps(tree).vcPluginArm).toBe(armBefore);
    expect(armBefore).toBe(true);

    // And the new element, which has had no `onPreviewStarted`, is not
    // reported as drawing.
    expect(surfaceProps(tree).hostPreviewLive).toBe(false);
    act(() => { tree.unmount(); });
  });
});

describe('⚑ THE OWNERSHIP FLIP — a handoff, not an instant swap', () => {
  it('hands the camera over with NEITHER side holding one', () => {
    // The AR pill moves ownership at idle. Done in one commit, <CameraView>
    // unmounts and the surface opens its own client in the same frame while
    // Camera2 is still releasing — ERROR_CAMERA_IN_USE for an ordering bug.
    const tree = render();
    expect(cameraViews(tree)).toHaveLength(1);

    const toAr = surfaceProps(tree).onPoseSourceChange as (s: string) => void;
    act(() => { toAr('ar'); });

    // Mid-handoff: the surface is told 'host' so it lets go, and nothing is
    // mounted so nothing contends.
    expect(cameraViews(tree)).toHaveLength(0);
    expect(surfaceProps(tree).frameSource).toBe('host');
    expect(surfaceProps(tree).vcPluginArm).toBe(false);

    // After the window, the surface owns its own camera.
    act(() => { jest.advanceTimersByTime(1000); });
    expect(cameraViews(tree)).toHaveLength(0);
    expect(surfaceProps(tree).frameSource).toBe('own');
    act(() => { tree.unmount(); });
  });

  it('⚑ a bag-pinned lens cannot disarm the multicam guard', () => {
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
    const tree = render({
      defaultLens: '0.5x' as const,
      sweep: { lens: 'wide' as const },
    });
    const p = surfaceProps(tree);
    // PRECONDITIONS: the body really is multicam and the device really is
    // at 0.5×. Without these the assertion below passes on any tree.
    expect(p.lens).toBe('wide');
    expect(p.vcPluginArm).toBe(false);      // the bag bought no ownership
    expect(p.frameSource).toBe('own');
    act(() => { tree.unmount(); });
  });
});
