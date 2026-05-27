// SPDX-License-Identifier: Apache-2.0
//
// stitcher_worklet_registry_test.cpp — v0.10.0 audit #9A
//
// Lifecycle + concurrency coverage for the process-scope native
// `StitcherWorkletRegistry` introduced in v0.8.0 Phase 4b.  See
// `cpp/stitcher_worklet_registry.hpp` for the public contract.
//
// The registry's production `install(runtime, workletValue)` path
// constructs an `RNWorklet::WorkletInvoker` from a JSI `Runtime` and
// `Value`.  Standing up a real worklets-core runtime under gtest would
// pull in Hermes + JSI + the whole worklets-core library — too heavy
// for these scope-limited storage tests.  Instead we exercise the
// equivalent `_installEntryForTests(invoker)` test seam (mirrors
// `_resetForTests` in pattern) with `nullptr` invokers.  The registry
// never dereferences the pointer — it only stores the shared_ptr and
// hands it back via `snapshot` — so nullptr is safe.
//
// What this covers (lifting from the production `install`/`uninstall`/
// `snapshot`/`count` contract):
//   - shared() returns the same instance across calls
//   - count/snapshot start empty after _resetForTests
//   - install assigns monotonically increasing host-N IDs
//   - count tracks installs / uninstalls
//   - uninstall of an unknown ID is a no-op (matches JS side)
//   - snapshot returns an independent copy (mutations after snapshot
//     don't affect the snapshot's view)
//   - concurrent installs from many threads serialise correctly and
//     yield unique IDs (no double-issue under contention)

#include "stitcher_worklet_registry.hpp"
#include <react-native-worklets-core/WKTJsiWorklet.h>

#include <gtest/gtest.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <set>
#include <string>
#include <thread>
#include <vector>

using retailens::StitcherWorkletEntry;
using retailens::StitcherWorkletRegistry;

namespace {

/// Test fixture — resets the singleton before each test so cases
/// don't leak state into each other.  Without this every test would
/// see the cumulative entries from prior tests in the run.
class StitcherWorkletRegistryTest : public ::testing::Test {
 protected:
  void SetUp() override {
    StitcherWorkletRegistry::shared()._resetForTests();
  }
  void TearDown() override {
    StitcherWorkletRegistry::shared()._resetForTests();
  }
};

}  // namespace

TEST_F(StitcherWorkletRegistryTest, SharedReturnsSameInstance) {
  // The singleton invariant is load-bearing for the JS-side mental
  // model: `useFrameProcessor` mounts on one component and unmounts
  // from another but the registry stays.
  StitcherWorkletRegistry& a = StitcherWorkletRegistry::shared();
  StitcherWorkletRegistry& b = StitcherWorkletRegistry::shared();
  EXPECT_EQ(&a, &b);
}

TEST_F(StitcherWorkletRegistryTest, StartsEmptyAfterReset) {
  auto& r = StitcherWorkletRegistry::shared();
  EXPECT_EQ(r.count(), 0u);
  EXPECT_TRUE(r.snapshot().empty());
}

TEST_F(StitcherWorkletRegistryTest, InstallAssignsHostPrefixedIncrementingIds) {
  auto& r = StitcherWorkletRegistry::shared();
  const std::string id0 = r._installEntryForTests(nullptr);
  const std::string id1 = r._installEntryForTests(nullptr);
  const std::string id2 = r._installEntryForTests(nullptr);

  // IDs are "host-N" with N monotonically increasing from 0 after a
  // reset.  The format is part of the public contract — uninstall
  // callers store these IDs verbatim.
  EXPECT_EQ(id0, "host-0");
  EXPECT_EQ(id1, "host-1");
  EXPECT_EQ(id2, "host-2");
  EXPECT_EQ(r.count(), 3u);
}

TEST_F(StitcherWorkletRegistryTest, UninstallRemovesByIdAndUpdatesCount) {
  auto& r = StitcherWorkletRegistry::shared();
  const std::string id0 = r._installEntryForTests(nullptr);
  const std::string id1 = r._installEntryForTests(nullptr);
  const std::string id2 = r._installEntryForTests(nullptr);
  EXPECT_EQ(r.count(), 3u);

  r.uninstall(id1);  // remove the middle entry
  EXPECT_EQ(r.count(), 2u);

  // Snapshot should contain only id0 and id2, in some order — the
  // contract doesn't promise insertion order survives uninstall
  // (the erase-remove pattern is stable in practice but we don't
  // pin that publicly).
  const auto snap = r.snapshot();
  std::vector<std::string> remainingIds;
  remainingIds.reserve(snap.size());
  for (const auto& entry : snap) {
    remainingIds.push_back(entry.id);
  }
  std::sort(remainingIds.begin(), remainingIds.end());
  EXPECT_EQ(remainingIds, (std::vector<std::string>{id0, id2}));
}

TEST_F(StitcherWorkletRegistryTest, UninstallOfUnknownIdIsNoop) {
  // Matches the JS-side `StitcherWorkletRegistry.uninstall` semantics
  // (idempotent, no throw on unknown).  Critical because the JS
  // useEffect cleanup can fire after an unmount/remount race where the
  // ID has already been removed.
  auto& r = StitcherWorkletRegistry::shared();
  r._installEntryForTests(nullptr);
  EXPECT_EQ(r.count(), 1u);
  EXPECT_NO_THROW(r.uninstall("host-does-not-exist"));
  EXPECT_NO_THROW(r.uninstall(""));
  EXPECT_EQ(r.count(), 1u);  // existing entry untouched
}

TEST_F(StitcherWorkletRegistryTest, SnapshotIsIndependentOfFutureMutations) {
  // Per header docstring: "mutations against the registry after
  // `snapshot` returns do not affect the snapshot."  This matters for
  // the AR-session dispatch path, which snapshots and then iterates
  // without holding the registry lock — concurrent uninstall on the
  // JS thread must NOT invalidate the snapshot.
  auto& r = StitcherWorkletRegistry::shared();
  const std::string id0 = r._installEntryForTests(nullptr);
  const std::string id1 = r._installEntryForTests(nullptr);

  const auto snap = r.snapshot();
  ASSERT_EQ(snap.size(), 2u);

  r.uninstall(id0);
  r.uninstall(id1);
  EXPECT_EQ(r.count(), 0u);

  // Snapshot still has both entries.
  EXPECT_EQ(snap.size(), 2u);
  EXPECT_EQ(snap[0].id, id0);
  EXPECT_EQ(snap[1].id, id1);
}

TEST_F(StitcherWorkletRegistryTest, ConcurrentInstallsYieldUniqueIds) {
  // Many threads racing `_installEntryForTests` simultaneously must
  // not see duplicate IDs (would indicate the mutex around _nextId is
  // missing or broken).  This is the per-instance equivalent of
  // TransferredNV21Test's "only one of N concurrent callers wins"
  // pattern, adapted for "all N callers succeed but produce distinct
  // IDs".
  auto& r = StitcherWorkletRegistry::shared();
  constexpr int kThreads = 16;
  constexpr int kPerThread = 32;  // 512 total installs

  std::vector<std::thread> workers;
  workers.reserve(kThreads);
  std::vector<std::vector<std::string>> idsPerThread(kThreads);

  std::atomic<bool> go{false};
  for (int t = 0; t < kThreads; ++t) {
    workers.emplace_back([&, t]() {
      while (!go.load(std::memory_order_acquire)) {
        std::this_thread::yield();
      }
      for (int i = 0; i < kPerThread; ++i) {
        idsPerThread[t].push_back(r._installEntryForTests(nullptr));
      }
    });
  }
  go.store(true, std::memory_order_release);
  for (auto& w : workers) w.join();

  // Aggregate every ID issued.  Total count = kThreads * kPerThread;
  // uniqueness = the set size matches.
  std::set<std::string> allIds;
  for (const auto& v : idsPerThread) {
    for (const auto& id : v) {
      allIds.insert(id);
    }
  }
  EXPECT_EQ(allIds.size(),
            static_cast<std::size_t>(kThreads * kPerThread));
  EXPECT_EQ(r.count(),
            static_cast<std::size_t>(kThreads * kPerThread));
}
