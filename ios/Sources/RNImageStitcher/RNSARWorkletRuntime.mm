// SPDX-License-Identifier: Apache-2.0
//
// RNSARWorkletRuntime.mm — Obj-C++ implementation.  See the header
// for the API contract.  This file owns:
//
//   - The dispatch queue the worklet runtime is pinned to
//   - The `std::shared_ptr<RNWorklet::JsiWorkletContext>` itself
//   - The registry of host worklets (Phase 4 wiring will populate
//     this via a JSI plugin entry point)
//
// Phase 3b scope: construct the context + expose the API.  No
// dispatch logic yet — `dispatchFrame:pose:` is a stub.  Phase 3c
// fills in (a) the host-object construction + worklet invocation,
// (b) the first-party stitching callback, (c) the migration in
// `RNSARSession.delegate`.

#import "RNSARWorkletRuntime.h"

#import <Foundation/Foundation.h>

#include <jsi/jsi.h>
#include <WKTJsiWorkletContext.h>
#include <WKTJsiWorklet.h>

#include <memory>
#include <utility>

// Forward-declare `RNSARFramePose` — same pattern as
// StitcherFrameHostObject.mm.  We don't read its fields here in
// Phase 3b (the stub doesn't unpack the pose), but Phase 3c will.
@class RNSARFramePose;

@implementation RNSARWorkletRuntime {
    /// Dispatch queue the worklet runtime's `workletCallInvoker`
    /// posts onto.  Serial; `DISPATCH_QUEUE_SERIAL` matches the
    /// existing `IncrementalStitcher::workQueue` cost envelope
    /// (one-at-a-time frame ingest).
    ///
    /// Phase 3c will configure `ARSession.delegateQueue` to point
    /// at the same queue so the delegate fires on the worklet
    /// thread — eliminates a thread hop per frame + makes the
    /// "first-party first, host worklets after" ordering trivial
    /// to enforce (all on one queue).
    dispatch_queue_t _dispatchQueue;

    /// The wrapped worklet-runtime context.  Constructed lazily on
    /// `-installIfNeeded`; held for the singleton's lifetime
    /// (process-wide).
    std::shared_ptr<RNWorklet::JsiWorkletContext> _ctx;

    /// Single-flight install guard.  `BOOL` is sufficient because
    /// `-installIfNeeded` synchronises on `_installLock` below.
    BOOL _installed;

    /// Lock for `_installed` + `_ctx`.  Construction may race with
    /// concurrent first-mount calls from multiple `<Camera>`
    /// instances; serialise to ensure exactly-once init.
    NSLock *_installLock;

    /// Registry of host worklets, populated by Phase 4's JSI
    /// plugin.  Stored as boxed `std::shared_ptr<RNWorklet::JsiWorklet>`
    /// pointers (one allocation per registration, freed on
    /// unregister).  Empty in Phase 3b.
    NSMutableArray<NSValue *> *_hostWorklets;
}

+ (instancetype)shared {
    static RNSARWorkletRuntime *sInstance;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ sInstance = [[self alloc] init]; });
    return sInstance;
}

- (instancetype)init {
    if ((self = [super init])) {
        _dispatchQueue = dispatch_queue_create(
            "io.imagestitcher.ar-worklet-runtime", DISPATCH_QUEUE_SERIAL);
        _installed = NO;
        _installLock = [[NSLock alloc] init];
        _hostWorklets = [NSMutableArray array];
    }
    return self;
}

- (void)installIfNeeded {
    [_installLock lock];
    if (_installed) {
        [_installLock unlock];
        return;
    }

    // Build the `workletCallInvoker`.  `RNWorklet::JsiWorkletContext`
    // accepts a `std::function<void(std::function<void()>&&)>` that
    // posts a task onto whatever thread the runtime should execute
    // on.  We post onto `_dispatchQueue` (a serial GCD queue).
    //
    // The captured `fp` is moved into a `std::shared_ptr` so the
    // dispatch_async block (which can only capture copyable types)
    // can hold + invoke it.  Without the shared_ptr indirection
    // we'd hit `std::function` copy-construction on the
    // non-copyable forward closure.
    dispatch_queue_t queue = _dispatchQueue;
    auto invoker = [queue](std::function<void()>&& fp) {
        auto fpHolder = std::make_shared<std::function<void()>>(std::move(fp));
        dispatch_async(queue, ^{ (*fpHolder)(); });
    };

    _ctx = std::make_shared<RNWorklet::JsiWorkletContext>(
        "stitcher.ar", std::move(invoker));
    _installed = YES;
    [_installLock unlock];
}

- (BOOL)isInstalled {
    [_installLock lock];
    BOOL result = _installed;
    [_installLock unlock];
    return result;
}

- (void)dispatchFrame:(ARFrame *)arFrame pose:(RNSARFramePose *)pose {
    // Phase 3b stub.  No-op until Phase 3c lands the actual dispatch.
    //
    // Why ship the stub:
    //   - Surface fixes the API at the boundary, so RNSARSession's
    //     migration call site (Phase 3c) compiles against this
    //     interface today.
    //   - `installIfNeeded` is testable + verifiable in isolation
    //     without a running AR session.
    //   - Phase 3c reviewer sees the API + the no-op + can audit
    //     only the dispatch-logic delta, not the whole class.
    //
    // Phase 3c will replace this method body with:
    //   1. `StitcherFrameHostObject *host = [StitcherFrameHostObject
    //         fromARFrame:arFrame pose:pose];`
    //   2. First-party stitching: invoke
    //      `IncrementalStitcher.shared.ingestFromARCameraView(...)`
    //      synchronously on the caller thread (preserves the
    //      current per-frame cost envelope).
    //   3. If `_hostWorklets.count > 0`, invoke
    //      `_ctx->invokeOnWorkletThread([...](ctx, rt) { ... })`
    //      and inside the lambda construct a `jsi::Object` from
    //      the host object's `jsiHostObjectPtr` + iterate the
    //      worklet list, invoking each via
    //      `RNWorklet::WorkletInvoker(w).call(rt, undef, &arg, 1)`.
    //   4. `[host invalidate]` after the worklets finish (or
    //      immediately if none registered).
    //
    // Suppress unused-parameter warnings; the args are part of the
    // contract even though Phase 3b doesn't read them.
    (void)arFrame;
    (void)pose;
}

@end
