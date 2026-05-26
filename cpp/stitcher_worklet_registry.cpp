// SPDX-License-Identifier: Apache-2.0
//
// stitcher_worklet_registry.cpp — implementation of the v0.8.0
// Phase 4b native worklet registry.  See header for the public
// contract + threading rules.

#include "stitcher_worklet_registry.hpp"

// Cross-platform worklets-core header include.  On iOS the
// CocoaPods setup publishes worklets-core headers via
// `HEADER_SEARCH_PATHS` at the root of `Pods/Headers/Public/`,
// so `<WKTJsiWorklet.h>` works.  On Android the prefab puts
// headers under a `react-native-worklets-core/` subdirectory of
// the include path (matches the prefab name).  The angled
// namespace-prefixed include works on BOTH — `<x/y.h>` resolves
// to `Pods/Headers/Public/x/y.h` on iOS (CocoaPods auto-creates
// symlinked subdirs per pod) and to `build/headers/.../x/y.h` on
// Android.  Pattern lifted from vc's
// `node_modules/react-native-vision-camera/android/src/main/cpp/`.
#include <react-native-worklets-core/WKTJsiWorklet.h>

#include <algorithm>
#include <sstream>

namespace retailens {

StitcherWorkletRegistry& StitcherWorkletRegistry::shared() {
  static StitcherWorkletRegistry s_instance;
  return s_instance;
}

std::string StitcherWorkletRegistry::install(
    facebook::jsi::Runtime& mainRuntime,
    const facebook::jsi::Value& workletValue) {
  // Construct the invoker outside the lock — the WorkletInvoker
  // constructor calls into worklets-core which acquires its own
  // locks; nesting our lock around that would invite a deadlock if
  // worklets-core ever called back into our code synchronously.
  auto invoker = std::make_shared<RNWorklet::WorkletInvoker>(
      mainRuntime, workletValue);

  std::lock_guard<std::mutex> lock(_mutex);
  std::ostringstream idStream;
  idStream << "host-" << _nextId++;
  std::string id = idStream.str();
  _entries.push_back({id, std::move(invoker)});
  return id;
}

void StitcherWorkletRegistry::uninstall(const std::string& id) {
  std::lock_guard<std::mutex> lock(_mutex);
  // erase-remove with a predicate (single-pass O(n) — n is tiny in
  // practice, typically 0-3).
  _entries.erase(
      std::remove_if(_entries.begin(), _entries.end(),
                     [&id](const StitcherWorkletEntry& e) {
                       return e.id == id;
                     }),
      _entries.end());
}

std::vector<StitcherWorkletEntry> StitcherWorkletRegistry::snapshot() {
  std::lock_guard<std::mutex> lock(_mutex);
  // Copy the vector — entries hold shared_ptrs so this is O(n)
  // refcount bumps, no deep copies.  Returning by value lets the
  // caller iterate without holding the lock.
  return _entries;
}

std::size_t StitcherWorkletRegistry::count() {
  std::lock_guard<std::mutex> lock(_mutex);
  return _entries.size();
}

void StitcherWorkletRegistry::_resetForTests() {
  std::lock_guard<std::mutex> lock(_mutex);
  _entries.clear();
  _nextId = 0;
}

}  // namespace retailens
