// SPDX-License-Identifier: Apache-2.0

// ⚠ `export {}` MAKES THIS A MODULE. Both of these files reach react-native
// through `require` and never `import`, so TypeScript treats them as global
// SCRIPTS — and two scripts each declaring `const rn` at top level collide
// with "Cannot redeclare block-scoped variable". One empty export gives each
// its own scope. (It did not bite in the package these came from because
// that tsconfig's include set never had both in one program.)
export {};
/**
 * panoPlusAndroidPreviewView — the PROBE, which is the only part of this file
 * that can be wrong in a way nobody notices.
 *
 * The failure it guards against is not a crash. It is a FALSE NEGATIVE: under
 * the New Architecture `getViewManagerConfig` returns null for every legacy
 * ViewManager, so a probe written against it reports "the viewfinder is not in
 * this build" for a view manager that is registered and working — and the
 * panel then shows its rebuild-the-plugin message forever while the recorder
 * runs headless beside it. `hasViewManagerConfig` is the call RN's own
 * soft-error text points at, and these tests pin that it is the one tried
 * first and that every way a runtime can refuse to answer is survivable.
 *
 * ⚠ A LOCAL `react-native` MOCK, not the shared one in jest.mocks/. That mock
 * defines `Platform` and nothing else — no `UIManager`, no
 * `requireNativeComponent` — so the shared stub cannot express any of the
 * cases below. Widening it for one suite would change what eight other suites
 * import.
 *
 * ⚠ THE MODULE MEMOISES. `requireNativeComponent` must be called at most once
 * per name per process, so the resolution is cached — every case has to
 * re-require the module through `jest.isolateModules`, or the second test
 * reads the first one's answer.
 *
 * ⚠ PROBE, THEN REQUIRE. `requireNativeComponent` must be called only on a
 * name that probed true: calling it on an unknown one warns and memoises a
 * broken component for the life of the process.
 */

const NEW_NAME = 'RNSSweepPreviewView';

/* eslint-disable @typescript-eslint/no-explicit-any */

const rn: any = {
  Platform: { OS: 'android' },
  UIManager: {},
  requireNativeComponent: (name: string) => ({ __nativeComponent: name }),
};

jest.mock('react-native', () => rn, { virtual: true });

type Probe = () => unknown;

function loadProbe(): Probe {
  let fn: Probe = () => null;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    fn = require('../panoPlusAndroidPreviewView').getPanoPlusAndroidPreviewView;
  });
  return fn;
}

describe('getPanoPlusAndroidPreviewView', () => {
  beforeEach(() => {
    rn.Platform.OS = 'android';
    rn.UIManager = {};
  });

  it('resolves the native component when the bridgeless probe says it is there', () => {
    const asked: string[] = [];
    rn.UIManager.hasViewManagerConfig = (n: string) => { asked.push(n); return true; };
    expect(loadProbe()()).toEqual({ __nativeComponent: NEW_NAME });
    expect(asked).toEqual([NEW_NAME]);
  });

  it('never requires a name that probed false', () => {
    // The regression this pins: if the resolver ever called
    // requireNativeComponent on a name that answered false, RN would hand back
    // a broken component and the module-level memo would keep it forever.
    const required: string[] = [];
    rn.requireNativeComponent = (name: string) => {
      required.push(name);
      return { __nativeComponent: name };
    };
    rn.UIManager.hasViewManagerConfig = () => false;
    expect(loadProbe()()).toBeNull();
    expect(required).toEqual([]);
    rn.requireNativeComponent = (name: string) => ({ __nativeComponent: name });
  });

  it('returns null when the view manager is not registered', () => {
    const asked: string[] = [];
    rn.UIManager.hasViewManagerConfig = (n: string) => { asked.push(n); return false; };
    expect(loadProbe()()).toBeNull();
    expect(asked).toEqual([NEW_NAME]);
  });

  it('returns null off Android without probing the UIManager at all', () => {
    rn.Platform.OS = 'ios';
    let hasCalls = 0;
    let getCalls = 0;
    rn.UIManager.hasViewManagerConfig = () => { hasCalls += 1; return true; };
    rn.UIManager.getViewManagerConfig = () => { getCalls += 1; return {}; };
    expect(loadProbe()()).toBeNull();
    expect(hasCalls).toBe(0);
    expect(getCalls).toBe(0);
  });

  it('prefers hasViewManagerConfig — the bridgeless-correct probe', () => {
    let getCalls = 0;
    rn.UIManager.hasViewManagerConfig = () => false;
    rn.UIManager.getViewManagerConfig = () => { getCalls += 1; return {}; };
    expect(loadProbe()()).toBeNull();
    // A definitive `false` is an ANSWER, not a failure to answer: falling
    // through to getViewManagerConfig here would ask the call that cannot
    // answer under bridgeless and reach the same null for a different reason.
    expect(getCalls).toBe(0);
  });

  it('falls back to getViewManagerConfig when the bridgeless probe throws', () => {
    // `unstable_hasComponent` raises when its global is not registered, which
    // is exactly the non-bridgeless runtime where getViewManagerConfig works.
    rn.UIManager.hasViewManagerConfig = () => {
      throw new Error('Global function is not registered');
    };
    rn.UIManager.getViewManagerConfig = () => ({ NativeProps: {} });
    expect(loadProbe()()).toEqual({ __nativeComponent: NEW_NAME });
  });

  it('falls back when the runtime has no hasViewManagerConfig at all', () => {
    // Any older Paper host — and, before this suite existed, every Jest run.
    const asked: string[] = [];
    rn.UIManager.getViewManagerConfig = (n: string) => { asked.push(n); return undefined; };
    expect(loadProbe()()).toBeNull();
    expect(asked).toEqual([NEW_NAME]);
  });

  it('survives a UIManager that answers nothing rather than taking the panel down', () => {
    // Both probes throwing — and, separately, no UIManager at all, which is
    // what a stubbed react-native gives you.
    rn.UIManager.hasViewManagerConfig = () => { throw new Error('nope'); };
    rn.UIManager.getViewManagerConfig = () => { throw new Error('nope either'); };
    expect(loadProbe()()).toBeNull();
    rn.UIManager = undefined;
    expect(loadProbe()()).toBeNull();
  });
});
