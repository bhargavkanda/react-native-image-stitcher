// SPDX-License-Identifier: Apache-2.0
//
// ReactNativeBridgeDelegate — Obj-C bridge for the bridgeless
// PlatformConstants registration race on RN 0.84.1 + prebuilt
// React.xcframework + no Expo.
//
// Why this file exists:
//
//   RCTTurboModuleManager (bridgeless) resolves a module by calling
//   `getModuleClassFromName:` on its delegate.  In non-Expo RN 0.84
//   projects the default impl
//   (`RCTDefaultReactNativeFactoryDelegate.getModuleClassFromName:`)
//   returns nullptr — and the manager has no other path to find
//   ObjC core modules like RCTPlatform (the PlatformConstants
//   provider).  Result: JS hits
//   "[runtime not ready]: PlatformConstants could not be found" at
//   bundle eval time, intermittently or every time depending on
//   DerivedData / Pods cache state.
//
//   Swift can't override `getModuleClassFromName:` because the
//   `RCTTurboModuleManagerDelegate` protocol that declares it is
//   `#if defined(__cplusplus)`-gated.  Swift doesn't see that gate,
//   so to Swift the method "doesn't exist" and any `override` call
//   fails with "method does not override any method from its
//   superclass".  Obj-C++ files (.mm) DO see __cplusplus, so this
//   class can legitimately override it.
//
// Usage:
//
//   1. Add this file + the matching .mm to the example target.
//   2. Set SWIFT_OBJC_BRIDGING_HEADER to
//      "RNImageStitcherExample-Bridging-Header.h" which imports
//      this header.
//   3. In AppDelegate.swift, change `ReactNativeDelegate` to
//      inherit from `ReactNativeBridgeDelegate` instead of
//      `RCTDefaultReactNativeFactoryDelegate`.

// In the prebuilt React.xcframework, RCTDefaultReactNativeFactoryDelegate
// lives in the `React_RCTAppDelegate` module, not `React`.  Module map:
// example/ios/Pods/React-Core-prebuilt/React.xcframework/ios-arm64/
//   React.framework/Modules/module.modulemap
#import <React_RCTAppDelegate/RCTDefaultReactNativeFactoryDelegate.h>

NS_ASSUME_NONNULL_BEGIN

@interface ReactNativeBridgeDelegate : RCTDefaultReactNativeFactoryDelegate
@end

NS_ASSUME_NONNULL_END
