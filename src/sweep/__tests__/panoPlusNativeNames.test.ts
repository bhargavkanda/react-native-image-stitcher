// SPDX-License-Identifier: Apache-2.0

// ⚠ `export {}` MAKES THIS A MODULE. Both of these files reach react-native
// through `require` and never `import`, so TypeScript treats them as global
// SCRIPTS — and two scripts each declaring `const rn` at top level collide
// with "Cannot redeclare block-scoped variable". One empty export gives each
// its own scope. (It did not bite in the package these came from because
// that tsconfig's include set never had both in one program.)
export {};
/**
 * panoPlusNativeNames — every pano+ native identifier resolves under the name
 * native registers, and reports itself absent when nothing is registered.
 *
 * Every one of these accessors is written to FAIL CLOSED — a missing module
 * resolves to `null` and the feature reports itself absent — so a name that
 * drifts from native produces a build that installs, launches, and simply
 * says pano+ is not in this build.  There is no error to grep for.  So each
 * accessor is pinned in both states: registered, and absent.  The absent case
 * matters as much as the first — an accessor that returned something truthy
 * for an absent module would turn a clean "not in this build" into a
 * TypeError at the first call.
 *
 * ⚠ THESE ARE FIXTURES, NOT EVIDENCE ABOUT THE BINARY.  Green here proves the
 * JS resolution logic; only a device capture proves the names agree with what
 * is registered.
 */

/* eslint-disable @typescript-eslint/no-explicit-any, global-require, @typescript-eslint/no-var-requires */

const NAMES = {
  session: 'RNSSweepSession',
  tools: 'RNSSweepTools',
  calib: 'RNSSweepCalibration',
  sourceView: 'RNSSweepSourceView',
} as const;

/**
 * ⚠ THE MOCK SHARES `NativeModules` AND `Platform` WITH jest.mocks/react-native.js
 * BY IDENTITY, and that is not tidiness — it is the fix for a real failure.
 *
 * `jest.config.js` maps `^react-native$` to that file.  This suite needs
 * `UIManager` and `requireNativeComponent`, which the shared mock does not
 * define, so it registers its own factory.  With BOTH in play, which one a
 * given module under test receives depends on what else the worker has
 * already resolved: run this file alone and every case passes; run it beside
 * two sibling calibration suites and `panoPlusCalibration` reads the OTHER
 * object, sees an empty registry, and reports the module unavailable.
 *
 * Reusing the shared mock's own objects makes the question moot — the
 * module lives in the one `NativeModules` either instance hands out.  Do not replace these with fresh `{}`.
 */
// ⚠ THE FACTORY BUILDS THE OBJECT; THE MODULE SCOPE ONLY READS IT BACK.
// `jest.mock` is hoisted above every `const` in the file, so a factory that
// closes over a module-scope `const rn` throws "Cannot access 'rn' before
// initialization" the moment anything imports react-native during setup.
// Building inside the factory and reading it back with `require` afterwards
// keeps the shared-identity property below without the ordering hazard.
jest.mock('react-native', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const shared = jest.requireActual('../../../jest.mocks/react-native.js');
  return {
    ...shared,
    // Shared BY IDENTITY with the mapped mock — see the note below.
    Platform: shared.Platform,
    NativeModules: shared.NativeModules,
    UIManager: {},
    requireNativeComponent: (name: string) => ({ __nativeComponent: name }),
  };
}, { virtual: true });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const rn: any = require('react-native');

/** The accessors memoise per process, so every case re-requires the module. */
function fresh<T>(path: string, pick: (m: any) => T): T {
  let out!: T;
  jest.isolateModules(() => {
    out = pick(require(path));
  });
  return out;
}

const sessionModuleFixture = () => ({
  start: () => Promise.resolve({}),
  stop: () => Promise.resolve({}),
  cancel: () => Promise.resolve({}),
  getStatus: () => Promise.resolve({}),
});

const toolsModuleFixture = () => ({
  engineInfo: () => Promise.resolve({}),
  replayPack: () => Promise.resolve({}),
  deriveBasis: () => Promise.resolve({}),
});

const calibModuleFixture = () => ({ startBasisCalibration: () => Promise.resolve({}) });

beforeEach(() => {
  rn.Platform.OS = 'ios';
  // Clear IN PLACE. Assigning a fresh object would break the identity the
  // banner above depends on, and would leak this suite's fixtures into the
  // shared mock for every later file in the worker.
  for (const k of Object.keys(rn.NativeModules)) delete rn.NativeModules[k];
  rn.UIManager = {};
});

afterAll(() => {
  for (const k of Object.keys(rn.NativeModules)) delete rn.NativeModules[k];
  rn.Platform.OS = 'ios';
});

describe('the sweep session module', () => {
  const isAvailable = () =>
    fresh('../panoPlusNative', (m) => m.panoPlusIsAvailable)();

  it('resolves the registered name', () => {
    rn.NativeModules[NAMES.session] = sessionModuleFixture();
    expect(isAvailable()).toBe(true);
  });

  it('reports unavailable when it is not registered', () => {
    rn.NativeModules.SomethingElse = sessionModuleFixture();
    expect(isAvailable()).toBe(false);
  });

  it('still requires the METHODS, not just a module object of the right name', () => {
    // A registered module whose methods did not link is the silent-failure
    // shape this codebase keeps hitting; a name match alone is not evidence.
    rn.NativeModules[NAMES.session] = { start: () => {} };
    expect(isAvailable()).toBe(false);
  });

  it('rejects with panoplus-unavailable, naming the module', async () => {
    const start = fresh('../panoPlusNative', (m) => m.startPanoPlus);
    await expect(start({ sessionDir: '/tmp/x' })).rejects.toMatchObject({
      code: 'panoplus-unavailable',
    });
    await expect(start({ sessionDir: '/tmp/x' })).rejects.toThrow(NAMES.session);
  });
});

describe('the sweep tools module', () => {
  const available = () =>
    fresh('../panoPlusAndroid', (m) => m.panoPlusAndroidIsAvailable)();

  beforeEach(() => {
    rn.Platform.OS = 'android';
  });

  it('resolves the registered name', () => {
    rn.NativeModules[NAMES.tools] = toolsModuleFixture();
    expect(available()).toBe(true);
  });

  it('reports unavailable when it is not registered', () => {
    expect(available()).toBe(false);
  });
});

describe('the calibration module', () => {
  const available = () =>
    fresh('../panoPlusCalibration', (m) => m.panoCalibAvailable)();

  it('resolves the registered name', () => {
    rn.NativeModules[NAMES.calib] = calibModuleFixture();
    expect(available()).toBe(true);
  });

  it('reports unavailable when it is not registered', () => {
    expect(available()).toBe(false);
  });
});

describe('the iOS source view', () => {
  const view = () =>
    fresh('../panoPlusSourceView', (m) => m.getPanoPlusSourceView)();

  it('resolves the registered name', () => {
    rn.UIManager.getViewManagerConfig = (n: string) =>
      (n === NAMES.sourceView ? { NativeProps: {} } : null);
    expect(view()).toEqual({ __nativeComponent: NAMES.sourceView });
  });

  it('never requires a name that probed false', () => {
    // RN warns and returns a broken component for a name the UIManager does
    // not know, and the module-level memo would then keep that broken
    // component forever.
    const required: string[] = [];
    rn.requireNativeComponent = (name: string) => {
      required.push(name);
      return { __nativeComponent: name };
    };
    rn.UIManager.getViewManagerConfig = () => null;
    expect(view()).toBeNull();
    expect(required).toEqual([]);
    rn.requireNativeComponent = (name: string) => ({ __nativeComponent: name });
  });

  it('returns null when it is not registered', () => {
    rn.UIManager.getViewManagerConfig = () => null;
    expect(view()).toBeNull();
  });
});

describe('the AR frame-plugin registry key', () => {
  const read = (plugins: Record<string, unknown>) =>
    fresh('../panoPlusModel', (m) => m.readPanoPlusStatus)({ plugins });

  it('reads the registered key', () => {
    const { PANO_PLUS_PLUGIN_KEY } = require('../panoPlusModel');
    expect(PANO_PLUS_PLUGIN_KEY).toBe('sweep');
    expect(read({ sweep: { running: true, seq: 7 } })).toMatchObject({ seq: 7 });
  });

  it('returns null when the key is not present', () => {
    expect(read({ someOtherPlugin: { running: true, seq: 3 } })).toBeNull();
  });
});

/**
 * ── THE RE-DECLARED VERDICT SHAPE ───────────────────────────────────────
 *
 * `panoPlusCalibration` declares its own `SweepVerdict`/`SweepVerdictTone`
 * rather than importing the host SDK's `ArProbeVerdict`/`ArProbeTone`, so the
 * sweep builds outside that SDK. Five exported functions return it, and a
 * host panel consumes those by NAME — which works only while the two shapes
 * stay structurally identical.
 *
 * This is the test that says when they stop. It reads the host's declaration
 * as TEXT rather than importing it: importing would re-create the dependency
 * the re-declaration exists to remove, and would vanish the day the sweep
 * moves packages. Reading the file still works from either side; when the
 * file is genuinely gone, the skip below says so out loud instead of passing.
 */
describe('the re-declared verdict shape still matches the host SDK', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const hostPath = path.resolve(__dirname, '../../device/arCaptureSummary.ts');

  it('has the same fields, in the same shape', () => {
    if (!fs.existsSync(hostPath)) {
      // Not a silent skip: state it, so a green run cannot be mistaken for a
      // checked one after the sweep leaves this package.
      // eslint-disable-next-line no-console
      console.warn(
        `[verdict parity] SKIPPED — ${hostPath} is gone. The sweep has left `
        + 'this SDK; re-point this check at the host that still declares '
        + 'ArProbeVerdict, or delete it.',
      );
      return;
    }
    const host = fs.readFileSync(hostPath, 'utf8');
    // tone union
    expect(host).toMatch(/type ArProbeTone = 'yes' \| 'no' \| 'unknown'/);
    // the three fields, in order
    const block = host.slice(host.indexOf('interface ArProbeVerdict'));
    const body = block.slice(0, block.indexOf('}'));
    expect(body).toMatch(/tone: ArProbeTone;/);
    expect(body).toMatch(/headline: string;/);
    expect(body).toMatch(/detail: string;/);
    // …and nothing else, which is what "structurally identical" needs
    const fields = body.match(/^\s{2}\w+[?]?:/gm) ?? [];
    expect(fields).toHaveLength(3);
  });
});
