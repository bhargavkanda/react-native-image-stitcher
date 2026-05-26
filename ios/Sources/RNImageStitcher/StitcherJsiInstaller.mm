// SPDX-License-Identifier: Apache-2.0
//
// StitcherJsiInstaller.mm — implementation.  Installs
// `globalThis.__stitcherProxy` on the main JS runtime.
//
// ## Why a host object rather than two globalThis functions
//
// We could install `__stitcherProxy_install` + `__stitcherProxy_uninstall`
// directly on `globalThis`.  Wrapping them in a host object is
// slightly more code but:
//   - Namespaces the proxy under a single global property
//     (easier to feature-detect; one `if (globalThis.__stitcherProxy)`
//     instead of two).
//   - Matches vc's pattern (`global.VisionCameraProxy`), so future
//     readers recognise the shape.
//   - Keeps room to grow (e.g., add `__stitcherProxy.snapshot()` for
//     diagnostics) without polluting globalThis further.

#import "StitcherJsiInstaller.h"

#import <Foundation/Foundation.h>
#import <React/RCTBridge.h>
#import <React/RCTBridge+Private.h>
#import <React/RCTUtils.h>
#import <os/log.h>

#include <jsi/jsi.h>

#include "stitcher_proxy_jsi.hpp"

using namespace facebook;

// The host object class + install logic moved to shared C++ in
// `cpp/stitcher_proxy_jsi.{hpp,cpp}` (v0.8.0 Phase 4b.ii).  The
// Android JNI installer reuses the same `install` / `uninstall` /
// `count` host functions verbatim — the JSI dispatch is identical
// across platforms (matches the StitcherFrame host object's design).

#pragma mark - RN module

@implementation StitcherJsiInstaller

// RN injects `_bridge` at module init (legacy bridge → RCTBridge*;
// bridgeless / new arch → RCTBridgeProxy*, which forwards `runtime`
// access via NSProxy `forwardInvocation:`).  Using the injected
// `_bridge` instead of `[RCTBridge currentBridge]` is the
// bridgeless-compatible idiom — `currentBridge` is nil under new
// arch.  Pattern lifted from `react-native-worklets-core/ios/Worklets.mm`.
@synthesize bridge = _bridge;

RCT_EXPORT_MODULE()

+ (BOOL)requiresMainQueueSetup {
  return YES;
}

- (void)setBridge:(RCTBridge*)bridge {
  _bridge = bridge;
}

// Synchronous install method.  JS calls this once at lib bootstrap
// to install the global proxy on the main JS runtime.  Returns
// `@YES` on success or `@NO` if the JSI runtime wasn't reachable
// (remote debug mode pre-Hermes; bridge not yet ready; etc.).
//
// `RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD` is the documented
// pattern for "run native code synchronously on the JS thread to
// install JSI bindings."  Same pattern worklets-core + vision-camera
// use for their installs.
//
// **Bridgeless mode:** `_bridge` is an `RCTBridgeProxy` (NSProxy
// subclass) that forwards `-runtime` / `-jsCallInvoker` invocations
// to the underlying RCTHost-backed runtime.  The `(RCTCxxBridge*)`
// cast is a no-op at runtime (NSProxy ignores static type) but
// keeps the Obj-C compiler happy about property access.
RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(install) {
  if (_bridge == nil) {
    os_log_error(OS_LOG_DEFAULT,
        "[StitcherJsiInstaller] _bridge is nil; the module was "
        "instantiated without bridge injection.  Cannot install "
        "__stitcherProxy.");
    return @NO;
  }

  RCTCxxBridge* cxxBridge = (RCTCxxBridge*)_bridge;
  if (cxxBridge.runtime == nullptr) {
    os_log_error(OS_LOG_DEFAULT,
        "[StitcherJsiInstaller] _bridge.runtime is nullptr; the JS "
        "runtime hasn't been initialized yet OR remote debugger is "
        "attached.  Cannot install __stitcherProxy.");
    return @NO;
  }

  jsi::Runtime& runtime = *(jsi::Runtime*)cxxBridge.runtime;
  retailens::installStitcherProxy(runtime);

  os_log_info(OS_LOG_DEFAULT,
      "[StitcherJsiInstaller] installed globalThis.__stitcherProxy "
      "on main JS runtime.");
  return @YES;
}

@end
