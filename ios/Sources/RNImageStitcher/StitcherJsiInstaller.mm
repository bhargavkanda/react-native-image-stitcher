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
#include <memory>
#include <string>
#include <vector>

#include "stitcher_worklet_registry.hpp"

using namespace facebook;

#pragma mark - StitcherProxy host object

namespace {

/// JSI host object that exposes `install` / `uninstall` to JS.
class StitcherProxyHostObject : public jsi::HostObject {
 public:
  jsi::Value get(jsi::Runtime& rt, const jsi::PropNameID& propName) override {
    const std::string name = propName.utf8(rt);

    if (name == "install") {
      // install(workletFn) → string ID.  The host function captures
      // nothing; the registry is a process-scope singleton.
      auto fn = [](jsi::Runtime& runtime, const jsi::Value& /*thisVal*/,
                   const jsi::Value* args, size_t count) -> jsi::Value {
        if (count < 1) {
          throw jsi::JSError(runtime,
              "[StitcherProxy] install() requires 1 argument (worklet "
              "function); got 0");
        }
        if (!args[0].isObject() ||
            !args[0].getObject(runtime).isFunction(runtime)) {
          throw jsi::JSError(runtime,
              "[StitcherProxy] install() argument must be a function "
              "decorated with 'worklet'");
        }
        // The WorkletInvoker ctor extracts the worklet metadata
        // (`__workletHash` etc.) and throws if absent.  Propagate.
        std::string id =
            retailens::StitcherWorkletRegistry::shared().install(
                runtime, args[0]);
        return jsi::String::createFromUtf8(runtime, id);
      };
      return jsi::Function::createFromHostFunction(
          rt, jsi::PropNameID::forUtf8(rt, "install"), 1, std::move(fn));
    }

    if (name == "uninstall") {
      auto fn = [](jsi::Runtime& runtime, const jsi::Value& /*thisVal*/,
                   const jsi::Value* args, size_t count) -> jsi::Value {
        if (count < 1 || !args[0].isString()) {
          // No throw — match the JS-side registry's permissive
          // uninstall semantics; missing/bad ID is a no-op.
          return jsi::Value::undefined();
        }
        std::string id = args[0].getString(runtime).utf8(runtime);
        retailens::StitcherWorkletRegistry::shared().uninstall(id);
        return jsi::Value::undefined();
      };
      return jsi::Function::createFromHostFunction(
          rt, jsi::PropNameID::forUtf8(rt, "uninstall"), 1, std::move(fn));
    }

    if (name == "count") {
      // Diagnostic — number of currently registered worklets.
      // Read once on each call (no caching); registry mutations are
      // serialised under its own mutex.
      auto fn = [](jsi::Runtime& runtime, const jsi::Value& /*thisVal*/,
                   const jsi::Value* /*args*/, size_t /*count*/) -> jsi::Value {
        return jsi::Value(static_cast<double>(
            retailens::StitcherWorkletRegistry::shared().count()));
      };
      return jsi::Function::createFromHostFunction(
          rt, jsi::PropNameID::forUtf8(rt, "count"), 0, std::move(fn));
    }

    return jsi::Value::undefined();
  }

  std::vector<jsi::PropNameID> getPropertyNames(jsi::Runtime& rt) override {
    std::vector<jsi::PropNameID> names;
    names.push_back(jsi::PropNameID::forUtf8(rt, "install"));
    names.push_back(jsi::PropNameID::forUtf8(rt, "uninstall"));
    names.push_back(jsi::PropNameID::forUtf8(rt, "count"));
    return names;
  }
};

}  // namespace

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
  auto proxy = std::make_shared<StitcherProxyHostObject>();
  runtime.global().setProperty(
      runtime, "__stitcherProxy",
      jsi::Object::createFromHostObject(runtime, proxy));

  os_log_info(OS_LOG_DEFAULT,
      "[StitcherJsiInstaller] installed globalThis.__stitcherProxy "
      "on main JS runtime.");
  return @YES;
}

@end
