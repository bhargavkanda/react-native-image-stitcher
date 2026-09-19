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
 * That is a defect class no render test in this package can reach —
 * `<Camera>`'s vision-camera mocks cannot be driven into most of these
 * states — which is exactly the reason `cameraShouldUnmount` is also a pure
 * exported function with its own table. This is that table.
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
  sweepMergedLens,
  sweepMergedPoseSource,
  type SweepHostOwnsCameraInput,
  _sweepHostOwnsCameraForTests as hostOwns,
  _sweepCameraHandoffForTests as handoff,
  _sweepShouldSettleForTests as shouldSettle,
} from '../Camera';

/** The state in which the host genuinely does own the camera. */
const OK: SweepHostOwnsCameraInput = {
  isAR: false,
  sweepPoseSource: 'imu' as const,
  platformOS: 'android',
  cameraUnmounting: false,
  pluginReady: true,
  deviceId: 'back-0',
  captureMode: 'wide-only' as const,
  lens: '1x' as const,
  hostFrameProcessorPresent: false,
};

describe('sweepHostOwnsCamera — the one state that is true', () => {
  it('Android, non-AR, plugin acquired, a device id, settled, wide', () => {
    expect(hostOwns(OK)).toBe(true);
  });

  it('is true in multicam AT the wide baseline', () => {
    // 1× is the logical container's default crop, which is the one the
    // recorder's `CameraCharacteristics` read is correct for.
    expect(hostOwns({ ...OK, captureMode: 'multicam' })).toBe(true);
  });

  it('is true on a standalone ultra-wide at 0.5× — that is a real device', () => {
    // `'standalone-uw'` switches lens by REMOUNTING a physical device, so
    // the id names a physical camera and there is no constituent to drift.
    expect(hostOwns({ ...OK, captureMode: 'standalone-uw', lens: '0.5x' }))
      .toBe(true);
  });
});

describe('sweepHostOwnsCamera — each false row is a collision it prevents', () => {
  it('⚑ iOS: false, because nothing under ios/ reads the arm', () => {
    // `vcPluginArm`/`vcCameraId` are read by PanoPlusAndroidRecorder and by
    // no Swift or Obj-C in this package. The iOS bridge knows "ar" and
    // "imu"; "imu" starts RNISPanoAvfSource, which opens its OWN
    // AVCaptureSession. Saying the host owns the camera there mounts
    // <CameraView> beside that session. This row IS the S7 regression.
    expect(hostOwns({ ...OK, platformOS: 'ios' })).toBe(false);
  });

  it('AR arm: false — the AR arm feeds itself and must be the only session', () => {
    expect(hostOwns({ ...OK, isAR: true })).toBe(false);
  });

  it('⚑ camera in transition: false — the v0.14.2 handoff race', () => {
    // `isAR` is FALSE while the async isSupported() probe is pending, so
    // without this term the sweep cell mounted <CameraView> for the width
    // of the probe with AR as the intent — the window in which ARKit then
    // fails "Required sensor failed".
    expect(hostOwns({ ...OK, cameraUnmounting: true })).toBe(false);
  });

  it('plugin not acquired: false — an armed arm with no feeder', () => {
    // The registry resolves asynchronously. Declaring host ownership before
    // it does leaves native opening its own camera while the surface, told
    // it owns nothing, draws no viewfinder: a black screen over a live sweep.
    expect(hostOwns({ ...OK, pluginReady: false })).toBe(false);
  });

  it('no device id: false — the recorder refuses rather than guess fx', () => {
    expect(hostOwns({ ...OK, deviceId: '' })).toBe(false);
  });

  it('⚑ AR PREFERRED BUT UNAVAILABLE: false — the gap `!isAR` does not close', () => {
    // `deriveEffectiveCaptureSource` answers 'non-ar' when AR is merely
    // UNSUPPORTED, so `isAR` is false here while the operator has AR on.
    // `<Camera>` then sends `poseSource: 'ar'`, and the surface forwards
    // `vcPluginArm` only on the IMU arm — so the flag is dropped on the way
    // out and the recorder opens its own camera while <CameraView> holds it.
    expect(hostOwns({ ...OK, isAR: false, sweepPoseSource: 'ar' })).toBe(false);
  });

  it('⚑ AR preferred at 0.5×: false — the same gap, via the lens', () => {
    // The other route to the same state, and the common one: the lens pill
    // forces 'non-ar' regardless of AR support, so every 0.5× sweep with the
    // AR pill on took the collision path.
    expect(hostOwns({
      ...OK, isAR: false, sweepPoseSource: 'ar',
      captureMode: 'standalone-uw', lens: '0.5x',
    })).toBe(false);
  });

  it('⚑ a HOST frameProcessor: false — ours would be silently unbound', () => {
    // `effectiveFrameProcessor = hostFrameProcessor ?? (engine === 'sweep'
    // ? sweepFrameProcessor : …)`, so a host that sets both gets its own
    // worklet bound and the sweep's ingest worklet bound to NOTHING. Saying
    // the host owns the camera there tells the recorder to open nothing and
    // wait to be fed by a plugin no frame reaches — armed with no feeder,
    // which presents as `vcFramesOffered == 0`.
    expect(hostOwns({ ...OK, hostFrameProcessorPresent: true })).toBe(false);
  });

  it('⚑ multicam at 0.5×: false — the virtual-container hazard, both ways', () => {
    // S6 refuses an iOS frame precisely because a virtual multi-camera
    // switches its active constituent under zoom with no notification.
    // In 'multicam' the device id IS that container and the recorder reads
    // its characteristics assuming the default crop, so accepting this
    // would be the same bug on the other platform.
    expect(hostOwns({ ...OK, captureMode: 'multicam', lens: '0.5x' }))
      .toBe(false);
  });
});

describe('sweepHostOwnsCamera — no term is decorative', () => {
  /**
   * ⚠ THE ROW LIST COMES FROM THE IMPLEMENTATION, NOT FROM THIS FILE, AND
   * THAT TOOK TWO TRIES TO GET RIGHT.
   *
   * v1 asserted `expect(mutations).toHaveLength(6)` — a literal array
   * checked against its own length, true of any tree in which nobody edits
   * this file. v2 keyed off `Object.keys(OK)` and CLAIMED to be derived
   * from the predicate's inputs; `OK` is a literal in this file too, so
   * that was two adjacent literals compared with each other — the same
   * vacuity in a better disguise, and a reviewer caught it.
   *
   * A TypeScript parameter type is erased, so nothing at runtime can
   * enumerate it. `SWEEP_HOST_OWNS_INPUT_KEYS` is exported BESIDE the
   * predicate with a `tsc` exhaustiveness check against its interface, so
   * a new term fails the BUILD if it is missing from the list and fails
   * THIS CASE if it is missing a falsifying value.
   */
  const FALSIFY: Record<string, unknown> = {
    isAR: true,
    sweepPoseSource: 'ar',
    platformOS: 'ios',
    cameraUnmounting: true,
    pluginReady: false,
    deviceId: '',
    // The pair is the term: multicam is only a hazard away from the wide
    // baseline, so one key alone cannot falsify it.
    captureMode: 'multicam',
    lens: '0.5x',
    hostFrameProcessorPresent: true,
  };

  it('⚑ every input key has a value that flips the answer', () => {
    expect(SWEEP_HOST_OWNS_INPUT_KEYS.length).toBeGreaterThan(0);
    const missing = SWEEP_HOST_OWNS_INPUT_KEYS.filter((k) => !(k in FALSIFY));
    expect(missing).toEqual([]);   // a new term with no row fails HERE
    // …and the baseline must carry every one of them too, or `OK` and the
    // predicate have drifted apart in the other direction.
    expect(SWEEP_HOST_OWNS_INPUT_KEYS.filter((k) => !(k in OK))).toEqual([]);
  });

  it('⚑ and each one actually flips it, on its own', () => {
    // `captureMode`/`lens` are applied together for the reason above; every
    // other key is mutated alone, so a clause that never affects the result
    // shows up as a name in this list.
    const dead = SWEEP_HOST_OWNS_INPUT_KEYS.filter((k) => {
      const over = (k === 'captureMode' || k === 'lens')
        ? { captureMode: FALSIFY.captureMode, lens: FALSIFY.lens }
        : { [k]: FALSIFY[k] };
      return hostOwns({ ...OK, ...over } as Parameters<typeof hostOwns>[0])
        !== false;
    });
    expect(dead).toEqual([]);
  });

  it('⚑ …and the baseline it is measured against is genuinely true', () => {
    // Otherwise every row above is satisfied by a predicate that returns
    // false unconditionally.
    expect(hostOwns(OK)).toBe(true);
  });
});

/**
 * ── THE HANDOFF ─────────────────────────────────────────────────────────
 *
 * `sweepHostOwnsCamera` answers who SHOULD hold the camera. Getting there
 * from where we are is a separate problem, and the reason is physical: the
 * Camera2 release is asynchronous (~479 ms, measured in this file's own
 * constant), so a flip done in one commit has the winner opening while the
 * loser is still closing.
 *
 * These rows are the states in between. None of them is reachable from the
 * render harness — `Platform.OS` and the device are pinned in the mocks, so
 * the live value cannot be moved at all — which is why this is a table.
 */
describe('sweepCameraHandoff — the loser releases first, the winner waits', () => {
  it('steady state, host owns: mounts the preview and says so', () => {
    expect(handoff({ live: true, latch: null, settling: false }))
      .toEqual({ mountHostPreview: true, surfaceFrameSource: 'host' });
  });

  it('steady state, surface owns: no preview, and the surface is told', () => {
    expect(handoff({ live: false, latch: null, settling: false }))
      .toEqual({ mountHostPreview: false, surfaceFrameSource: 'own' });
  });

  it('⚑ own → host, mid-handoff: the surface lets go BEFORE we mount', () => {
    // It is told 'host' immediately (so it closes its idle preview) while
    // the preview waits. The reverse order is two clients on one device.
    expect(handoff({ live: true, latch: null, settling: true }))
      .toEqual({ mountHostPreview: false, surfaceFrameSource: 'host' });
  });

  it('⚑ host → own, mid-handoff: we unmount BEFORE the surface opens', () => {
    // Still told 'host', which is what keeps it from opening anything while
    // vision-camera's session is still going down.
    expect(handoff({ live: false, latch: null, settling: true }))
      .toEqual({ mountHostPreview: false, surfaceFrameSource: 'host' });
  });

  it('⚑ NOBODY holds a camera mid-handoff, whichever way it is going', () => {
    // The property that makes the window safe, asserted as a property
    // rather than inferred from the two rows above.
    for (const live of [true, false]) {
      expect(handoff({ live, latch: null, settling: true }).mountHostPreview)
        .toBe(false);
    }
  });

  it('⚑ the LATCH outranks the live value while a sweep runs', () => {
    // Native latched the arm at start and never re-reads it.
    expect(handoff({ live: false, latch: true, settling: false }))
      .toEqual({ mountHostPreview: true, surfaceFrameSource: 'host' });
    expect(handoff({ live: true, latch: false, settling: false }))
      .toEqual({ mountHostPreview: false, surfaceFrameSource: 'own' });
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
    expect(handoff({ live: false, latch: true, settling: true }).mountHostPreview)
      .toBe(false);
    expect(handoff({ live: false, latch: true, settling: false }).mountHostPreview)
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
describe('sweepMergedPoseSource / sweepMergedLens — the bag wins, upstream', () => {
  it('falls back to <Camera>\'s own state when the bag says nothing', () => {
    expect(sweepMergedPoseSource(undefined, true)).toBe('ar');
    expect(sweepMergedPoseSource(undefined, false)).toBe('imu');
    expect(sweepMergedLens(undefined, '0.5x')).toBe('ultraWide');
    expect(sweepMergedLens(undefined, '1x')).toBe('wide');
  });

  it('⚑ the bag OVERRIDES it — which is why ownership must read the merge', () => {
    expect(sweepMergedPoseSource('ar', false)).toBe('ar');
    expect(sweepMergedPoseSource('imu', true)).toBe('imu');
    expect(sweepMergedLens('ultraWide', '1x')).toBe('ultraWide');
    expect(sweepMergedLens('wide', '0.5x')).toBe('wide');
  });

  it('⚑ …and that override really does flip ownership', () => {
    // The end-to-end statement, on the pure layer: a host asking for the AR
    // arm through the bag must take the camera back from the host preview,
    // because the surface forwards the vc arm only on the IMU arm.
    expect(hostOwns({
      ...OK,
      sweepPoseSource: sweepMergedPoseSource('ar', /* arPreference */ false),
    })).toBe(false);
    expect(hostOwns({
      ...OK,
      sweepPoseSource: sweepMergedPoseSource(undefined, false),
    })).toBe(true);
  });
});
