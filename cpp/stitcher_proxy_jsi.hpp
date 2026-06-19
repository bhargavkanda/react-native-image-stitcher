// SPDX-License-Identifier: Apache-2.0
//
// stitcher_proxy_jsi.hpp — shared C++ JSI host object that's exposed
// as `globalThis.__stitcherProxy` on the main JS runtime.
//
// Originally inlined as an anonymous-namespace class in iOS'
// `StitcherJsiInstaller.mm` (v0.8.0 Phase 4b.i).  Phase 4b.ii lifts
// it into shared C++ so the Android JNI installer reuses the same
// `install` / `uninstall` / `count` host functions verbatim — the
// JSI dispatch is identical across platforms (matches the
// `StitcherFrame` host object's design).
//
// Platform-specific code (Obj-C++ on iOS, JNI on Android) only
// owns the bootstrap: get a handle to the main JS runtime, then
// call `retailens::installStitcherProxy(runtime)`.
//
// ## Surface
//
//   __stitcherProxy.install(workletFn)  →  string ID
//   __stitcherProxy.uninstall(id)       →  undefined
//   __stitcherProxy.count()             →  number  (diagnostic)
//
// `install` wraps the worklet into a `RNWorklet::WorkletInvoker`
// and stores it in the process-scope C++
// `retailens::StitcherWorkletRegistry`.  The AR worklet runtime
// (iOS' `RNSARWorkletRuntime`, Android's `StitcherWorkletRuntime`)
// reads from that registry to fan out per-frame invocations.

#pragma once

#include <jsi/jsi.h>

namespace retailens {

/// Install `globalThis.__stitcherProxy` on the supplied runtime.
/// Idempotent — re-installing overwrites the existing global with
/// a fresh host object; the underlying `StitcherWorkletRegistry`
/// state is unaffected.
///
/// Thread: must be called from a thread that owns `runtime`.
/// Typically called once at lib bootstrap from a synchronous JS
/// bridge method (iOS: `RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD`;
/// Android: `@ReactMethod(isBlockingSynchronousMethod = true)`).
void installStitcherProxy(facebook::jsi::Runtime& runtime);

/// Per-frame AR-metadata extraction toggles.  Set from JS via
/// `__stitcherProxy.setExtractionConfig(depth, anchors, mesh)` (driven by
/// the `<Camera>` enableDepth/enableAnchors/enableMesh props); read by the
/// platform AR extraction to skip costly work when off.  Defaults: all
/// false — zero arDepth/arAnchors/mesh cost until a host opts in (the
/// always-cheap pose/tracking/pixels are unaffected).
struct ExtractionConfig {
  bool depth = false;
  bool anchors = false;
  bool mesh = false;
};

/// Thread-safe snapshot of the current extraction config.  Written on the
/// JS thread (via the proxy), read on the AR delegate / GL thread.
ExtractionConfig getExtractionConfig();

}  // namespace retailens
