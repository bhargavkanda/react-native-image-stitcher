// SPDX-License-Identifier: Apache-2.0
/**
 * panoPlusSourceView — null-guarded access to the `RNSSweepSourceView` native
 * component (the decoupled arm's viewfinder; see RNSSweepSourceView.swift).
 *
 * Guarded the same way `panoPlusNative` guards the module, and for the same
 * reason: the component exists only on iOS builds that carry the v12 plugin
 * cut, and `requireNativeComponent` on a name the UIManager does not know
 * THROWS at render on the Paper bridge. `UIManager.getViewManagerConfig` is
 * the documented existence probe, and it also returns nothing under Jest —
 * so render tests exercise the no-viewfinder branch without mocking this
 * file.
 *
 * `requireNativeComponent` must be called at most once per name per process
 * (RN warns and returns a broken component on the second call), hence the
 * memo.
 *
 * ⚠ THE `Platform.OS !== 'ios'` GUARD IS NOT A GAP — DO NOT "FIX" IT HERE.
 * Android has its own viewfinder and its own resolver,
 * `panoPlusAndroidPreviewView.ts`, and the two are deliberately separate: this
 * view DRAWS a session it does not own and may be mounted at any moment, while
 * the Android one VENDS a Surface that the recorder must claim BEFORE
 * `createCaptureSession` (Camera2 fixes a session's outputs at configure time,
 * so a surface arriving later cannot join and the sweep records headless).
 * Folding them into one component would mount the Android view too late and
 * produce a black rectangle with nothing to explain it. `PanoPlusCaptureSurface`
 * resolves both and mounts from its FIRST render, which is what satisfies the
 * Android ordering.
 */

import { Platform, UIManager, requireNativeComponent } from 'react-native';
import type { HostComponent } from 'react-native';
import type { ViewProps } from 'react-native';

const COMPONENT_NAME = 'RNSSweepSourceView';
/** The pre-migration spelling — see the dual-name banner in panoPlusNative.ts. */
const LEGACY_COMPONENT_NAME = 'RNISPanoSourceView';

let resolved: HostComponent<ViewProps> | null | undefined;

/**
 * Is the native view manager registered in THIS runtime?
 *
 * ⚠ `hasViewManagerConfig` FIRST, and that order is load-bearing — this used
 * to call `getViewManagerConfig` alone.  Under the New Architecture
 * `BridgelessUIManager.getViewManagerConfig` returns null for EVERY legacy
 * ViewManager unless RN's native-ViewConfig interop binding is installed, and
 * whether it is installed is an RN feature flag, not something this package
 * controls.  On the flag's off side this probe answers "not in this build"
 * for a view manager that is registered and working, the module-level memo
 * keeps that null for the life of the process, and the operator sees the
 * no-viewfinder explainer with no error to grep.
 *
 * `hasViewManagerConfig` can itself THROW (`unstable_hasComponent` raises when
 * its global is not registered), which is the non-bridgeless runtime where
 * `getViewManagerConfig` is the correct call — hence the try around each.
 *
 * This is the same ladder `panoPlusAndroidPreviewView.ts` uses, and for the
 * same reason; the two files disagreeing about it was the defect.
 */
function isRegistered(name: string): boolean {
  try {
    if (typeof UIManager.hasViewManagerConfig === 'function') {
      return UIManager.hasViewManagerConfig(name);
    }
  } catch {
    // Bridgeless global not installed — fall through to the Paper probe.
  }
  try {
    return UIManager.getViewManagerConfig?.(name) != null;
  } catch {
    return false;
  }
}

export function getPanoPlusSourceView(): HostComponent<ViewProps> | null {
  if (resolved !== undefined) return resolved;
  if (Platform.OS !== 'ios') {
    resolved = null;
    return resolved;
  }
  try {
    // ⚠ PROBE BOTH, REQUIRE ONE. The memo above is per NAME: probing is free,
    // but `requireNativeComponent` on a name the UIManager does not know warns
    // and returns a broken component the memo would then keep forever.
    const name = [COMPONENT_NAME, LEGACY_COMPONENT_NAME].find(isRegistered);
    resolved = name != null
      ? (requireNativeComponent(name) as HostComponent<ViewProps>)
      : null;
  } catch {
    resolved = null;
  }
  return resolved;
}
