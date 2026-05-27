// SPDX-License-Identifier: Apache-2.0
//
// WKTJsiWorklet.h — TEST-ONLY stub of RNWorklet::WorkletInvoker.
//
// `cpp/stitcher_worklet_registry.cpp` constructs a
// `std::make_shared<RNWorklet::WorkletInvoker>(runtime, value)` inside
// `install`.  The real WorkletInvoker (from react-native-worklets-core)
// captures the worklet's source / closure / runtime affinity and is
// non-trivial to stand up in a unit-test context.
//
// This stub provides JUST the symbols needed for the registry to
// compile and link.  The constructor and destructor are no-ops; calling
// methods on a stub invoker is undefined behaviour, but the registry
// itself never does (it only stores the shared_ptr and hands it out
// via `snapshot`).  Tests construct entries directly via
// `_installEntryForTests(nullptr)` to avoid even the trivial
// allocation.
//
// See cpp/tests/stubs/jsi/jsi.h for the parallel stub of facebook::jsi.

#pragma once

#include <jsi/jsi.h>

namespace RNWorklet {

class WorkletInvoker {
 public:
  WorkletInvoker(facebook::jsi::Runtime& /*runtime*/,
                 const facebook::jsi::Value& /*workletValue*/) {}
  ~WorkletInvoker() = default;
};

}  // namespace RNWorklet
