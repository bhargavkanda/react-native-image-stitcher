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
//
// ## Singleton lifetime note (for Leaks-tool readers)
//
// `+ shared` uses `dispatch_once`, so the singleton lives for the
// process lifetime — same pattern as most Obj-C singletons.  This
// means the dispatch queue (created in `init`) + the JsiWorkletContext
// (constructed lazily in `installIfNeeded`) + the `workletCallInvoker`
// lambda that captures the queue are ALL retained until process
// termination.  Xcode Instruments → Leaks will flag this as "leaked
// allocation rooted at the singleton" — that's noise, not a real leak
// (process termination reclaims it).  Phase 3c will keep this shape.

#import "RNSARWorkletRuntime.h"

#import <Foundation/Foundation.h>

#include <jsi/jsi.h>
// worklets-core headers — use quotes-include since the pod
// publishes them via HEADER_SEARCH_PATHS, not as a framework
// module map.  Same pattern KeyframeGateFrameProcessor.mm uses
// for vision-camera headers (which are reachable via <angle>
// only because vc's podspec sets `define_module` differently).
#include "WKTJsiWorkletContext.h"
#include "WKTJsiWorklet.h"

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

    // Phase 4 will add the host-worklet registry here.  Storage
    // shape (NSMutableArray of boxed shared_ptrs vs C++ vector
    // ivar) is intentionally NOT pre-committed in Phase 3b — let
    // the JSI plugin's actual register/unregister implementation
    // pick the natural shape.

    /// Phase 3c — first-party callback installed by RNSARSession.
    /// Invoked synchronously on the caller thread per AR frame.
    /// Cleared on RNSARSession.stop() to avoid retain cycles.
    ///
    /// Atomic property protects against the delegate firing
    /// concurrently with a setFirstPartyCallback: call on a
    /// different thread (rare but possible: setter on main thread
    /// from RNSARSession.start while a delayed delegate frame
    /// arrives).
    RNSARFirstPartyCallback _firstPartyCallback;

    /// Lock for `_firstPartyCallback` reads + writes.  The
    /// `_installLock` above is dispatch-queue-scoped (install);
    /// callback rotation is a separate concern.
    NSLock *_callbackLock;
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
        _callbackLock = [[NSLock alloc] init];
        _firstPartyCallback = nil;
    }
    return self;
}

- (void)setFirstPartyCallback:(RNSARFirstPartyCallback)callback {
    [_callbackLock lock];
    // Copy the block to move it from stack to heap (ARC handles
    // the copy semantics for blocks assigned to strong ivars).
    _firstPartyCallback = [callback copy];
    [_callbackLock unlock];
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
    // Phase 3c minimal-viable: synchronous first-party callback
    // dispatch.  The callback (installed by RNSARSession.start)
    // wraps the existing `incrementalConsumer.consumeFrame(...)`
    // call path, so net behavior is byte-identical to the v0.7.x
    // direct call.
    //
    // Phase 4 will add (on top of this):
    //   - Build `StitcherFrameHostObject` from `arFrame` + `pose`.
    //   - If host worklets registered, dispatch the host object
    //     onto `_ctx->invokeOnWorkletThread([...](ctx, rt) { ... })`
    //     and invoke each via `RNWorklet::WorkletInvoker::call`.
    //   - Invalidate the host object after the host worklets
    //     finish (or immediately if none registered).
    //
    // **Why first-party runs on the CALLER thread (not the worklet
    // thread):** ARKit's pool reuse contract requires the pixel
    // buffer to be consumed before this method returns.  The Swift
    // consumer does that synchronously inside `consumeFrame(...)`
    // (converts NV12 → cv::Mat synchronously, then defers heavier
    // work to its own queue).  If we posted the callback onto
    // `_dispatchQueue`, the delegate would return before
    // `consumeFrame` ran, ARKit could reclaim the buffer, and we'd
    // get torn frames.  Phase 4's host-worklet dispatch will need
    // to copy the buffer for off-thread access; Phase 3c keeps the
    // sync contract intact.
    //
    // Pull the callback under the lock so a concurrent
    // `setFirstPartyCallback:` doesn't race with our invocation.
    [_callbackLock lock];
    RNSARFirstPartyCallback cb = _firstPartyCallback;
    [_callbackLock unlock];
    if (cb != nil) {
        cb(arFrame, pose);
    }
}

@end
