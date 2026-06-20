// SPDX-License-Identifier: Apache-2.0
//
// ARCameraViewManager.m
//
// RN bridge declaration for the Swift `RNSARCameraViewManager`.
// Without this file the JS side's `requireNativeComponent('RNSARCameraView')`
// would resolve to undefined because RN's component registry is
// populated by RCT_EXTERN_MODULE / RCT_EXPORT_VIEW_PROPERTY macros,
// not Swift @objc decorators alone.
//
// View name semantics:
//   `RCT_EXTERN_MODULE(<ManagerName>, RCTViewManager)` registers the
//   Swift manager class.  RN auto-derives the JS-visible component
//   name by stripping the trailing "Manager" — so this manager
//   exposes a component named "RNSARCameraView" on the JS side.
//   That name MUST match what `requireNativeComponent('...')` looks
//   up in `ARCameraView.tsx`.
//

#import <React/RCTViewManager.h>

@interface RCT_EXTERN_MODULE(RNSARCameraViewManager, RCTViewManager)

// v0.20.0 — declarative AR overlay set.  React-state-driven array of
// overlay dictionaries (the JS `AROverlay[]` shape).  RN sets this via KVC
// on the VIEW (`RNSARCameraView.overlays`); the view's `@objc` setter
// forwards the array to the JS namespace of `RNISAROverlayStore.shared`,
// which the per-frame draw view reprojects + strokes.  (We forward through
// the view rather than store per-view state because the overlay set is
// global to the single AR session.)
//
// The IMPERATIVE overlay API (setOverlays / addOverlay / updateOverlay /
// removeOverlay / clearOverlays on the ref) is NOT a view command — per
// the shared contract (src/camera/arOverlayController.ts) it dispatches
// through the `RNSARSession.setOverlays(_:)` native MODULE method (see
// ARSessionBridge.{swift,m}), matching every other AR setting.  Only the
// declarative prop lives on the view manager.
RCT_EXPORT_VIEW_PROPERTY(overlays, NSArray)

@end
