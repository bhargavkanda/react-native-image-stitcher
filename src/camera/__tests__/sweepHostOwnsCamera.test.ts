// SPDX-License-Identifier: Apache-2.0
/**
 * `sweepHostOwnsCamera` — the one boolean that decides who holds the back
 * camera on `engine="sweep"`.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────
 *
 * S7 asked this question in three places and got three different answers.
 * Every disagreement between them ends identically and invisibly: vision-
 * camera holds the camera while the native recorder opens its own session
 * against it, and because `canAddInput` tests configuration compatibility
 * rather than runtime exclusivity, the second open USUALLY SUCCEEDS. There
 * is no error code. One of the two sessions is interrupted some moments
 * later and the operator sees a dead preview.
 *
 * ⚠ THIS FILE USED TO SAY "no render test in this package can reach" these
 * states. That was FALSE, and believing it cost five review rounds:
 * `src/sweep/__tests__/cameraSweepHostArm.render.test.tsx` overrides the
 * pinned mocks in that one file and drives the Android host arm end to end.
 *
 * The table is still the right home for the rows a mounted tree cannot
 * produce — every single-term mutation against an otherwise-true baseline,
 * which needs eight independent inputs moved one at a time — and that is
 * what it is for now. For the wired behaviour, read the render suite.
 *
 * Every FALSE row below is a state that was reachable before the collapse,
 * and each one names the collision it prevents.
 */
// Camera.tsx transitively imports the entire camera surface; we call one
// pure function, so the native dep tree is stubbed exactly as
// `cameraUnmountGate.test.ts` does for its sibling predicate.
//
// ⚠ NOTE THE STUB'S `Platform.OS: 'ios'` — irrelevant here, and
// deliberately so: the platform is an ARGUMENT to this predicate, not
// something it reads from the module. A predicate that read the global
// could not be tested for both platforms in one process, which is the
// whole reason the iOS regression below is reachable by a unit test.
// Camera.tsx transitively imports the entire camera surface (vision-camera,
// worklets, sensors, native modules); we only call one pure function, so
// stub the whole dependency tree (mirrors homeIndicatorEdge.test.ts).
jest.mock('react-native', () => ({
  NativeModules: {},
  Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios },
  Pressable: 'Pressable',
  StyleSheet: { create: (s: Record<string, unknown>) => s, absoluteFill: {} },
  Text: 'Text',
  View: 'View',
  Image: 'Image',
  ScrollView: 'ScrollView',
  Animated: { View: 'Animated.View', Value: class {}, timing: () => ({ start: () => undefined }) },
  Modal: 'Modal',
  ActivityIndicator: 'ActivityIndicator',
  useWindowDimensions: () => ({ width: 0, height: 0 }),
  requireNativeComponent: () => 'NativeComponent',
  UIManager: { getViewManagerConfig: () => ({}) },
  findNodeHandle: () => 1,
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('react-native-sensors', () => ({
  accelerometer: { subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) },
  setUpdateIntervalForType: jest.fn(),
  SensorTypes: { accelerometer: 'accelerometer' },
}));
jest.mock('react-native-worklets-core', () => ({ Worklets: {} }));
jest.mock('react-native-vision-camera', () => ({
  Camera: 'Camera',
  useCameraDevice: jest.fn(),
  useCameraPermission: jest.fn(),
}));

import {
  SWEEP_HOST_OWNS_INPUT_KEYS,
  sweepEffectiveLens,
  sweepHostArmRefusal,
  colourLensTypeCount,
  sweepFailureCameraCode,
  type SweepHostArmRefusalInput,
  type SweepHostOwnsCameraInput,
  _sweepHostOwnsCameraForTests as hostOwns,
  _sweepCameraHandoffForTests as handoff,
  _sweepPreviewLiveForTests as previewLive,
  _sweepShouldSettleForTests as shouldSettle,
  cameraKindFor,
} from '../Camera';

/** The state in which the host owns the camera: non-AR, no hatch (M5: both platforms). */
const OK: SweepHostOwnsCameraInput = {
  isAR: false,
  frameSourceOverride: undefined,
};

/**
 * ── M3: THE CAMERA DECIDES, AND NOTHING ELSE ────────────────────────────
 *
 * The predicate used to have nine terms, and six of them answered "no" by
 * handing the sweep to pano+'s OWN Camera2 client — a second camera owner.
 * Those six are now named refusals of the hold (`sweepHostArmRefusal`,
 * tabled below), and ownership is `<Camera>`'s own state: non-AR on Android
 * ⇒ the host's `<CameraView>`, always.
 */
describe('sweepHostOwnsCamera — the camera state alone decides', () => {
  it('non-AR: the host owns it — on BOTH platforms since M5', () => {
    expect(hostOwns(OK)).toBe(true);
  });

  it('the full truth table — false ONLY for the DR-1a hatch on a non-AR sweep (M8)', () => {
    // M8: the AR sweep runs on `<Camera>`'s own AR view too, so ownership is
    // `<Camera>`'s on every cell but the reference hatch — and the hatch is
    // inert with AR on.
    for (const isAR of [true, false]) {
      for (const frameSourceOverride of [undefined, 'own' as const]) {
        const want = !(frameSourceOverride === 'own' && !isAR);
        expect({ isAR, frameSourceOverride, owns: hostOwns({ isAR, frameSourceOverride }) })
          .toEqual({ isAR, frameSourceOverride, owns: want });
      }
    }
  });

  it('⚑ every input key has a value that flips the answer, on its own', () => {
    // From the hatch state (non-AR + 'own' → false), each key alone flips it.
    const HATCH: SweepHostOwnsCameraInput = { isAR: false, frameSourceOverride: 'own' };
    const flip: { [K in keyof SweepHostOwnsCameraInput]: SweepHostOwnsCameraInput[K] } = {
      isAR: true,
      frameSourceOverride: undefined,
    };
    expect(hostOwns(HATCH)).toBe(false);
    for (const key of SWEEP_HOST_OWNS_INPUT_KEYS) {
      expect({ key, owns: hostOwns({ ...HATCH, [key]: flip[key] }) })
        .toEqual({ key, owns: true });
    }
  });
});

/** Nothing wrong: a hold can run on the host camera. */
const READY: SweepHostArmRefusalInput = {
  hostProcessorDrawable: false,
  captureMode: 'wide-only',
  lens: '1x',
  pluginReady: true,
  pluginUnavailable: false,
  nativeVcArm: true,
  cameraUnmounting: false,
  deviceId: 'back-0',
  colourLensTypes: 1,
  depthMount: false,
};

describe('sweepHostArmRefusal — each old fallback is now a NAMED refusal', () => {
  it('nothing wrong: no refusal', () => {
    expect(sweepHostArmRefusal(READY)).toBeNull();
  });

  const cases: Array<[string, Partial<SweepHostArmRefusalInput>, string]> = [
    ['a drawable (Skia) host processor', { hostProcessorDrawable: true }, 'panoplus-refused-drawable-processor'],
    ['multicam at 0.5× (D13 — which lens is unknown)', { captureMode: 'multicam', lens: '0.5x' }, 'panoplus-refused-zoom-lens'],
    ['the plugin is not in this build', { pluginReady: false, pluginUnavailable: true }, 'panoplus-plugin-unavailable'],
    ['M5: the native module predates the vc arm', { nativeVcArm: false }, 'panoplus-vc-arm-unavailable'],
    ['the plugin is still loading', { pluginReady: false }, 'panoplus-not-ready'],
    ['the camera is in transition', { cameraUnmounting: true }, 'panoplus-camera-not-ready'],
    ['no device id yet', { deviceId: '' }, 'panoplus-camera-not-ready'],
    ['M5 review: an iOS mount combining two colour lenses', { colourLensTypes: 2 }, 'panoplus-vc-device-unsupported'],
  ];
  for (const [what, over, code] of cases) {
    it(`${what}: ${code}`, () => {
      const r = sweepHostArmRefusal({ ...READY, ...over });
      expect(r?.code).toBe(code);
      expect(r?.message.length ?? 0).toBeGreaterThan(20);
    });
  }

  it('multicam AT the wide baseline and a standalone ultra-wide are NOT refused', () => {
    expect(sweepHostArmRefusal({ ...READY, captureMode: 'multicam', lens: '1x' })).toBeNull();
    expect(sweepHostArmRefusal({ ...READY, captureMode: 'wide-only', lens: '0.5x' })).toBeNull();
  });

  it('⚑ the most actionable reason wins when several hold', () => {
    const all: SweepHostArmRefusalInput = {
      hostProcessorDrawable: true,
      captureMode: 'multicam',
      lens: '0.5x',
      pluginReady: false,
      pluginUnavailable: true,
      nativeVcArm: false,
      cameraUnmounting: true,
      deviceId: '',
      colourLensTypes: 2,
      depthMount: true,
    };
    expect(sweepHostArmRefusal(all)?.code).toBe('panoplus-refused-drawable-processor');
    expect(sweepHostArmRefusal({ ...all, hostProcessorDrawable: false })?.code)
      .toBe('panoplus-refused-zoom-lens');
    // The multi-lens mount outranks the build faults: the operator can act on
    // it (AR or 0.5×) where a missing plugin needs a rebuild.
    expect(sweepHostArmRefusal({ ...all, hostProcessorDrawable: false, lens: '1x' })?.code)
      .toBe('panoplus-vc-device-unsupported');
    expect(sweepHostArmRefusal({
      ...all, hostProcessorDrawable: false, lens: '1x', colourLensTypes: 1,
    })?.code).toBe('panoplus-plugin-unavailable');
  });
});

describe('the iOS multi-lens mount (M5 review) — refused before the hold, by its cause', () => {
  // vision-camera's `physicalDevices` for the mounts `selectCaptureDevice`
  // makes with photo depth on: LiDAR (iPhone Pro), Dual Wide (non-LiDAR with
  // an ultra-wide), Dual (wide + tele). The LiDAR sensor is reported as
  // `wide-angle-camera` — vision-camera's fallback for an unknown type.
  it.each([
    ['LiDAR depth camera', ['wide-angle-camera', 'wide-angle-camera'], 1],
    ['Dual Wide', ['ultra-wide-angle-camera', 'wide-angle-camera'], 2],
    ['Dual', ['wide-angle-camera', 'telephoto-camera'], 2],
    ['Triple', ['ultra-wide-angle-camera', 'wide-angle-camera', 'telephoto-camera'], 3],
    ['a physical wide', ['wide-angle-camera'], 1],
  ] as const)('%s → %i distinct colour lens(es)', (_n, devices, n) => {
    expect(colourLensTypeCount([...devices])).toBe(n);
  });
  it('the LiDAR mount sweeps; Dual Wide is refused naming photo depth; off iOS nothing is counted', () => {
    expect(sweepHostArmRefusal({ ...READY, colourLensTypes: 1, depthMount: true })).toBeNull();
    const r = sweepHostArmRefusal({ ...READY, colourLensTypes: 2, depthMount: true });
    expect(r?.code).toBe('panoplus-vc-device-unsupported');
    expect(r?.message).toMatch(/photo depth/);
    expect(sweepFailureCameraCode(r?.code)).toBe('SWEEP_DEVICE_UNSUPPORTED');
    expect(sweepHostArmRefusal({ ...READY, colourLensTypes: null })).toBeNull();
  });
});

describe('sweepFailureCameraCode — only a missing plugin is a BUILD failure', () => {
  it('the plugin-missing refusal reaches the host as ENGINE_UNAVAILABLE', () => {
    expect(sweepFailureCameraCode('panoplus-plugin-unavailable')).toBe('ENGINE_UNAVAILABLE');
    expect(sweepFailureCameraCode('panoplus-vc-arm-unavailable')).toBe('ENGINE_UNAVAILABLE');
    // M8 review — the session module itself missing (JS synthesises it; the
    // Android module says it of a missing engine). Every emitter means "not
    // in this build", and since M8 a hold reports it instead of dying silent.
    expect(sweepFailureCameraCode('panoplus-unavailable')).toBe('ENGINE_UNAVAILABLE');
  });
  it('M5: a camera that cannot carry a sweep is named by what is wrong with it', () => {
    expect(sweepFailureCameraCode('panoplus-vc-device-unsupported')).toBe('SWEEP_DEVICE_UNSUPPORTED');
    expect(sweepFailureCameraCode('panoplus-vc-basis-unverified')).toBe('SWEEP_DEVICE_UNSUPPORTED');
    expect(sweepFailureCameraCode('panoplus-refused-zoom-lens')).toBe('SWEEP_DEVICE_UNSUPPORTED');
    expect(sweepFailureCameraCode('panoplus-vc-format-below-30fps')).toBe('SWEEP_FORMAT_BELOW_30FPS');
    expect(sweepFailureCameraCode('panoplus-vc-zoom-not-1')).toBe('SWEEP_ZOOM_NOT_1');
    expect(sweepFailureCameraCode('panoplus-camera-inactive')).toBe('CAPTURE_INTERRUPTED');
  });
  it('every other refusal is this attempt failing', () => {
    for (const c of ['panoplus-not-ready', 'panoplus-camera-not-ready',
      'panoplus-refused-drawable-processor',
      'panoplus-panorama-disabled', 'panoplus-busy',
      'panoplus-io', '', null, undefined]) {
      expect(sweepFailureCameraCode(c as string | null | undefined)).toBe('PANORAMA_START_FAILED');
    }
  });
});

describe('sweepCameraHandoff — the loser releases first, the winner waits', () => {
  it('steady state, host owns: mounts the preview and says so', () => {
    expect(handoff({ live: true, latch: null, settling: false, isAR: false }))
      .toEqual({ mountHostPreview: true, surfaceFrameSource: 'host' });
  });

  it('steady state, surface owns: no preview, and the surface is told', () => {
    expect(handoff({ live: false, latch: null, settling: false, isAR: false }))
      .toEqual({ mountHostPreview: false, surfaceFrameSource: 'own' });
  });

  it('⚑ own → host, mid-handoff: the surface lets go BEFORE we mount', () => {
    // It is told 'host' immediately (so it closes its idle preview) while
    // the preview waits. The reverse order is two clients on one device.
    expect(handoff({ live: true, latch: null, settling: true, isAR: false }))
      .toEqual({ mountHostPreview: false, surfaceFrameSource: 'host' });
  });

  it('⚑ host → own, mid-handoff: we unmount BEFORE the surface opens', () => {
    // Still told 'host', which is what keeps it from opening anything while
    // vision-camera's session is still going down.
    expect(handoff({ live: false, latch: null, settling: true, isAR: false }))
      .toEqual({ mountHostPreview: false, surfaceFrameSource: 'host' });
  });

  it('⚑ NOBODY holds a camera mid-handoff, whichever way it is going', () => {
    // The property that makes the window safe, asserted as a property
    // rather than inferred from the two rows above.
    for (const live of [true, false]) {
      expect(handoff({ live, latch: null, settling: true, isAR: false }).mountHostPreview)
        .toBe(false);
    }
  });

  it('⚑ the LATCH outranks the live value while a sweep runs', () => {
    // Native latched the arm at start and never re-reads it.
    expect(handoff({ live: false, latch: true, settling: false, isAR: false }))
      .toEqual({ mountHostPreview: true, surfaceFrameSource: 'host' });
    expect(handoff({ live: true, latch: false, settling: false, isAR: false }))
      .toEqual({ mountHostPreview: false, surfaceFrameSource: 'own' });
  });
});

describe('sweepCameraHandoff — M8: the AR kind is <Camera>\'s AR view', () => {
  it('owned + AR: the engine is told host-ar (it mounts no AR view of its own)', () => {
    expect(handoff({ live: true, latch: null, settling: false, isAR: true }).surfaceFrameSource)
      .toBe('host-ar');
  });
  it('the hatch and the settle window never say host-ar', () => {
    expect(handoff({ live: false, latch: null, settling: false, isAR: true }).surfaceFrameSource)
      .toBe('own');
    expect(handoff({ live: false, latch: null, settling: true, isAR: true }).surfaceFrameSource)
      .toBe('host');
  });
});

describe('sweepShouldSettle — and never under a running sweep', () => {
  it('opens a window when the answer changed at idle', () => {
    expect(shouldSettle({ latch: null, previous: false, live: true })).toBe(true);
    expect(shouldSettle({ latch: null, previous: true, live: false })).toBe(true);
  });

  it('does nothing when the answer did not change', () => {
    expect(shouldSettle({ latch: null, previous: true, live: true })).toBe(false);
  });

  it('⚑ REFUSES under the sweep latch — this is the regression guard', () => {
    // `mountHostPreview` ANDs the latch with `!settling`, so a window opened
    // mid-sweep would UNMOUNT the preview the engine is being fed from. That
    // is the exact failure the latch was added to prevent, arriving through
    // the fix for a different one. It was in the first version of the settle.
    for (const latch of [true, false]) {
      expect(shouldSettle({ latch, previous: false, live: true })).toBe(false);
      expect(shouldSettle({ latch, previous: true, live: false })).toBe(false);
    }
  });

  it('⚑ …and the state it refuses really would drop the preview', () => {
    // Pins WHY the guard above matters, so deleting it cannot be argued as
    // harmless: with a sweep latched to `host`, a settle turns the mount off.
    expect(handoff({ live: false, latch: true, settling: true, isAR: false }).mountHostPreview)
      .toBe(false);
    expect(handoff({ live: false, latch: true, settling: false, isAR: false }).mountHostPreview)
      .toBe(true);
  });
});

/**
 * ── THE MERGE ───────────────────────────────────────────────────────────
 *
 * `poseSource` and `lens` are host-settable through the `sweep` bag, and
 * the bag is spread OVER `<Camera>`'s own props — so the ownership
 * predicate has to judge the MERGED value, not `<Camera>`'s state.
 *
 * ⚠ THIS LIVES HERE BECAUSE THE RENDER SUITE CANNOT SEE IT. Measured: the
 * whole 1154-case suite stayed green with the merge reverted, because the
 * harness pins three of the predicate's OTHER terms false, so the props it
 * can observe do not move either way.
 */
describe('sweepPreviewLive — mounted is not drawing', () => {
  it('both: drawing', () => {
    expect(previewLive({ mounted: true, started: true })).toBe(true);
  });
  it('mounted but no frame yet: NOT drawing (the session-open window)', () => {
    expect(previewLive({ mounted: true, started: false })).toBe(false);
  });
  it('⚑ started but NOT mounted: not drawing — the stale-flag state', () => {
    // Unreachable in a tree, and the one the app kept ending up in: a flag
    // set by a previous element (the review cycle, the engine round trip,
    // the keyframe tree's own preview) surviving into a new, session-less
    // mount. Whoever clears it can regress; this row says what the answer
    // must be regardless.
    expect(previewLive({ mounted: false, started: true })).toBe(false);
  });
  it('neither', () => {
    expect(previewLive({ mounted: false, started: false })).toBe(false);
  });
});

// ── THE LENS THE CHIP IS ALLOWED TO CLAIM ──────────────────────────────────
//
// Field report, 2026-09-19: "0.5x lens does not go to that camera — shows the
// same view as 1x." Every layer below the chip was correct: 0.5× moves the arm
// (Pano's rule), the iOS IMU arm has no τ for that key so it declines, and
// ARKit is structurally wide-only. The CHIP went on claiming the lens anyway.
describe('sweepEffectiveLens', () => {
  type Arm = { poseSource: 'ar' | 'imu'; resolving: boolean };
  const AR: Arm = { poseSource: 'ar', resolving: false };
  const IMU: Arm = { poseSource: 'imu', resolving: false };
  const PENDING_AR: Arm = { poseSource: 'ar', resolving: true };

  it('⚑ THE DEFECT: the AR arm masks 0.5× back to 1×', () => {
    // ARKit publishes no ultra-wide format and `start` deletes the lens key on
    // that arm, so a chip painting 0.5× names a camera nothing ever opened.
    expect(sweepEffectiveLens('0.5x', AR)).toBe('1x');
  });

  it('⚑ the decoupled arm HONOURS it — the mask is not a veto', () => {
    // Without this the "fix" could be `always 1x`, which would delete the
    // ultra-wide from the product on the one arm that can open it.
    expect(sweepEffectiveLens('0.5x', IMU)).toBe('0.5x');
  });

  it('⚑ while the arm read is in flight it follows the REQUEST', () => {
    // The courtesy the surface's start button and AR pill already give: a
    // label that may be taken back one frame later is not offered.
    expect(sweepEffectiveLens('0.5x', PENDING_AR)).toBe('0.5x');
  });

  it('⚑ no arm at all (keyframe engine) is untouched, on BOTH lenses', () => {
    // `engine` selects which engine the hold runs and changes nothing else —
    // so the mask must be invisible to the engine that has no sweep arm.
    expect(sweepEffectiveLens('0.5x', null)).toBe('0.5x');
    expect(sweepEffectiveLens('1x', null)).toBe('1x');
  });

  it('⚑ 1× is 1× under every arm — the mask never invents a lens', () => {
    for (const arm of [AR, IMU, PENDING_AR, null]) {
      expect(sweepEffectiveLens('1x', arm)).toBe('1x');
    }
  });
});

describe('cameraKindFor — M8: the camera is <Camera>\'s state, never the engine\'s', () => {
  it('the table', () => {
    expect(cameraKindFor(true, true)).toBe('none');
    expect(cameraKindFor(true, false)).toBe('none');
    expect(cameraKindFor(false, true)).toBe('ar');
    expect(cameraKindFor(false, false)).toBe('vc');
  });
  it('⚑ has NO engine input — flipping the engine cannot change the camera', () => {
    // Two parameters, both camera state. An engine argument added here is
    // the regression this pins.
    expect(cameraKindFor.length).toBe(2);
  });
});
