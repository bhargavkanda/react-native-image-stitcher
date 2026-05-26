// SPDX-License-Identifier: Apache-2.0
//
// RNSARWorkletRuntime.h — Obj-C facade for the v0.8.0 AR-mode
// worklet runtime.  Wraps `react-native-worklets-core`'s
// `RNWorklet::JsiWorkletContext` (the same primitive vision-camera
// uses for its Frame Processor runtime) so the lib can dispatch
// per-ARFrame worklets on a thread we own — rather than ARKit's
// delegate queue, where doing significant work would block the
// AR session's update loop.
//
// ## Phase 3b scope (this commit)
//
// Owns:
//   - The dispatch queue the worklet runtime pins to.
//   - The underlying `JsiWorkletContext` (constructed lazily on
//     `installIfNeeded`, lives for the singleton's lifetime).
//   - A registry of host worklets (initially empty; populated by
//     Phase 4's TS-side hook + JSI plugin).
//
// Exposes:
//   - `+ shared` singleton accessor.
//   - `- installIfNeeded` (idempotent runtime construction).
//   - `- isInstalled` for diagnostics + tests.
//   - `- dispatchFrame:pose:` — currently a no-op stub; Phase 3c
//     fills in the actual host-object construction + worklet
//     invocation + first-party stitching dispatch.
//
// ## Why Obj-C facade with `.mm` implementation
//
// The implementation needs to hold `std::shared_ptr<JsiWorkletContext>`
// + run JSI value construction, which can't live in pure Swift.  Same
// pattern as `KeyframeGateBridge.{h,mm}` + `StitcherFrameHostObject.{h,mm}`:
// keep the header umbrella-safe (no JSI imports), put the C++ glue in
// the .mm.
//
// ## Header umbrella safety
//
// This .h imports only Foundation + ARKit (both system frameworks).
// Worklets-core types are confined to the .mm.

#pragma once

#import <Foundation/Foundation.h>
#import <ARKit/ARKit.h>

@class RNSARFramePose;

NS_ASSUME_NONNULL_BEGIN

NS_SWIFT_NAME(RNSARWorkletRuntime)
@interface RNSARWorkletRuntime : NSObject

/// Singleton accessor.  One AR worklet runtime per process; multiple
/// `<Camera>` mounts share it.  Construction is cheap (just an Obj-C
/// alloc + an `NSMutableArray`); the heavy JSI work happens in
/// `-installIfNeeded`.
+ (instancetype)shared NS_SWIFT_NAME(shared());

/// Construct the underlying `JsiWorkletContext` if not yet
/// installed.  Idempotent — repeated calls are no-ops.  Called from
/// `RNSARSession` at AR-mode start time (Phase 3c will wire this
/// up; Phase 3b ships the method but no one calls it yet).
///
/// Threading: safe to call from any thread; internally serialised.
/// The runtime's own dispatch queue starts running once installed.
- (void)installIfNeeded;

/// Diagnostics + tests.  Returns `YES` after a successful
/// `-installIfNeeded`.
- (BOOL)isInstalled;

/// Dispatch one AR frame through the registered worklets.  Called
/// per `ARFrame` by `RNSARSession.delegate` once Phase 3c lands the
/// migration (Phase 3b ships this method as a no-op stub so the
/// runtime can be built + linked + the API surface fixed).
///
/// The Phase 3c implementation will:
///   1. Build a `StitcherFrameHostObject` from `arFrame` + `pose`.
///   2. Run the first-party stitching synchronously on the caller
///      thread (preserves today's `ingestFromARCameraView` cost
///      envelope at the producer site).
///   3. If any host worklets are registered, dispatch the host
///      object onto the worklet runtime's thread + invoke each
///      worklet via `RNWorklet::WorkletInvoker::call`.
///   4. Invalidate the host object after all worklets return.
///
/// Threading: typically called from `ARSession.delegateQueue` (main
/// queue by default; Phase 3c will pin it explicitly to a
/// dedicated queue).
- (void)dispatchFrame:(ARFrame *)arFrame pose:(RNSARFramePose *)pose
    NS_SWIFT_NAME(dispatchFrame(_:pose:));

@end

NS_ASSUME_NONNULL_END
