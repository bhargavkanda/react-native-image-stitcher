// SPDX-License-Identifier: Apache-2.0

import { NativeModules } from 'react-native';

/**
 * v0.8.0 Phase 4b — one-shot installer that asks the native side
 * to install `globalThis.__stitcherProxy` on the main JS runtime.
 *
 * ## When this runs
 *
 * The first call to `useFrameProcessor` triggers this.  Idempotent:
 * once the global is installed, subsequent calls short-circuit.
 *
 * ## What it does
 *
 * Calls into the platform-native `StitcherJsiInstaller` RN module
 * which is registered with a `RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(install)`
 * on iOS (see `ios/Sources/RNImageStitcher/StitcherJsiInstaller.mm`)
 * and — Phase 4b.ii — an analogous Kotlin TurboModule on Android.
 *
 * The native module reaches into the main JS runtime via
 * `RCTCxxBridge.runtime` (iOS) / the equivalent Android JSI access
 * pattern and installs a host object on `globalThis.__stitcherProxy`
 * exposing `install(workletFn)` / `uninstall(id)` / `count()`.
 *
 * ## Failure modes (and what happens then)
 *
 * 1. **Module not registered** (Android in Phase 4b.i; old iOS
 *    builds without the new pod files).  `NativeModules
 *    .StitcherJsiInstaller` is `undefined`.  This function returns
 *    `false` and the hook falls back to the JS-side
 *    `StitcherWorkletRegistry` — host worklets are registered
 *    on the JS side but never fan out to AR mode.  No crash, no
 *    regression vs. Phase 4a.
 *
 * 2. **JSI runtime unreachable** (e.g., remote debug mode).  The
 *    sync method returns `false`.  Same JS-side-registry fallback.
 *
 * 3. **Native install succeeds but global not yet visible.**
 *    The native call is SYNCHRONOUS (`BLOCKING_SYNCHRONOUS_METHOD`),
 *    so by the time the function returns the global is installed.
 *    No race here.
 *
 * ## Why a separate module
 *
 * The install method is a one-time runtime bootstrap, not a
 * per-call API.  Putting it on its own RN module (vs. on the
 * existing `StitcherBridge` / `IncrementalStitcherBridge`) keeps
 * the responsibility surface narrow and the failure mode easy
 * to diagnose ("`__stitcherProxy` not installed" → check
 * `StitcherJsiInstaller` module registration first).
 */

interface StitcherJsiInstallerModule {
  install(): boolean;
}

/**
 * `__DEV__` is RN's global dev-flag.  Guard the read with `typeof`
 * so the helper works in any environment that imports it without
 * defining __DEV__ (jest, SSR, custom tooling).  Same pattern RN's
 * own debug code uses.
 */
function isDev(): boolean {
  return typeof __DEV__ !== 'undefined' && __DEV__;
}

let installed = false;

export function ensureStitcherProxyInstalled(): boolean {
  if (installed) return true;
  // Already installed by an earlier hook mount.  Cheap fast-path.
  if (typeof (globalThis as { __stitcherProxy?: unknown }).__stitcherProxy !== 'undefined') {
    installed = true;
    return true;
  }

  const mod = (NativeModules as { StitcherJsiInstaller?: StitcherJsiInstallerModule })
    .StitcherJsiInstaller;
  if (mod == null || typeof mod.install !== 'function') {
    // Module not present — Android until Phase 4b.ii lands, or
    // an old iOS build.  Surface this once at debug-info level so
    // the host can see "your worklets are JS-registered only" in
    // logcat / Console.app without a noisy per-frame warning.
    if (isDev() && !warnedAboutMissingModule) {
      warnedAboutMissingModule = true;
      console.info(
        '[react-native-image-stitcher] StitcherJsiInstaller native ' +
          'module not found; host worklets registered in JS-side ' +
          'registry only.  AR-mode dispatch requires the native install ' +
          '(iOS Phase 4b.i — included in v0.8.0; Android Phase 4b.ii ' +
          '— follow-up release).',
      );
    }
    return false;
  }

  try {
    const ok = mod.install();
    if (!ok) {
      // Native module ran but couldn't install (JSI runtime
      // unreachable).  Same fallback as the missing-module case.
      if (isDev() && !warnedAboutFailedInstall) {
        warnedAboutFailedInstall = true;
        console.info(
          '[react-native-image-stitcher] StitcherJsiInstaller.install() ' +
            'returned false (JSI runtime unreachable — remote debug ' +
            'mode?).  Falling back to JS-side host worklet registry.',
        );
      }
      return false;
    }
    installed = true;
    return true;
  } catch (err) {
    if (isDev() && !warnedAboutFailedInstall) {
      warnedAboutFailedInstall = true;
      console.info(
        '[react-native-image-stitcher] StitcherJsiInstaller.install() ' +
          'threw: ' +
          String(err) +
          '.  Falling back to JS-side host worklet registry.',
      );
    }
    return false;
  }
}

let warnedAboutMissingModule = false;
let warnedAboutFailedInstall = false;

/**
 * Test-only — reset module-internal state.  Used by jest to allow
 * multiple test cases to re-trigger the install path independently.
 * NOT exported from `src/index.ts`.
 */
export function _resetStitcherProxyInstallStateForTests(): void {
  installed = false;
  warnedAboutMissingModule = false;
  warnedAboutFailedInstall = false;
}
