// SPDX-License-Identifier: Apache-2.0
/**
 * M10 review — A HOLD TAKEN INSIDE THE HATCH'S ENTERING SETTLE runs the arm
 * the phone is calibrated for, not an ARKit fallback built from a placeholder.
 *
 * The DR-1a hatch (`sweep.frameSourceOverride: 'own'`, non-AR) is entered
 * through `<Camera>`'s ownership settle: turn AR off, or pick 0.5× in AR, and
 * for ~600 ms the engine is told `frameSource: 'host'` so that nobody opens a
 * camera while the last owner lets go. `vcPluginArm` is false for that whole
 * window — `<Camera>` has not armed anything.
 *
 * The engine used to read that placeholder `'host'` as "the iOS arm runs on
 * the host's camera" (`vcHostArm`), and the host arm's precondition shortcut
 * stored `plan = null`, `calib = null`, `calibRead = true`. A hold pressed in
 * the window is DEFERRED by the dispatcher and resumed in the commit where
 * the settle ends — and `<Camera>`'s resume effect runs BEFORE the hook's
 * precondition effect in that commit (the hook is called later in
 * `<Camera>`). So the resumed start read the null snapshot: the notice
 * resolved it to "IMU ARM — THIS BUILD CANNOT ANSWER", the sweep ran on
 * ARKit, the hatch mounted its fallback `<ARCameraView>`, and the pack blamed
 * a missing pod install on a complete build.
 *
 * `vcHostArm` is now keyed on REAL host ownership — `'host'` AND
 * `vcPluginArm` — so the settle keeps the hatch's own calibration answer.
 *
 * The cases:
 *
 *   · a hold on the hatch's shutter, and one through `startPanorama`, inside
 *     the settle on a calibrated phone → ONE start, on the IMU arm, notice
 *     "IMU ARM — CALIBRATED", no AR view. 50 ms in, the AR → non-AR camera
 *     transition is still in flight as well; 300 ms in, only the settle
 *     defers the hold;
 *   · CONTROL — the same press after the settle gives the same answer, so the
 *     two cases above are not passing on some other difference;
 *   · NEGATIVE CONTROL — an UNCALIBRATED phone, same press in the settle,
 *     still falls back to ARKit, and the pack names the real reason (τ
 *     missing), not a build fault. The fix keeps the ladder; it does not
 *     force the IMU arm.
 *
 * And (M10 re-review, round 3) a hold on the hatch with PANORAMA OFF while
 * the iOS calibration read is still in flight: refused as panorama off, on
 * both channels and on screen, not as "still loading" (see the last block).
 */
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { NativeModules, Platform } from 'react-native';

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///var/mobile/Documents/',
  makeDirectoryAsync: () => Promise.resolve(),
  readAsStringAsync: () => Promise.resolve(''),
  writeAsStringAsync: (uri: string, body: string) => {
    ((globalThis as any).__hatchSettleWrites ??= []).push({ uri, body });
    return Promise.resolve();
  },
  deleteAsync: () => Promise.resolve(),
  getInfoAsync: () => Promise.resolve({ exists: false }),
  readDirectoryAsync: () => Promise.resolve([]),
}), { virtual: true });

import { ARToggle, Camera, SWEEP_PANORAMA_DISABLED } from '../../camera/Camera';
import { ARCameraView } from '../../camera/ARCameraView';
import { CameraShutter } from '../../camera/CameraShutter';
import { SweepHoldOverlay } from '../SweepHoldOverlay';

const NM = NativeModules as Record<string, unknown>;
const starts: Array<Record<string, unknown>> = [];

function writes(): Array<{ uri: string; body: string }> {
  return ((globalThis as any).__hatchSettleWrites ??= []);
}

/** `complete` false models a phone with no τ on record for this format. */
function install(calibrated: boolean): void {
  starts.length = 0;
  writes().length = 0;
  NM.RNSSweepSession = {
    start: (o: Record<string, unknown>) => {
      starts.push(o);
      return Promise.resolve({
        sessionDir: o.sessionDir, startedAtMs: 1, pluginAvailable: true,
        poseSource: o.poseSource,
      });
    },
    stop: () => Promise.resolve({}),
    cancel: () => Promise.resolve({ cancelled: true }),
    getStatus: () => Promise.resolve({ running: true }),
    setIdlePreview: (on: boolean) => Promise.resolve({ on, reason: '' }),
    getConstants: () => ({
      documentDirectory: 'file:///var/mobile/Documents/', vcArmSupported: true,
    }),
    documentDirectory: 'file:///var/mobile/Documents/',
    vcArmSupported: true,
  };
  NM.RNSSweepCalibration = {
    plannedCaptureFormat: (k: Record<string, unknown>) => Promise.resolve({
      ok: true,
      lens: k?.lens === 'ultraWide'
        ? 'AVCaptureDeviceTypeBuiltInUltraWideCamera'
        : 'AVCaptureDeviceTypeBuiltInWideAngleCamera',
      width: 1920, height: 1440, fps: 60,
      tauKey: 'iPhone17,1|x|1920x1440|60', basisKey: 'iPhone17,1',
    }),
    getCalibration: () => Promise.resolve({
      resolved: calibrated
        ? {
            haveTau: true, haveBasis: true, complete: true, missing: null,
            tauS: -0.0042, tauStdErrMs: 0.31, basisIndex: 5, basisLabel: '+y+z+x',
          }
        : {
            haveTau: false, haveBasis: true, complete: false, missing: 'tau',
            tauS: null, tauStdErrMs: null, basisIndex: 5, basisLabel: '+y+z+x',
          },
    }),
    startBasisCalibration: () => Promise.resolve({}),
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  (Platform as { OS: string }).OS = 'ios';
});
afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
  delete NM.RNSSweepSession;
  delete NM.RNSSweepCalibration;
});

async function tick(ms: number): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

interface Outcome {
  /** Starts sent to native within 100 ms of the press (the settle is open). */
  startsDuringSettle: number;
  starts: Array<{ poseSource: unknown; allowOwnCamera: unknown }>;
  arViews: number;
  notice: { effective: unknown; fallbackToAr: unknown; headline: unknown } | null;
  errors: string[];
}

/**
 * Mount the hatch on iOS, turn AR on and off again, and press `pressAtMs`
 * into the entering settle — or after it, with `afterSettle`.
 */
async function pressIntoSettle(opts: {
  calibrated: boolean;
  via: 'shutter' | 'handle';
  pressAtMs: number;
  afterSettle?: boolean;
}): Promise<Outcome> {
  install(opts.calibrated);
  const errors: string[] = [];
  const ref = React.createRef<any>();
  let t!: ReactTestRenderer;
  act(() => {
    t = create(
      <Camera
        ref={ref}
        engine="sweep"
        defaultCaptureSource="non-ar"
        panMode="both"
        rectCrop={false}
        sweep={{ frameSourceOverride: 'own' }}
        onError={(e: { code: string }) => { errors.push(e.code); }}
      />,
    );
  });
  // The hatch's first calibration read lands (it is cached per lens).
  await tick(0);
  await tick(1500);
  const toggle = () => t.root.findByType(ARToggle).props.onToggle as () => void;
  await act(async () => { toggle()(); });
  await tick(1500);
  await tick(1500);
  expect(t.root.findByType(ARToggle).props.arEnabled).toBe(true);
  // AR off: back onto the hatch, through the ownership settle.
  await act(async () => { toggle()(); });
  await tick(opts.pressAtMs);
  if (opts.afterSettle === true) { await tick(1500); await tick(1500); }
  if (opts.via === 'shutter') {
    const hatch = t.root.findAll((n) => n.props?.testID === 'camera-hatch-shutter');
    expect(hatch).toHaveLength(1);
    const shutter = hatch[0].findByType(CameraShutter);
    await act(async () => { (shutter.props.onHoldStart as () => void)(); });
  } else {
    await act(async () => { ref.current.startPanorama(); });
  }
  await tick(100);
  const startsDuringSettle = starts.length;
  await tick(700);
  await tick(500);
  const sidecar = writes().find((w) => w.uri.endsWith('host_notice.json'));
  const parsed = sidecar != null ? JSON.parse(sidecar.body) : null;
  const out: Outcome = {
    startsDuringSettle,
    starts: starts.map((s) => ({
      poseSource: s.poseSource, allowOwnCamera: s.allowOwnCamera,
    })),
    arViews: t.root.findAllByType(ARCameraView).length,
    notice: parsed == null ? null : {
      effective: parsed.poseSourceEffective,
      fallbackToAr: parsed.fallbackToAr,
      headline: parsed.headline,
    },
    errors,
  };
  act(() => { t.unmount(); });
  return out;
}

const CALIBRATED_IMU = {
  effective: 'imu',
  fallbackToAr: false,
  headline: 'IMU ARM — CALIBRATED',
};

describe('the hatch: a hold inside the entering settle', () => {
  it('on the shutter, 50 ms in: deferred, then ONE start on the calibrated IMU arm', async () => {
    const r = await pressIntoSettle({ calibrated: true, via: 'shutter', pressAtMs: 50 });
    // Deferred while neither side may open a camera — not refused…
    expect(r.startsDuringSettle).toBe(0);
    expect(r.errors).toEqual([]);
    // …and resumed on the arm this phone is calibrated for.
    expect(r.starts).toEqual([{ poseSource: 'imu', allowOwnCamera: true }]);
    expect(r.notice).toEqual(CALIBRATED_IMU);
    // No ARKit session: the hatch's fallback view is not mounted.
    expect(r.arViews).toBe(0);
  });

  it('on the shutter, 300 ms in — past the camera transition, the settle alone holds it', async () => {
    const r = await pressIntoSettle({ calibrated: true, via: 'shutter', pressAtMs: 300 });
    expect(r.startsDuringSettle).toBe(0);
    expect(r.errors).toEqual([]);
    expect(r.starts).toEqual([{ poseSource: 'imu', allowOwnCamera: true }]);
    expect(r.notice).toEqual(CALIBRATED_IMU);
    expect(r.arViews).toBe(0);
  });

  it('through startPanorama, 300 ms in: the same answer', async () => {
    const r = await pressIntoSettle({ calibrated: true, via: 'handle', pressAtMs: 300 });
    expect(r.startsDuringSettle).toBe(0);
    expect(r.starts).toEqual([{ poseSource: 'imu', allowOwnCamera: true }]);
    expect(r.notice).toEqual(CALIBRATED_IMU);
    expect(r.arViews).toBe(0);
  });

  it('CONTROL — the same press after the settle starts the same arm', async () => {
    const r = await pressIntoSettle({
      calibrated: true, via: 'shutter', pressAtMs: 0, afterSettle: true,
    });
    expect(r.starts).toEqual([{ poseSource: 'imu', allowOwnCamera: true }]);
    expect(r.notice).toEqual(CALIBRATED_IMU);
    expect(r.arViews).toBe(0);
  });

  it('NEGATIVE CONTROL — an uncalibrated phone still falls back to ARKit, for the real reason', async () => {
    const r = await pressIntoSettle({ calibrated: false, via: 'shutter', pressAtMs: 50 });
    expect(r.startsDuringSettle).toBe(0);
    expect(r.starts).toEqual([{ poseSource: 'ar', allowOwnCamera: true }]);
    // The pack names the missing τ — never a build fault on a complete build.
    expect(r.notice).toEqual({
      effective: 'ar',
      fallbackToAr: true,
      headline: 'IMU ARM — NEEDS CALIBRATION (missing tau)',
    });
    expect(r.arViews).toBe(1);
  });
});

/**
 * PANORAMA OFF WINS OVER THE ENGINE'S OWN READINESS (M10 re-review, round 3).
 *
 * The hatch's shutter is armed with panorama capture off, and the dispatcher
 * hands the hold to the engine, which refuses it with the host's
 * `SWEEP_PANORAMA_DISABLED`. But the engine's `holdStart` checked its own
 * readiness (`canCapture`: the iOS arm's calibration read has landed) BEFORE
 * `start()` read the host's refusal. So while that read was in flight (on
 * mount, on a first flip to a lens, coming off AR) the hold was refused as
 * "still loading. Try again", and the retry then said "turned off".
 *
 * The read here never lands, so the arm is still resolving for the whole
 * case. The real engine, not a stub: the order under test is the engine's.
 */
describe('the hatch with panorama OFF while the iOS calibration read is in flight', () => {
  async function holdWhileResolving(opts: {
    panorama: boolean;
    via: 'shutter' | 'handle';
  }): Promise<{
    starts: number;
    errors: Array<[string, string]>;
    captures: Array<[boolean, unknown]>;
    onScreen: unknown;
  }> {
    install(true);
    (NM.RNSSweepCalibration as Record<string, unknown>).plannedCaptureFormat =
      () => new Promise(() => undefined);
    const errors: Array<[string, string]> = [];
    const captures: Array<[boolean, unknown]> = [];
    const ref = React.createRef<any>();
    let t!: ReactTestRenderer;
    act(() => {
      t = create(
        <Camera
          ref={ref}
          engine="sweep"
          defaultCaptureSource="non-ar"
          panMode="both"
          rectCrop={false}
          enablePanoramaMode={opts.panorama}
          sweep={{ frameSourceOverride: 'own' }}
          onError={(e: { code: string; message: string }) => { errors.push([e.code, e.message]); }}
          onCapture={(r: { ok: boolean; error?: { code?: string } }) => {
            captures.push([r.ok, r.error?.code]);
          }}
        />,
      );
    });
    await tick(0);
    await tick(1500);
    if (opts.via === 'shutter') {
      const hatch = t.root.findAll((n) => n.props?.testID === 'camera-hatch-shutter');
      expect(hatch).toHaveLength(1);
      const shutter = hatch[0].findByType(CameraShutter);
      await act(async () => { (shutter.props.onHoldStart as () => void)(); });
    } else {
      await act(async () => { ref.current.startPanorama(); });
    }
    await tick(100);
    const out = {
      starts: starts.length,
      errors,
      captures,
      // The line the hatch draws on screen.
      onScreen: t.root.findByType(SweepHoldOverlay).props.error,
    };
    act(() => { t.unmount(); });
    return out;
  }

  for (const via of ['shutter', 'handle'] as const) {
    it(`${via === 'shutter' ? 'the hatch shutter' : 'startPanorama()'}: refused as panorama off, not "still loading"`, async () => {
      const r = await holdWhileResolving({ panorama: false, via });
      expect(r.starts).toBe(0);
      expect(r.errors).toEqual([['PANORAMA_START_FAILED', SWEEP_PANORAMA_DISABLED.message]]);
      expect(r.captures).toEqual([[false, 'PANORAMA_START_FAILED']]);
      expect(r.onScreen).toBe(SWEEP_PANORAMA_DISABLED.message);
    });
  }

  it('CONTROL — panorama ON, the same hold: "still loading", so the read really is in flight', async () => {
    const r = await holdWhileResolving({ panorama: true, via: 'shutter' });
    expect(r.starts).toBe(0);
    expect(r.errors).toEqual([[
      'PANORAMA_START_FAILED',
      'This sweep cannot start yet: it is still loading. Try again in a moment.',
    ]]);
  });
});
