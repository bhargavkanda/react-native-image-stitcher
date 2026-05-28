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
#import <ReactCommon/CallInvoker.h>
// `RCTCxxBridge` (and its bridgeless-mode `RCTBridgeProxy` forwarder)
// exposes `-jsCallInvoker` returning `std::shared_ptr<CallInvoker>`,
// but the property declaration lives in `<ReactCommon/RCTTurboModule.h>`
// which isn't on our pod's HEADER_SEARCH_PATHS (worklets-core gets it
// via its own ReactCommon dep).  Rather than enlarging our pod's
// dependency surface, forward-declare the property in an anonymous
// category — the runtime dispatches to RN's actual implementation.
// Pattern matches `WKTJsiWorkletContext.cpp`'s approach to keep the
// pod self-contained.
@interface RCTCxxBridge ()
@property (nonatomic, readonly) std::shared_ptr<facebook::react::CallInvoker> jsCallInvoker;
@end
#import <os/log.h>

#include <jsi/jsi.h>

#include "stitcher_proxy_jsi.hpp"
// v0.11.1 — worklets-core JsiWorkletContext.  We initialize the
// SINGLETON default instance here so that other contexts in this
// library that use the 2-arg `JsiWorkletContext(name, workletInvoker)`
// constructor inherit a working `_jsCallInvoker` (and thus their
// `runOnJS` / `Worklets.createRunOnJS` callbacks actually route back
// to the main JS thread).  Specifically: `RNSARWorkletRuntime`'s AR-
// side worklet context (see `RNSARWorkletRuntime.mm:155`) uses the
// 2-arg ctor; pre-v0.11.1 that left its inherited `_jsCallInvoker`
// nullptr, and `invokeOnJsThread` silently no-op'd (see
// `WKTJsiWorkletContext.cpp:124-131`).  Test 2 of the v0.11.0
// manual-verification checklist surfaced this as "AR-mode host
// worklets register but their runOnJS callbacks never fire."
#include "WKTJsiWorkletContext.h"

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

  // v0.11.1 — initialize the singleton default JsiWorkletContext so
  // that downstream 2-arg ctors (RNSARWorkletRuntime) inherit a
  // working `_jsCallInvoker`.  Without this, AR-mode host worklets'
  // `runOnJS` / `Worklets.createRunOnJS` callbacks silently no-op
  // (`WKTJsiWorkletContext.cpp:124-131` early-returns when
  // `_jsCallInvoker == nullptr`).  See file-top comment for the full
  // diagnosis (Test 2 of v0.11.0 manual-verification checklist).
  //
  // Idempotent at the worklets-core level: re-initialization is
  // tolerated; the default instance is a process-scope singleton
  // and we're called once per JS-runtime bootstrap.  In bridgeless
  // mode `cxxBridge.jsCallInvoker` is forwarded via RCTBridgeProxy
  // to the underlying RCTHost's `CallInvoker` (same forwarding
  // pattern as `cxxBridge.runtime` above).
  auto jsCallInvoker = cxxBridge.jsCallInvoker;
  if (jsCallInvoker == nullptr) {
    os_log_error(OS_LOG_DEFAULT,
        "[StitcherJsiInstaller] cxxBridge.jsCallInvoker is nullptr; "
        "AR-mode host worklets' runOnJS will not fire.  Proxy installed "
        "but worklet-bridging is impaired.");
    // Proxy is still installed; only the runOnJS path is impaired.
    // Return @YES so JS callers don't fall back to the JS-side registry.
    return @YES;
  }
  auto jsInvokerAdapter =
      [jsCallInvoker](std::function<void()>&& fp) {
        jsCallInvoker->invokeAsync(std::move(fp));
      };
  RNWorklet::JsiWorkletContext::getDefaultInstance()->initialize(
      "stitcher.default", &runtime, jsInvokerAdapter);

  os_log_info(OS_LOG_DEFAULT,
      "[StitcherJsiInstaller] installed globalThis.__stitcherProxy "
      "AND initialized default JsiWorkletContext on main JS runtime.");
  return @YES;
}

@end
