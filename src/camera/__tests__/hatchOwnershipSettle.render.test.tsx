// SPDX-License-Identifier: Apache-2.0
/**
 * M10 re-review (#3) — THE OWNERSHIP SETTLE OPENS IN THE FLIP COMMIT ITSELF.
 *
 * The DR-1a hatch (`sweep.frameSourceOverride: 'own'`, non-AR) hands the sweep
 * pano+'s own camera. Moving onto it or off it with the engine idle is a
 * camera HANDOFF, and `<Camera>` holds a ~600 ms settle for it
 * (`SWEEP_CAMERA_RELEASE_SETTLE_MS`): the engine is told `frameSource: 'host'`
 * (so it opens no camera of its own), `<CameraView>` stays unmounted, and
 * `vcPluginArm` is false. Nobody opens a camera while the last owner lets go.
 *
 * The settle used to be state that only an effect set, AFTER the commit. So
 * the flip commit itself ran with the settle closed:
 *
 *   · into the hatch (AR off, or 0.5× in AR): the commit that unmounted the
 *     host's `<ARCameraView>` told the engine `'own'`. Its idle effect asked
 *     native for pano+'s own viewfinder (`setIdlePreview(true)`) while ARKit /
 *     ARCore was still releasing, took it back one commit later
 *     (`setIdlePreview(false)`), and asked again when the settle ended;
 *   · out of the hatch (the override removed): the flip commit mounted
 *     `<CameraView>` and told the engine `vcPluginArm: true`; the next commit
 *     unmounted it for the settle, and the settle's end mounted it again.
 *
 * <Camera> now computes the settle during render (`sweepShouldSettle` against
 * the last recorded owner), so the flip commit is already inside it.
 *
 * The M10 re-review (round 3) added the rest of the settle's properties:
 *   · THE LATCH OUTRANKS IT. The DR-1a flag added under a running host-arm
 *     sweep leaves the sweep's preview and arm alone; the handoff happens
 *     when the sweep ends.
 *   · OUT OF THE HATCH INTO AR (the AR pill, or 1× under an AR preference):
 *     the host's AR view waits out the settle too, not just the transition.
 *   · SWEEP ENGINE ONLY. On `engine="keyframe"` nothing of pano+'s is open,
 *     so the flag changes no keyframe camera timing — and a switch into the
 *     hatch while the AR session is still stopping still waits for the stop.
 *   · THE ENGINE-SWITCH SETTLE (hatch → keyframe) opens in the switch commit
 *     too, and runs out even if the engine flips back inside it.
 *
 * THE PROBES.
 *   · `useSweepEngine` is the real hook, wrapped so a layout effect logs what
 *     each COMMIT told the engine (`ENGINE <frameSource> vc=<vcPluginArm>`),
 *     and `PHASE <phase>` whenever the engine's phase changes.
 *   · `<ARCameraView>` and `<CameraView>` are the real components, wrapped
 *     (as in `m8ReviewNoRemount`) so a layout effect logs MOUNT / UNMOUNT.
 *   · `RNSSweepSession.setIdlePreview` logs `IDLE <on>`, and `start` logs
 *     `START`.
 * In one commit React runs the unmount's layout cleanup before the layout
 * effects, so the first `ENGINE` entry after `AR-UNMOUNT` is what the engine
 * was told in the commit that unmounted the AR view.
 */
jest.mock('../../sweep/useSweepEngine', () => {
  const actual = jest.requireActual('../../sweep/useSweepEngine');
  const R = require('react');
  return {
    ...actual,
    useSweepEngine: (props: Record<string, unknown>, ref: unknown, options: unknown) => {
      const engine = actual.useSweepEngine(props, ref, options);
      const log = (globalThis as { __hatchOwnLog?: string[] }).__hatchOwnLog!;
      const phase = R.useRef(engine.phase);
      R.useLayoutEffect(() => {
        if (phase.current !== engine.phase) {
          phase.current = engine.phase;
          log.push(`PHASE ${String(engine.phase)}`);
        }
        log.push(`ENGINE ${String(props.frameSource)} vc=${String(props.vcPluginArm)}`);
      });
      return engine;
    },
  };
});

// `globalThis`, not a module-scope variable: `jest.mock` factories are hoisted
// above every declaration in this file.
(globalThis as { __hatchOwnLog?: string[] }).__hatchOwnLog = [];
function probeFactory(modulePath: string, exportName: string, tag: string) {
  const actual = jest.requireActual(modulePath);
  const R = require('react');
  const Wrapped = R.forwardRef((props: object, ref: unknown) => {
    R.useLayoutEffect(() => {
      const log = (globalThis as { __hatchOwnLog?: string[] }).__hatchOwnLog!;
      log.push(`${tag}-MOUNT`);
      return () => { log.push(`${tag}-UNMOUNT`); };
    }, []);
    return R.createElement(actual[exportName], { ...props, ref });
  });
  Wrapped.displayName = `${exportName}Probe`;
  return { ...actual, [exportName]: Wrapped };
}
jest.mock('../CameraView', () => probeFactory('../CameraView', 'CameraView', 'CV'));
jest.mock('../ARCameraView', () => probeFactory('../ARCameraView', 'ARCameraView', 'AR'));

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///var/mobile/Documents/',
  makeDirectoryAsync: () => Promise.resolve(),
  readAsStringAsync: () => Promise.resolve(''),
  writeAsStringAsync: () => Promise.resolve(),
  deleteAsync: () => Promise.resolve(),
  getInfoAsync: () => Promise.resolve({ exists: false }),
  readDirectoryAsync: () => Promise.resolve([]),
  copyAsync: () => Promise.resolve(),
}), { virtual: true });

// eslint-disable-next-line import/first
import React from 'react';
// eslint-disable-next-line import/first
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
// eslint-disable-next-line import/first
import { NativeModules, Platform } from 'react-native';
// eslint-disable-next-line import/first
import { VisionCameraProxy } from 'react-native-vision-camera';
// eslint-disable-next-line import/first
import { ARToggle, Camera, LensChip } from '../Camera';
// eslint-disable-next-line import/first
import { CameraShutter } from '../CameraShutter';

const log = (globalThis as { __hatchOwnLog?: string[] }).__hatchOwnLog!;
const NM = NativeModules as Record<string, unknown>;
const vc = require('react-native-vision-camera') as {
  useCameraDevice: unknown; useCameraDevices: unknown;
};
const realDevice = vc.useCameraDevice;
const realDevices = vc.useCameraDevices;
const proxy = VisionCameraProxy as unknown as { initFrameProcessorPlugin: unknown };
const realInit = proxy.initFrameProcessorPlugin;

const WIDE = {
  id: 'back-0', position: 'back', physicalDevices: ['wide-angle-camera'],
  hasTorch: true, minZoom: 1, maxZoom: 8, neutralZoom: 1, formats: [],
  isMultiCam: false, supportsFocus: true, name: 'back-0',
};
const WIDE_AND_UW = {
  ...WIDE,
  physicalDevices: ['ultra-wide-angle-camera', 'wide-angle-camera'],
  isMultiCam: true, minZoom: 0.5,
};

/** The settle `<Camera>` holds; the constant is not exported. */
const SETTLE_MS = 600;
/**
 * The camera transition's grace after the AR session's stop resolves
 * (`<Camera>`'s transition effect; the mock's `RNSARSession.stop` resolves at
 * once). Also not exported.
 */
const AR_STOP_GRACE_MS = 250;

/** A case that sets this holds native `stop()` open until it resolves. */
let holdStop: Promise<void> | null = null;

function install(): void {
  NM.RNSSweepSession = {
    start: (o: Record<string, unknown>) => {
      log.push('START');
      return Promise.resolve({
        sessionDir: o.sessionDir, startedAtMs: 1, pluginAvailable: true,
        poseSource: o.poseSource,
        // A binary with the vision-camera arm answers that it is on it.
        ...(o.vcPluginArm === true ? { frameSource: 'vc-plugin' } : {}),
      });
    },
    stop: () => (holdStop ?? Promise.resolve()).then(() => ({})),
    cancel: () => Promise.resolve({ cancelled: true }),
    // `viewfinderAttached`: the idle feed stays up, so Android's 1 Hz idle
    // heartbeat does not re-ask for it and add `IDLE` entries of its own.
    getStatus: () => Promise.resolve({ running: false, viewfinderAttached: true }),
    setIdlePreview: (on: boolean) => {
      log.push(`IDLE ${String(on)}`);
      return Promise.resolve({ on, reason: '' });
    },
    getConstants: () => ({
      documentDirectory: 'file:///var/mobile/Documents/', vcArmSupported: true,
    }),
    documentDirectory: 'file:///var/mobile/Documents/',
    vcArmSupported: true,
  };
  // A calibrated iPhone, so the hatch's IMU arm resolves (iOS reads this
  // before it asks for the idle viewfinder; Android does not have it).
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
      resolved: {
        haveTau: true, haveBasis: true, complete: true, missing: null,
        tauS: -0.0042, tauStdErrMs: 0.31, basisIndex: 5, basisLabel: '+y+z+x',
      },
    }),
    startBasisCalibration: () => Promise.resolve({}),
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  log.length = 0;
  vc.useCameraDevice = () => WIDE;
  vc.useCameraDevices = () => [WIDE];
  proxy.initFrameProcessorPlugin = () => ({ call: () => undefined });
  install();
});
// Every tree mounted here is unmounted after its case, pass or fail: a tree a
// failed case leaves mounted keeps committing, and its `ENGINE` entries would
// land in the next case's log.
const mounted: ReactTestRenderer[] = [];
afterEach(() => {
  while (mounted.length > 0) {
    const t = mounted.pop()!;
    try { act(() => { t.unmount(); }); } catch { /* already unmounted */ }
  }
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
  holdStop = null;
  (Platform as { OS: string }).OS = 'ios';
  vc.useCameraDevice = realDevice;
  vc.useCameraDevices = realDevices;
  proxy.initFrameProcessorPlugin = realInit;
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

function engineEntries(from: string[]): string[] {
  return from.filter((e) => e.startsWith('ENGINE '));
}
function lastEngine(): string {
  const e = engineEntries(log);
  return e[e.length - 1];
}

function el(extra: Record<string, unknown>): React.ReactElement {
  return (
    <Camera
      engine="sweep"
      panMode="both"
      rectCrop={false}
      {...(extra as object)}
    />
  );
}

/** Mount `<Camera>` with `props` and let its probes and reads land. */
async function mountWith(props: Record<string, unknown>): Promise<ReactTestRenderer> {
  let t!: ReactTestRenderer;
  act(() => { t = create(el(props)); });
  mounted.push(t);
  await tick(0);
  await tick(1500);
  await tick(1500);
  return t;
}

/**
 * Advance in 10 ms steps until `done()` holds. Returns how long that took
 * (0 if it already held), or null if it did not hold within `limitMs`.
 */
async function msUntil(done: () => boolean, limitMs = 3000): Promise<number | null> {
  for (let ms = 0; ms <= limitMs; ms += 10) {
    if (done()) return ms;
    // eslint-disable-next-line no-await-in-loop
    await tick(10);
  }
  return null;
}

function camEntries(from: string[], tag: 'CV' | 'AR'): string[] {
  return from.filter((e) => e.startsWith(`${tag}-`));
}
function idleEntries(from: string[]): string[] {
  return from.filter((e) => e.startsWith('IDLE '));
}
const toggleAR = (t: ReactTestRenderer): void => {
  (t.root.findByType(ARToggle).props.onToggle as () => void)();
};
const pickLens = (t: ReactTestRenderer, l: '0.5x' | '1x'): void => {
  (t.root.findByType(LensChip).props.onChange as (x: string) => void)(l);
};
function hatchShutter(t: ReactTestRenderer) {
  const dock = t.root.findAll((n) => n.props?.testID === 'camera-hatch-shutter');
  expect(dock).toHaveLength(1);
  return dock[0].findByType(CameraShutter);
}

/** Mount the hatch non-AR and let its calibration read and idle ask land. */
async function mountHatch(): Promise<ReactTestRenderer> {
  let t!: ReactTestRenderer;
  act(() => {
    t = create(el({ defaultCaptureSource: 'non-ar', sweep: { frameSourceOverride: 'own' } }));
  });
  mounted.push(t);
  await tick(0);
  await tick(1500);
  // Precondition: the hatch is live on pano+'s own camera, and has asked
  // native for its viewfinder.
  expect(lastEngine()).toBe('ENGINE own vc=false');
  expect(log.filter((e) => e.startsWith('IDLE ')).slice(-1)).toEqual(['IDLE true']);
  return t;
}

/** AR on, from the hatch: the override is inert with AR, so the host owns. */
async function arOn(t: ReactTestRenderer): Promise<void> {
  await act(async () => { (t.root.findByType(ARToggle).props.onToggle as () => void)(); });
  await tick(1500);
  await tick(1500);
  // Precondition: the host's AR view is up and the engine is on it.
  expect(t.root.findByType(ARToggle).props.arEnabled).toBe(true);
  expect(log.filter((e) => e === 'AR-MOUNT').length
    - log.filter((e) => e === 'AR-UNMOUNT').length).toBe(1);
  expect(lastEngine()).toBe('ENGINE host-ar vc=false');
}

/**
 * The flip into the hatch, in one synchronous commit, then the settle.
 * Returns the log from the flip on.
 */
async function flipIntoHatch(
  flip: () => void,
): Promise<{ atFlip: string[]; inSettle: string[]; after: string[] }> {
  log.length = 0;
  act(() => { flip(); });
  const atFlip = [...log];
  // Up to the last millisecond before the settle can end.
  await tick(SETTLE_MS - 1);
  const inSettle = [...log];
  await tick(1500);
  await tick(1500);
  return { atFlip, inSettle, after: [...log] };
}

function assertIntoHatch(r: { atFlip: string[]; inSettle: string[]; after: string[] }): void {
  // The flip commit unmounted the host's AR view…
  const unmount = r.atFlip.indexOf('AR-UNMOUNT');
  expect(unmount).toBeGreaterThanOrEqual(0);
  // …and in THAT commit the engine was told 'host', not 'own'.
  expect(engineEntries(r.atFlip.slice(unmount))[0]).toBe('ENGINE host vc=false');
  // No commit in the settle tells it 'own', and it asks native for nothing:
  // no idle viewfinder is opened while the AR session is still letting go.
  expect(engineEntries(r.inSettle).every((e) => e === 'ENGINE host vc=false')).toBe(true);
  expect(r.inSettle.filter((e) => e.startsWith('IDLE '))).toEqual([]);
  // When the settle ends the hatch gets its camera, asked for ONCE.
  expect(lastEngine()).toBe('ENGINE own vc=false');
  expect(r.after.filter((e) => e.startsWith('IDLE '))).toEqual(['IDLE true']);
  // The hatch's IMU arm mounts no AR view of its own.
  expect(r.after.filter((e) => e === 'AR-MOUNT')).toEqual([]);
}

describe('the DR-1a hatch: the ownership settle opens in the flip commit', () => {
  for (const os of ['ios', 'android'] as const) {
    it(`${os}: AR off onto the hatch — the commit that unmounts the AR view tells the engine 'host', and nothing opens a camera until the settle ends`, async () => {
      (Platform as { OS: string }).OS = os;
      const t = await mountHatch();
      await arOn(t);
      const r = await flipIntoHatch(
        () => { (t.root.findByType(ARToggle).props.onToggle as () => void)(); },
      );
      expect(t.root.findByType(ARToggle).props.arEnabled).toBe(false);
      assertIntoHatch(r);
    });
  }

  it('ios: 0.5× in AR onto the hatch — the same commit, the same answer', async () => {
    (Platform as { OS: string }).OS = 'ios';
    vc.useCameraDevice = () => WIDE_AND_UW;
    vc.useCameraDevices = () => [WIDE_AND_UW];
    const t = await mountHatch();
    await arOn(t);
    const r = await flipIntoHatch(
      () => { (t.root.findByType(LensChip).props.onChange as (l: string) => void)('0.5x'); },
    );
    // The flip took: the chip is at 0.5×, which makes the effective source
    // non-AR (Pano's rule) and so hands the sweep to the hatch.
    expect(t.root.findByType(LensChip).props.lens).toBe('0.5x');
    assertIntoHatch(r);
  });

  for (const os of ['ios', 'android'] as const) {
    it(`${os}: OUT of the hatch (override removed) — <CameraView> mounts once, when the settle ends, and never before`, async () => {
      (Platform as { OS: string }).OS = os;
      const t = await mountHatch();
      // Precondition: the hatch mounts no <CameraView> (its camera is pano+'s).
      expect(log.filter((e) => e === 'CV-MOUNT')).toEqual([]);
      log.length = 0;
      act(() => {
        t.update(el({ defaultCaptureSource: 'non-ar', sweep: {} }));
      });
      const atFlip = [...log];
      await tick(SETTLE_MS - 1);
      const inSettle = [...log];
      await tick(1500);
      await tick(1500);
      // The flip commit is inside the settle: 'host' (nobody opens a camera),
      // no plugin arm, and no <CameraView> yet…
      expect(engineEntries(atFlip)[0]).toBe('ENGINE host vc=false');
      expect(inSettle.filter((e) => e.startsWith('CV-'))).toEqual([]);
      // …while the loser lets go at once: the hatch's own viewfinder is
      // released in the flip commit, and nothing asks for it again.
      expect(atFlip.filter((e) => e.startsWith('IDLE '))).toEqual(['IDLE false']);
      expect(log.filter((e) => e.startsWith('IDLE '))).toEqual(['IDLE false']);
      expect(engineEntries(inSettle).every((e) => e === 'ENGINE host vc=false')).toBe(true);
      // Then the host's preview mounts ONCE and stays, and the engine arms it.
      expect(log.filter((e) => e.startsWith('CV-'))).toEqual(['CV-MOUNT']);
      expect(lastEngine()).toBe('ENGINE host vc=true');
    });
  }
});

describe('the latch outranks the settle: the DR-1a flag added under a running sweep', () => {
  for (const os of ['ios', 'android'] as const) {
    it(`${os}: a host-arm sweep keeps its preview and its arm to the end; the handoff to the hatch waits for the sweep to end, then settles`, async () => {
      (Platform as { OS: string }).OS = os;
      const t = await mountWith({ defaultCaptureSource: 'non-ar', sweep: {} });
      // Precondition: the main tree's host arm, with <CameraView> up and the
      // engine armed on it.
      expect(camEntries(log, 'CV')).toEqual(['CV-MOUNT']);
      expect(lastEngine()).toBe('ENGINE host vc=true');
      const shutters = t.root.findAllByType(CameraShutter);
      expect(shutters).toHaveLength(1);
      await act(async () => { (shutters[0].props.onHoldStart as () => void)(); });
      await tick(300);
      // Precondition: a sweep is running on the host's camera.
      expect(log.filter((e) => e === 'START')).toEqual(['START']);
      expect(log.filter((e) => e.startsWith('PHASE ')).slice(-1)).toEqual(['PHASE sweeping']);

      log.length = 0;
      act(() => {
        t.update(el({ defaultCaptureSource: 'non-ar', sweep: { frameSourceOverride: 'own' } }));
      });
      await tick(1000);
      const during = [...log];
      // Mid-sweep the preview the engine is fed from stays mounted, and every
      // commit still tells the engine 'host' with its arm. Nothing asks for
      // pano+'s own viewfinder.
      expect(camEntries(during, 'CV')).toEqual([]);
      expect(engineEntries(during).length).toBeGreaterThan(0);
      expect(engineEntries(during).every((e) => e === 'ENGINE host vc=true')).toBe(true);
      expect(idleEntries(during)).toEqual([]);

      // The release starts the finish. Native `stop()` is held open, so the
      // sweep sits in 'finishing', and it is still the sweep's camera: the
      // preview stays mounted and armed.
      let releaseStop!: () => void;
      holdStop = new Promise<void>((resolve) => { releaseStop = resolve; });
      log.length = 0;
      await act(async () => {
        (t.root.findAllByType(CameraShutter)[0].props.onHoldComplete as () => void)();
      });
      await tick(100);
      expect(log.filter((e) => e.startsWith('PHASE '))).toEqual(['PHASE finishing']);
      expect(camEntries(log, 'CV')).toEqual([]);
      expect(engineEntries(log).every((e) => e === 'ENGINE host vc=true')).toBe(true);
      // Native answers; the sweep ends, and only then does the handoff start.
      await act(async () => { releaseStop(); });
      expect(await msUntil(() => log.includes('CV-UNMOUNT'))).not.toBeNull();
      const unmount = log.indexOf('CV-UNMOUNT');
      expect(log.slice(0, unmount)).toContain('PHASE idle');
      // No commit before the one that unmounts the preview disarmed it…
      expect(engineEntries(log.slice(0, unmount)).every((e) => e === 'ENGINE host vc=true')).toBe(true);
      // …and that commit tells the engine 'host' with no arm: the settle.
      expect(engineEntries(log.slice(unmount))[0]).toBe('ENGINE host vc=false');
      // pano+'s own viewfinder is asked for once, when the settle ends.
      await tick(SETTLE_MS - 1);
      expect(idleEntries(log)).toEqual([]);
      expect(engineEntries(log.slice(unmount)).every((e) => e === 'ENGINE host vc=false')).toBe(true);
      await tick(1500);
      expect(idleEntries(log)).toEqual(['IDLE true']);
      expect(lastEngine()).toBe('ENGINE own vc=false');
    });
  }
});

/**
 * Out of the hatch into AR. Returns the log from the flip on: `atFlip` (the
 * flip commit), `inSettle` (up to 1 ms before the settle can end), `after`.
 */
async function flipOutToAr(
  flip: () => void,
): Promise<{ atFlip: string[]; inSettle: string[]; after: string[] }> {
  log.length = 0;
  act(() => { flip(); });
  const atFlip = [...log];
  // Let the flip's promise work run NOW, at the flip's time: the camera
  // transition schedules its 250 ms grace from the AR stop's `.then`. Left to
  // the first `await` inside a longer tick, the grace would be scheduled only
  // after that tick's advance, and a mounting AR view could slip past the
  // window check below.
  await tick(0);
  await tick(SETTLE_MS - 1);
  const inSettle = [...log];
  await tick(1500);
  await tick(1500);
  return { atFlip, inSettle, after: [...log] };
}

function assertOutToAr(r: { atFlip: string[]; inSettle: string[]; after: string[] }): void {
  // The hatch lets go at once: pano+'s idle viewfinder is released in the
  // flip commit, and that commit puts the engine on the host's AR camera,
  // which opens nothing of pano+'s.
  expect(idleEntries(r.atFlip)).toEqual(['IDLE false']);
  expect(engineEntries(r.atFlip)[0]).toBe('ENGINE host-ar vc=false');
  // The host's AR view waits out the settle, not just the 250 ms camera
  // transition: pano+'s camera is still being released.
  expect(camEntries(r.inSettle, 'AR')).toEqual([]);
  // Then it mounts once, and nothing asks for pano+'s viewfinder again.
  expect(camEntries(r.after, 'AR')).toEqual(['AR-MOUNT']);
  expect(idleEntries(r.after)).toEqual(['IDLE false']);
  expect(lastEngine()).toBe('ENGINE host-ar vc=false');
}

describe('out of the hatch into AR: the AR view waits out the settle', () => {
  for (const os of ['ios', 'android'] as const) {
    it(`${os}: the AR pill`, async () => {
      (Platform as { OS: string }).OS = os;
      const t = await mountHatch();
      const r = await flipOutToAr(() => { toggleAR(t); });
      expect(t.root.findByType(ARToggle).props.arEnabled).toBe(true);
      assertOutToAr(r);
    });

    it(`${os}: 1× under an AR preference, from 0.5×`, async () => {
      (Platform as { OS: string }).OS = os;
      vc.useCameraDevice = () => WIDE_AND_UW;
      vc.useCameraDevices = () => [WIDE_AND_UW];
      const t = await mountWith({ defaultCaptureSource: 'ar', sweep: { frameSourceOverride: 'own' } });
      // Precondition: AR is preferred at 1×, so the host's AR view is the camera.
      expect(lastEngine()).toBe('ENGINE host-ar vc=false');
      await act(async () => { pickLens(t, '0.5x'); });
      await tick(1500);
      await tick(1500);
      // Precondition: 0.5× makes the effective source non-AR, which is the
      // hatch, and the hatch has its viewfinder.
      expect(lastEngine()).toBe('ENGINE own vc=false');
      expect(idleEntries(log).slice(-1)).toEqual(['IDLE true']);
      const r = await flipOutToAr(() => { pickLens(t, '1x'); });
      expect(t.root.findByType(LensChip).props.lens).toBe('1x');
      assertOutToAr(r);
    });
  }
});

describe('sweep engine only: on engine="keyframe" the DR-1a flag changes no camera', () => {
  /**
   * How long after an AR flip on the keyframe engine its camera mounts
   * (`<CameraView>` for AR off, `<ARCameraView>` for AR on).
   */
  async function keyframeArFlipMountMs(flag: boolean, arTo: 'off' | 'on'): Promise<number | null> {
    const t = await mountWith({
      engine: 'keyframe',
      defaultCaptureSource: arTo === 'off' ? 'ar' : 'non-ar',
      sweep: flag ? { frameSourceOverride: 'own' } : {},
    });
    // Precondition: the keyframe camera for the starting source is up.
    expect(camEntries(log, arTo === 'off' ? 'AR' : 'CV').slice(-1))
      .toEqual([arTo === 'off' ? 'AR-MOUNT' : 'CV-MOUNT']);
    log.length = 0;
    await act(async () => { toggleAR(t); });
    const ms = await msUntil(() => log.includes(arTo === 'off' ? 'CV-MOUNT' : 'AR-MOUNT'));
    act(() => { t.unmount(); });
    return ms;
  }

  for (const os of ['ios', 'android'] as const) {
    for (const arTo of ['off', 'on'] as const) {
      it(`${os}: AR ${arTo} — the camera mounts when the transition ends, with the flag as without it`, async () => {
        (Platform as { OS: string }).OS = os;
        const withFlag = await keyframeArFlipMountMs(true, arTo);
        log.length = 0;
        const without = await keyframeArFlipMountMs(false, arTo);
        expect(without).not.toBeNull();
        expect(withFlag).toBe(without);
        expect(withFlag as number).toBeLessThan(SETTLE_MS);
      });
    }

    it(`${os}: adding and removing the flag with AR off leaves the keyframe viewfinder mounted`, async () => {
      (Platform as { OS: string }).OS = os;
      const t = await mountWith({ engine: 'keyframe', defaultCaptureSource: 'non-ar', sweep: {} });
      expect(camEntries(log, 'CV')).toEqual(['CV-MOUNT']);
      log.length = 0;
      act(() => {
        t.update(el({ engine: 'keyframe', defaultCaptureSource: 'non-ar', sweep: { frameSourceOverride: 'own' } }));
      });
      await tick(1500);
      act(() => {
        t.update(el({ engine: 'keyframe', defaultCaptureSource: 'non-ar', sweep: {} }));
      });
      await tick(1500);
      expect(camEntries(log, 'CV')).toEqual([]);
    });

    it(`${os}: AR off on keyframe, then a switch into the hatch before the AR session has stopped — the hatch opens nothing until the stop's grace ends, and no longer`, async () => {
      (Platform as { OS: string }).OS = os;
      const t = await mountWith({
        engine: 'keyframe', defaultCaptureSource: 'ar', sweep: { frameSourceOverride: 'own' },
      });
      expect(camEntries(log, 'AR').slice(-1)).toEqual(['AR-MOUNT']);
      const SWITCH_AT_MS = 50;
      await act(async () => { toggleAR(t); });
      await tick(SWITCH_AT_MS);
      log.length = 0;
      act(() => {
        t.update(el({ engine: 'sweep', defaultCaptureSource: 'ar', sweep: { frameSourceOverride: 'own' } }));
      });
      // The switch commit already puts the hatch on 'host': nobody opens a
      // camera while ARKit / ARCore is still letting go.
      expect(engineEntries(log)[0]).toBe('ENGINE host vc=false');
      const ownIn = await msUntil(() => log.includes('ENGINE own vc=false'));
      expect(ownIn).not.toBeNull();
      // The hatch gets its camera once the AR stop's grace is over…
      expect(SWITCH_AT_MS + (ownIn as number)).toBeGreaterThanOrEqual(AR_STOP_GRACE_MS);
      // …and not a whole ownership window later: the keyframe AR flip opened none.
      expect(SWITCH_AT_MS + (ownIn as number)).toBeLessThan(SETTLE_MS);
      // Until then every commit said 'host', and nothing asked for a camera.
      const own = log.indexOf('ENGINE own vc=false');
      expect(engineEntries(log.slice(0, own)).every((e) => e === 'ENGINE host vc=false')).toBe(true);
      expect(idleEntries(log.slice(0, own))).toEqual([]);
      await tick(1500);
      expect(idleEntries(log)).toEqual(['IDLE true']);
      expect(lastEngine()).toBe('ENGINE own vc=false');
    });
  }

  for (const os of ['ios', 'android'] as const) {
    it(`${os}: a flip made on keyframe opens no window when the engine later switches to sweep — the AR view stays`, async () => {
      (Platform as { OS: string }).OS = os;
      const t = await mountWith({
        engine: 'keyframe', defaultCaptureSource: 'non-ar', sweep: { frameSourceOverride: 'own' },
      });
      // AR on, on the keyframe engine: the owner changes (the flag is inert
      // under AR), and is recorded there without a window.
      await act(async () => { toggleAR(t); });
      await tick(1500);
      expect(camEntries(log, 'AR').slice(-1)).toEqual(['AR-MOUNT']);
      log.length = 0;
      act(() => {
        t.update(el({ engine: 'sweep', defaultCaptureSource: 'non-ar', sweep: { frameSourceOverride: 'own' } }));
      });
      await tick(1500);
      // Switching the engine is not a camera switch (DR-2 I3/A7): the AR view
      // is not taken down, and the engine is on it.
      expect(camEntries(log, 'AR')).toEqual([]);
      expect(lastEngine()).toBe('ENGINE host-ar vc=false');
    });

    it(`${os}: an ownership window already open when the engine switches to keyframe runs to its end`, async () => {
      (Platform as { OS: string }).OS = os;
      const t = await mountHatch();
      log.length = 0;
      // Out of the hatch: the override removed. pano+'s viewfinder is
      // released in this commit, and the window opens.
      act(() => { t.update(el({ defaultCaptureSource: 'non-ar', sweep: {} })); });
      expect(idleEntries(log)).toEqual(['IDLE false']);
      const SWITCH_AT_MS = 100;
      await tick(SWITCH_AT_MS);
      act(() => { t.update(el({ engine: 'keyframe', defaultCaptureSource: 'non-ar', sweep: {} })); });
      // The keyframe camera waits for the rest of the window: the release it
      // covers began before the switch…
      await tick(SETTLE_MS - SWITCH_AT_MS - 1);
      expect(camEntries(log, 'CV')).toEqual([]);
      // …and then the window comes down.
      await tick(1500);
      expect(camEntries(log, 'CV')).toEqual(['CV-MOUNT']);
    });
  }

  it('ios: a lens swap ON the hatch is not held on \'host\' (it is not an AR stop)', async () => {
    (Platform as { OS: string }).OS = 'ios';
    vc.useCameraDevice = () => WIDE_AND_UW;
    vc.useCameraDevices = () => [WIDE_AND_UW];
    const t = await mountHatch();
    log.length = 0;
    await act(async () => { pickLens(t, '0.5x'); });
    await tick(1500);
    expect(t.root.findByType(LensChip).props.lens).toBe('0.5x');
    expect(engineEntries(log).length).toBeGreaterThan(0);
    expect(engineEntries(log).every((e) => e === 'ENGINE own vc=false')).toBe(true);
    expect(idleEntries(log).slice(-1)).toEqual(['IDLE true']);
  });
});

describe('the engine-switch settle (hatch → keyframe)', () => {
  const keyframe = { engine: 'keyframe', defaultCaptureSource: 'non-ar', sweep: { frameSourceOverride: 'own' } };
  const hatch = { defaultCaptureSource: 'non-ar', sweep: { frameSourceOverride: 'own' } };

  for (const os of ['ios', 'android'] as const) {
    it(`${os}: opens in the switch commit — <CameraView> mounts once, when the settle ends`, async () => {
      (Platform as { OS: string }).OS = os;
      const t = await mountHatch();
      log.length = 0;
      act(() => { t.update(el(keyframe)); });
      const atSwitch = [...log];
      await tick(SETTLE_MS - 1);
      const inSettle = [...log];
      await tick(1500);
      // pano+'s idle viewfinder is released in the switch commit…
      expect(idleEntries(atSwitch)).toEqual(['IDLE false']);
      // …and <CameraView> stays unmounted through the settle, the switch
      // commit included…
      expect(camEntries(inSettle, 'CV')).toEqual([]);
      // …then mounts once.
      expect(camEntries(log, 'CV')).toEqual(['CV-MOUNT']);
    });

    it(`${os}: runs out when the engine comes back to the hatch inside it — a hold afterwards starts`, async () => {
      (Platform as { OS: string }).OS = os;
      const t = await mountHatch();
      act(() => { t.update(el(keyframe)); });
      await tick(100);
      act(() => { t.update(el(hatch)); });
      await tick(1500);
      log.length = 0;
      await act(async () => { (hatchShutter(t).props.onHoldStart as () => void)(); });
      await tick(100);
      expect(log.filter((e) => e === 'START')).toEqual(['START']);
    });

    it(`${os}: runs out when the engine comes back to the MAIN tree inside it — <CameraView> mounts`, async () => {
      (Platform as { OS: string }).OS = os;
      const t = await mountHatch();
      act(() => { t.update(el(keyframe)); });
      await tick(100);
      log.length = 0;
      act(() => { t.update(el({ defaultCaptureSource: 'non-ar', sweep: {} })); });
      await tick(1500);
      await tick(1500);
      expect(camEntries(log, 'CV')).toEqual(['CV-MOUNT']);
      expect(lastEngine()).toBe('ENGINE host vc=true');
    });
  }
});
