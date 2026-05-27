// SPDX-License-Identifier: Apache-2.0
//
// stitcher_worklet_dispatch.hpp — shared C++ helper that fans out a
// `StitcherFrameData` to every host worklet registered in the
// process-scope `retailens::StitcherWorkletRegistry`.
//
// v0.8.0 Phase 4b.iii — used by Android's per-frame fan-out path
// (`StitcherWorkletRuntime.dispatchToHostWorklets` → JNI binding →
// this function).  Designed to be platform-neutral so iOS' inline
// dispatch in `RNSARWorkletRuntime.mm` could refactor onto this
// helper in a later cleanup pass.
//
// ## Threading
//
// `dispatchToHostWorklets` is safe to call from ANY thread.  It
// posts a lambda onto `context`'s worklet thread via
// `JsiWorkletContext::invokeOnWorkletThread`.  The caller's thread
// returns immediately (async); the lambda runs later on the
// worklet thread.
//
// `data` is moved into the lambda — including the
// `std::shared_ptr<PixelBufferReader>` which owns the pixel bytes.
// The reader (and any underlying buffer it holds) lives until the
// dispatch lambda completes + the resulting jsi::Object is GC'd by
// the worklet runtime.

#pragma once

#include "stitcher_frame_data.hpp"

#include <jsi/jsi.h>

namespace RNWorklet {
class JsiWorkletContext;
}

namespace retailens {

/// Fan out a `StitcherFrameData` to every registered host worklet.
///
/// Behaviour:
///
///   1. Fast-path early-exit when `StitcherWorkletRegistry::shared()`
///      is empty.  No host object is constructed; the caller's
///      thread returns immediately.
///   2. Otherwise, the function snapshots the registry, constructs
///      a `StitcherFrameJsiHostObject` (deferred until inside the
///      worklet-thread lambda so JSI access happens on the
///      target runtime), and dispatches via
///      `context->invokeOnWorkletThread(...)`.
///   3. Each registered `RNWorklet::WorkletInvoker` is called with
///      the host object as its single argument.  Per-worklet failure
///      isolation: exceptions thrown by one invoker do NOT stop
///      the next invoker (each call is try/catch'd).
///   4. After all invokers return, the host object is invalidated;
///      its underlying `PixelBufferReader` is released so the
///      caller-provided buffer (NV21 bytes / CVPixelBuffer / etc.)
///      can be reclaimed.
///
/// @param context  Worklet runtime to dispatch on.  On Android this
///                 is typically `RNWorklet::JsiWorkletContext::
///                 getDefaultInstance()` (worklets-core's default,
///                 set up by `Worklets.install()`).  iOS uses its
///                 own context (`RNSARWorkletRuntime::_ctx`).
///                 MUST be non-null and initialized.
/// @param data     Frame data + pixel reader.  Moved into the
///                 worklet-thread lambda.
void dispatchToHostWorklets(RNWorklet::JsiWorkletContext* context,
                             StitcherFrameData data);

}  // namespace retailens
