//
// ARCameraViewManager.m
//
// RN bridge declaration for the Swift `RetaiLensARCameraViewManager`.
// Without this file the JS side's `requireNativeComponent('RetaiLensARCameraView')`
// would resolve to undefined because RN's component registry is
// populated by RCT_EXTERN_MODULE / RCT_EXPORT_VIEW_PROPERTY macros,
// not Swift @objc decorators alone.
//
// View name semantics:
//   `RCT_EXTERN_MODULE(<ManagerName>, RCTViewManager)` registers the
//   Swift manager class.  RN auto-derives the JS-visible component
//   name by stripping the trailing "Manager" — so this manager
//   exposes a component named "RetaiLensARCameraView" on the JS side.
//   That name MUST match what `requireNativeComponent('...')` looks
//   up in `ARCameraView.tsx`.
//

#import <React/RCTViewManager.h>

@interface RCT_EXTERN_MODULE(RetaiLensARCameraViewManager, RCTViewManager)

// No exposed view props for Phase 4.4 — the view's behaviour is
// fully driven by mount/unmount lifecycle (the AR session
// starts/stops automatically when the view enters/leaves the
// window hierarchy).  Future phases may add props for:
//   - tracking-state HUD visibility
//   - exposure / focus controls
//   - debug overlay (feature points, planes)
// Each of these will land here as RCT_EXPORT_VIEW_PROPERTY lines.

@end
