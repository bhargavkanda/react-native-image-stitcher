// SPDX-License-Identifier: Apache-2.0
//
// stitcher_worklet_dispatch.cpp — implementation of the v0.8.0
// Phase 4b.iii per-frame fan-out helper.  See header for contract.

#include "stitcher_worklet_dispatch.hpp"

#include "stitcher_frame_jsi.hpp"
#include "stitcher_worklet_registry.hpp"

#include <react-native-worklets-core/WKTJsiWorklet.h>
#include <react-native-worklets-core/WKTJsiWorkletContext.h>

#include <exception>
#include <memory>
#include <utility>
#include <vector>

#if defined(__ANDROID__)
#include <android/log.h>
#define DISPATCH_LOG_ERROR(...) \
  __android_log_print(ANDROID_LOG_ERROR, "StitcherWorkletDispatch", __VA_ARGS__)
#else
// iOS path uses `os_log` from its caller (RNSARWorkletRuntime.mm);
// this shared helper isn't invoked from iOS in v0.8.0.  Fall back
// to fprintf for any non-Android build that picks this up.
#include <cstdio>
#define DISPATCH_LOG_ERROR(...) std::fprintf(stderr, __VA_ARGS__)
#endif

namespace retailens {

void dispatchToHostWorklets(RNWorklet::JsiWorkletContext* context,
                             StitcherFrameData data) {
  // Fast-path early-exit when no host worklets are registered.
  // The Android caller (`StitcherWorkletRuntime.dispatchToHostWorklets`)
  // already runs in a hot per-frame loop; saving the host-object
  // alloc + dispatch hop on every frame is meaningful — typical
  // first-party-only deployments will hit this path.
  auto invokers = StitcherWorkletRegistry::shared().snapshot();
  if (invokers.empty()) {
    return;
  }

  if (context == nullptr) {
    DISPATCH_LOG_ERROR(
        "dispatchToHostWorklets: context is null; "
        "did Worklets.install() run on the JS side?");
    return;
  }

  // Build the JSI host object on the worklet thread (inside the
  // lambda) so JSI access happens on the target runtime.
  // `StitcherFrameJsiHostObject::create` uses the `make_shared`-via-
  // factory pattern (required by `shared_from_this()` inside the
  // `toArrayBuffer` lambda); see its header.
  //
  // Capture `data` by-move so the StitcherFrameData (including the
  // pixel reader's shared_ptr) lives until the lambda runs.
  // Capture `invokers` by-move as well.
  context->invokeOnWorkletThread(
      [invokers = std::move(invokers), data = std::move(data)](
          RNWorklet::JsiWorkletContext* /*ctx*/,
          facebook::jsi::Runtime& rt) mutable {
        auto hostObj = StitcherFrameJsiHostObject::create(std::move(data));
        facebook::jsi::Object frameJsi =
            facebook::jsi::Object::createFromHostObject(rt, hostObj);
        facebook::jsi::Value frameVal(rt, frameJsi);

        for (const auto& entry : invokers) {
          if (!entry.invoker) continue;
          try {
            entry.invoker->call(rt, facebook::jsi::Value::undefined(),
                                 &frameVal, 1);
          } catch (const facebook::jsi::JSError& jsErr) {
            // Per-worklet failure isolation: one host worklet
            // throwing must NOT stop the lib's own path or other
            // host worklets.  Log + continue.  Same three-level
            // catch hierarchy iOS' `RNSARWorkletRuntime` uses.
            DISPATCH_LOG_ERROR(
                "host worklet '%s' threw JS error: %s",
                entry.id.c_str(), jsErr.what());
          } catch (const std::exception& e) {
            DISPATCH_LOG_ERROR(
                "host worklet '%s' threw native exception: %s",
                entry.id.c_str(), e.what());
          } catch (...) {
            DISPATCH_LOG_ERROR(
                "host worklet '%s' threw unknown exception",
                entry.id.c_str());
          }
        }

        // Invalidate after all worklets finish.  Releases the
        // PixelBufferReader's shared_ptr, which (when its refcount
        // drops to 0) drops the underlying buffer — for Android
        // that's the std::vector of copied NV21 bytes; for iOS it
        // would be the CFBridgingRetain'd ARFrame.
        hostObj->invalidate();
      });
}

}  // namespace retailens
