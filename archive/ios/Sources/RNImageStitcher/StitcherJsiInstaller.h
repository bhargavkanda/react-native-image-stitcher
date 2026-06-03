// SPDX-License-Identifier: Apache-2.0
//
// StitcherJsiInstaller.h — RN module that installs the
// `globalThis.__stitcherProxy` JSI host object on the main JS
// runtime.  Called once at lib boot from the TS layer
// (`src/index.ts` or the `useFrameProcessor` hook) via a
// synchronous JS bridge call.
//
// The proxy exposes two host functions:
//
//   __stitcherProxy.install(workletFn)  →  string ID
//   __stitcherProxy.uninstall(id)       →  undefined
//
// `install` wraps the worklet function into a
// `RNWorklet::WorkletInvoker` and stores it in the C++
// `retailens::StitcherWorkletRegistry` singleton (in
// `cpp/stitcher_worklet_registry.{hpp,cpp}`).  The AR worklet
// runtime's per-frame dispatch reads from that registry to fan
// out invocations.
//
// Why a RN module (not a vanilla NSObject installable):
//   - Hosts can't reliably reach into the JSI runtime from JS
//     without a native sync method to broker the install.
//   - `RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD` is the documented
//     pattern for "JS calls a native method synchronously to
//     install JSI bindings on the main runtime".  vision-camera
//     uses the same pattern (`VisionCameraInstaller.mm`).
//   - In RN's bridgeless mode the legacy `RCTCxxBridge.runtime`
//     accessor still works (vc has a comment to migrate but it
//     hasn't been needed yet — same applies to us).

#pragma once

#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>

NS_ASSUME_NONNULL_BEGIN

@interface StitcherJsiInstaller : NSObject <RCTBridgeModule>
@end

NS_ASSUME_NONNULL_END
