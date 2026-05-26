// SPDX-License-Identifier: Apache-2.0
//
// stitcher_worklet_registry.hpp — process-scope native registry of
// host-supplied worklets (v0.8.0 Phase 4b).
//
// ## What this is
//
// The native-side counterpart to the JS-side `StitcherWorkletRegistry`
// singleton (`src/stitching/StitcherWorkletRegistry.ts`).  When the
// public `useFrameProcessor` hook is mounted from JS, it calls into a
// JSI installable (`globalThis.__stitcherProxy.install(workletFn)`)
// that wraps the worklet's JSI value into a
// `RNWorklet::WorkletInvoker` and stores it here.  Unmount calls
// `__stitcherProxy.uninstall(id)` which removes the entry.
//
// The AR worklet runtime's per-frame dispatch (`RNSARWorkletRuntime::
// dispatchFrame:pose:` on iOS) reads from this registry to fan out
// invocations across all registered host worklets.  The vc-mode
// path (non-AR) does NOT touch this registry — vision-camera owns
// the Frame Processor runtime in that mode and our public hook
// passes the worklet through to vc unchanged.
//
// ## Threading
//
// `install` / `uninstall` are called from the main JS thread
// (`useFrameProcessor`'s `useEffect` body).
//
// `snapshot` is called from the AR session callback thread (the
// caller thread of `RNSARWorkletRuntime::dispatchFrame:pose:`).  The
// snapshot returns shared_ptrs, so even if `uninstall` races on the
// JS thread between the snapshot and the worklet runtime's
// invocation, the WorkletInvoker stays alive until the caller drops
// the shared_ptr.  WorkletInvoker itself does NOT need its caller
// to live on a particular thread — the `call` method takes the
// target `jsi::Runtime&` as an argument, so callers from any
// thread can invoke it on any runtime they own.
//
// Mutation is serialised through `_mutex` (std::mutex).  Reads via
// `snapshot` lock briefly to copy the entry vector; that's microseconds
// at most (registry typically has 0-3 entries).  No worklet invocation
// happens under the lock.
//
// ## Lifetime
//
// The registry is a `static`-local singleton, constructed on first
// `shared()` call (function-static init = thread-safe per the C++11
// memory model).  It outlives every JS / native runtime in the
// process.  Entries are only added by `install` and only removed by
// `uninstall` — no GC, no weak refs.  Hosts that bypass the
// `useFrameProcessor` hook and call `install` directly without ever
// calling `uninstall` leak entries (matches the JS-side singleton's
// contract).
//
// ## Why a singleton (not per-runtime / per-AR-session)
//
// The AR worklet runtime (`RNSARWorkletRuntime` / `StitcherWorkletRuntime`)
// is itself a process-scope singleton.  The hook lifecycle is
// per-component-mount.  Registering against a per-AR-session registry
// would mean re-registering each time AR mode starts — but the host
// worklet's identity hasn't changed.  Process-scope = "registry
// matches the host's mental model of `useFrameProcessor` semantics".

#pragma once

#include <jsi/jsi.h>

#include <memory>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

// Forward-declare to avoid pulling the whole worklets-core header
// into every translation unit that just needs to hold an invoker
// pointer.  The .cpp includes the full header.
namespace RNWorklet {
class WorkletInvoker;
}

namespace retailens {

/// One registered host worklet.  Public so callers iterating via
/// `snapshot` can read both the ID and the invoker.
struct StitcherWorkletEntry {
  std::string id;
  std::shared_ptr<RNWorklet::WorkletInvoker> invoker;
};

class StitcherWorkletRegistry {
 public:
  /// Process-scope singleton.  Thread-safe lazy init via C++11
  /// function-static.
  static StitcherWorkletRegistry& shared();

  /// Install a host worklet.  Wraps the JSI value (the worklet's
  /// `'worklet'`-decorated function from the main JS runtime) into
  /// a `WorkletInvoker` and stores it.  Returns a stable string ID
  /// the caller passes to `uninstall`.
  ///
  /// Thread: must be called from a thread that owns `mainRuntime`
  /// (typically the main JS thread).  The wrapped `WorkletInvoker`
  /// can then be invoked from any thread on any runtime via
  /// `call(rt, ...)`.
  std::string install(facebook::jsi::Runtime& mainRuntime,
                       const facebook::jsi::Value& workletValue);

  /// Remove a previously-installed entry by ID.  No-op for unknown
  /// IDs (matches the JS-side `StitcherWorkletRegistry` semantics).
  void uninstall(const std::string& id);

  /// Snapshot the current entries.  The returned vector holds
  /// shared_ptrs to `WorkletInvoker`; mutations against the
  /// registry after `snapshot` returns do not affect the snapshot.
  /// Callers iterate without holding the registry lock.
  std::vector<StitcherWorkletEntry> snapshot();

  /// Current entry count.  Used by `dispatchFrame:` for the
  /// fast-path early-exit (no fan-out cost when no host worklets
  /// are registered).
  std::size_t count();

  /// Test-only — clear all entries.  Used by C++ unit tests; not
  /// exposed through the JSI surface.
  void _resetForTests();

 private:
  StitcherWorkletRegistry() = default;
  StitcherWorkletRegistry(const StitcherWorkletRegistry&) = delete;
  StitcherWorkletRegistry& operator=(const StitcherWorkletRegistry&) = delete;

  std::mutex _mutex;
  std::vector<StitcherWorkletEntry> _entries;
  int _nextId = 0;
};

}  // namespace retailens
