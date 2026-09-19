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

import { _sweepHostOwnsCameraForTests as hostOwns } from '../Camera';

/** The state in which the host genuinely does own the camera. */
const OK = {
  isAR: false,
  arPreference: false,
  platformOS: 'android',
  cameraUnmounting: false,
  pluginReady: true,
  deviceId: 'back-0',
  captureMode: 'wide-only' as const,
  lens: '1x' as const,
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
    expect(hostOwns({ ...OK, isAR: false, arPreference: true })).toBe(false);
  });

  it('⚑ AR preferred at 0.5×: false — the same gap, via the lens', () => {
    // The other route to the same state, and the common one: the lens pill
    // forces 'non-ar' regardless of AR support, so every 0.5× sweep with the
    // AR pill on took the collision path.
    expect(hostOwns({
      ...OK, isAR: false, arPreference: true,
      captureMode: 'standalone-uw', lens: '0.5x',
    })).toBe(false);
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
  it('⚑ every single term can flip the answer on its own', () => {
    // Guards against the failure this suite exists to prevent in the first
    // place: a predicate that LOOKS thorough while one clause is dead. Each
    // mutation below is the only change from a true state.
    type Row = [string, Partial<Parameters<typeof hostOwns>[0]>];
    const mutations: Row[] = [
      ['isAR', { isAR: true }],
      ['arPreference', { arPreference: true }],
      ['platformOS', { platformOS: 'ios' }],
      ['cameraUnmounting', { cameraUnmounting: true }],
      ['pluginReady', { pluginReady: false }],
      ['deviceId', { deviceId: '' }],
      ['multicam@0.5x', { captureMode: 'multicam', lens: '0.5x' }],
    ];
    expect(mutations).toHaveLength(7);
    const dead = mutations
      .filter(([, m]) => hostOwns({ ...OK, ...m }) !== false)
      .map(([n]) => n);
    expect(dead).toEqual([]);
  });
});
