// SPDX-License-Identifier: Apache-2.0
/**
 * panoPlusAndroidPreviewView — null-guarded access to the
 * `RNSSweepPreviewView` native component (the pano+ ANDROID arm's
 * viewfinder; see PanoPlusPreviewView.kt).
 *
 * Guarded the way `panoPlusSourceView` guards its iOS counterpart, and for the
 * same reason: the component exists only on Android builds that carry the
 * stitch-plugins package, and `requireNativeComponent` on a name the UIManager
 * does not know THROWS at render. It also returns nothing under Jest — so
 * render tests exercise the no-viewfinder branch without mocking this file.
 *
 * ⚠ BUT THE PROBE IS `hasViewManagerConfig`, NOT `getViewManagerConfig`, AND
 * THAT IS NOT INTERCHANGEABLE HERE. This app runs the New Architecture
 * (`newArchEnabled=true`), and under bridgeless RN
 * `BridgelessUIManager.getViewManagerConfig` returns **null for every legacy
 * ViewManager** unless the native ViewConfig interop layer is switched on —
 * RN's own soft-error text says so and points at `hasViewManagerConfig`
 * instead. A probe on the wrong one would report "not in this build" for a
 * view manager that is registered and working, and the panel would render its
 * rebuild-the-plugin message forever while the recorder ran headless beside
 * it. `getViewManagerConfig` stays as the FALLBACK because it is the one that
 * answers on Paper and under Jest.
 *
 * `hasViewManagerConfig` can also THROW (`unstable_hasComponent` raises when
 * the bridgeless global is not registered), hence the try around each.
 *
 * `requireNativeComponent` must be called at most once per name per process
 * (RN warns and returns a broken component on the second call), hence the memo.
 *
 * ⚠ SEPARATE FROM `panoPlusSourceView`, NOT A PLATFORM BRANCH INSIDE IT. The
 * two views are not the same contract: the iOS one draws a session it does not
 * own and can be mounted at any moment, while this one VENDS a Surface that
 * the Android recorder must claim BEFORE `createCaptureSession` — Camera2
 * fixes a session's outputs at configure time. A caller that treated them as
 * one component would mount the Android view too late and get a black
 * rectangle with nothing to explain it.
 */

import { Platform, UIManager, requireNativeComponent } from 'react-native';
import type { HostComponent } from 'react-native';
import type { ViewProps } from 'react-native';

const COMPONENT_NAME = 'RNSSweepPreviewView';
/** The pre-migration spelling — see the dual-name banner in panoPlusNative.ts. */
const LEGACY_COMPONENT_NAME = 'RNISPanoPlusPreview';

let resolved: HostComponent<ViewProps> | null | undefined;

/** Is the native view manager registered in THIS runtime? See the header for
 *  why the bridgeless answer and the Paper answer come from different calls. */
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

/**
 * The registered spelling, or null.
 *
 * ⚠ PROBE BOTH, REQUIRE ONE.  The memo above is per NAME: probing two names
 * is free, but calling `requireNativeComponent` on a name the UIManager does
 * not know warns and hands back a broken component that the memo then keeps
 * forever.  So the probe picks the winner and only that name is required.
 */
function registeredName(): string | null {
  if (isRegistered(COMPONENT_NAME)) return COMPONENT_NAME;
  if (isRegistered(LEGACY_COMPONENT_NAME)) return LEGACY_COMPONENT_NAME;
  return null;
}

export function getPanoPlusAndroidPreviewView(): HostComponent<ViewProps> | null {
  if (resolved !== undefined) return resolved;
  if (Platform.OS !== 'android') {
    resolved = null;
    return resolved;
  }
  try {
    const name = registeredName();
    resolved = name != null
      ? (requireNativeComponent(name) as HostComponent<ViewProps>)
      : null;
  } catch {
    resolved = null;
  }
  return resolved;
}
